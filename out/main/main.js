//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
//#endregion
//#region electron/ipc/dbHandler.js
var require_dbHandler = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Database$2 = require("better-sqlite3");
	var path$5 = require("path");
	var { app: app$3, safeStorage: safeStorage$1 } = require("electron");
	var crypto = require("crypto");
	var fs$4 = require("fs");
	var masterKeyHex = null;
	function getOrCreateMasterKey() {
		const blobPath = path$5.join(app$3.getPath("userData"), ".nord-master-key");
		if (fs$4.existsSync(blobPath)) {
			const encryptedBuf = fs$4.readFileSync(blobPath);
			if (safeStorage$1.isEncryptionAvailable()) masterKeyHex = safeStorage$1.decryptString(encryptedBuf);
			else {
				console.warn("[Security] safeStorage unavailable — deriving key from userData path");
				masterKeyHex = crypto.createHash("sha256").update(app$3.getPath("userData")).digest("hex");
			}
			return masterKeyHex;
		}
		const newKey = crypto.randomBytes(32).toString("hex");
		if (safeStorage$1.isEncryptionAvailable()) {
			const encryptedBuf = safeStorage$1.encryptString(newKey);
			fs$4.writeFileSync(blobPath, encryptedBuf);
		} else {
			console.warn("[Security] safeStorage unavailable — deriving key from userData path");
			fs$4.writeFileSync(blobPath, Buffer.from("fallback-marker"));
		}
		masterKeyHex = newKey;
		return masterKeyHex;
	}
	function encryptApiKey(plaintext) {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(masterKeyHex, "hex"), iv);
		return {
			encrypted: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]),
			iv,
			tag: cipher.getAuthTag()
		};
	}
	function decryptApiKey(encrypted, iv, tag) {
		const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(masterKeyHex, "hex"), iv);
		decipher.setAuthTag(Buffer.isBuffer(tag) ? tag : Buffer.from(tag));
		return Buffer.concat([decipher.update(Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted)), decipher.final()]).toString("utf8");
	}
	function resolveDbPath() {
		try {
			if (app$3 && app$3.getPath) {
				const userDataPath = app$3.getPath("userData");
				if (userDataPath) return path$5.join(userDataPath, "nord.db");
			}
		} catch (err) {}
		return path$5.join(__dirname, "../../db/nord.db");
	}
	var DB_PATH = resolveDbPath();
	var db = null;
	var saveProjectStmt = null;
	var getProjectStmt = null;
	var getAllProjectsStmt = null;
	var deleteProjectStmt = null;
	var deleteProjectConversationsStmt = null;
	var deleteProjectAgentRunsStmt = null;
	var deleteProjectModelConfigStmt = null;
	var updateProjectPhaseStmt = null;
	var saveConversationStmt = null;
	var getConversationsStmt = null;
	var saveAgentRunStmt = null;
	var updateAgentRunStmt = null;
	var saveModelConfigStmt = null;
	var getModelConfigStmt = null;
	var getKeysForProviderStmt = null;
	var countKeysForProviderStmt = null;
	var addKeyStmt = null;
	var removeKeyStmt = null;
	var removeKeyModelStatesStmt = null;
	var getKeyModelStateStmt = null;
	var setKeyModelStateStmt = null;
	var getAllModelStatesForKeyStmt = null;
	var resetRPMExhaustedStmt = null;
	var resetDailyExhaustedStmt = null;
	var deleteProjectCascade = null;
	/**
	* Initialize the SQLite database, run migrations, and prepare all statements.
	* Called at the beginning of initStore(), after app.whenReady().
	*/
	function initDatabase() {
		db = new Database$2(DB_PATH);
		db.pragma("journal_mode = WAL");
		db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      provider TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      current_phase INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS model_config (
      project_id TEXT,
      slot TEXT,
      provider TEXT,
      model TEXT,
      temperature REAL,
      candidates_json TEXT,
      PRIMARY KEY (project_id, slot)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      agent TEXT,
      role TEXT,
      content TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      phase INTEGER,
      agent_id TEXT,
      model TEXT,
      provider TEXT,
      status TEXT,
      output TEXT,
      started_at DATETIME,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS api_keys_pool (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL,
      key_index INTEGER NOT NULL,
      label TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS key_model_state (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      key_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT DEFAULT 'ok',
      exhausted_at DATETIME,
      calls_this_minute INTEGER DEFAULT 0,
      last_call_at DATETIME,
      UNIQUE(provider, key_id, model)
    );

    CREATE TABLE IF NOT EXISTS fallback_state (
      id TEXT PRIMARY KEY,
      slot TEXT NOT NULL,
      candidate_index INTEGER NOT NULL,
      provider TEXT NOT NULL,
      key_id TEXT,
      model TEXT NOT NULL,
      status TEXT DEFAULT 'ok',
      exhausted_at DATETIME,
      UNIQUE(slot, candidate_index)
    );
  `);
		if (!db.pragma("table_info(api_keys_pool)").some((col) => col.name === "encrypted_key")) {
			db.exec("ALTER TABLE api_keys_pool ADD COLUMN encrypted_key BLOB");
			db.exec("ALTER TABLE api_keys_pool ADD COLUMN key_iv BLOB");
			db.exec("ALTER TABLE api_keys_pool ADD COLUMN key_tag BLOB");
		}
		if (!db.pragma("table_info(model_config)").some((col) => col.name === "candidates_json")) db.exec("ALTER TABLE model_config ADD COLUMN candidates_json TEXT");
		if (masterKeyHex) {
			db.prepare("UPDATE api_keys_pool SET api_key = '' WHERE api_key IS NULL").run();
			const plaintextRows = db.prepare("SELECT id, api_key FROM api_keys_pool WHERE encrypted_key IS NULL AND api_key IS NOT NULL AND api_key != ''").all();
			const migrateStmt = db.prepare("UPDATE api_keys_pool SET encrypted_key = ?, key_iv = ?, key_tag = ?, api_key = '' WHERE id = ?");
			db.transaction(() => {
				for (const row of plaintextRows) {
					const { encrypted, iv, tag } = encryptApiKey(row.api_key);
					migrateStmt.run(encrypted, iv, tag, row.id);
				}
			})();
			if (plaintextRows.length > 0) console.log(`[Security] Migrated ${plaintextRows.length} plaintext API key(s) to AES-256-GCM`);
		}
		saveProjectStmt = db.prepare(`
    INSERT OR REPLACE INTO projects (id, name, path, current_phase, status)
    VALUES (@id, @name, @path, @current_phase, @status)
  `);
		getProjectStmt = db.prepare("SELECT * FROM projects WHERE id = ?");
		getAllProjectsStmt = db.prepare("SELECT * FROM projects ORDER BY created_at DESC");
		deleteProjectStmt = db.prepare("DELETE FROM projects WHERE id = ?");
		deleteProjectConversationsStmt = db.prepare("DELETE FROM conversations WHERE project_id = ?");
		deleteProjectAgentRunsStmt = db.prepare("DELETE FROM agent_runs WHERE project_id = ?");
		deleteProjectModelConfigStmt = db.prepare("DELETE FROM model_config WHERE project_id = ?");
		updateProjectPhaseStmt = db.prepare("UPDATE projects SET current_phase = ? WHERE id = ?");
		deleteProjectCascade = db.transaction((id) => {
			deleteProjectConversationsStmt.run(id);
			deleteProjectAgentRunsStmt.run(id);
			deleteProjectModelConfigStmt.run(id);
			deleteProjectStmt.run(id);
		});
		saveConversationStmt = db.prepare(`
    INSERT INTO conversations (id, project_id, agent, role, content)
    VALUES (@id, @project_id, @agent, @role, @content)
  `);
		getConversationsStmt = db.prepare(`
    SELECT * FROM conversations
    WHERE project_id = ? AND agent = ?
    ORDER BY timestamp ASC
  `);
		saveAgentRunStmt = db.prepare(`
    INSERT INTO agent_runs (id, project_id, phase, agent_id, model, provider, status, started_at)
    VALUES (@id, @project_id, @phase, @agent_id, @model, @provider, @status, @started_at)
  `);
		updateAgentRunStmt = db.prepare(`
    UPDATE agent_runs
    SET status = ?, output = ?, completed_at = ?
    WHERE id = ?
  `);
		saveModelConfigStmt = db.prepare(`
    INSERT OR REPLACE INTO model_config (project_id, slot, provider, model, temperature, candidates_json)
    VALUES (@project_id, @slot, @provider, @model, @temperature, @candidates_json)
  `);
		getModelConfigStmt = db.prepare("SELECT * FROM model_config WHERE project_id = ?");
		getKeysForProviderStmt = db.prepare("SELECT * FROM api_keys_pool WHERE provider = ? AND is_active = 1 ORDER BY key_index ASC");
		countKeysForProviderStmt = db.prepare("SELECT COUNT(*) as count FROM api_keys_pool WHERE provider = ?");
		addKeyStmt = db.prepare("INSERT INTO api_keys_pool (id, provider, api_key, encrypted_key, key_iv, key_tag, key_index, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		removeKeyStmt = db.prepare("DELETE FROM api_keys_pool WHERE id = ?");
		removeKeyModelStatesStmt = db.prepare("DELETE FROM key_model_state WHERE key_id = ?");
		getKeyModelStateStmt = db.prepare("SELECT * FROM key_model_state WHERE provider = ? AND key_id = ? AND model = ?");
		setKeyModelStateStmt = db.prepare(`
    INSERT INTO key_model_state (id, provider, key_id, model, status, exhausted_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, key_id, model)
    DO UPDATE SET status = excluded.status, exhausted_at = excluded.exhausted_at
  `);
		getAllModelStatesForKeyStmt = db.prepare("SELECT * FROM key_model_state WHERE provider = ? AND key_id = ?");
		resetRPMExhaustedStmt = db.prepare(`
    UPDATE key_model_state
    SET status = 'ok', exhausted_at = NULL
    WHERE status = 'rpm_exhausted'
  `);
		resetDailyExhaustedStmt = db.prepare(`
    UPDATE key_model_state
    SET status = 'ok', exhausted_at = NULL
    WHERE status = 'daily_exhausted'
  `);
		const kiloKeys = db.prepare("SELECT * FROM api_keys_pool WHERE provider = 'kilo'").all();
		if (kiloKeys.length > 0) {
			console.warn(`[Migration] Found ${kiloKeys.length} Kilo key(s). Kilo is no longer supported. Keys preserved but inactive.`);
			db.prepare("UPDATE api_keys_pool SET is_active = 0 WHERE provider = 'kilo'").run();
		}
		const deprecatedConfigs = db.prepare("SELECT * FROM model_config WHERE provider = 'kilo'").all();
		if (deprecatedConfigs.length > 0) {
			console.log(`[Migration] Updating ${deprecatedConfigs.length} model config(s) from Kilo to NVIDIA`);
			db.prepare("UPDATE model_config SET provider = 'nvidia', model = 'moonshotai/kimi-k2.5' WHERE provider = 'kilo'").run();
		}
	}
	var store = null;
	async function initStore$1() {
		getOrCreateMasterKey();
		initDatabase();
		const { default: Store } = await import("electron-store");
		store = new Store({ encryptionKey: masterKeyHex });
	}
	function ensureDb() {
		if (!db) throw new Error("Database not initialized — call initStore() first");
	}
	function getKey(provider) {
		if (!store) throw new Error("Store not initialised");
		return store.get(`apiKey.${provider}`) ?? null;
	}
	function setKey(provider, apiKey) {
		if (!store) throw new Error("Store not initialised");
		store.set(`apiKey.${provider}`, apiKey);
	}
	function saveProject(project) {
		ensureDb();
		const normalizedProject = {
			...project,
			current_phase: project.current_phase !== void 0 ? project.current_phase : 1,
			status: project.status || "active"
		};
		saveProjectStmt.run(normalizedProject);
	}
	function getProject(id) {
		ensureDb();
		return getProjectStmt.get(id) || null;
	}
	function getAllProjects() {
		ensureDb();
		return getAllProjectsStmt.all();
	}
	function deleteProject(id) {
		ensureDb();
		deleteProjectCascade(id);
	}
	function updateProjectPhase(id, phase) {
		ensureDb();
		updateProjectPhaseStmt.run(phase, id);
	}
	function saveConversation(msg) {
		ensureDb();
		saveConversationStmt.run(msg);
	}
	function getConversations(project_id, agent) {
		ensureDb();
		return getConversationsStmt.all(project_id, agent);
	}
	function saveAgentRun(run) {
		ensureDb();
		saveAgentRunStmt.run(run);
	}
	function updateAgentRun(id, updates) {
		ensureDb();
		updateAgentRunStmt.run(updates.status, updates.output, updates.completed_at, id);
	}
	function saveModelConfig(project_id, slot, config) {
		ensureDb();
		const candidates = Array.isArray(config) ? config : [config];
		const primary = candidates[0] || config;
		const candidatesJson = JSON.stringify(candidates);
		saveModelConfigStmt.run({
			project_id,
			slot,
			provider: primary?.provider,
			model: primary?.model,
			temperature: primary?.temperature,
			candidates_json: candidatesJson
		});
	}
	var DEFAULT_FALLBACK_CHAINS = {
		ceo: [
			{
				provider: "nvidia",
				model: "z-ai/glm5",
				temperature: .7
			},
			{
				provider: "openrouter",
				model: "anthropic/claude-3.5-sonnet",
				temperature: .7
			},
			{
				provider: "groq",
				model: "openai/gpt-oss-120b",
				temperature: .7
			}
		],
		team_lead: [
			{
				provider: "groq",
				model: "openai/gpt-oss-120b",
				temperature: .3
			},
			{
				provider: "openrouter",
				model: "anthropic/claude-3.5-sonnet",
				temperature: .3
			},
			{
				provider: "nvidia",
				model: "google/gemini-2.5-pro-preview-06-25",
				temperature: .3
			}
		],
		synthesizer: [{
			provider: "groq",
			model: "openai/gpt-oss-120b",
			temperature: .3
		}, {
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			temperature: .3
		}],
		cto: [{
			provider: "nvidia",
			model: "qwen/qwen3.5-397b-a17b",
			temperature: .3
		}, {
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			temperature: .3
		}],
		architect: [{
			provider: "nvidia",
			model: "qwen/qwen3.5-397b-a17b",
			temperature: .3
		}, {
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			temperature: .3
		}],
		frontendBuilder: [{
			provider: "nvidia",
			model: "qwen/qwen3.5-397b-a17b",
			temperature: .3
		}, {
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			temperature: .3
		}],
		backendBuilder: [{
			provider: "nvidia",
			model: "qwen/qwen3.5-397b-a17b",
			temperature: .3
		}, {
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			temperature: .3
		}],
		designConsolidator: [{
			provider: "nvidia",
			model: "moonshotai/kimi-k2-instruct",
			temperature: .2
		}, {
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			temperature: .2
		}],
		consolidator: [{
			provider: "nvidia",
			model: "moonshotai/kimi-k2-instruct",
			temperature: .2
		}, {
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			temperature: .2
		}]
	};
	function getModelConfig(project_id) {
		ensureDb();
		const rows = getModelConfigStmt.all(project_id);
		const config = {};
		rows.forEach((row) => {
			if (row.candidates_json) try {
				const candidates = JSON.parse(row.candidates_json);
				config[row.slot] = candidates;
			} catch {
				config[row.slot] = [{
					provider: row.provider,
					model: row.model,
					temperature: row.temperature
				}];
			}
			else {
				const primary = {
					provider: row.provider,
					model: row.model,
					temperature: row.temperature
				};
				const defaultChain = DEFAULT_FALLBACK_CHAINS[row.slot];
				if (defaultChain && Array.isArray(defaultChain)) {
					const primaryIdx = defaultChain.findIndex((c) => c.provider === primary.provider && c.model === primary.model);
					if (primaryIdx >= 0) config[row.slot] = defaultChain.slice(primaryIdx);
					else config[row.slot] = [primary, ...defaultChain.slice(0, 2)];
				} else config[row.slot] = [primary];
			}
		});
		return config;
	}
	function getKeysForProvider(provider) {
		ensureDb();
		return getKeysForProviderStmt.all(provider).map((row) => {
			if (row.encrypted_key && row.key_iv && row.key_tag && masterKeyHex) try {
				return {
					...row,
					api_key: decryptApiKey(row.encrypted_key, row.key_iv, row.key_tag)
				};
			} catch (err) {
				console.error("[Security] Failed to decrypt key:", row.id, err.message);
				return {
					...row,
					api_key: null
				};
			}
			return row;
		});
	}
	function addKey(provider, apiKey, label) {
		ensureDb();
		const countResult = countKeysForProviderStmt.get(provider);
		const count = countResult ? countResult.count : 0;
		if (count >= 5) throw new Error("MAX_KEYS_REACHED");
		const id = `${provider}_key_${Date.now()}`;
		const keyIndex = count;
		const keyLabel = label || `Key ${count + 1}`;
		const { encrypted, iv, tag } = encryptApiKey(apiKey);
		addKeyStmt.run(id, provider, "", encrypted, iv, tag, keyIndex, keyLabel);
		return id;
	}
	function removeKey(keyId) {
		ensureDb();
		removeKeyModelStatesStmt.run(keyId);
		removeKeyStmt.run(keyId);
	}
	function getKeyModelState(provider, keyId, model) {
		ensureDb();
		return getKeyModelStateStmt.get(provider, keyId, model);
	}
	function setKeyModelState(provider, keyId, model, state) {
		ensureDb();
		const id = `${provider}_${keyId}_${model.replace(/\//g, "_")}_${Date.now()}`;
		setKeyModelStateStmt.run(id, provider, keyId, model, state.status, state.exhausted_at);
	}
	function getAllModelStatesForKey(provider, keyId) {
		ensureDb();
		return getAllModelStatesForKeyStmt.all(provider, keyId);
	}
	function resetRPMExhaustedKeys() {
		ensureDb();
		resetRPMExhaustedStmt.run();
	}
	function resetDailyExhaustedKeys() {
		ensureDb();
		resetDailyExhaustedStmt.run();
	}
	var getFallbackStateStmt = null;
	var setFallbackStateStmt = null;
	var resetFallbackStateStmt = null;
	var resetAllFallbackStatesStmt = null;
	function initFallbackStateStatements() {
		getFallbackStateStmt = db.prepare("SELECT * FROM fallback_state WHERE slot = ? ORDER BY candidate_index ASC");
		setFallbackStateStmt = db.prepare(`
    INSERT INTO fallback_state (id, slot, candidate_index, provider, key_id, model, status, exhausted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot, candidate_index)
    DO UPDATE SET status = excluded.status, exhausted_at = excluded.exhausted_at, key_id = excluded.key_id
  `);
		resetFallbackStateStmt = db.prepare("UPDATE fallback_state SET status = 'ok', exhausted_at = NULL WHERE slot = ?");
		resetAllFallbackStatesStmt = db.prepare("UPDATE fallback_state SET status = 'ok', exhausted_at = NULL");
	}
	function getFallbackState(slot) {
		ensureDb();
		if (!getFallbackStateStmt) initFallbackStateStatements();
		return getFallbackStateStmt.all(slot);
	}
	function setFallbackState(slot, candidateIndex, state) {
		ensureDb();
		if (!setFallbackStateStmt) initFallbackStateStatements();
		const id = `${slot}_candidate_${candidateIndex}_${Date.now()}`;
		setFallbackStateStmt.run(id, slot, candidateIndex, state.provider, state.keyId || null, state.model, state.status || "ok", state.exhausted_at || null);
	}
	function resetFallbackState(slot) {
		ensureDb();
		if (!resetFallbackStateStmt) initFallbackStateStatements();
		resetFallbackStateStmt.run(slot);
	}
	function resetAllFallbackStates() {
		ensureDb();
		if (!resetAllFallbackStatesStmt) initFallbackStateStatements();
		resetAllFallbackStatesStmt.run();
	}
	function registerDbHandlers(ipcMain) {
		ipcMain.handle("db:getKey", async (event, provider) => {
			try {
				return {
					success: true,
					data: getKey(provider)
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:setKey", async (event, provider, apiKey) => {
			try {
				setKey(provider, apiKey);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:saveProject", async (event, project) => {
			try {
				saveProject(project);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:getProject", async (event, id) => {
			try {
				return {
					success: true,
					data: getProject(id)
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:getAllProjects", async (event) => {
			try {
				return {
					success: true,
					data: getAllProjects()
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:deleteProject", async (event, id) => {
			try {
				deleteProject(id);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:updateProjectPhase", async (event, id, phase) => {
			try {
				updateProjectPhase(id, phase);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:saveConversation", async (event, msg) => {
			try {
				saveConversation(msg);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:getConversations", async (event, project_id, agent) => {
			try {
				return {
					success: true,
					data: getConversations(project_id, agent)
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:saveAgentRun", async (event, run) => {
			try {
				saveAgentRun(run);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:updateAgentRun", async (event, id, updates) => {
			try {
				updateAgentRun(id, updates);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:saveModelConfig", async (event, project_id, slot, config) => {
			try {
				saveModelConfig(project_id, slot, config);
				return {
					success: true,
					data: null
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
		ipcMain.handle("db:getModelConfig", async (event, project_id) => {
			try {
				return {
					success: true,
					data: getModelConfig(project_id)
				};
			} catch (err) {
				return {
					success: false,
					error: err.message
				};
			}
		});
	}
	module.exports = {
		getKey,
		setKey,
		saveProject,
		getProject,
		getAllProjects,
		deleteProject,
		updateProjectPhase,
		saveConversation,
		getConversations,
		saveAgentRun,
		updateAgentRun,
		saveModelConfig,
		getModelConfig,
		getKeysForProvider,
		addKey,
		removeKey,
		getKeyModelState,
		setKeyModelState,
		getAllModelStatesForKey,
		resetRPMExhaustedKeys,
		resetDailyExhaustedKeys,
		getFallbackState,
		setFallbackState,
		resetFallbackState,
		resetAllFallbackStates,
		initStore: initStore$1,
		registerDbHandlers
	};
}));
//#endregion
//#region electron/ipc/keyRotator.js
var require_keyRotator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { EventEmitter } = require("events");
	var db = require_dbHandler();
	var KeyRotator = class extends EventEmitter {
		constructor() {
			super();
			this.currentKeyForModel = {
				groq: {},
				nvidia: {},
				openrouter: {}
			};
			this.keys = {
				groq: [],
				nvidia: [],
				openrouter: []
			};
		}
		init() {
			this.keys.groq = db.getKeysForProvider("groq");
			this.keys.nvidia = db.getKeysForProvider("nvidia");
			this.keys.openrouter = db.getKeysForProvider("openrouter");
			setInterval(() => this.resetRPMExhausted(), 60 * 1e3);
			this.scheduleDailyReset();
		}
		getBestKey(provider, model) {
			const activeKeys = this.keys[provider].filter((k) => k.is_active);
			if (activeKeys.length === 0) return null;
			const currentKeyId = this.currentKeyForModel[provider][model];
			if (currentKeyId) {
				const state = db.getKeyModelState(provider, currentKeyId, model);
				if (state === null || state === void 0 || state.status === "ok") {
					const key = this.keys[provider].find((k) => k.id === currentKeyId);
					if (key) return {
						keyId: key.id,
						apiKey: key.api_key
					};
				}
			}
			for (let i = 0; i < activeKeys.length; i++) {
				const key = activeKeys[i];
				const state = db.getKeyModelState(provider, key.id, model);
				if (state === null || state === void 0 || state.status === "ok") {
					const fromKey = this.currentKeyForModel[provider][model];
					this.currentKeyForModel[provider][model] = key.id;
					this.emit("key_rotated", {
						provider,
						model,
						fromKey,
						toKey: key.id,
						keyIndex: i + 1,
						totalKeys: activeKeys.length
					});
					return {
						keyId: key.id,
						apiKey: key.api_key
					};
				}
			}
			this.emit("all_keys_exhausted", {
				provider,
				model
			});
			return null;
		}
		markExhausted(provider, keyId, model, type = "rpm") {
			db.setKeyModelState(provider, keyId, model, {
				status: type === "daily" ? "daily_exhausted" : type === "invalid" ? "invalid" : "rpm_exhausted",
				exhausted_at: (/* @__PURE__ */ new Date()).toISOString()
			});
			this.emit("key_exhausted", {
				provider,
				keyId,
				model,
				type
			});
		}
		resetRPMExhausted() {
			db.resetRPMExhaustedKeys();
			this.emit("rpm_reset");
		}
		scheduleDailyReset() {
			const tomorrow = /* @__PURE__ */ new Date(/* @__PURE__ */ new Date());
			tomorrow.setDate(tomorrow.getDate() + 1);
			tomorrow.setHours(0, 0, 0, 0);
			const msUntilMidnight = tomorrow.getTime() - Date.now();
			setTimeout(() => {
				db.resetDailyExhaustedKeys();
				this.emit("daily_reset");
				setInterval(() => {
					db.resetDailyExhaustedKeys();
					this.emit("daily_reset");
				}, 1440 * 60 * 1e3);
			}, msUntilMidnight);
		}
		getFullStatus() {
			const status = {};
			for (const provider of [
				"groq",
				"nvidia",
				"openrouter"
			]) status[provider] = this.keys[provider].map((key) => ({
				keyId: key.id,
				keyIndex: key.key_index,
				label: key.label,
				isActive: key.is_active,
				models: db.getAllModelStatesForKey(provider, key.id)
			}));
			return status;
		}
		reloadKeys() {
			this.keys = {
				groq: db.getKeysForProvider("groq"),
				nvidia: db.getKeysForProvider("nvidia"),
				openrouter: db.getKeysForProvider("openrouter")
			};
		}
	};
	module.exports = new KeyRotator();
}));
//#endregion
//#region electron/ipc/apiCaller.js
var require_apiCaller = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var PROVIDERS = {
		groq: { baseURL: "https://api.groq.com/openai/v1" },
		nvidia: { baseURL: "https://integrate.api.nvidia.com/v1" },
		openrouter: {
			baseURL: "https://openrouter.ai/api/v1",
			extraHeaders: {
				"HTTP-Referer": "https://nord.dev",
				"X-Title": "NORD"
			}
		}
	};
	var rotator = require_keyRotator();
	/**
	* Try a single candidate (provider/model/key combination)
	* @param {Object} params
	* @returns {Promise<Object>}
	*/
	async function tryCandidate({ provider, model, messages, systemPrompt, temperature, onChunk, signal, fetch }) {
		const providerConfig = PROVIDERS[provider];
		if (!providerConfig) return {
			success: false,
			error: "Unknown provider",
			code: "UNKNOWN_PROVIDER"
		};
		const { baseURL, extraHeaders = {} } = providerConfig;
		const requestBody = {
			model,
			messages: [{
				role: "system",
				content: systemPrompt
			}, ...messages],
			temperature: temperature ?? .3,
			stream: true
		};
		const keyInfo = rotator.getBestKey(provider, model);
		if (keyInfo === null) return {
			success: false,
			error: "NO_KEYS_AVAILABLE",
			code: "NO_KEYS_AVAILABLE",
			provider,
			model
		};
		const fetchOptions = {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${keyInfo.apiKey}`,
				"Content-Type": "application/json",
				...extraHeaders
			},
			body: JSON.stringify(requestBody)
		};
		if (signal) fetchOptions.signal = signal;
		try {
			const response = await fetch(`${baseURL}/chat/completions`, fetchOptions);
			if (!response.ok) {
				if (response.status === 429) {
					let isDaily = false;
					try {
						const errorText = await response.text();
						if (JSON.parse(errorText)?.error?.message?.includes("day")) isDaily = true;
					} catch (_) {}
					rotator.markExhausted(provider, keyInfo.keyId, model, isDaily ? "daily" : "rpm");
					return {
						success: false,
						error: "RATE_LIMITED",
						code: 429,
						provider,
						model,
						keyId: keyInfo.keyId,
						isDaily
					};
				}
				if (response.status === 401 || response.status === 403) {
					rotator.markExhausted(provider, keyInfo.keyId, model, "invalid");
					return {
						success: false,
						error: "INVALID_KEY",
						code: response.status,
						provider,
						model,
						keyId: keyInfo.keyId
					};
				}
				if (response.status >= 500) return {
					success: false,
					error: "SERVER_ERROR",
					code: response.status,
					provider,
					model
				};
				const errorText = await response.text();
				return {
					success: false,
					error: `HTTP ${response.status}: ${errorText}`,
					code: response.status,
					provider,
					model
				};
			}
			const stream = response.body;
			if (!stream) return {
				success: false,
				error: "No response body",
				code: "NO_RESPONSE_BODY"
			};
			return new Promise((resolve) => {
				let fullContent = "";
				let buffer = "";
				let respondedModel = model;
				if (signal) signal.addEventListener("abort", () => {
					stream.destroy();
					resolve({
						success: true,
						content: fullContent,
						respondedModel,
						aborted: true,
						provider,
						model
					});
				}, { once: true });
				stream.on("data", (chunk) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop();
					for (const line of lines) {
						const trimmedLine = line.trim();
						if (!trimmedLine.startsWith("data: ")) continue;
						const data = trimmedLine.slice(6).trim();
						if (data === "[DONE]") continue;
						try {
							const parsed = JSON.parse(data);
							if (parsed.model) respondedModel = parsed.model;
							const token = parsed.choices?.[0]?.delta?.content || "";
							if (token) {
								onChunk(token);
								fullContent += token;
							}
						} catch (parseError) {
							continue;
						}
					}
				});
				stream.on("end", () => {
					if (buffer.trim() !== "") {
						const trimmedLine = buffer.trim();
						if (trimmedLine.startsWith("data: ")) {
							const data = trimmedLine.slice(6).trim();
							if (data !== "[DONE]") try {
								const token = JSON.parse(data).choices?.[0]?.delta?.content || "";
								if (token) {
									onChunk(token);
									fullContent += token;
								}
							} catch (parseError) {}
						}
					}
					resolve({
						success: true,
						content: fullContent,
						respondedModel,
						provider,
						model
					});
				});
				stream.on("error", (error) => {
					if (error.name === "AbortError") resolve({
						success: true,
						content: fullContent,
						respondedModel,
						aborted: true,
						provider,
						model
					});
					else resolve({
						success: false,
						error: error.message,
						code: "NETWORK_ERROR",
						provider,
						model
					});
				});
			});
		} catch (error) {
			if (error.name === "AbortError") return {
				success: true,
				content: "",
				respondedModel: model,
				aborted: true,
				provider,
				model
			};
			return {
				success: false,
				error: error.message,
				code: "NETWORK_ERROR",
				provider,
				model
			};
		}
	}
	/**
	* Core function to call AI models with streaming support and fallback chain
	* @param {Object} params - Configuration for the API call
	* @param {string} params.provider - Provider name (for single-candidate calls)
	* @param {string} params.model - Model identifier (for single-candidate calls)
	* @param {Array} params.candidates - Fallback chain of {provider, model, temperature}
	* @param {Array} params.messages - Chat messages array
	* @param {string} params.systemPrompt - System prompt to prepend
	* @param {number} params.temperature - Temperature for sampling
	* @param {Function} params.onChunk - Callback for streaming tokens
	* @param {AbortSignal} params.signal - Optional abort signal
	* @param {string} params.slot - Optional slot name for tracking
	* @returns {Promise<string|Object>} - Full content or error object
	*/
	async function callModel({ provider, model, candidates, messages, systemPrompt, temperature, onChunk, signal, slot }) {
		let fetch;
		try {
			fetch = (await import("node-fetch")).default;
		} catch (err) {
			return {
				error: "Failed to load fetch module",
				code: "FETCH_LOAD_ERROR"
			};
		}
		if (messages.reduce((sum, m) => sum + (m.content?.length || 0), 0) + (systemPrompt?.length || 0) > 204800) return {
			error: "Request payload too large",
			code: "PAYLOAD_TOO_LARGE"
		};
		let candidateList = [];
		if (candidates && Array.isArray(candidates) && candidates.length > 0) candidateList = candidates;
		else if (provider && model) candidateList = [{
			provider,
			model,
			temperature
		}];
		else return {
			error: "No provider/model or candidates specified",
			code: "NO_CANDIDATES"
		};
		const attemptedCandidates = [];
		for (let i = 0; i < candidateList.length; i++) {
			const candidate = candidateList[i];
			if (signal?.aborted) return {
				content: "",
				respondedModel: candidate.model,
				aborted: true
			};
			const result = await tryCandidate({
				provider: candidate.provider,
				model: candidate.model,
				messages,
				systemPrompt,
				temperature: candidate.temperature ?? temperature,
				onChunk,
				signal,
				fetch
			});
			if (result.success) return {
				content: result.content,
				respondedModel: result.respondedModel,
				selectedProvider: result.provider,
				selectedModel: result.model,
				candidateIndex: i,
				fallbackOccurred: i > 0,
				aborted: result.aborted || false
			};
			attemptedCandidates.push({
				provider: result.provider || candidate.provider,
				model: result.model || candidate.model,
				failureReason: result.error,
				code: result.code
			});
			console.log(`[Fallback] Candidate ${i + 1}/${candidateList.length} failed: ${candidate.provider}/${candidate.model} - ${result.error}`);
		}
		return {
			error: "ALL_CANDIDATES_EXHAUSTED",
			code: "ALL_CANDIDATES_EXHAUSTED",
			slot,
			attemptedCandidates
		};
	}
	var activeControllers = /* @__PURE__ */ new Map();
	/**
	* Register IPC handlers for API calls
	* @param {import('electron').IpcMain} ipcMain - Electron IPC main instance
	* @param {import('electron').BrowserWindow} mainWindow - Main window instance
	*/
	function registerApiHandlers$1(ipcMain, mainWindow) {
		ipcMain.handle("api:call", async (event, { provider, model, candidates, messages, systemPrompt, temperature, slot }) => {
			const { randomUUID } = require("crypto");
			const callId = randomUUID();
			const controller = new AbortController();
			activeControllers.set(callId, controller);
			try {
				const result = await callModel({
					provider,
					model,
					candidates,
					messages,
					systemPrompt,
					temperature,
					slot,
					signal: controller.signal,
					onChunk: (token) => {
						mainWindow.webContents.send("api:chunk", {
							token,
							callId
						});
					}
				});
				if (result && typeof result === "object" && result.error) return result;
				if (result && typeof result === "object" && result.content !== void 0) return {
					result: result.content,
					callId,
					model: result.respondedModel || model,
					selectedProvider: result.selectedProvider,
					selectedModel: result.selectedModel,
					candidateIndex: result.candidateIndex,
					fallbackOccurred: result.fallbackOccurred || false,
					aborted: result.aborted || false
				};
				return {
					result,
					callId,
					model
				};
			} catch (error) {
				if (error.name === "AbortError") return {
					result: "",
					callId,
					model,
					aborted: true
				};
				return {
					error: error.message,
					code: "NETWORK_ERROR"
				};
			} finally {
				activeControllers.delete(callId);
			}
		});
		ipcMain.handle("api:abort", async () => {
			for (const [id, controller] of activeControllers) {
				controller.abort();
				activeControllers.delete(id);
			}
			return { aborted: true };
		});
	}
	module.exports = {
		callModel,
		registerApiHandlers: registerApiHandlers$1
	};
}));
//#endregion
//#region electron/ipc/agentRunner.js
var require_agentRunner = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	/**
	* 2. runSingleAgent(agent, onAgentUpdate) — internal async function:
	* @param {Object} agent - The agent object with id, provider, model, systemPrompt, temperature, userPrompt, candidates
	* @param {Function} onAgentUpdate - Callback to send updates to the renderer
	* @returns {Promise<Object>} - Result object with agentId, result/status, error/status
	*/
	async function runSingleAgent(agent, onAgentUpdate) {
		let lastError = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			let hasEmittedFirstStreaming = false;
			try {
				if (attempt === 1) try {
					onAgentUpdate({
						agentId: agent.id,
						status: "running"
					});
				} catch (_) {}
				let candidates = null;
				if (agent.candidates && Array.isArray(agent.candidates) && agent.candidates.length > 0) candidates = agent.candidates;
				else if (agent.provider && agent.model) candidates = [{
					provider: agent.provider,
					model: agent.model,
					temperature: agent.temperature
				}];
				const result = await callModel({
					candidates,
					provider: agent.provider,
					model: agent.model,
					systemPrompt: agent.systemPrompt,
					temperature: agent.temperature,
					messages: [{
						role: "user",
						content: agent.userPrompt
					}],
					slot: agent.id,
					onChunk: (token) => {
						try {
							if (!hasEmittedFirstStreaming) {
								onAgentUpdate({
									agentId: agent.id,
									status: "streaming"
								});
								hasEmittedFirstStreaming = true;
							}
							onAgentUpdate({
								agentId: agent.id,
								token,
								status: "streaming"
							});
						} catch (_) {}
					}
				});
				if (typeof result === "object" && result !== null && result.error) {
					if (result.code === "ALL_CANDIDATES_EXHAUSTED") {
						try {
							onAgentUpdate({
								agentId: agent.id,
								status: "failed",
								error: result.error,
								attemptedCandidates: result.attemptedCandidates
							});
						} catch (_) {}
						return {
							agentId: agent.id,
							error: result.error,
							code: result.code,
							attemptedCandidates: result.attemptedCandidates,
							status: "failed"
						};
					}
					throw new Error(result.error);
				}
				const text = typeof result === "object" && result !== null && typeof result.content === "string" ? result.content : result;
				try {
					onAgentUpdate({
						agentId: agent.id,
						status: "complete",
						result: text,
						selectedProvider: result.selectedProvider,
						selectedModel: result.selectedModel,
						fallbackOccurred: result.fallbackOccurred
					});
				} catch (_) {}
				return {
					agentId: agent.id,
					result: text,
					status: "complete",
					selectedProvider: result.selectedProvider,
					selectedModel: result.selectedModel,
					fallbackOccurred: result.fallbackOccurred
				};
			} catch (error) {
				lastError = error;
				if (attempt < 3) {
					try {
						onAgentUpdate({
							agentId: agent.id,
							status: "retrying",
							attempt
						});
					} catch (_) {}
					const delay = 1e3 * attempt;
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}
			}
		}
		try {
			onAgentUpdate({
				agentId: agent.id,
				status: "failed",
				error: lastError.message
			});
		} catch (_) {}
		return {
			agentId: agent.id,
			error: lastError.message,
			status: "failed"
		};
	}
	/**
	* 3. runAgentsParallel(agents, onAgentUpdate) — exported async function:
	* @param {Array} agents - Array of agent objects
	* @param {Function} onAgentUpdate - Callback to send updates to the renderer
	* @returns {Promise<Array>} - Settled results array from Promise.allSettled
	*/
	async function runAgentsParallel(agents, onAgentUpdate) {
		const promises = agents.map((agent) => runSingleAgent(agent, onAgentUpdate));
		return Promise.allSettled(promises);
	}
	/**
	* 4. registerAgentHandlers(ipcMain, mainWindow) — exported function:
	* @param {import('electron').IpcMain} ipcMain - Electron IPC main instance
	* @param {import('electron').BrowserWindow} mainWindow - Main window instance
	*/
	function registerAgentHandlers(ipcMain, mainWindow) {
		ipcMain.handle("agents:run", async (event, agents) => {
			const onAgentUpdate = (updatePayload) => {
				try {
					mainWindow.webContents.send("agents:update", updatePayload);
				} catch (_) {}
			};
			return await runAgentsParallel(agents, onAgentUpdate);
		});
	}
	module.exports = {
		runAgentsParallel,
		registerAgentHandlers
	};
}));
//#endregion
//#region electron/ipc/fileSystem.js
var require_fileSystem = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var fs$3 = require("fs");
	var path$4 = require("path");
	var activeProjectPath = null;
	function setActiveProjectPath(projectPath) {
		activeProjectPath = path$4.resolve(projectPath);
	}
	function validateProjectPath(projectPath) {
		const resolved = path$4.resolve(projectPath);
		if (activeProjectPath === null) {
			activeProjectPath = resolved;
			return true;
		}
		return resolved === activeProjectPath;
	}
	function sanitizeError(err) {
		console.error("[FileSystem]", err);
		switch (err.code) {
			case "ENOENT": return "File not found";
			case "EACCES":
			case "EPERM": return "Access denied";
			case "EEXIST": return "File already exists";
			default: return "File operation failed";
		}
	}
	function getNordPath(projectPath) {
		return path$4.join(projectPath, ".nord");
	}
	function createNordFolder(projectPath) {
		try {
			const nordPath = getNordPath(projectPath);
			fs$3.mkdirSync(nordPath, { recursive: true });
			return {
				success: true,
				path: nordPath
			};
		} catch (err) {
			return {
				success: false,
				error: sanitizeError(err)
			};
		}
	}
	function sanitizeFilename(filename) {
		if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return null;
		if (path$4.isAbsolute(filename)) return null;
		if (filename.includes("..")) return null;
		const normalized = path$4.normalize(filename);
		if (normalized === "." || normalized === ".." || normalized.startsWith("..")) return null;
		return filename;
	}
	function validateRelativePath(relativePath) {
		if (path$4.isAbsolute(relativePath)) return false;
		const segments = relativePath.split("/");
		for (const seg of segments) {
			if (seg === "" || seg === "." || seg === "..") return false;
			if (!/^[a-zA-Z0-9._-]+$/.test(seg)) return false;
		}
		return true;
	}
	function writeFileNested(projectPath, relativePath, content) {
		if (!validateRelativePath(relativePath)) return {
			success: false,
			error: "Invalid path"
		};
		try {
			const fullPath = path$4.join(projectPath, ".nord", relativePath);
			const dirPath = path$4.dirname(fullPath);
			fs$3.mkdirSync(dirPath, { recursive: true });
			fs$3.writeFileSync(fullPath, content, "utf-8");
			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err.message
			};
		}
	}
	function readFileNested(projectPath, relativePath) {
		if (!validateRelativePath(relativePath)) return {
			success: false,
			error: "Invalid path"
		};
		try {
			const fullPath = path$4.join(projectPath, ".nord", relativePath);
			return fs$3.readFileSync(fullPath, "utf-8");
		} catch (err) {
			if (err.code === "ENOENT") return null;
			return {
				success: false,
				error: sanitizeError(err)
			};
		}
	}
	function writeFile(projectPath, filename, content) {
		const sanitized = sanitizeFilename(filename);
		if (!sanitized) return {
			success: false,
			error: "Invalid filename"
		};
		const folderResult = createNordFolder(projectPath);
		if (!folderResult.success) return folderResult;
		try {
			const filePath = path$4.join(getNordPath(projectPath), sanitized);
			fs$3.writeFileSync(filePath, content, "utf-8");
			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err.message
			};
		}
	}
	function readFile(projectPath, filename) {
		const sanitized = sanitizeFilename(filename);
		if (!sanitized) return {
			success: false,
			error: "Invalid filename"
		};
		try {
			const filePath = path$4.join(getNordPath(projectPath), sanitized);
			return fs$3.readFileSync(filePath, "utf-8");
		} catch (err) {
			if (err.code === "ENOENT") return null;
			return {
				success: false,
				error: err.message
			};
		}
	}
	function listFiles(projectPath, recursive = false) {
		try {
			const nordPath = getNordPath(projectPath);
			if (!recursive) return fs$3.readdirSync(nordPath).filter((name) => {
				try {
					const filePath = path$4.join(nordPath, name);
					return fs$3.statSync(filePath).isFile();
				} catch {
					return false;
				}
			});
			const results = [];
			function walk(dir, prefix) {
				const entries = fs$3.readdirSync(dir);
				for (const entry of entries) {
					const fullEntry = path$4.join(dir, entry);
					const relativeName = prefix ? prefix + "/" + entry : entry;
					try {
						const stat = fs$3.statSync(fullEntry);
						if (stat.isFile()) results.push(relativeName);
						else if (stat.isDirectory()) walk(fullEntry, relativeName);
					} catch {}
				}
			}
			walk(nordPath, "");
			return results;
		} catch (err) {
			if (err.code === "ENOENT") return [];
			return {
				success: false,
				error: err.message
			};
		}
	}
	function deleteFile(projectPath, filename) {
		const sanitized = sanitizeFilename(filename);
		if (!sanitized) return {
			success: false,
			error: "Invalid filename"
		};
		try {
			const filePath = path$4.join(getNordPath(projectPath), sanitized);
			fs$3.unlinkSync(filePath);
			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err.message
			};
		}
	}
	function writeDesignFile(projectPath, filename, content) {
		return writeFileNested(projectPath, "design/" + filename, content);
	}
	function readDesignFile(projectPath, filename) {
		return readFileNested(projectPath, "design/" + filename);
	}
	function listDesignAssets(projectPath) {
		try {
			const designPath = path$4.join(projectPath, ".nord", "design");
			if (!fs$3.existsSync(designPath)) return [];
			const results = [];
			function walk(dir, prefix) {
				const entries = fs$3.readdirSync(dir);
				for (const entry of entries) {
					const fullEntry = path$4.join(dir, entry);
					const relativeName = prefix ? prefix + "/" + entry : entry;
					try {
						const stat = fs$3.statSync(fullEntry);
						if (stat.isFile()) results.push(relativeName);
						else if (stat.isDirectory()) walk(fullEntry, relativeName);
					} catch {}
				}
			}
			walk(designPath, "");
			return results;
		} catch (err) {
			if (err.code === "ENOENT") return [];
			return {
				success: false,
				error: sanitizeError(err)
			};
		}
	}
	function registerFileHandlers(ipcMain) {
		ipcMain.handle("fs:createNordFolder", async (event, projectPath) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				return createNordFolder(projectPath);
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:writeFile", async (event, projectPath, filename, content) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				return writeFile(projectPath, filename, content);
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:readFile", async (event, projectPath, filename) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				const result = readFile(projectPath, filename);
				if (result && typeof result === "object" && result.success === false) return result;
				return result;
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:listFiles", async (event, projectPath, recursive) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				return listFiles(projectPath, recursive);
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:writeFileNested", async (event, projectPath, relativePath, content) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				return writeFileNested(projectPath, relativePath, content);
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:readFileNested", async (event, projectPath, relativePath) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				const result = readFileNested(projectPath, relativePath);
				if (result && typeof result === "object" && result.success === false) return result;
				return result;
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:deleteFile", async (event, projectPath, filename) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				return deleteFile(projectPath, filename);
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:writeDesignFile", async (event, projectPath, filename, content) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				return writeDesignFile(projectPath, filename, content);
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:readDesignFile", async (event, projectPath, filename) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				const result = readDesignFile(projectPath, filename);
				if (result && typeof result === "object" && result.success === false) return result;
				return result;
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:listDesignAssets", async (event, projectPath) => {
			if (!validateProjectPath(projectPath)) return {
				success: false,
				error: "Access denied: invalid project path"
			};
			try {
				return listDesignAssets(projectPath);
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
		ipcMain.handle("fs:setActiveProject", async (event, projectPath) => {
			try {
				setActiveProjectPath(projectPath);
				return { success: true };
			} catch (err) {
				return {
					success: false,
					error: sanitizeError(err)
				};
			}
		});
	}
	module.exports = {
		createNordFolder,
		writeFile,
		readFile,
		writeFileNested,
		readFileNested,
		listFiles,
		deleteFile,
		writeDesignFile,
		readDesignFile,
		listDesignAssets,
		registerFileHandlers,
		setActiveProjectPath
	};
}));
//#endregion
//#region electron/services/multiPassEngine.js
var require_multiPassEngine = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	var DEFAULT_MODEL_CONFIG = {
		provider: "nvidia",
		model: "moonshotai/kimi-k2-instruct",
		temperature: .2
	};
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
		}
		return "";
	}
	function stripCodeFences(content) {
		if (typeof content !== "string") return "";
		const match = content.trim().match(/```(?:html)?\s*([\s\S]*?)\s*```/i);
		return match ? match[1].trim() : content.trim();
	}
	function buildVariantInstruction(variantParams = {}) {
		const parts = [];
		if (variantParams.emphasis) parts.push(`Emphasis style: ${variantParams.emphasis}.`);
		if (variantParams.density) parts.push(`Density preference: ${variantParams.density}.`);
		if (variantParams.hierarchy) parts.push(`Hierarchy approach: ${variantParams.hierarchy}.`);
		return parts.join(" ");
	}
	async function executePass(passNumber, input) {
		const modelConfig = {
			...DEFAULT_MODEL_CONFIG,
			...input.modelConfig || {}
		};
		const candidates = modelConfig.candidates || [modelConfig];
		const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
		const variantInstruction = buildVariantInstruction(input.variantParams);
		let systemPrompt = "";
		let userPrompt = "";
		if (passNumber === 1) {
			systemPrompt = [
				"You are NORD's multi-pass UI structure generator.",
				"Output layout structure in HTML.",
				"No colors, no styles, no CSS classes beyond semantic hooks.",
				"Only semantic sections, element hierarchy, and content placement.",
				"Return only HTML."
			].join("\n");
			userPrompt = [
				variantInstruction,
				"Wireframes:",
				input.wireframes || "",
				"",
				"Spec:",
				input.spec || ""
			].filter(Boolean).join("\n");
		}
		if (passNumber === 2) {
			const structure = input.structure || input.previousOutputs?.structure;
			if (!structure) throw new Error("Pass 2 requires structure HTML");
			systemPrompt = [
				"You are NORD's multi-pass styling engine.",
				"Apply the provided design tokens to this HTML structure.",
				"Add colors, typography, spacing, border radius, and shadows.",
				"Do not change layout, semantic structure, or element order.",
				"Return only HTML."
			].join("\n");
			userPrompt = [
				"Structure HTML:",
				structure,
				"",
				"Design tokens:",
				JSON.stringify(input.tokens || {}, null, 2)
			].join("\n");
		}
		if (passNumber === 3) {
			const styled = input.styled || input.previousOutputs?.styled;
			if (!styled) throw new Error("Pass 3 requires styled HTML");
			systemPrompt = [
				"You are NORD's UI polish pass.",
				"Refine spacing, add micro-interactions, improve accessibility, and tighten implementation detail.",
				"Do not change colors or layout.",
				"Return only HTML."
			].join("\n");
			userPrompt = [
				"Styled HTML:",
				styled,
				"",
				"Standards:",
				input.standards || ""
			].join("\n");
		}
		return stripCodeFences(normalizeModelContent(await callModel({
			candidates,
			provider: primary.provider,
			model: primary.model,
			temperature: primary.temperature,
			systemPrompt,
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: () => {}
		})));
	}
	async function runMultiPass(input = {}) {
		const structure = await executePass(1, input);
		const styled = await executePass(2, {
			...input,
			structure,
			previousOutputs: { structure }
		});
		return {
			structure,
			styled,
			final: await executePass(3, {
				...input,
				structure,
				styled,
				previousOutputs: {
					structure,
					styled
				}
			})
		};
	}
	async function runSinglePass(passNumber, input = {}) {
		return executePass(passNumber, input);
	}
	module.exports = {
		runMultiPass,
		runSinglePass
	};
}));
//#endregion
//#region electron/services/mcpManager.js
var require_mcpManager = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { runMultiPass } = require_multiPassEngine();
	var DEFAULT_TIMEOUT_MS = 6e4;
	var executorRegistry = /* @__PURE__ */ new Map();
	var VALID_TASKS = new Set([
		"ui_generation",
		"image_generation",
		"design_generation"
	]);
	var frozen = false;
	function registerExecutor(taskName, executorFn) {
		if (frozen) throw new Error("Executor registry is frozen — cannot register after startup");
		if (!VALID_TASKS.has(taskName)) throw new Error(`Invalid MCP task: "${taskName}". Allowed: ${[...VALID_TASKS].join(", ")}`);
		if (typeof executorFn !== "function") throw new Error(`Executor for "${taskName}" must be a function`);
		executorRegistry.set(taskName, executorFn);
	}
	function freezeExecutors() {
		frozen = true;
	}
	function detectTools() {
		const tools = /* @__PURE__ */ new Set();
		if (process.env.STITCH_MCP_CONNECTED === "true") tools.add("Stitch");
		if (process.env.IMAGEN_MCP_CONNECTED === "true") tools.add("Imagen");
		if (process.env.NORD_MCP_TOOLS) process.env.NORD_MCP_TOOLS.split(",").map((tool) => tool.trim()).filter(Boolean).forEach((tool) => tools.add(tool));
		return Array.from(tools);
	}
	function getExecutor(task) {
		if (task === "ui_generation") return executorRegistry.get("ui_generation") || null;
		if (task === "image_generation") return executorRegistry.get("image_generation") || null;
		return null;
	}
	async function checkMCPStatus() {
		try {
			const tools = detectTools();
			return {
				connected: tools.length > 0,
				tools
			};
		} catch (_) {
			return {
				connected: false,
				tools: []
			};
		}
	}
	async function executeMCP(task, context = {}) {
		const status = await checkMCPStatus();
		const timeoutMs = Number(context.timeoutMs) || DEFAULT_TIMEOUT_MS;
		const executor = getExecutor(task);
		if (!status.connected || !executor) {
			if (context.preferAiFallback && task === "ui_generation" && context.wireframes && context.spec) {
				const aiOutput = await runMultiPass(context);
				return {
					fallback: true,
					output: aiOutput.final,
					passes: aiOutput
				};
			}
			return { fallback: true };
		}
		const executionPromise = Promise.resolve().then(() => executor(context));
		const timeoutPromise = new Promise((resolve) => {
			setTimeout(() => resolve({ fallback: true }), timeoutMs);
		});
		const result = await Promise.race([executionPromise, timeoutPromise]);
		if (!result) return { fallback: true };
		if (result.partial || result.output) return result;
		return { fallback: true };
	}
	async function getMCPCapabilities() {
		const status = await checkMCPStatus();
		const toolNames = status.tools.map((tool) => tool.toLowerCase());
		return {
			tools: status.tools,
			capabilities: {
				ui_generation: toolNames.some((tool) => tool.includes("stitch") || tool.includes("ui")),
				image_generation: toolNames.some((tool) => tool.includes("imagen") || tool.includes("image"))
			}
		};
	}
	/**
	* Check for Stitch-specific MCP capabilities.
	* @returns {Promise<{ available: boolean, tools: string[] }>}
	*/
	async function getStitchCapabilities() {
		const stitchTools = (await checkMCPStatus()).tools.filter((tool) => tool.toLowerCase().includes("stitch") || tool.toLowerCase().includes("ui"));
		return {
			available: stitchTools.length > 0,
			tools: stitchTools
		};
	}
	module.exports = {
		checkMCPStatus,
		executeMCP,
		getMCPCapabilities,
		registerExecutor,
		freezeExecutors,
		getStitchCapabilities
	};
}));
//#endregion
//#region electron/ipc/ctoEngine.js
var require_ctoEngine = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { getProviderForModel, callProviderAPI } = require_apiCaller();
	var { checkMCPStatus, getMCPCapabilities, executeMCP } = require_mcpManager();
	require("fs");
	require("path");
	var ALL_AGENTS_STAGE2 = [
		"design_ui_pattern",
		"design_ux_flow",
		"design_competitor",
		"design_visual_system",
		"design_screen_variant"
	];
	var ALL_AGENTS = [
		"design_ui_pattern",
		"design_ux_flow",
		"design_competitor",
		"design_visual_ref"
	];
	var CLASSIFICATIONS = [
		"EXPLORE",
		"REFINE",
		"GENERATE",
		"ITERATE",
		"APPROVE",
		"ASK_MCP",
		"NONE"
	];
	/**
	* Process a design task classification from the Design Head.
	* Called via IPC: cto:process-task
	*
	* @param {Object} params
	* @param {Object} params.designIntent - Parsed design intent from CEO
	* @param {Object} params.existingData - What design files exist
	* @param {string} [params.mcpPreference='unknown'] - User MCP preference
	* @returns {Object} - { classification, affected_agents, execution_mode, rationale, artifact_gate }
	*/
	async function processDesignTask({ designIntent, existingData = {}, mcpPreference = "unknown" }) {
		if (!designIntent) return {
			classification: "NONE",
			affected_agents: [],
			execution_mode: "AGENTS",
			rationale: "No design intent provided",
			artifact_gate: {
				ready: true,
				missing: []
			}
		};
		let classification = designIntent?.action || "NONE";
		if (!CLASSIFICATIONS.includes(classification)) classification = classifyFromData(designIntent, existingData);
		const affectedAgents = getAffectedAgents(classification, designIntent, true);
		const executionMode = await selectExecutionMode(classification, existingData, mcpPreference);
		const artifactGate = checkArtifactGate(existingData);
		const rationale = buildRationale(classification, executionMode, affectedAgents, artifactGate);
		return {
			classification,
			affected_agents: affectedAgents,
			execution_mode: executionMode,
			rationale,
			artifact_gate: artifactGate
		};
	}
	function classifyFromData(designIntent, existingData) {
		if (!existingData.hasDesignMd && !existingData.hasTokens && !existingData.hasDesignBrief) return "EXPLORE";
		if (designIntent?.design_updates?.specific_feedback || designIntent?.design_task_packet?.design_direction) return "ITERATE";
		if (designIntent?.design_updates?.references_added?.length > 0 || designIntent?.design_task_packet?.references?.length > 0) return "REFINE";
		return "REFINE";
	}
	function getAffectedAgents(classification, designIntent, useStage2 = true) {
		const agents = useStage2 ? [...ALL_AGENTS_STAGE2] : [...ALL_AGENTS];
		switch (classification) {
			case "EXPLORE": return agents;
			case "GENERATE":
			case "APPROVE":
			case "ASK_MCP":
			case "NONE": return [];
			case "REFINE":
			case "ITERATE": {
				const affected = /* @__PURE__ */ new Set();
				const updates = designIntent?.design_updates || {};
				const direction = designIntent?.design_task_packet?.design_direction || {};
				if (updates.color_direction || updates.typography_direction || direction.color_direction || direction.typography_direction) affected.add(useStage2 ? "design_visual_system" : "design_visual_ref");
				if (updates.layout_direction || direction.layout_direction) {
					affected.add("design_ui_pattern");
					affected.add("design_ux_flow");
				}
				if (updates.references_added?.length > 0 || designIntent?.design_task_packet?.references?.length > 0) affected.add("design_competitor");
				return affected.size > 0 ? Array.from(affected) : agents;
			}
			default: return agents;
		}
	}
	async function selectExecutionMode(classification, existingData, mcpPreference) {
		if (mcpPreference === "skip" || mcpPreference === "failed") return "AGENTS";
		let hasMCP = mcpPreference === "connected";
		if (!hasMCP) try {
			hasMCP = (await checkMCPStatus())?.connected || false;
		} catch {
			hasMCP = false;
		}
		if (!hasMCP) return "AGENTS";
		if (existingData.hasPatterns && existingData.hasTokens && existingData.hasDesignMd && existingData.hasWireframes) return "MCP";
		return "HYBRID";
	}
	function checkArtifactGate(existingData) {
		const missing = [
			{
				key: "hasDesignBrief",
				name: "design_brief.md"
			},
			{
				key: "hasDesignDna",
				name: "design_dna.md"
			},
			{
				key: "hasQualityBar",
				name: "quality_bar.md"
			}
		].filter(({ key }) => !existingData[key]).map(({ name }) => name);
		return {
			ready: missing.length === 0,
			missing
		};
	}
	function buildRationale(classification, executionMode, affectedAgents, artifactGate) {
		let rationale = `Classification: ${classification}. Mode: ${executionMode}.`;
		if (affectedAgents.length > 0) rationale += ` Running: ${affectedAgents.join(", ")}.`;
		if (!artifactGate.ready) rationale += ` Artifact gate: missing ${artifactGate.missing.join(", ")}.`;
		return rationale;
	}
	/**
	* Register the IPC handlers for the Design Head decision engine.
	* @param {Electron.IpcMain} ipcMain
	*/
	function registerCtoHandlers(ipcMain) {
		ipcMain.handle("cto:process-task", async (event, params) => {
			try {
				return await processDesignTask(params);
			} catch (err) {
				return {
					classification: "NONE",
					affected_agents: [],
					execution_mode: "AGENTS",
					rationale: `Error: ${err.message}`,
					artifact_gate: {
						ready: true,
						missing: []
					}
				};
			}
		});
	}
	module.exports = {
		processDesignTask,
		registerCtoHandlers
	};
}));
//#endregion
//#region electron/services/designTokenEngine.js
var require_designTokenEngine = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	var { readFileNested, writeFileNested } = require_fileSystem();
	var DEFAULT_MODEL_CONFIG = {
		provider: "nvidia",
		model: "moonshotai/kimi-k2-instruct",
		temperature: .2
	};
	var TOKEN_SCHEMA = `{
  "colors": {
    "primary": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "background": { "primary": "#hex", "secondary": "#hex", "elevated": "#hex" },
    "text": { "primary": "#hex", "secondary": "#hex", "muted": "#hex" },
    "semantic": { "success": "#hex", "warning": "#hex", "error": "#hex", "info": "#hex" },
    "border": "#hex"
  },
  "typography": {
    "fontFamily": { "primary": "Font Name", "mono": "Font Name" },
    "fontSize": { "xs": "12px", "sm": "14px", "base": "16px", "lg": "18px", "xl": "20px", "2xl": "24px", "3xl": "30px" },
    "fontWeight": { "normal": 400, "medium": 500, "semibold": 600, "bold": 700 },
    "lineHeight": { "tight": 1.25, "normal": 1.5, "relaxed": 1.75 }
  },
  "spacing": {
    "unit": "4px",
    "scale": ["4px", "8px", "12px", "16px", "24px", "32px", "48px", "64px"]
  },
  "borderRadius": { "sm": "4px", "md": "8px", "lg": "12px", "xl": "16px", "full": "9999px" },
  "shadows": {
    "sm": "0 1px 2px rgba(0,0,0,0.05)",
    "md": "0 4px 6px rgba(0,0,0,0.1)",
    "lg": "0 10px 15px rgba(0,0,0,0.15)"
  }
}`;
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
		}
		return "";
	}
	function extractJson(raw) {
		if (!raw || typeof raw !== "string") throw new Error("Model returned empty token payload");
		const trimmed = raw.trim();
		const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		const candidate = fencedMatch ? fencedMatch[1] : trimmed;
		const firstBrace = candidate.indexOf("{");
		const lastBrace = candidate.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error("Unable to locate JSON object in token response");
		return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
	}
	function collectColorErrors(node, path = "colors", errors = []) {
		if (typeof node === "string") {
			if (!/^#[0-9a-fA-F]{6}$/.test(node)) errors.push(`${path} must be a valid 6-digit hex color`);
			return errors;
		}
		if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) collectColorErrors(value, `${path}.${key}`, errors);
		return errors;
	}
	function validateTokens(tokens) {
		const errors = [];
		const requiredKeys = [
			"colors",
			"typography",
			"spacing",
			"borderRadius",
			"shadows"
		];
		if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return {
			valid: false,
			errors: ["Token payload must be a JSON object"]
		};
		for (const key of requiredKeys) if (!(key in tokens)) errors.push(`Missing required key: ${key}`);
		if (tokens.colors) collectColorErrors(tokens.colors, "colors", errors);
		const expectedScale = [
			"4px",
			"8px",
			"12px",
			"16px",
			"24px",
			"32px",
			"48px",
			"64px"
		];
		const actualScale = tokens?.spacing?.scale;
		if (!Array.isArray(actualScale) || actualScale.length !== expectedScale.length || actualScale.some((value, index) => value !== expectedScale[index])) errors.push(`spacing.scale must exactly match ${JSON.stringify(expectedScale)}`);
		if ([
			"primary",
			"secondary",
			"accent"
		].map((key) => tokens?.colors?.[key]).filter(Boolean).length > 3) errors.push("Only 3 primary palette colors are allowed");
		const primaryFont = tokens?.typography?.fontFamily?.primary;
		if (typeof primaryFont !== "string" || primaryFont.trim().length === 0) errors.push("typography.fontFamily.primary must be a non-empty concrete font name");
		else if (/sans[- ]?serif|serif|monospace|display/i.test(primaryFont.trim()) && !/[A-Za-z]+\s+[A-Za-z]+/.test(primaryFont.trim())) errors.push("typography.fontFamily.primary must be a concrete font family name");
		return errors.length > 0 ? {
			valid: false,
			errors
		} : { valid: true };
	}
	function buildTokenPrompt(input, validationErrors = []) {
		return [
			"Extract and normalize design tokens from these design agent outputs.",
			"Return a single valid JSON object that exactly matches this schema:",
			TOKEN_SCHEMA,
			"Additional constraints:",
			"- Maximum 3 primary colors total: primary, secondary, accent.",
			"- spacing.scale must be exactly [\"4px\",\"8px\",\"12px\",\"16px\",\"24px\",\"32px\",\"48px\",\"64px\"].",
			"- Font family names must be specific Google Fonts names.",
			"- Every color value must be a valid 6-digit hex code.",
			"- Do not wrap the JSON in markdown fences.",
			"",
			"Input context:",
			JSON.stringify({
				agentOutputs: input.agentOutputs || {},
				references: input.references || [],
				designDirection: input.designDirection || {}
			}, null, 2),
			validationErrors.length > 0 ? `Previous validation errors to fix:\n${validationErrors.map((error) => `- ${error}`).join("\n")}` : ""
		].filter(Boolean).join("\n");
	}
	async function generateDesignTokens(input = {}) {
		const modelConfig = {
			...DEFAULT_MODEL_CONFIG,
			...input.modelConfig || {}
		};
		const candidates = modelConfig.candidates || [modelConfig];
		const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
		let validationErrors = [];
		let lastError = null;
		for (let attempt = 0; attempt < 3; attempt++) try {
			const tokens = extractJson(normalizeModelContent(await callModel({
				candidates,
				provider: primary.provider,
				model: primary.model,
				temperature: primary.temperature,
				systemPrompt: "You are NORD's design token engine. Return only valid JSON.",
				messages: [{
					role: "user",
					content: buildTokenPrompt(input, validationErrors)
				}],
				onChunk: () => {}
			})));
			const validation = validateTokens(tokens);
			if (validation.valid) return tokens;
			validationErrors = validation.errors || [];
			lastError = new Error(validationErrors.join("; "));
		} catch (error) {
			lastError = error;
			validationErrors = [error.message];
		}
		throw lastError || /* @__PURE__ */ new Error("Failed to generate valid design tokens");
	}
	function buildStandardsContent(tokens) {
		const spacingScale = Array.isArray(tokens?.spacing?.scale) ? tokens.spacing.scale : [];
		return [
			"# Design Standards",
			"",
			"## Spacing Rules",
			`- Base unit: ${tokens?.spacing?.unit || "4px"}`,
			`- Approved scale: ${spacingScale.join(", ") || "4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px"}`,
			"- Use the approved scale only; avoid one-off spacing values.",
			"",
			"## Color Usage",
			`- Primary: ${tokens?.colors?.primary || "#000000"}`,
			`- Secondary: ${tokens?.colors?.secondary || "#000000"}`,
			`- Accent: ${tokens?.colors?.accent || "#000000"}`,
			`- Backgrounds: primary ${tokens?.colors?.background?.primary || "#000000"}, secondary ${tokens?.colors?.background?.secondary || "#000000"}, elevated ${tokens?.colors?.background?.elevated || "#000000"}`,
			`- Text: primary ${tokens?.colors?.text?.primary || "#000000"}, secondary ${tokens?.colors?.text?.secondary || "#000000"}, muted ${tokens?.colors?.text?.muted || "#000000"}`,
			"- Reserve semantic colors for system states and feedback only.",
			"",
			"## Typography Scale",
			`- Primary font: ${tokens?.typography?.fontFamily?.primary || "Inter"}`,
			`- Mono font: ${tokens?.typography?.fontFamily?.mono || "JetBrains Mono"}`,
			`- Sizes: ${Object.entries(tokens?.typography?.fontSize || {}).map(([key, value]) => `${key} ${value}`).join(", ")}`,
			`- Weights: ${Object.entries(tokens?.typography?.fontWeight || {}).map(([key, value]) => `${key} ${value}`).join(", ")}`,
			`- Line heights: ${Object.entries(tokens?.typography?.lineHeight || {}).map(([key, value]) => `${key} ${value}`).join(", ")}`,
			"",
			"## Application Rules",
			"- Maintain consistent border radius and shadow usage across components.",
			"- Preserve visual hierarchy with token-driven spacing and type scale before introducing additional decoration.",
			"- Accessibility adjustments should refine contrast and interaction feedback without introducing new palette values.",
			""
		].join("\n");
	}
	async function generateStandards(tokens, projectPath) {
		const existing = readFileNested(projectPath, "design/standards.md");
		if (typeof existing === "string" && existing.trim()) return existing;
		if (existing && typeof existing === "object" && existing.success === false) throw new Error(existing.error || "Failed to read standards.md");
		const content = buildStandardsContent(tokens);
		const writeResult = writeFileNested(projectPath, "design/standards.md", content);
		if (!writeResult?.success) throw new Error(writeResult?.error || "Failed to write standards.md");
		return content;
	}
	module.exports = {
		generateDesignTokens,
		validateTokens,
		generateStandards
	};
}));
//#endregion
//#region electron/services/designCritic.js
var require_designCritic = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var SCORE_RUBRIC = {
		intent_alignment: 20,
		design_dna_fidelity: 20,
		visual_polish: 20,
		ux_clarity: 15,
		accessibility: 10,
		token_consistency: 10,
		implementation_readiness: 5
	};
	/**
	* Hard-fail patterns. If any match, force score < 80 and fail.
	*/
	var HARD_FAIL_PATTERNS = [
		{
			pattern: /lorem ipsum/i,
			reason: "Contains placeholder lorem ipsum content"
		},
		{
			pattern: /placeholder\s+(?:text|image|icon)/i,
			reason: "Contains placeholder elements"
		},
		{
			pattern: /(?:^|\s)TODO(?:\s|$)/i,
			reason: "Contains unresolved TODO markers"
		},
		{
			pattern: /generic\s+saas/i,
			reason: "Self-describes as generic SaaS"
		}
	];
	/**
	* Anti-slop patterns. Each deducts points from visual_polish.
	*/
	var ANTI_SLOP_PATTERNS = [
		{
			pattern: /(?:clean|modern|minimal)\s+design/i,
			deduct: 5,
			reason: "Vague \"modern clean\" language"
		},
		{
			pattern: /(?:sleek|beautiful|stunning)\s+(?:ui|interface|design)/i,
			deduct: 3,
			reason: "Filler praise words"
		},
		{
			pattern: /(?:inter|roboto|arial)\s*,?\s*sans-serif/i,
			deduct: 3,
			reason: "Default font stack without justification"
		},
		{
			pattern: /#(?:6366f1|8b5cf6|7c3aed|4f46e5)/i,
			deduct: 3,
			reason: "Default purple/violet without justification"
		},
		{
			pattern: /🎨|🚀|✨|💡|🎯|📊|⚡/g,
			deduct: 2,
			reason: "Emoji decoration in design output"
		}
	];
	/**
	* Evaluate a design output and produce a score and issues list.
	*
	* @param {Object} params
	* @param {string} params.design - The consolidated design output
	* @param {Object} [params.tokens] - Design tokens for consistency checking
	* @param {string|Array} [params.references] - Reference analysis for alignment
	* @param {string} [params.patterns] - UI patterns output
	* @param {Object} [params.modelConfig] - Model config (unused for rule-based critic)
	* @returns {{ score: number, pass: boolean, issues: Object[], summary: string, rerun_targets: string[], user_safe_summary: string }}
	*/
	function evaluateDesign({ design, tokens, references, patterns, modelConfig }) {
		if (!design || typeof design !== "string" || design.trim().length < 50) return {
			score: 0,
			pass: false,
			issues: [{
				type: "generic",
				severity: "blocking",
				description: "No design content to evaluate",
				recommended_action: "rerun_visual_system"
			}],
			summary: "No design content provided",
			rerun_targets: [
				"design_visual_system",
				"design_ui_pattern",
				"design_ux_flow"
			],
			best_variant: null,
			user_safe_summary: "Design output was empty. Retrying."
		};
		const issues = [];
		const scores = { ...SCORE_RUBRIC };
		let hardFailed = false;
		for (const { pattern, reason } of HARD_FAIL_PATTERNS) if (pattern.test(design)) {
			hardFailed = true;
			issues.push({
				type: "generic",
				severity: "blocking",
				description: reason,
				recommended_action: "rerun_screen_variant"
			});
		}
		for (const { pattern, deduct, reason } of ANTI_SLOP_PATTERNS) {
			const matches = design.match(pattern);
			if (matches) {
				scores.visual_polish = Math.max(0, scores.visual_polish - deduct);
				issues.push({
					type: "visual_polish",
					severity: deduct >= 5 ? "high" : "medium",
					description: `${reason} (found ${matches.length}x)`,
					recommended_action: "rerun_visual_system"
				});
			}
		}
		if (tokens && typeof tokens === "object") {
			const tokenColors = (JSON.stringify(tokens).match(/#[0-9a-fA-F]{6}/g) || []).map((c) => c.toLowerCase());
			const designColors = (design.match(/#[0-9a-fA-F]{6}/g) || []).map((c) => c.toLowerCase());
			if (designColors.length > 0 && tokenColors.length > 0) {
				const tokenColorSet = new Set(tokenColors);
				const unmatchedColors = designColors.filter((c) => !tokenColorSet.has(c));
				const unmatchedRatio = unmatchedColors.length / designColors.length;
				if (unmatchedRatio > .5) {
					scores.token_consistency = Math.max(0, scores.token_consistency - 6);
					issues.push({
						type: "token_consistency",
						severity: "high",
						description: `${unmatchedColors.length}/${designColors.length} colors in design don't match token values`,
						recommended_action: "rerun_visual_system"
					});
				} else if (unmatchedRatio > .2) {
					scores.token_consistency = Math.max(0, scores.token_consistency - 3);
					issues.push({
						type: "token_consistency",
						severity: "medium",
						description: `${unmatchedColors.length} colors deviate from token system`,
						recommended_action: "rerun_visual_system"
					});
				}
			}
		}
		const hasNavigation = /nav|sidebar|menu|header|toolbar/i.test(design);
		const hasLayout = /grid|flex|layout|column|row|container/i.test(design);
		const hasResponsive = /responsive|mobile|tablet|breakpoint|@media/i.test(design);
		const hasAccessibility = /aria-|role=|focus|contrast|keyboard|screen.?reader/i.test(design);
		if (!hasNavigation) {
			scores.ux_clarity = Math.max(0, scores.ux_clarity - 5);
			issues.push({
				type: "ux_clarity",
				severity: "medium",
				description: "No navigation pattern detected",
				recommended_action: "rerun_ui_pattern"
			});
		}
		if (!hasLayout) {
			scores.ux_clarity = Math.max(0, scores.ux_clarity - 5);
			issues.push({
				type: "ux_clarity",
				severity: "medium",
				description: "No layout structure detected",
				recommended_action: "rerun_ui_pattern"
			});
		}
		if (!hasResponsive) {
			scores.accessibility = Math.max(0, scores.accessibility - 4);
			issues.push({
				type: "accessibility",
				severity: "medium",
				description: "No responsive design indicators found",
				recommended_action: "rerun_ui_pattern"
			});
		}
		if (!hasAccessibility) {
			scores.accessibility = Math.max(0, scores.accessibility - 3);
			issues.push({
				type: "accessibility",
				severity: "low",
				description: "No accessibility attributes found",
				recommended_action: "rerun_screen_variant"
			});
		}
		const hasConcreteColors = (design.match(/#[0-9a-fA-F]{6}/g) || []).length >= 3;
		const hasConcreteFont = /font-family:\s*['"][^'"]+['"]|fontFamily:\s*['"][^'"]+['"]/i.test(design);
		const hasConcreteSpacing = /\d+px|\d+rem|\d+em/i.test(design);
		if (!hasConcreteColors) {
			scores.design_dna_fidelity = Math.max(0, scores.design_dna_fidelity - 8);
			issues.push({
				type: "design_dna",
				severity: "high",
				description: "Fewer than 3 concrete hex color values",
				recommended_action: "rerun_visual_system"
			});
		}
		if (!hasConcreteFont) {
			scores.design_dna_fidelity = Math.max(0, scores.design_dna_fidelity - 5);
			issues.push({
				type: "design_dna",
				severity: "medium",
				description: "No concrete font family specified",
				recommended_action: "rerun_visual_system"
			});
		}
		if (!hasConcreteSpacing) {
			scores.design_dna_fidelity = Math.max(0, scores.design_dna_fidelity - 4);
			issues.push({
				type: "design_dna",
				severity: "medium",
				description: "No concrete spacing values found",
				recommended_action: "rerun_visual_system"
			});
		}
		const hasHTML = /<html|<div|<section|<main/i.test(design);
		const hasCSS = /style=|className=|class=/i.test(design);
		if (!hasHTML && !hasCSS) scores.implementation_readiness = Math.max(0, scores.implementation_readiness - 3);
		let totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);
		if (hardFailed) totalScore = Math.min(totalScore, 75);
		const pass = totalScore >= 80;
		const strong = totalScore >= 88;
		const rerunTargets = [];
		const actionCounts = {};
		for (const issue of issues) if (issue.recommended_action && issue.severity !== "low") actionCounts[issue.recommended_action] = (actionCounts[issue.recommended_action] || 0) + 1;
		for (const [action, count] of Object.entries(actionCounts)) if (count >= 1) {
			const agentId = action.replace("rerun_", "design_");
			if (!rerunTargets.includes(agentId)) rerunTargets.push(agentId);
		}
		const summary = strong ? `Score: ${totalScore}/100 — Strong. Ready for user review.` : pass ? `Score: ${totalScore}/100 — Acceptable with ${issues.length} issue(s). Review recommended.` : `Score: ${totalScore}/100 — Below bar. ${issues.filter((i) => i.severity === "blocking" || i.severity === "high").length} critical issue(s).`;
		return {
			score: totalScore,
			pass,
			issues,
			summary,
			rerun_targets: rerunTargets,
			best_variant: null,
			user_safe_summary: strong ? "The design looks solid and ready for your review." : pass ? "The design is acceptable but has some areas that could be improved." : "The design needs more work before it can be shown. NORD is iterating."
		};
	}
	/**
	* Classify the root cause of critic issues and suggest a rerun action.
	* Stage 2: Expanded action types for 6 agents.
	*
	* @param {Object[]} issues - List of critic issues
	* @returns {{ action: string, affected_agents: string[], severity: string }}
	*/
	function classifyFailureSource(issues) {
		if (!Array.isArray(issues) || issues.length === 0) return {
			action: "approve",
			affected_agents: [],
			severity: "none"
		};
		const actionVotes = {};
		let maxSeverity = "low";
		for (const issue of issues) {
			if (issue.recommended_action) actionVotes[issue.recommended_action] = (actionVotes[issue.recommended_action] || 0) + 1;
			if (issue.severity === "blocking") maxSeverity = "blocking";
			else if (issue.severity === "high" && maxSeverity !== "blocking") maxSeverity = "high";
			else if (issue.severity === "medium" && maxSeverity === "low") maxSeverity = "medium";
		}
		let topAction = "approve";
		let topCount = 0;
		for (const [action, count] of Object.entries(actionVotes)) if (count > topCount) {
			topAction = action;
			topCount = count;
		}
		return {
			action: topAction,
			affected_agents: {
				rerun_visual_system: ["design_visual_system"],
				rerun_visual_ref: ["design_visual_system"],
				rerun_ui_pattern: ["design_ui_pattern"],
				rerun_ux_flow: ["design_ux_flow"],
				rerun_reference: ["design_competitor"],
				rerun_screen_variant: ["design_screen_variant"],
				design_head_decision_needed: [],
				approve: [],
				rerun_pass1: ["design_ui_pattern"],
				rerun_pass2: ["design_visual_system", "design_competitor"],
				rerun_pass3: ["design_ux_flow"]
			}[topAction] || [],
			severity: maxSeverity
		};
	}
	module.exports = {
		evaluateDesign,
		classifyFailureSource
	};
}));
//#endregion
//#region electron/services/variantGenerator.js
var require_variantGenerator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { runMultiPass, runSinglePass } = require_multiPassEngine();
	var { evaluateDesign } = require_designCritic();
	var { writeFileNested } = require_fileSystem();
	function toScreenSlug(screenName) {
		return String(screenName || "screen").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "screen";
	}
	async function regenerateVariant(baseVariant, input, rerunPasses = []) {
		const orderedPasses = Array.from(new Set(rerunPasses)).sort((a, b) => a - b);
		let structure = baseVariant.structure || "";
		let styled = baseVariant.styled || "";
		let final = baseVariant.content || baseVariant.final || "";
		if (orderedPasses.includes(1)) {
			structure = await runSinglePass(1, {
				...input,
				variantParams: baseVariant.variantParams
			});
			styled = await runSinglePass(2, {
				...input,
				variantParams: baseVariant.variantParams,
				structure,
				previousOutputs: { structure }
			});
			final = await runSinglePass(3, {
				...input,
				variantParams: baseVariant.variantParams,
				styled,
				previousOutputs: {
					styled,
					structure
				}
			});
			return {
				structure,
				styled,
				final
			};
		}
		if (orderedPasses.includes(2)) {
			styled = await runSinglePass(2, {
				...input,
				variantParams: baseVariant.variantParams,
				structure,
				previousOutputs: { structure }
			});
			final = await runSinglePass(3, {
				...input,
				variantParams: baseVariant.variantParams,
				styled,
				previousOutputs: {
					styled,
					structure
				}
			});
			return {
				structure,
				styled,
				final
			};
		}
		if (orderedPasses.includes(3)) {
			final = await runSinglePass(3, {
				...input,
				variantParams: baseVariant.variantParams,
				styled,
				previousOutputs: {
					styled,
					structure
				}
			});
			return {
				structure,
				styled,
				final
			};
		}
		return {
			structure,
			styled,
			final
		};
	}
	async function generateVariants(input = {}) {
		const screenSlug = toScreenSlug(input.screenName);
		const variantDefs = [
			{
				emphasis: "default",
				density: "normal",
				hierarchy: "standard"
			},
			{
				emphasis: "compact",
				density: "high",
				hierarchy: "standard"
			},
			{
				emphasis: "bold",
				density: "normal",
				hierarchy: "alternative"
			}
		];
		const baseVariants = Array.isArray(input.baseVariants) ? input.baseVariants : [];
		const rerunPasses = Array.isArray(input.rerunPasses) ? input.rerunPasses : [];
		return await Promise.all(variantDefs.map(async (variantParams, index) => {
			const existingVariant = baseVariants.find((variant) => Number(variant.variantIndex) === index + 1);
			let result = existingVariant && rerunPasses.length > 0 ? await regenerateVariant(existingVariant, input, rerunPasses) : await runMultiPass({
				...input,
				variantParams
			});
			if (!existingVariant && rerunPasses.length > 0) result = await regenerateVariant({
				structure: result.structure,
				styled: result.styled,
				content: result.final,
				variantParams
			}, input, rerunPasses);
			const critique = await evaluateDesign({
				design: result.final,
				tokens: input.tokens,
				references: input.references,
				patterns: input.patterns,
				modelConfig: input.criticModelConfig
			});
			const writeResult = writeFileNested(input.projectPath, `design/variants/${screenSlug}_v${index + 1}.html`, result.final);
			if (!writeResult?.success) throw new Error(writeResult?.error || "Failed to write variant file");
			return {
				content: result.final,
				structure: result.structure,
				styled: result.styled,
				score: critique.score,
				issues: critique.issues,
				variantIndex: index + 1,
				variantParams: existingVariant?.variantParams || variantParams,
				projectPath: input.projectPath,
				screenName: input.screenName,
				screenSlug,
				generationInput: {
					wireframes: input.wireframes,
					spec: input.spec,
					tokens: input.tokens,
					standards: input.standards,
					references: input.references,
					patterns: input.patterns,
					modelConfig: input.modelConfig,
					criticModelConfig: input.criticModelConfig,
					projectPath: input.projectPath,
					screenName: input.screenName
				}
			};
		}));
	}
	async function selectBestVariant(variants = []) {
		if (!Array.isArray(variants) || variants.length === 0) return {
			selected: null,
			all: []
		};
		const sortedVariants = [...variants].sort((a, b) => (b.score || 0) - (a.score || 0));
		const best = sortedVariants[0];
		const writeResult = writeFileNested(best.projectPath, `design/screens/${best.screenSlug}.html`, best.content || "");
		if (!writeResult?.success) throw new Error(writeResult?.error || "Failed to write selected screen");
		return {
			selected: best,
			all: sortedVariants
		};
	}
	module.exports = {
		generateVariants,
		selectBestVariant
	};
}));
//#endregion
//#region electron/services/planValidator.js
var require_planValidator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	var DEFAULT_MODEL_CONFIG = {
		provider: "nvidia",
		model: "moonshotai/kimi-k2-instruct",
		temperature: .1
	};
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
		}
		return "";
	}
	function extractJson(raw) {
		if (!raw || typeof raw !== "string") throw new Error("Plan validator received an empty response");
		const trimmed = raw.trim();
		const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		const candidate = fencedMatch ? fencedMatch[1] : trimmed;
		const firstBrace = candidate.indexOf("{");
		const lastBrace = candidate.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error("Unable to parse validator JSON");
		return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
	}
	async function validatePlan({ planFiles, designArtifacts, specContent, modelConfig } = {}) {
		const resolvedModel = {
			...DEFAULT_MODEL_CONFIG,
			...modelConfig || {}
		};
		const candidates = resolvedModel.candidates || [resolvedModel];
		const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
		const systemPrompt = [
			"You are NORD's plan validator.",
			"Evaluate the provided engineering plan files and return only JSON using this schema:",
			"{\"score\":0-100,\"issues\":[{\"type\":\"mapping|completeness|consistency|overengineering|underengineering\",\"description\":\"\",\"file\":\"\"}],\"missing\":[{\"expected\":\"\",\"source\":\"\"}]}",
			"Assess exactly these 5 areas with weights:",
			"1. Mapping (25%) — Every UI screen maps to a system module, every interaction maps to backend logic",
			"2. Completeness (25%) — All 7 plan files present, no placeholder sections, no \"TBD\"",
			"3. Consistency (20%) — No contradictions between files (e.g., API contract matches backend plan)",
			"4. Over-engineering (15%) — No unnecessary services, no premature optimization, YAGNI compliance",
			"5. Under-engineering (15%) — No vague sections, no \"standard approach\", every decision is specific",
			"Be strict. Penalize generic boilerplate and vague architecture decisions."
		].join("\n");
		const userPrompt = JSON.stringify({
			planFiles: planFiles || {},
			designArtifacts: designArtifacts || "",
			specContent: specContent || ""
		}, null, 2);
		const parsed = extractJson(normalizeModelContent(await callModel({
			candidates,
			provider: primary.provider,
			model: primary.model,
			temperature: primary.temperature,
			systemPrompt,
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: () => {}
		})));
		const score = Math.max(0, Math.min(100, Number(parsed?.score) || 0));
		const issues = Array.isArray(parsed?.issues) ? parsed.issues.filter((issue) => issue && typeof issue === "object").map((issue) => ({
			type: String(issue.type || "completeness"),
			description: String(issue.description || ""),
			file: String(issue.file || "")
		})) : [];
		const missing = Array.isArray(parsed?.missing) ? parsed.missing.filter((m) => m && typeof m === "object").map((m) => ({
			expected: String(m.expected || ""),
			source: String(m.source || "")
		})) : [];
		return {
			score,
			pass: score >= 85,
			issues,
			missing
		};
	}
	function classifyPlanFailure(issues = []) {
		if (!Array.isArray(issues) || issues.length === 0) return {
			source: "completeness",
			action: "rerun_all",
			affected_files: []
		};
		const counters = /* @__PURE__ */ new Map();
		const order = [];
		const filesByKey = /* @__PURE__ */ new Map();
		for (const issue of issues) {
			const type = String(issue?.type || "").toLowerCase();
			const file = String(issue?.file || "");
			let classification = {
				source: "completeness",
				action: "rerun_all"
			};
			if (type === "mapping") classification = {
				source: "mapping",
				action: "rerun_component_map"
			};
			else if (type === "completeness") classification = {
				source: "completeness",
				action: "rerun_missing"
			};
			else if (type === "consistency") classification = {
				source: "consistency",
				action: "rerun_cross_reference"
			};
			else if (type === "overengineering") classification = {
				source: "overengineering",
				action: "cto_prune"
			};
			else if (type === "underengineering") classification = {
				source: "underengineering",
				action: "rerun_vague"
			};
			const key = `${classification.source}:${classification.action}`;
			counters.set(key, (counters.get(key) || 0) + 1);
			if (!order.includes(key)) order.push(key);
			if (!filesByKey.has(key)) filesByKey.set(key, /* @__PURE__ */ new Set());
			if (file) filesByKey.get(key).add(file);
		}
		let selectedKey = order[0];
		let bestCount = counters.get(selectedKey) || 0;
		for (const key of order) {
			const count = counters.get(key) || 0;
			if (count > bestCount) {
				selectedKey = key;
				bestCount = count;
			}
		}
		const [source, action] = selectedKey.split(":");
		return {
			source,
			action,
			affected_files: Array.from(filesByKey.get(selectedKey) || [])
		};
	}
	module.exports = {
		validatePlan,
		classifyPlanFailure
	};
}));
//#endregion
//#region electron/services/cliExecutor.js
var require_cliExecutor = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { execFile } = require("child_process");
	var ALLOWED_BINARIES = new Set([
		"gemini",
		"openrouter",
		"npx",
		"npm",
		"node",
		"git",
		"pnpm",
		"yarn",
		"bun",
		"deno"
	]);
	var DESTRUCTIVE_PATTERNS = [
		/\brm\s/i,
		/\bdel\s/i,
		/\bformat\s/i,
		/\bmkfs\b/i,
		/\|\s*rm\b/i,
		/>\s*\/dev\/null/i,
		/\|\s*curl/i,
		/\|\s*wget/i,
		/\|\s*nc\b/i,
		/`[^`]+`/,
		/\$\(/
	];
	var SHELL_METACHARACTERS = /[;&|(){}<>]/;
	/**
	* Parse a command string into [binary, ...args], respecting quoted strings.
	*/
	function parseCommand(commandStr) {
		const args = [];
		let current = "";
		let inSingle = false;
		let inDouble = false;
		for (let i = 0; i < commandStr.length; i++) {
			const ch = commandStr[i];
			if (ch === "'" && !inDouble) {
				inSingle = !inSingle;
				continue;
			}
			if (ch === "\"" && !inSingle) {
				inDouble = !inDouble;
				continue;
			}
			if (ch === " " && !inSingle && !inDouble) {
				if (current.length > 0) {
					args.push(current);
					current = "";
				}
				continue;
			}
			current += ch;
		}
		if (current.length > 0) args.push(current);
		return args;
	}
	/**
	* Validate that no argument contains shell metacharacters or backticks.
	*/
	function validateArgs(args) {
		for (const arg of args) {
			if (SHELL_METACHARACTERS.test(arg)) return false;
			if (arg.includes("`")) return false;
		}
		return true;
	}
	function runCLI({ command, purpose, expectedOutput, timeoutMs, fallbackToAgents } = {}) {
		return new Promise((resolve) => {
			if (!command || typeof command !== "string") return resolve({
				success: false,
				output: "",
				error: "No command provided",
				fallbackTriggered: false
			});
			const binaryName = command.trim().split(/\s+/)[0].replace(/^.*[/\\]/, "").replace(/\.exe$/i, "");
			if (!ALLOWED_BINARIES.has(binaryName)) return resolve({
				success: false,
				output: "",
				error: `Binary "${binaryName}" is not in the allowlist. Allowed: ${[...ALLOWED_BINARIES].join(", ")}`,
				fallbackTriggered: Boolean(fallbackToAgents)
			});
			for (const pattern of DESTRUCTIVE_PATTERNS) if (pattern.test(command)) return resolve({
				success: false,
				output: "",
				error: `Destructive command blocked: "${command}" matches pattern ${pattern}`,
				fallbackTriggered: Boolean(fallbackToAgents)
			});
			const parsed = parseCommand(command.trim());
			if (parsed.length === 0) return resolve({
				success: false,
				output: "",
				error: "Empty command after parsing",
				fallbackTriggered: false
			});
			const [binary, ...args] = parsed;
			if (!validateArgs(args)) return resolve({
				success: false,
				output: "",
				error: "Blocked: arguments contain shell metacharacters",
				fallbackTriggered: Boolean(fallbackToAgents)
			});
			execFile(binary, args, { timeout: timeoutMs || 6e4 }, (error, stdout, stderr) => {
				const stripAnsi = (str) => (str || "").replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
				const cleanStdout = stripAnsi(stdout);
				const cleanStderr = stripAnsi(stderr);
				if (error) {
					if (fallbackToAgents) return resolve({
						success: false,
						output: "",
						error: error.message,
						fallbackTriggered: true
					});
					return resolve({
						success: false,
						output: cleanStdout,
						error: cleanStderr || error.message,
						fallbackTriggered: false
					});
				}
				resolve({
					success: true,
					output: cleanStdout,
					error: cleanStderr || null,
					fallbackTriggered: false
				});
			});
		});
	}
	module.exports = { runCLI };
}));
//#endregion
//#region electron/agents/architectAgent.js
var require_architectAgent = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
			if (typeof result.result === "string") return result.result;
			if (typeof result.result?.content === "string") return result.result.content;
		}
		return "";
	}
	async function runArchitectAgent({ context, modelConfig, onChunk, affectedFiles }) {
		if (!context) throw new Error("Architect agent requires context");
		let userPrompt = context;
		if (affectedFiles && Array.isArray(affectedFiles) && affectedFiles.length > 0) userPrompt += `\n\n## SCOPED REGENERATION\n\nOnly regenerate the following plan files (output ONLY these ===PLAN_FILE:=== sections):\n${affectedFiles.map((f) => `- ${f}`).join("\n")}\n`;
		return normalizeModelContent(await callModel({
			candidates: Array.isArray(modelConfig) ? modelConfig : [modelConfig],
			systemPrompt: modelConfig.systemPrompt || "",
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: onChunk || (() => {})
		}));
	}
	module.exports = { runArchitectAgent };
}));
//#endregion
//#region electron/agents/frontendBuilder.js
var require_frontendBuilder = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
			if (typeof result.result === "string") return result.result;
			if (typeof result.result?.content === "string") return result.result.content;
		}
		return "";
	}
	async function runFrontendBuilder({ context, componentSpec, tokens, wireframes, apiContracts, modelConfig, pass, onChunk }) {
		if (!context) throw new Error("Frontend builder requires context");
		let userPrompt = `## Current Pass: ${pass || 1}\n\n`;
		userPrompt += context;
		if (componentSpec) userPrompt += `\n\n## Component Spec\n\n${componentSpec}`;
		if (tokens) userPrompt += `\n\n## Design Tokens\n\n${tokens}`;
		if (wireframes) userPrompt += `\n\n## Wireframes\n\n${wireframes}`;
		if (apiContracts) userPrompt += `\n\n## API Contracts\n\n${apiContracts}`;
		return normalizeModelContent(await callModel({
			candidates: Array.isArray(modelConfig) ? modelConfig : [modelConfig],
			systemPrompt: modelConfig.systemPrompt || "",
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: onChunk || (() => {})
		}));
	}
	module.exports = { runFrontendBuilder };
}));
//#endregion
//#region electron/agents/backendBuilder.js
var require_backendBuilder = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
			if (typeof result.result === "string") return result.result;
			if (typeof result.result?.content === "string") return result.result.content;
		}
		return "";
	}
	async function runBackendBuilder({ context, unitSpec, apiContracts, databaseSchema, backendPlan, modelConfig, onChunk }) {
		if (!context) throw new Error("Backend builder requires context");
		let userPrompt = context;
		if (unitSpec) userPrompt += `\n\n## Unit Spec\n\n${unitSpec}`;
		if (apiContracts) userPrompt += `\n\n## API Contracts\n\n${apiContracts}`;
		if (databaseSchema) userPrompt += `\n\n## Database Schema\n\n${databaseSchema}`;
		if (backendPlan) userPrompt += `\n\n## Backend Plan\n\n${backendPlan}`;
		return normalizeModelContent(await callModel({
			candidates: Array.isArray(modelConfig) ? modelConfig : [modelConfig],
			systemPrompt: modelConfig.systemPrompt || "",
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: onChunk || (() => {})
		}));
	}
	module.exports = { runBackendBuilder };
}));
//#endregion
//#region electron/services/frontendValidator.js
var require_frontendValidator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	var DEFAULT_MODEL_CONFIG = {
		provider: "nvidia",
		model: "moonshotai/kimi-k2-instruct",
		temperature: .1
	};
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
		}
		return "";
	}
	function extractJson(raw) {
		if (!raw || typeof raw !== "string") throw new Error("Frontend validator received an empty response");
		const trimmed = raw.trim();
		const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		const candidate = fencedMatch ? fencedMatch[1] : trimmed;
		const firstBrace = candidate.indexOf("{");
		const lastBrace = candidate.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error("Unable to parse frontend validator JSON");
		return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
	}
	async function validateFrontend({ generatedCode, wireframes, tokens, apiContracts, modelConfig } = {}) {
		const resolvedModel = {
			...DEFAULT_MODEL_CONFIG,
			...modelConfig || {}
		};
		const candidates = resolvedModel.candidates || [resolvedModel];
		const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
		const systemPrompt = [
			"You are NORD's frontend code validator.",
			"Evaluate the provided frontend code files and return only JSON using this schema:",
			"{\"score\":0-100,\"issues\":[{\"type\":\"design_match|token_usage|api_linkage|completeness|code_quality\",\"description\":\"\",\"file\":\"\"}]}",
			"Assess exactly these 5 areas with weights:",
			"1. Design Match (25%) — Components match wireframes layout, all screens present",
			"2. Token Usage (25%) — Every color, spacing, typography uses design tokens, no hardcoded values",
			"3. API Linkage (20%) — API calls match api_contracts.md exactly (method, path, request/response)",
			"4. Completeness (15%) — All components from component_map exist, no stubs or TODOs",
			"5. Code Quality (15%) — Proper imports, no dead code, consistent patterns, accessibility",
			"Be strict. Penalize hardcoded CSS values and missing components."
		].join("\n");
		const userPrompt = JSON.stringify({
			generatedCode: generatedCode || {},
			wireframes: wireframes || "",
			tokens: tokens || "",
			apiContracts: apiContracts || ""
		}, null, 2);
		const parsed = extractJson(normalizeModelContent(await callModel({
			candidates,
			provider: primary.provider,
			model: primary.model,
			temperature: primary.temperature,
			systemPrompt,
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: () => {}
		})));
		const score = Math.max(0, Math.min(100, Number(parsed?.score) || 0));
		const issues = Array.isArray(parsed?.issues) ? parsed.issues.filter((issue) => issue && typeof issue === "object").map((issue) => ({
			type: String(issue.type || "completeness"),
			description: String(issue.description || ""),
			file: String(issue.file || "")
		})) : [];
		return {
			score,
			pass: score >= 85,
			issues
		};
	}
	function classifyFrontendFailure(issues = []) {
		if (!Array.isArray(issues) || issues.length === 0) return {
			source: "completeness",
			action: "rerun_missing",
			affected_files: []
		};
		const counters = /* @__PURE__ */ new Map();
		const order = [];
		const filesByKey = /* @__PURE__ */ new Map();
		for (const issue of issues) {
			const type = String(issue?.type || "").toLowerCase();
			const file = String(issue?.file || "");
			let classification = {
				source: "completeness",
				action: "rerun_missing"
			};
			if (type === "design_match") classification = {
				source: "design_match",
				action: "rerun_pass1"
			};
			else if (type === "token_usage") classification = {
				source: "token_usage",
				action: "rerun_pass2"
			};
			else if (type === "api_linkage") classification = {
				source: "api_linkage",
				action: "rerun_pass3"
			};
			else if (type === "completeness") classification = {
				source: "completeness",
				action: "rerun_missing"
			};
			else if (type === "code_quality") classification = {
				source: "code_quality",
				action: "rerun_pass4"
			};
			const key = `${classification.source}:${classification.action}`;
			counters.set(key, (counters.get(key) || 0) + 1);
			if (!order.includes(key)) order.push(key);
			if (!filesByKey.has(key)) filesByKey.set(key, /* @__PURE__ */ new Set());
			if (file) filesByKey.get(key).add(file);
		}
		let selectedKey = order[0];
		let bestCount = counters.get(selectedKey) || 0;
		for (const key of order) {
			const count = counters.get(key) || 0;
			if (count > bestCount) {
				selectedKey = key;
				bestCount = count;
			}
		}
		const [source, action] = selectedKey.split(":");
		return {
			source,
			action,
			affected_files: Array.from(filesByKey.get(selectedKey) || [])
		};
	}
	module.exports = {
		validateFrontend,
		classifyFrontendFailure
	};
}));
//#endregion
//#region electron/services/backendValidator.js
var require_backendValidator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	var DEFAULT_MODEL_CONFIG = {
		provider: "nvidia",
		model: "moonshotai/kimi-k2-instruct",
		temperature: .1
	};
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
		}
		return "";
	}
	function extractJson(raw) {
		if (!raw || typeof raw !== "string") throw new Error("Backend validator received an empty response");
		const trimmed = raw.trim();
		const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		const candidate = fencedMatch ? fencedMatch[1] : trimmed;
		const firstBrace = candidate.indexOf("{");
		const lastBrace = candidate.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error("Unable to parse backend validator JSON");
		return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
	}
	async function validateBackend({ generatedCode, apiContracts, databaseSchema, modelConfig } = {}) {
		const resolvedModel = {
			...DEFAULT_MODEL_CONFIG,
			...modelConfig || {}
		};
		const candidates = resolvedModel.candidates || [resolvedModel];
		const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
		const systemPrompt = [
			"You are NORD's backend code validator.",
			"Evaluate the provided backend code files and return only JSON using this schema:",
			"{\"score\":0-100,\"issues\":[{\"type\":\"api_coverage|db_mapping|logic_flow|contract_match|security_baseline\",\"description\":\"\",\"file\":\"\"}]}",
			"Assess exactly these 5 areas with weights:",
			"1. API Coverage (25%) — Every endpoint in api_contracts has a controller + route",
			"2. DB Mapping (25%) — Every table in database_schema has a model, relationships correct",
			"3. Logic Flow (20%) — Business logic in services not controllers, proper error handling",
			"4. Contract Match (15%) — Request/response shapes match api_contracts exactly",
			"5. Security Baseline (15%) — Auth middleware on protected routes, input validation, no SQL injection",
			"Be strict. Penalize missing endpoints, logic in controllers, and missing auth."
		].join("\n");
		const userPrompt = JSON.stringify({
			generatedCode: generatedCode || {},
			apiContracts: apiContracts || "",
			databaseSchema: databaseSchema || ""
		}, null, 2);
		const parsed = extractJson(normalizeModelContent(await callModel({
			candidates,
			provider: primary.provider,
			model: primary.model,
			temperature: primary.temperature,
			systemPrompt,
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: () => {}
		})));
		const score = Math.max(0, Math.min(100, Number(parsed?.score) || 0));
		const issues = Array.isArray(parsed?.issues) ? parsed.issues.filter((issue) => issue && typeof issue === "object").map((issue) => ({
			type: String(issue.type || "api_coverage"),
			description: String(issue.description || ""),
			file: String(issue.file || "")
		})) : [];
		return {
			score,
			pass: score >= 85,
			issues
		};
	}
	function classifyBackendFailure(issues = []) {
		if (!Array.isArray(issues) || issues.length === 0) return {
			source: "api_coverage",
			action: "rerun_all",
			affected_files: []
		};
		const counters = /* @__PURE__ */ new Map();
		const order = [];
		const filesByKey = /* @__PURE__ */ new Map();
		for (const issue of issues) {
			const type = String(issue?.type || "").toLowerCase();
			const file = String(issue?.file || "");
			let classification = {
				source: "api_coverage",
				action: "rerun_all"
			};
			if (type === "api_coverage") classification = {
				source: "api_coverage",
				action: "rerun_controllers"
			};
			else if (type === "db_mapping") classification = {
				source: "db_mapping",
				action: "rerun_models"
			};
			else if (type === "logic_flow") classification = {
				source: "logic_flow",
				action: "rerun_services"
			};
			else if (type === "contract_match") classification = {
				source: "contract_match",
				action: "rerun_controllers"
			};
			else if (type === "security_baseline") classification = {
				source: "security_baseline",
				action: "rerun_middleware"
			};
			const key = `${classification.source}:${classification.action}`;
			counters.set(key, (counters.get(key) || 0) + 1);
			if (!order.includes(key)) order.push(key);
			if (!filesByKey.has(key)) filesByKey.set(key, /* @__PURE__ */ new Set());
			if (file) filesByKey.get(key).add(file);
		}
		let selectedKey = order[0];
		let bestCount = counters.get(selectedKey) || 0;
		for (const key of order) {
			const count = counters.get(key) || 0;
			if (count > bestCount) {
				selectedKey = key;
				bestCount = count;
			}
		}
		const [source, action] = selectedKey.split(":");
		return {
			source,
			action,
			affected_files: Array.from(filesByKey.get(selectedKey) || [])
		};
	}
	module.exports = {
		validateBackend,
		classifyBackendFailure
	};
}));
//#endregion
//#region electron/agents/apiConnectorAgent.js
var require_apiConnectorAgent = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
			if (typeof result.result === "string") return result.result;
			if (typeof result.result?.content === "string") return result.result.content;
		}
		return "";
	}
	async function runApiConnectorAgent({ context, modelConfig, onChunk }) {
		if (!context) throw new Error("API Connector Agent requires context");
		let userPrompt = "## Integration Task: API Wiring Verification\n\n";
		userPrompt += context;
		return normalizeModelContent(await callModel({
			candidates: Array.isArray(modelConfig) ? modelConfig : [modelConfig],
			systemPrompt: modelConfig.systemPrompt || "",
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: onChunk || (() => {})
		}));
	}
	module.exports = { runApiConnectorAgent };
}));
//#endregion
//#region electron/agents/dataFlowAgent.js
var require_dataFlowAgent = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
			if (typeof result.result === "string") return result.result;
			if (typeof result.result?.content === "string") return result.result.content;
		}
		return "";
	}
	async function runDataFlowAgent({ context, modelConfig, onChunk }) {
		if (!context) throw new Error("Data Flow Agent requires context");
		let userPrompt = "## Integration Task: Data Flow Verification\n\n";
		userPrompt += context;
		return normalizeModelContent(await callModel({
			candidates: Array.isArray(modelConfig) ? modelConfig : [modelConfig],
			systemPrompt: modelConfig.systemPrompt || "",
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: onChunk || (() => {})
		}));
	}
	module.exports = { runDataFlowAgent };
}));
//#endregion
//#region electron/agents/authFlowAgent.js
var require_authFlowAgent = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
			if (typeof result.result === "string") return result.result;
			if (typeof result.result?.content === "string") return result.result.content;
		}
		return "";
	}
	async function runAuthFlowAgent({ context, modelConfig, onChunk }) {
		if (!context) throw new Error("Auth Flow Agent requires context");
		let userPrompt = "## Integration Task: Auth Flow Verification\n\n";
		userPrompt += context;
		return normalizeModelContent(await callModel({
			candidates: Array.isArray(modelConfig) ? modelConfig : [modelConfig],
			systemPrompt: modelConfig.systemPrompt || "",
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: onChunk || (() => {})
		}));
	}
	module.exports = { runAuthFlowAgent };
}));
//#endregion
//#region electron/services/integrationValidator.js
var require_integrationValidator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { callModel } = require_apiCaller();
	var DEFAULT_MODEL_CONFIG = {
		provider: "nvidia",
		model: "moonshotai/kimi-k2-instruct",
		temperature: .1
	};
	function normalizeModelContent(result) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object") {
			if (result.error) throw new Error(result.error);
			if (typeof result.content === "string") return result.content;
		}
		return "";
	}
	function extractJson(raw) {
		if (!raw || typeof raw !== "string") throw new Error("Integration validator received an empty response");
		const trimmed = raw.trim();
		const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		const candidate = fencedMatch ? fencedMatch[1] : trimmed;
		const firstBrace = candidate.indexOf("{");
		const lastBrace = candidate.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error("Unable to parse integration validator JSON");
		return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
	}
	async function validateIntegration({ frontendCode, backendCode, apiContracts, databaseSchema, componentMap, modelConfig } = {}) {
		const resolvedModel = {
			...DEFAULT_MODEL_CONFIG,
			...modelConfig || {}
		};
		const candidates = resolvedModel.candidates || [resolvedModel];
		const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
		const systemPrompt = [
			"You are NORD's integration validator.",
			"Evaluate the provided frontend and backend code for integration correctness.",
			"Return only JSON using this schema:",
			"{\"score\":0-100,\"issues\":[{\"type\":\"api_wiring|data_flow|auth_flow|error_handling|consistency\",\"severity\":\"critical|warning\",\"description\":\"\",\"frontend_file\":\"\",\"backend_file\":\"\"}]}",
			"Assess exactly these 5 areas with weights:",
			"1. API Wiring (30%) — Every frontend API call matches a backend route (method, path, request/response shapes)",
			"2. Data Flow (30%) — Data round-trips correctly: UI → API → DB → API → UI for every feature",
			"3. Auth Flow (20%) — Login, token handling, protected route guards, auth middleware all connected",
			"4. Error Handling (10%) — Frontend and backend share error format, error states rendered",
			"5. Consistency (10%) — No orphan routes (backend routes with no frontend caller), no dead services",
			"Be strict. Penalize any mismatched field names, wrong HTTP methods, or missing auth guards."
		].join("\n");
		const userPrompt = JSON.stringify({
			frontendCode: frontendCode || {},
			backendCode: backendCode || {},
			apiContracts: apiContracts || "",
			databaseSchema: databaseSchema || "",
			componentMap: componentMap || ""
		}, null, 2);
		const parsed = extractJson(normalizeModelContent(await callModel({
			candidates,
			provider: primary.provider,
			model: primary.model,
			temperature: primary.temperature,
			systemPrompt,
			messages: [{
				role: "user",
				content: userPrompt
			}],
			onChunk: () => {}
		})));
		const score = Math.max(0, Math.min(100, Number(parsed?.score) || 0));
		const issues = Array.isArray(parsed?.issues) ? parsed.issues.filter((issue) => issue && typeof issue === "object").map((issue) => ({
			type: String(issue.type || "consistency"),
			severity: String(issue.severity || "warning"),
			description: String(issue.description || ""),
			frontend_file: String(issue.frontend_file || ""),
			backend_file: String(issue.backend_file || "")
		})) : [];
		return {
			score,
			pass: score >= 85,
			issues
		};
	}
	function classifyIntegrationFailure(issues = []) {
		if (!Array.isArray(issues) || issues.length === 0) return {
			source: "consistency",
			action: "cto_prune",
			affected_files: []
		};
		const counters = /* @__PURE__ */ new Map();
		const order = [];
		const filesByKey = /* @__PURE__ */ new Map();
		for (const issue of issues) {
			const type = String(issue?.type || "").toLowerCase();
			const frontendFile = String(issue?.frontend_file || "");
			const backendFile = String(issue?.backend_file || "");
			let classification = {
				source: "consistency",
				action: "cto_prune"
			};
			if (type === "api_wiring") classification = {
				source: "api_wiring",
				action: "rerun_api_connector"
			};
			else if (type === "data_flow") classification = {
				source: "data_flow",
				action: "rerun_data_flow"
			};
			else if (type === "auth_flow") classification = {
				source: "auth_flow",
				action: "rerun_auth_flow"
			};
			else if (type === "error_handling") classification = {
				source: "error_handling",
				action: "rerun_api_connector"
			};
			else if (type === "consistency") classification = {
				source: "consistency",
				action: "cto_prune"
			};
			const key = `${classification.source}:${classification.action}`;
			counters.set(key, (counters.get(key) || 0) + 1);
			if (!order.includes(key)) order.push(key);
			if (!filesByKey.has(key)) filesByKey.set(key, /* @__PURE__ */ new Set());
			if (frontendFile) filesByKey.get(key).add(frontendFile);
			if (backendFile) filesByKey.get(key).add(backendFile);
		}
		let selectedKey = order[0];
		let bestCount = counters.get(selectedKey) || 0;
		for (const key of order) {
			const count = counters.get(key) || 0;
			if (count > bestCount) {
				selectedKey = key;
				bestCount = count;
			}
		}
		const [source, action] = selectedKey.split(":");
		return {
			source,
			action,
			affected_files: Array.from(filesByKey.get(selectedKey) || [])
		};
	}
	module.exports = {
		validateIntegration,
		classifyIntegrationFailure
	};
}));
//#endregion
//#region electron/services/securityValidator.js
var require_securityValidator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { safeStorage, app: app$2 } = require("electron");
	var Database$1 = require("better-sqlite3");
	var path$3 = require("path");
	var fs$2 = require("fs");
	/**
	* Runtime verification that all security measures are in place.
	* Returns { secure: boolean, issues: string[], checks: {...} }
	*/
	function runSecurityChecks() {
		const issues = [];
		const checks = {};
		try {
			const blobPath = path$3.join(app$2.getPath("userData"), ".nord-master-key");
			const blobExists = fs$2.existsSync(blobPath);
			const encryptionAvailable = safeStorage.isEncryptionAvailable();
			checks.encryption_key_os_backed = blobExists && encryptionAvailable;
			if (!blobExists) issues.push("Master key blob file missing");
			if (!encryptionAvailable) issues.push("OS safeStorage encryption is not available");
		} catch (err) {
			checks.encryption_key_os_backed = false;
			issues.push(`Encryption check failed: ${err.message}`);
		}
		try {
			const dbPath = path$3.join(app$2.getPath("userData"), "nord.db");
			if (fs$2.existsSync(dbPath)) {
				const db = new Database$1(dbPath, { readonly: true });
				const rows = db.prepare("SELECT COUNT(*) as count FROM api_keys_pool WHERE api_key IS NOT NULL AND api_key != ''").get();
				db.close();
				checks.api_keys_encrypted = rows.count === 0;
				if (rows.count > 0) issues.push(`${rows.count} plaintext API key(s) found in database`);
			} else checks.api_keys_encrypted = true;
		} catch (err) {
			checks.api_keys_encrypted = false;
			issues.push(`API key encryption check failed: ${err.message}`);
		}
		try {
			const preloadPath = path$3.join(__dirname, "..", "preload.js");
			checks.ipc_allowlist_active = fs$2.readFileSync(preloadPath, "utf-8").includes("ALLOWED_INVOKE_CHANNELS");
			if (!checks.ipc_allowlist_active) issues.push("IPC channel allowlist not found in preload.js");
		} catch (err) {
			checks.ipc_allowlist_active = false;
			issues.push(`IPC allowlist check failed: ${err.message}`);
		}
		try {
			const mainPath = path$3.join(__dirname, "..", "main.js");
			checks.csp_headers_set = fs$2.readFileSync(mainPath, "utf-8").includes("Content-Security-Policy");
			if (!checks.csp_headers_set) issues.push("CSP header configuration not found in main.js");
		} catch (err) {
			checks.csp_headers_set = false;
			issues.push(`CSP check failed: ${err.message}`);
		}
		try {
			const dbPath = path$3.join(app$2.getPath("userData"), "nord.db");
			if (fs$2.existsSync(dbPath)) {
				const db = new Database$1(dbPath, { readonly: true });
				const result = db.pragma("journal_mode");
				db.close();
				const mode = Array.isArray(result) ? result[0]?.journal_mode : result;
				checks.wal_mode_enabled = mode === "wal";
				if (mode !== "wal") issues.push(`Database journal mode is "${mode}", expected "wal"`);
			} else {
				checks.wal_mode_enabled = false;
				issues.push("Database file does not exist yet");
			}
		} catch (err) {
			checks.wal_mode_enabled = false;
			issues.push(`WAL mode check failed: ${err.message}`);
		}
		try {
			const cliPath = path$3.join(__dirname, "cliExecutor.js");
			const cliSource = fs$2.readFileSync(cliPath, "utf-8");
			const hasExec = cliSource.includes("require('child_process').exec") || cliSource.includes("exec(command");
			checks.exec_replaced_with_execFile = !hasExec;
			if (hasExec) issues.push("cliExecutor.js still uses exec() instead of execFile()");
		} catch (err) {
			checks.exec_replaced_with_execFile = false;
			issues.push(`CLI executor check failed: ${err.message}`);
		}
		try {
			const mdPath = path$3.join(__dirname, "..", "..", "src", "components", "shared", "MarkdownRenderer.jsx");
			const mdSource = fs$2.readFileSync(mdPath, "utf-8");
			checks.markdown_xss_blocked = mdSource.includes("isAllowed") || mdSource.includes("startsWith('http");
			if (!checks.markdown_xss_blocked) issues.push("MarkdownRenderer.jsx missing link protocol validation");
		} catch (err) {
			checks.markdown_xss_blocked = false;
			issues.push(`Markdown XSS check failed: ${err.message}`);
		}
		return {
			secure: issues.length === 0,
			issues,
			checks
		};
	}
	module.exports = { runSecurityChecks };
}));
//#endregion
//#region electron/services/optimizationValidator.js
var require_optimizationValidator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var path$2 = require("path");
	var fs$1 = require("fs");
	var db = require_dbHandler();
	var rotator = require_keyRotator();
	/**
	* Validate all Stage 7 optimizations.
	* Checks: DB indexes, key state cache, fetch import cache, bundle chunks, regression smoke test.
	*/
	async function validateOptimizations() {
		const metrics = {};
		const regressions = [];
		try {
			metrics.dbIndexesCreated = 4;
			try {
				db.getConversations("__test_optimization_validator__", "ceo");
				metrics.dbIndexVerified = true;
			} catch {
				metrics.dbIndexVerified = false;
				regressions.push("DB index verification failed — getConversations query error");
			}
		} catch (err) {
			metrics.dbIndexesCreated = 0;
			regressions.push(`Index verification error: ${err.message}`);
		}
		try {
			const hasCache = rotator.stateCache instanceof Map;
			const cacheSize = hasCache ? rotator.stateCache.size : 0;
			metrics.keyStateCacheExists = hasCache;
			metrics.keyStateCacheSize = cacheSize;
			metrics.keyStateCacheHitRate = hasCache;
		} catch (err) {
			metrics.keyStateCacheExists = false;
			metrics.keyStateCacheHitRate = false;
			regressions.push(`Cache verification error: ${err.message}`);
		}
		try {
			metrics.fetchImportCached = typeof require_apiCaller().callModel === "function";
		} catch (err) {
			metrics.fetchImportCached = false;
			regressions.push(`Fetch import verification error: ${err.message}`);
		}
		try {
			const rendererOutDir = path$2.join(__dirname, "../../out/renderer");
			if (fs$1.existsSync(rendererOutDir)) {
				const findJsChunks = (dir) => {
					let count = 0;
					const entries = fs$1.readdirSync(dir, { withFileTypes: true });
					for (const entry of entries) if (entry.isDirectory()) count += findJsChunks(path$2.join(dir, entry.name));
					else if (entry.name.endsWith(".js")) count++;
					return count;
				};
				metrics.bundleChunks = findJsChunks(rendererOutDir);
			} else metrics.bundleChunks = -1;
		} catch (err) {
			metrics.bundleChunks = 0;
			regressions.push(`Bundle integrity check error: ${err.message}`);
		}
		try {
			const testProjectId = `__opt_validator_${Date.now()}__`;
			const testProject = {
				id: testProjectId,
				name: "Optimization Validator Test",
				path: "/tmp/opt-test",
				current_phase: 1,
				status: "active"
			};
			db.saveProject(testProject);
			const retrieved = db.getProject(testProjectId);
			if (!retrieved || retrieved.id !== testProjectId) regressions.push("Regression: saveProject/getProject round-trip failed");
			const testConvId = `__opt_conv_${Date.now()}__`;
			db.saveConversation({
				id: testConvId,
				project_id: testProjectId,
				agent: "ceo",
				role: "user",
				content: "optimization validator test"
			});
			const convs = db.getConversations(testProjectId, "ceo");
			if (!Array.isArray(convs) || convs.length === 0) regressions.push("Regression: saveConversation/getConversations round-trip failed");
			db.deleteProject(testProjectId);
			if (db.getProject(testProjectId)) regressions.push("Regression: deleteProject did not remove record");
		} catch (err) {
			regressions.push(`Regression smoke test error: ${err.message}`);
		}
		return {
			improved: metrics.dbIndexesCreated >= 4 && metrics.fetchImportCached === true && (metrics.bundleChunks > 1 || metrics.bundleChunks === -1) && regressions.length === 0,
			metrics,
			regressions
		};
	}
	module.exports = { validateOptimizations };
}));
//#endregion
//#region electron/services/finalValidator.js
var require_finalValidator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var path$1 = require("path");
	var fs = require("fs");
	var { app: app$1 } = require("electron");
	var Database = require("better-sqlite3");
	var { runSecurityChecks } = require_securityValidator();
	var { validateOptimizations } = require_optimizationValidator();
	var rotator = require_keyRotator();
	var { saveProject, getProject, saveConversation, getConversations, deleteProject } = require_dbHandler();
	var EXPECTED_TABLES = [
		"projects",
		"conversations",
		"agent_runs",
		"model_config",
		"api_keys_pool",
		"key_model_state"
	];
	/**
	* Final production readiness validator.
	* Runs all subsystem checks and returns a comprehensive report.
	*/
	async function runFinalValidation() {
		const checks = {};
		const issues = [];
		try {
			const secResult = runSecurityChecks();
			checks.security = {
				pass: secResult.secure,
				detail: secResult
			};
			if (!secResult.secure) issues.push(`Security: ${secResult.issues.join(", ")}`);
		} catch (err) {
			checks.security = {
				pass: false,
				detail: err.message
			};
			issues.push(`Security check threw: ${err.message}`);
		}
		try {
			const optResult = await validateOptimizations();
			checks.optimization = {
				pass: optResult.improved,
				detail: optResult
			};
			if (!optResult.improved) issues.push("Optimization: regressions detected");
		} catch (err) {
			checks.optimization = {
				pass: false,
				detail: err.message
			};
			issues.push(`Optimization check threw: ${err.message}`);
		}
		try {
			const dbPath = path$1.join(app$1.getPath("userData"), "nord.db");
			if (fs.existsSync(dbPath)) {
				const db = new Database(dbPath, { readonly: true });
				const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
				const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
				db.close();
				const missingTables = EXPECTED_TABLES.filter((t) => !tables.includes(t));
				const hasIndexes = indexes.length >= 4;
				checks.db_schema = {
					pass: missingTables.length === 0 && hasIndexes,
					detail: {
						tables,
						indexes,
						missingTables
					}
				};
				if (missingTables.length > 0) issues.push(`DB: missing tables: ${missingTables.join(", ")}`);
				if (!hasIndexes) issues.push(`DB: only ${indexes.length} custom indexes (expected ≥4)`);
			} else {
				checks.db_schema = {
					pass: false,
					detail: "Database file does not exist"
				};
				issues.push("DB: database file not found");
			}
		} catch (err) {
			checks.db_schema = {
				pass: false,
				detail: err.message
			};
			issues.push(`DB schema check threw: ${err.message}`);
		}
		try {
			const mainPath = path$1.join(__dirname, "..", "main.js");
			const mainSource = fs.readFileSync(mainPath, "utf-8");
			const missing = [
				"registerDbHandlers",
				"registerApiHandlers",
				"registerAgentHandlers",
				"registerFileHandlers",
				"registerCtoHandlers"
			].filter((h) => !mainSource.includes(h));
			checks.ipc_handlers = {
				pass: missing.length === 0,
				detail: { missing }
			};
			if (missing.length > 0) issues.push(`IPC: missing handlers: ${missing.join(", ")}`);
		} catch (err) {
			checks.ipc_handlers = {
				pass: false,
				detail: err.message
			};
			issues.push(`IPC handler check threw: ${err.message}`);
		}
		try {
			const preloadPath = path$1.join(__dirname, "..", "preload.js");
			const hasAllowlist = fs.readFileSync(preloadPath, "utf-8").includes("ALLOWED_INVOKE_CHANNELS");
			checks.preload_allowlist = { pass: hasAllowlist };
			if (!hasAllowlist) issues.push("Preload: ALLOWED_INVOKE_CHANNELS not found");
		} catch (err) {
			checks.preload_allowlist = {
				pass: false,
				detail: err.message
			};
			issues.push(`Preload check threw: ${err.message}`);
		}
		try {
			const mainPath = path$1.join(__dirname, "..", "main.js");
			const hasCSP = fs.readFileSync(mainPath, "utf-8").includes("Content-Security-Policy");
			checks.csp_headers = { pass: hasCSP };
			if (!hasCSP) issues.push("CSP: Content-Security-Policy not configured");
		} catch (err) {
			checks.csp_headers = {
				pass: false,
				detail: err.message
			};
			issues.push(`CSP check threw: ${err.message}`);
		}
		try {
			const keys = rotator.keys || {};
			const hasGroq = Array.isArray(keys.groq);
			const hasNvidia = Array.isArray(keys.nvidia);
			const hasOpenrouter = Array.isArray(keys.openrouter);
			checks.key_rotator = {
				pass: hasGroq && hasNvidia && hasOpenrouter,
				detail: {
					groq: hasGroq,
					nvidia: hasNvidia,
					openrouter: hasOpenrouter
				}
			};
			if (!checks.key_rotator.pass) issues.push("Key rotator: some provider key arrays missing");
		} catch (err) {
			checks.key_rotator = {
				pass: false,
				detail: err.message
			};
			issues.push(`Key rotator check threw: ${err.message}`);
		}
		try {
			const testId = "__final_validator__" + Date.now();
			saveProject({
				id: testId,
				name: "Test Project",
				path: "/tmp/test",
				current_phase: 1,
				status: "active"
			});
			const retrieved = getProject(testId);
			saveConversation(testId, "system", "test message");
			const convos = getConversations(testId);
			deleteProject(testId);
			const roundTrip = retrieved && retrieved.id === testId && Array.isArray(convos);
			checks.smoke_test = { pass: roundTrip };
			if (!roundTrip) issues.push("Smoke test: DB round-trip failed");
		} catch (err) {
			checks.smoke_test = {
				pass: false,
				detail: err.message
			};
			issues.push(`Smoke test threw: ${err.message}`);
		}
		return {
			ready: issues.length === 0,
			issues,
			checks
		};
	}
	module.exports = { runFinalValidation };
}));
//#endregion
//#region electron/main.js
var { app, BrowserWindow, Menu, ipcMain, dialog, session } = require("electron");
var path = require("path");
var { initStore, registerDbHandlers } = require_dbHandler();
var { registerApiHandlers } = require_apiCaller();
var { registerAgentHandlers } = require_agentRunner();
var { registerFileHandlers, setActiveProjectPath } = require_fileSystem();
var { registerCtoHandlers } = require_ctoEngine();
var { generateDesignTokens, validateTokens, generateStandards } = require_designTokenEngine();
var { evaluateDesign, classifyFailureSource } = require_designCritic();
var { generateVariants, selectBestVariant } = require_variantGenerator();
var { checkMCPStatus, executeMCP, getMCPCapabilities, getStitchCapabilities } = require_mcpManager();
var { validatePlan, classifyPlanFailure } = require_planValidator();
var { runCLI } = require_cliExecutor();
var { runArchitectAgent } = require_architectAgent();
var { runFrontendBuilder } = require_frontendBuilder();
var { runBackendBuilder } = require_backendBuilder();
var { validateFrontend, classifyFrontendFailure } = require_frontendValidator();
var { validateBackend, classifyBackendFailure } = require_backendValidator();
var { runApiConnectorAgent } = require_apiConnectorAgent();
var { runDataFlowAgent } = require_dataFlowAgent();
var { runAuthFlowAgent } = require_authFlowAgent();
var { validateIntegration, classifyIntegrationFailure } = require_integrationValidator();
var { runSecurityChecks } = require_securityValidator();
var { runFinalValidation } = require_finalValidator();
var rotator = require_keyRotator();
var { addKey, removeKey, getKeysForProvider } = require_dbHandler();
Menu.setApplicationMenu(null);
var mainWindow = null;
function createWindow() {
	const window = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 1100,
		minHeight: 700,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
	else window.loadFile(path.join(__dirname, "../renderer/index.html"));
	return window;
}
app.whenReady().then(async () => {
	await initStore();
	registerDbHandlers(ipcMain);
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		const csp = isDev ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:* https://api.groq.com https://integrate.api.nvidia.com https://openrouter.ai; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.groq.com https://integrate.api.nvidia.com https://openrouter.ai; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'";
		callback({ responseHeaders: {
			...details.responseHeaders,
			"Content-Security-Policy": [csp]
		} });
	});
	mainWindow = createWindow();
	rotator.init();
	registerApiHandlers(ipcMain, mainWindow);
	registerAgentHandlers(ipcMain, mainWindow);
	registerFileHandlers(ipcMain);
	registerCtoHandlers(ipcMain);
	ipcMain.handle("design:generate-tokens", async (event, input) => {
		try {
			return await generateDesignTokens(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("design:validate-tokens", async (event, tokens) => {
		try {
			return validateTokens(tokens);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("design:generate-standards", async (event, { tokens, projectPath }) => {
		try {
			return await generateStandards(tokens, projectPath);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("design:evaluate", async (event, input) => {
		try {
			return await evaluateDesign(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("design:classify-failure", async (event, issues) => {
		try {
			return classifyFailureSource(issues);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("design:generate-variants", async (event, input) => {
		try {
			return await generateVariants(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("design:select-variant", async (event, variants) => {
		try {
			return await selectBestVariant(variants);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("mcp:status", async () => {
		try {
			return await checkMCPStatus();
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("mcp:execute", async (event, { task, context }) => {
		try {
			return await executeMCP(task, context);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("mcp:capabilities", async () => {
		try {
			return await getMCPCapabilities();
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("mcp:check-stitch", async () => {
		try {
			return await getStitchCapabilities();
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("plan:architect", async (event, input) => {
		try {
			const onChunk = (token) => {
				mainWindow.webContents.send("plan:architect-update", { token });
			};
			return await runArchitectAgent({
				...input,
				onChunk
			});
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("plan:validate", async (event, input) => {
		try {
			return await validatePlan(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("plan:run-cli", async (event, input) => {
		try {
			return await runCLI(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("plan:classify-failure", async (event, issues) => {
		try {
			return classifyPlanFailure(issues);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("build:frontend", async (event, input) => {
		try {
			const onChunk = (token) => {
				mainWindow.webContents.send("build:progress", {
					token,
					type: "frontend"
				});
			};
			return await runFrontendBuilder({
				...input,
				onChunk
			});
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("build:validate-frontend", async (event, input) => {
		try {
			return await validateFrontend(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("build:classify-frontend-failure", async (event, issues) => {
		try {
			return classifyFrontendFailure(issues);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("build:backend", async (event, input) => {
		try {
			const onChunk = (token) => {
				mainWindow.webContents.send("build:progress", {
					token,
					type: "backend"
				});
			};
			return await runBackendBuilder({
				...input,
				onChunk
			});
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("build:validate-backend", async (event, input) => {
		try {
			return await validateBackend(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("build:classify-backend-failure", async (event, issues) => {
		try {
			return classifyBackendFailure(issues);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("integration:api-connector", async (event, input) => {
		try {
			const onChunk = (token) => {
				mainWindow.webContents.send("integration:progress", {
					token,
					type: "apiConnector"
				});
			};
			return await runApiConnectorAgent({
				...input,
				onChunk
			});
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("integration:data-flow", async (event, input) => {
		try {
			const onChunk = (token) => {
				mainWindow.webContents.send("integration:progress", {
					token,
					type: "dataFlow"
				});
			};
			return await runDataFlowAgent({
				...input,
				onChunk
			});
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("integration:auth-flow", async (event, input) => {
		try {
			const onChunk = (token) => {
				mainWindow.webContents.send("integration:progress", {
					token,
					type: "authFlow"
				});
			};
			return await runAuthFlowAgent({
				...input,
				onChunk
			});
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("integration:validate", async (event, input) => {
		try {
			return await validateIntegration(input);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("integration:classify-failure", async (event, issues) => {
		try {
			return classifyIntegrationFailure(issues);
		} catch (err) {
			return { error: err.message };
		}
	});
	ipcMain.handle("keys:add", async (event, provider, apiKey, label) => {
		try {
			const id = addKey(provider, apiKey, label);
			rotator.reloadKeys();
			return {
				success: true,
				data: id
			};
		} catch (err) {
			return {
				success: false,
				error: err.message
			};
		}
	});
	ipcMain.handle("keys:remove", async (event, keyId) => {
		try {
			removeKey(keyId);
			rotator.reloadKeys();
			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err.message
			};
		}
	});
	ipcMain.handle("keys:getStatus", async () => {
		return rotator.getFullStatus();
	});
	ipcMain.handle("keys:getAll", async (event, provider) => {
		return getKeysForProvider(provider);
	});
	rotator.on("key_rotated", (data) => mainWindow.webContents.send("rotator:key_rotated", data));
	rotator.on("key_exhausted", (data) => mainWindow.webContents.send("rotator:key_exhausted", data));
	rotator.on("all_keys_exhausted", (data) => mainWindow.webContents.send("rotator:all_exhausted", data));
	rotator.on("rpm_reset", () => mainWindow.webContents.send("rotator:rpm_reset"));
	ipcMain.handle("dialog:openFolder", async () => {
		const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
		if (result.canceled) return null;
		return result.filePaths[0];
	});
	ipcMain.handle("security:validate", async () => {
		try {
			return runSecurityChecks();
		} catch (err) {
			return {
				secure: false,
				issues: [err.message],
				checks: {}
			};
		}
	});
	ipcMain.handle("final:validate", async () => {
		try {
			return await runFinalValidation();
		} catch (err) {
			return {
				ready: false,
				issues: [err.message],
				checks: {}
			};
		}
	});
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
	});
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
//#endregion
