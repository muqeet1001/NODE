const { execFile } = require('child_process');

const ALLOWED_BINARIES = new Set([
  'gemini', 'openrouter', 'npx', 'npm', 'node', 'git',
  'pnpm', 'yarn', 'bun', 'deno',
]);

const DESTRUCTIVE_PATTERNS = [
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
  /\$\(/,
];

const SHELL_METACHARACTERS = /[;&|(){}<>]/;

/**
 * Parse a command string into [binary, ...args], respecting quoted strings.
 */
function parseCommand(commandStr) {
  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < commandStr.length; i++) {
    const ch = commandStr[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Validate that no argument contains shell metacharacters or backticks.
 */
function validateArgs(args) {
  for (const arg of args) {
    if (SHELL_METACHARACTERS.test(arg)) return false;
    if (arg.includes('`')) return false;
  }
  return true;
}

function runCLI({ command, purpose, expectedOutput, timeoutMs, fallbackToAgents } = {}) {
  return new Promise((resolve) => {
    if (!command || typeof command !== 'string') {
      return resolve({
        success: false,
        output: '',
        error: 'No command provided',
        fallbackTriggered: false,
      });
    }

    // Parse the first token (binary name) for allowlist check
    const firstToken = command.trim().split(/\s+/)[0];
    const binaryName = firstToken.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '');

    if (!ALLOWED_BINARIES.has(binaryName)) {
      return resolve({
        success: false,
        output: '',
        error: `Binary "${binaryName}" is not in the allowlist. Allowed: ${[...ALLOWED_BINARIES].join(', ')}`,
        fallbackTriggered: Boolean(fallbackToAgents),
      });
    }

    // Check for destructive patterns on the full original command
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) {
        return resolve({
          success: false,
          output: '',
          error: `Destructive command blocked: "${command}" matches pattern ${pattern}`,
          fallbackTriggered: Boolean(fallbackToAgents),
        });
      }
    }

    // Parse command into binary + args
    const parsed = parseCommand(command.trim());
    if (parsed.length === 0) {
      return resolve({
        success: false,
        output: '',
        error: 'Empty command after parsing',
        fallbackTriggered: false,
      });
    }

    const [binary, ...args] = parsed;

    // Validate args for shell metacharacters
    if (!validateArgs(args)) {
      return resolve({
        success: false,
        output: '',
        error: 'Blocked: arguments contain shell metacharacters',
        fallbackTriggered: Boolean(fallbackToAgents),
      });
    }

    // Execute with execFile (no shell interpretation)
    const timeout = timeoutMs || 60000;

    execFile(binary, args, { timeout }, (error, stdout, stderr) => {
      // Strip ANSI escape codes
      const stripAnsi = (str) => (str || '').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      const cleanStdout = stripAnsi(stdout);
      const cleanStderr = stripAnsi(stderr);

      if (error) {
        if (fallbackToAgents) {
          return resolve({
            success: false,
            output: '',
            error: error.message,
            fallbackTriggered: true,
          });
        }
        return resolve({
          success: false,
          output: cleanStdout,
          error: cleanStderr || error.message,
          fallbackTriggered: false,
        });
      }

      resolve({
        success: true,
        output: cleanStdout,
        error: cleanStderr || null,
        fallbackTriggered: false,
      });
    });
  });
}

module.exports = { runCLI };
