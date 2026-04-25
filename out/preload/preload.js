//#region electron/preload.js
var { contextBridge, ipcRenderer } = require("electron");
var ALLOWED_INVOKE_CHANNELS = new Set([
	"db:getKey",
	"db:setKey",
	"db:saveProject",
	"db:getProject",
	"db:getAllProjects",
	"db:deleteProject",
	"db:updateProjectPhase",
	"db:saveConversation",
	"db:getConversations",
	"db:saveAgentRun",
	"db:updateAgentRun",
	"db:saveModelConfig",
	"db:getModelConfig",
	"fs:createNordFolder",
	"fs:writeFile",
	"fs:readFile",
	"fs:listFiles",
	"fs:writeFileNested",
	"fs:readFileNested",
	"fs:deleteFile",
	"fs:setActiveProject",
	"fs:writeDesignFile",
	"fs:readDesignFile",
	"fs:listDesignAssets",
	"api:call",
	"api:abort",
	"agents:run",
	"design:generate-tokens",
	"design:validate-tokens",
	"design:generate-standards",
	"design:evaluate",
	"design:classify-failure",
	"design:generate-variants",
	"design:select-variant",
	"mcp:status",
	"mcp:execute",
	"mcp:capabilities",
	"mcp:check-stitch",
	"plan:architect",
	"plan:validate",
	"plan:run-cli",
	"plan:classify-failure",
	"build:frontend",
	"build:validate-frontend",
	"build:classify-frontend-failure",
	"build:backend",
	"build:validate-backend",
	"build:classify-backend-failure",
	"integration:api-connector",
	"integration:data-flow",
	"integration:auth-flow",
	"integration:validate",
	"integration:classify-failure",
	"keys:add",
	"keys:remove",
	"keys:getStatus",
	"keys:getAll",
	"cto:process-task",
	"dialog:openFolder",
	"security:validate",
	"final:validate"
]);
var ALLOWED_EVENT_CHANNELS = new Set([
	"api:chunk",
	"agents:update",
	"plan:architect-update",
	"build:progress",
	"integration:progress",
	"rotator:key_rotated",
	"rotator:key_exhausted",
	"rotator:all_exhausted",
	"rotator:rpm_reset"
]);
var callbackWrappers = /* @__PURE__ */ new WeakMap();
contextBridge.exposeInMainWorld("electronAPI", {
	invoke: (channel, ...args) => {
		if (!ALLOWED_INVOKE_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
		return ipcRenderer.invoke(channel, ...args);
	},
	on: (channel, callback) => {
		if (!ALLOWED_EVENT_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
		const wrapper = (event, ...args) => callback(...args);
		callbackWrappers.set(callback, wrapper);
		ipcRenderer.on(channel, wrapper);
		return () => {
			ipcRenderer.removeListener(channel, wrapper);
			callbackWrappers.delete(callback);
		};
	},
	off: (channel, callback) => {
		if (!ALLOWED_EVENT_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
		const wrapper = callbackWrappers.get(callback);
		if (wrapper) {
			ipcRenderer.removeListener(channel, wrapper);
			callbackWrappers.delete(callback);
		}
	}
});
//#endregion
