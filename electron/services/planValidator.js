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
    throw new Error('Plan validator received an empty response');
  }

  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Unable to parse validator JSON');
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

async function validatePlan({ planFiles, designArtifacts, specContent, modelConfig } = {}) {
  const resolvedModel = { ...DEFAULT_MODEL_CONFIG, ...(modelConfig || {}) };
  // Normalize to candidates array
  const candidates = resolvedModel.candidates || [resolvedModel];
  const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
  
  const systemPrompt = [
    'You are NORD\'s plan validator.',
    'Evaluate the provided engineering plan files and return only JSON using this schema:',
    '{"score":0-100,"issues":[{"type":"mapping|completeness|consistency|overengineering|underengineering","description":"","file":""}],"missing":[{"expected":"","source":""}]}',
    'Assess exactly these 5 areas with weights:',
    '1. Mapping (25%) — Every UI screen maps to a system module, every interaction maps to backend logic',
    '2. Completeness (25%) — All 7 plan files present, no placeholder sections, no "TBD"',
    '3. Consistency (20%) — No contradictions between files (e.g., API contract matches backend plan)',
    '4. Over-engineering (15%) — No unnecessary services, no premature optimization, YAGNI compliance',
    '5. Under-engineering (15%) — No vague sections, no "standard approach", every decision is specific',
    'Be strict. Penalize generic boilerplate and vague architecture decisions.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    planFiles: planFiles || {},
    designArtifacts: designArtifacts || '',
    specContent: specContent || '',
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
  const missing = Array.isArray(parsed?.missing)
    ? parsed.missing
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({
          expected: String(m.expected || ''),
          source: String(m.source || ''),
        }))
    : [];

  return { score, pass: score >= 85, issues, missing };
}

function classifyPlanFailure(issues = []) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return { source: 'completeness', action: 'rerun_all', affected_files: [] };
  }

  const counters = new Map();
  const order = [];
  const filesByKey = new Map();

  for (const issue of issues) {
    const type = String(issue?.type || '').toLowerCase();
    const file = String(issue?.file || '');
    let classification = { source: 'completeness', action: 'rerun_all' };

    if (type === 'mapping') {
      classification = { source: 'mapping', action: 'rerun_component_map' };
    } else if (type === 'completeness') {
      classification = { source: 'completeness', action: 'rerun_missing' };
    } else if (type === 'consistency') {
      classification = { source: 'consistency', action: 'rerun_cross_reference' };
    } else if (type === 'overengineering') {
      classification = { source: 'overengineering', action: 'cto_prune' };
    } else if (type === 'underengineering') {
      classification = { source: 'underengineering', action: 'rerun_vague' };
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

module.exports = { validatePlan, classifyPlanFailure };
