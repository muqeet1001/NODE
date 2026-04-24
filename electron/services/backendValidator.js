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
    throw new Error('Backend validator received an empty response');
  }

  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Unable to parse backend validator JSON');
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

async function validateBackend({ generatedCode, apiContracts, databaseSchema, modelConfig } = {}) {
  const resolvedModel = { ...DEFAULT_MODEL_CONFIG, ...(modelConfig || {}) };
  // Normalize to candidates array
  const candidates = resolvedModel.candidates || [resolvedModel];
  const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
  
  const systemPrompt = [
    'You are NORD\'s backend code validator.',
    'Evaluate the provided backend code files and return only JSON using this schema:',
    '{"score":0-100,"issues":[{"type":"api_coverage|db_mapping|logic_flow|contract_match|security_baseline","description":"","file":""}]}',
    'Assess exactly these 5 areas with weights:',
    '1. API Coverage (25%) — Every endpoint in api_contracts has a controller + route',
    '2. DB Mapping (25%) — Every table in database_schema has a model, relationships correct',
    '3. Logic Flow (20%) — Business logic in services not controllers, proper error handling',
    '4. Contract Match (15%) — Request/response shapes match api_contracts exactly',
    '5. Security Baseline (15%) — Auth middleware on protected routes, input validation, no SQL injection',
    'Be strict. Penalize missing endpoints, logic in controllers, and missing auth.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    generatedCode: generatedCode || {},
    apiContracts: apiContracts || '',
    databaseSchema: databaseSchema || '',
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
          type: String(issue.type || 'api_coverage'),
          description: String(issue.description || ''),
          file: String(issue.file || ''),
        }))
    : [];

  return { score, pass: score >= 85, issues };
}

function classifyBackendFailure(issues = []) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return { source: 'api_coverage', action: 'rerun_all', affected_files: [] };
  }

  const counters = new Map();
  const order = [];
  const filesByKey = new Map();

  for (const issue of issues) {
    const type = String(issue?.type || '').toLowerCase();
    const file = String(issue?.file || '');
    let classification = { source: 'api_coverage', action: 'rerun_all' };

    if (type === 'api_coverage') {
      classification = { source: 'api_coverage', action: 'rerun_controllers' };
    } else if (type === 'db_mapping') {
      classification = { source: 'db_mapping', action: 'rerun_models' };
    } else if (type === 'logic_flow') {
      classification = { source: 'logic_flow', action: 'rerun_services' };
    } else if (type === 'contract_match') {
      classification = { source: 'contract_match', action: 'rerun_controllers' };
    } else if (type === 'security_baseline') {
      classification = { source: 'security_baseline', action: 'rerun_middleware' };
    }

    const key = `${classification.source}:${classification.action}`;
    counters.set(key, (counters.get(key) || 0) + 1);
    if (!order.includes(key)) {
      order.push(key);
    }
    if (!filesByKey.has(key)) {
      filesByKey.set(key, new Set());
    }
    if (file) {
      filesByKey.get(key).add(file);
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

module.exports = { validateBackend, classifyBackendFailure };
