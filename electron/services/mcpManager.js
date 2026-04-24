const { runMultiPass } = require('./multiPassEngine');

const DEFAULT_TIMEOUT_MS = 60000;

// ── Module-scoped executor registry (replaces global.__NORD_MCP_EXECUTORS__) ──
const executorRegistry = new Map();
const VALID_TASKS = new Set(['ui_generation', 'image_generation', 'design_generation']);
let frozen = false;

function registerExecutor(taskName, executorFn) {
  if (frozen) {
    throw new Error('Executor registry is frozen — cannot register after startup');
  }
  if (!VALID_TASKS.has(taskName)) {
    throw new Error(`Invalid MCP task: "${taskName}". Allowed: ${[...VALID_TASKS].join(', ')}`);
  }
  if (typeof executorFn !== 'function') {
    throw new Error(`Executor for "${taskName}" must be a function`);
  }
  executorRegistry.set(taskName, executorFn);
}

function freezeExecutors() {
  frozen = true;
}

function detectTools() {
  const tools = new Set();

  if (process.env.STITCH_MCP_CONNECTED === 'true') {
    tools.add('Stitch');
  }
  if (process.env.IMAGEN_MCP_CONNECTED === 'true') {
    tools.add('Imagen');
  }

  if (process.env.NORD_MCP_TOOLS) {
    process.env.NORD_MCP_TOOLS
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean)
      .forEach((tool) => tools.add(tool));
  }

  return Array.from(tools);
}

function getExecutor(task) {
  if (task === 'ui_generation') {
    return executorRegistry.get('ui_generation') || null;
  }
  if (task === 'image_generation') {
    return executorRegistry.get('image_generation') || null;
  }
  return null;
}

async function checkMCPStatus() {
  try {
    const tools = detectTools();
    return { connected: tools.length > 0, tools };
  } catch (_) {
    return { connected: false, tools: [] };
  }
}

async function executeMCP(task, context = {}) {
  const status = await checkMCPStatus();
  const timeoutMs = Number(context.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const executor = getExecutor(task);

  if (!status.connected || !executor) {
    if (context.preferAiFallback && task === 'ui_generation' && context.wireframes && context.spec) {
      const aiOutput = await runMultiPass(context);
      return { fallback: true, output: aiOutput.final, passes: aiOutput };
    }
    return { fallback: true };
  }

  const executionPromise = Promise.resolve().then(() => executor(context));
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ fallback: true }), timeoutMs);
  });

  const result = await Promise.race([executionPromise, timeoutPromise]);
  if (!result) {
    return { fallback: true };
  }

  if (result.partial || result.output) {
    return result;
  }

  return { fallback: true };
}

async function getMCPCapabilities() {
  const status = await checkMCPStatus();
  const toolNames = status.tools.map((tool) => tool.toLowerCase());
  return {
    tools: status.tools,
    capabilities: {
      ui_generation: toolNames.some((tool) => tool.includes('stitch') || tool.includes('ui')),
      image_generation: toolNames.some((tool) => tool.includes('imagen') || tool.includes('image')),
    },
  };
}

/**
 * Check for Stitch-specific MCP capabilities.
 * @returns {Promise<{ available: boolean, tools: string[] }>}
 */
async function getStitchCapabilities() {
  const status = await checkMCPStatus();
  const stitchTools = status.tools.filter((tool) =>
    tool.toLowerCase().includes('stitch') || tool.toLowerCase().includes('ui')
  );
  return {
    available: stitchTools.length > 0,
    tools: stitchTools,
  };
}

module.exports = { checkMCPStatus, executeMCP, getMCPCapabilities, registerExecutor, freezeExecutors, getStitchCapabilities };
