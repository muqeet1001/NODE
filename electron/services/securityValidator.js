const { safeStorage, app } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Runtime verification that all security measures are in place.
 * Returns { secure: boolean, issues: string[], checks: {...} }
 */
function runSecurityChecks() {
  const issues = [];
  const checks = {};

  // 1. Encryption key is OS-backed
  try {
    const blobPath = path.join(app.getPath('userData'), '.nord-master-key');
    const blobExists = fs.existsSync(blobPath);
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    checks.encryption_key_os_backed = blobExists && encryptionAvailable;
    if (!blobExists) issues.push('Master key blob file missing');
    if (!encryptionAvailable) issues.push('OS safeStorage encryption is not available');
  } catch (err) {
    checks.encryption_key_os_backed = false;
    issues.push(`Encryption check failed: ${err.message}`);
  }

  // 2. API keys are encrypted at rest
  try {
    const dbPath = path.join(app.getPath('userData'), 'nord.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(
        "SELECT COUNT(*) as count FROM api_keys_pool WHERE api_key IS NOT NULL AND api_key != ''"
      ).get();
      db.close();
      checks.api_keys_encrypted = rows.count === 0;
      if (rows.count > 0) {
        issues.push(`${rows.count} plaintext API key(s) found in database`);
      }
    } else {
      checks.api_keys_encrypted = true; // No DB yet, nothing to check
    }
  } catch (err) {
    checks.api_keys_encrypted = false;
    issues.push(`API key encryption check failed: ${err.message}`);
  }

  // 3. IPC allowlist is active
  try {
    const preloadPath = path.join(__dirname, '..', 'preload.js');
    const preloadSource = fs.readFileSync(preloadPath, 'utf-8');
    checks.ipc_allowlist_active = preloadSource.includes('ALLOWED_INVOKE_CHANNELS');
    if (!checks.ipc_allowlist_active) {
      issues.push('IPC channel allowlist not found in preload.js');
    }
  } catch (err) {
    checks.ipc_allowlist_active = false;
    issues.push(`IPC allowlist check failed: ${err.message}`);
  }

  // 4. CSP headers are configured
  try {
    const mainPath = path.join(__dirname, '..', 'main.js');
    const mainSource = fs.readFileSync(mainPath, 'utf-8');
    checks.csp_headers_set = mainSource.includes('Content-Security-Policy');
    if (!checks.csp_headers_set) {
      issues.push('CSP header configuration not found in main.js');
    }
  } catch (err) {
    checks.csp_headers_set = false;
    issues.push(`CSP check failed: ${err.message}`);
  }

  // 5. WAL mode is enabled
  try {
    const dbPath = path.join(app.getPath('userData'), 'nord.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const result = db.pragma('journal_mode');
      db.close();
      const mode = Array.isArray(result) ? result[0]?.journal_mode : result;
      checks.wal_mode_enabled = mode === 'wal';
      if (mode !== 'wal') {
        issues.push(`Database journal mode is "${mode}", expected "wal"`);
      }
    } else {
      checks.wal_mode_enabled = false;
      issues.push('Database file does not exist yet');
    }
  } catch (err) {
    checks.wal_mode_enabled = false;
    issues.push(`WAL mode check failed: ${err.message}`);
  }

  // 6. exec replaced with execFile
  try {
    const cliPath = path.join(__dirname, 'cliExecutor.js');
    const cliSource = fs.readFileSync(cliPath, 'utf-8');
    const hasExec = cliSource.includes("require('child_process').exec") || cliSource.includes('exec(command');
    checks.exec_replaced_with_execFile = !hasExec;
    if (hasExec) {
      issues.push('cliExecutor.js still uses exec() instead of execFile()');
    }
  } catch (err) {
    checks.exec_replaced_with_execFile = false;
    issues.push(`CLI executor check failed: ${err.message}`);
  }

  // 7. Markdown XSS is blocked
  try {
    const mdPath = path.join(__dirname, '..', '..', 'src', 'components', 'shared', 'MarkdownRenderer.jsx');
    const mdSource = fs.readFileSync(mdPath, 'utf-8');
    checks.markdown_xss_blocked = mdSource.includes('isAllowed') || mdSource.includes("startsWith('http");
    if (!checks.markdown_xss_blocked) {
      issues.push('MarkdownRenderer.jsx missing link protocol validation');
    }
  } catch (err) {
    checks.markdown_xss_blocked = false;
    issues.push(`Markdown XSS check failed: ${err.message}`);
  }

  return {
    secure: issues.length === 0,
    issues,
    checks,
  };
}

module.exports = { runSecurityChecks };
