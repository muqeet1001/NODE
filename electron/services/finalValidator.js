const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const Database = require('better-sqlite3');
const { runSecurityChecks } = require('./securityValidator');
const { validateOptimizations } = require('./optimizationValidator');
const rotator = require('../ipc/keyRotator');
const { saveProject, getProject, saveConversation, getConversations, deleteProject } = require('../ipc/dbHandler');

const EXPECTED_TABLES = ['projects', 'conversations', 'agent_runs', 'model_config', 'api_keys_pool', 'key_model_state'];

/**
 * Final production readiness validator.
 * Runs all subsystem checks and returns a comprehensive report.
 */
async function runFinalValidation() {
  const checks = {};
  const issues = [];

  // ── Check 1: Security ────────────────────────────────────
  try {
    const secResult = runSecurityChecks();
    checks.security = { pass: secResult.secure, detail: secResult };
    if (!secResult.secure) {
      issues.push(`Security: ${secResult.issues.join(', ')}`);
    }
  } catch (err) {
    checks.security = { pass: false, detail: err.message };
    issues.push(`Security check threw: ${err.message}`);
  }

  // ── Check 2: Optimization ────────────────────────────────
  try {
    const optResult = await validateOptimizations();
    checks.optimization = { pass: optResult.improved, detail: optResult };
    if (!optResult.improved) {
      issues.push('Optimization: regressions detected');
    }
  } catch (err) {
    checks.optimization = { pass: false, detail: err.message };
    issues.push(`Optimization check threw: ${err.message}`);
  }

  // ── Check 3: DB Schema ───────────────────────────────────
  try {
    const dbPath = path.join(app.getPath('userData'), 'nord.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
      db.close();

      const missingTables = EXPECTED_TABLES.filter((t) => !tables.includes(t));
      const hasIndexes = indexes.length >= 4;

      checks.db_schema = { pass: missingTables.length === 0 && hasIndexes, detail: { tables, indexes, missingTables } };
      if (missingTables.length > 0) issues.push(`DB: missing tables: ${missingTables.join(', ')}`);
      if (!hasIndexes) issues.push(`DB: only ${indexes.length} custom indexes (expected ≥4)`);
    } else {
      checks.db_schema = { pass: false, detail: 'Database file does not exist' };
      issues.push('DB: database file not found');
    }
  } catch (err) {
    checks.db_schema = { pass: false, detail: err.message };
    issues.push(`DB schema check threw: ${err.message}`);
  }

  // ── Check 4: IPC Handlers ────────────────────────────────
  try {
    const mainPath = path.join(__dirname, '..', 'main.js');
    const mainSource = fs.readFileSync(mainPath, 'utf-8');
    const required = ['registerDbHandlers', 'registerApiHandlers', 'registerAgentHandlers', 'registerFileHandlers', 'registerCtoHandlers'];
    const missing = required.filter((h) => !mainSource.includes(h));
    checks.ipc_handlers = { pass: missing.length === 0, detail: { missing } };
    if (missing.length > 0) issues.push(`IPC: missing handlers: ${missing.join(', ')}`);
  } catch (err) {
    checks.ipc_handlers = { pass: false, detail: err.message };
    issues.push(`IPC handler check threw: ${err.message}`);
  }

  // ── Check 5: Preload Allowlist ───────────────────────────
  try {
    const preloadPath = path.join(__dirname, '..', 'preload.js');
    const preloadSource = fs.readFileSync(preloadPath, 'utf-8');
    const hasAllowlist = preloadSource.includes('ALLOWED_INVOKE_CHANNELS');
    checks.preload_allowlist = { pass: hasAllowlist };
    if (!hasAllowlist) issues.push('Preload: ALLOWED_INVOKE_CHANNELS not found');
  } catch (err) {
    checks.preload_allowlist = { pass: false, detail: err.message };
    issues.push(`Preload check threw: ${err.message}`);
  }

  // ── Check 6: CSP Headers ────────────────────────────────
  try {
    const mainPath = path.join(__dirname, '..', 'main.js');
    const mainSource = fs.readFileSync(mainPath, 'utf-8');
    const hasCSP = mainSource.includes('Content-Security-Policy');
    checks.csp_headers = { pass: hasCSP };
    if (!hasCSP) issues.push('CSP: Content-Security-Policy not configured');
  } catch (err) {
    checks.csp_headers = { pass: false, detail: err.message };
    issues.push(`CSP check threw: ${err.message}`);
  }

  // ── Check 7: Key Rotator ────────────────────────────────
  try {
    const keys = rotator.keys || {};
    const hasGroq = Array.isArray(keys.groq);
    const hasNvidia = Array.isArray(keys.nvidia);
    const hasOpenrouter = Array.isArray(keys.openrouter);
    checks.key_rotator = { pass: hasGroq && hasNvidia && hasOpenrouter, detail: { groq: hasGroq, nvidia: hasNvidia, openrouter: hasOpenrouter } };
    if (!checks.key_rotator.pass) issues.push('Key rotator: some provider key arrays missing');
  } catch (err) {
    checks.key_rotator = { pass: false, detail: err.message };
    issues.push(`Key rotator check threw: ${err.message}`);
  }

  // ── Check 8: Smoke Test ─────────────────────────────────
  try {
    const testId = '__final_validator__' + Date.now();
    saveProject({ id: testId, name: 'Test Project', path: '/tmp/test', current_phase: 1, status: 'active' });
    const retrieved = getProject(testId);
    saveConversation(testId, 'system', 'test message');
    const convos = getConversations(testId);
    deleteProject(testId);

    const roundTrip = retrieved && retrieved.id === testId && Array.isArray(convos);
    checks.smoke_test = { pass: roundTrip };
    if (!roundTrip) issues.push('Smoke test: DB round-trip failed');
  } catch (err) {
    checks.smoke_test = { pass: false, detail: err.message };
    issues.push(`Smoke test threw: ${err.message}`);
  }

  return {
    ready: issues.length === 0,
    issues,
    checks,
  };
}

module.exports = { runFinalValidation };
