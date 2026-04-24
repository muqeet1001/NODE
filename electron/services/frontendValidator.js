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
    throw new Error('Frontend validator received an empty response');
  }

  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Unable to parse frontend validator JSON');
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

async function validateFrontend({ generatedCode, wireframes, tokens, apiContracts, modelConfig } = {}) {
  const resolvedModel = { ...DEFAULT_MODEL_CONFIG, ...(modelConfig || {}) };
  // Normalize to candidates array
  const candidates = resolvedModel.candidates || [resolvedModel];
  const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
  
  const systemPrompt = [
    'You are NORD\'s frontend code validator.',
    'Evaluate the provided frontend code files and return only JSON using this schema:',
    '{"score":0-100,"issues":[{"type":"design_match|token_usage|api_linkage|completeness|code_quality","description":"","file":""}]}',
    'Assess exactly these 5 areas with weights:',
    '1. Design Match (25%) — Components match wireframes layout, all screens present',
    '2. Token Usage (25%) — Every color, spacing, typography uses design tokens, no hardcoded values',
    '3. API Linkage (20%) — API calls match api_contracts.md exactly (method, path, request/response)',
    '4. Completeness (15%) — All components from component_map exist, no stubs or TODOs',
    '5. Code Quality (15%) — Proper imports, no dead code, consistent patterns, accessibility',
    'Be strict. Penalize hardcoded CSS values and missing components.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    generatedCode: generatedCode || {},
    wireframes: wireframes || '',
    tokens: tokens || '',
    apiContracts: apiContracts || '',
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
          type: String(issue.type || 'completeness'),
          description: String(issue.description || ''),
          file: String(issue.file || ''),
        }))
    : [];

  return { score, pass: score >= 85, issues };
}

function classifyFrontendFailure(issues = []) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return { source: 'completeness', action: 'rerun_missing', affected_files: [] };
  }

  const counters = new Map();
  const order = [];
  const filesByKey = new Map();

  for (const issue of issues) {
    const type = String(issue?.type || '').toLowerCase();
    const file = String(issue?.file || '');
    let classification = { source: 'completeness', action: 'rerun_missing' };

    if (type === 'design_match') {
      classification = { source: 'design_match', action: 'rerun_pass1' };
    } else if (type === 'token_usage') {
      classification = { source: 'token_usage', action: 'rerun_pass2' };
    } else if (type === 'api_linkage') {
      classification = { source: 'api_linkage', action: 'rerun_pass3' };
    } else if (type === 'completeness') {
      classification = { source: 'completeness', action: 'rerun_missing' };
    } else if (type === 'code_quality') {
      classification = { source: 'code_quality', action: 'rerun_pass4' };
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

module.exports = { validateFrontend, classifyFrontendFailure };
