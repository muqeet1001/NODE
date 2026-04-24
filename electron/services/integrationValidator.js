const { callModel } = require('../ipc/apiCaller');

const DEFAULT_MODEL_CONFIG = {
  provider: 'nvidia',
  model: 'moonshotai/kimi-k2-instruct',
  temperature: 0.1,
};

function normalizeModelContent(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    if (result.error) {
      throw new Error(result.error);
    }
    if (typeof result.content === 'string') return result.content;
  }
  return '';
}

function extractJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Integration validator received an empty response');
  }

  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Unable to parse integration validator JSON');
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

async function validateIntegration({ frontendCode, backendCode, apiContracts, databaseSchema, componentMap, modelConfig } = {}) {
  const resolvedModel = { ...DEFAULT_MODEL_CONFIG, ...(modelConfig || {}) };
  // Normalize to candidates array
  const candidates = resolvedModel.candidates || [resolvedModel];
  const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
  
  const systemPrompt = [
    'You are NORD\'s integration validator.',
    'Evaluate the provided frontend and backend code for integration correctness.',
    'Return only JSON using this schema:',
    '{"score":0-100,"issues":[{"type":"api_wiring|data_flow|auth_flow|error_handling|consistency","severity":"critical|warning","description":"","frontend_file":"","backend_file":""}]}',
    'Assess exactly these 5 areas with weights:',
    '1. API Wiring (30%) — Every frontend API call matches a backend route (method, path, request/response shapes)',
    '2. Data Flow (30%) — Data round-trips correctly: UI → API → DB → API → UI for every feature',
    '3. Auth Flow (20%) — Login, token handling, protected route guards, auth middleware all connected',
    '4. Error Handling (10%) — Frontend and backend share error format, error states rendered',
    '5. Consistency (10%) — No orphan routes (backend routes with no frontend caller), no dead services',
    'Be strict. Penalize any mismatched field names, wrong HTTP methods, or missing auth guards.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    frontendCode: frontendCode || {},
    backendCode: backendCode || {},
    apiContracts: apiContracts || '',
    databaseSchema: databaseSchema || '',
    componentMap: componentMap || '',
  }, null, 2);

  const response = await callModel({
    candidates,
    provider: primary.provider,
    model: primary.model,
    temperature: primary.temperature,
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    onChunk: () => {},
  });

  const parsed = extractJson(normalizeModelContent(response));
  const score = Math.max(0, Math.min(100, Number(parsed?.score) || 0));
  const issues = Array.isArray(parsed?.issues)
    ? parsed.issues
        .filter((issue) => issue && typeof issue === 'object')
        .map((issue) => ({
          type: String(issue.type || 'consistency'),
          severity: String(issue.severity || 'warning'),
          description: String(issue.description || ''),
          frontend_file: String(issue.frontend_file || ''),
          backend_file: String(issue.backend_file || ''),
        }))
    : [];

  return { score, pass: score >= 85, issues };
}

function classifyIntegrationFailure(issues = []) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return { source: 'consistency', action: 'cto_prune', affected_files: [] };
  }

  const counters = new Map();
  const order = [];
  const filesByKey = new Map();

  for (const issue of issues) {
    const type = String(issue?.type || '').toLowerCase();
    const frontendFile = String(issue?.frontend_file || '');
    const backendFile = String(issue?.backend_file || '');
    let classification = { source: 'consistency', action: 'cto_prune' };

    if (type === 'api_wiring') {
      classification = { source: 'api_wiring', action: 'rerun_api_connector' };
    } else if (type === 'data_flow') {
      classification = { source: 'data_flow', action: 'rerun_data_flow' };
    } else if (type === 'auth_flow') {
      classification = { source: 'auth_flow', action: 'rerun_auth_flow' };
    } else if (type === 'error_handling') {
      classification = { source: 'error_handling', action: 'rerun_api_connector' };
    } else if (type === 'consistency') {
      classification = { source: 'consistency', action: 'cto_prune' };
    }

    const key = `${classification.source}:${classification.action}`;
    counters.set(key, (counters.get(key) || 0) + 1);
    if (!order.includes(key)) {
      order.push(key);
    }
    if (!filesByKey.has(key)) {
      filesByKey.set(key, new Set());
    }
    if (frontendFile) {
      filesByKey.get(key).add(frontendFile);
    }
    if (backendFile) {
      filesByKey.get(key).add(backendFile);
    }
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

  const [source, action] = selectedKey.split(':');
  const affected_files = Array.from(filesByKey.get(selectedKey) || []);
  return { source, action, affected_files };
}

module.exports = { validateIntegration, classifyIntegrationFailure };
