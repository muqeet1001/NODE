const { callModel } = require('../ipc/apiCaller');

const DEFAULT_MODEL_CONFIG = {
  provider: 'nvidia',
  model: 'moonshotai/kimi-k2-instruct',
  temperature: 0.2,
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

function stripCodeFences(content) {
  if (typeof content !== 'string') return '';
  const match = content.trim().match(/```(?:html)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : content.trim();
}

function buildVariantInstruction(variantParams = {}) {
  const parts = [];
  if (variantParams.emphasis) {
    parts.push(`Emphasis style: ${variantParams.emphasis}.`);
  }
  if (variantParams.density) {
    parts.push(`Density preference: ${variantParams.density}.`);
  }
  if (variantParams.hierarchy) {
    parts.push(`Hierarchy approach: ${variantParams.hierarchy}.`);
  }
  return parts.join(' ');
}

async function executePass(passNumber, input) {
  const modelConfig = { ...DEFAULT_MODEL_CONFIG, ...(input.modelConfig || {}) };
  // Normalize to candidates array
  const candidates = modelConfig.candidates || [modelConfig];
  const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
  
  const variantInstruction = buildVariantInstruction(input.variantParams);
  let systemPrompt = '';
  let userPrompt = '';

  if (passNumber === 1) {
    systemPrompt = [
      'You are NORD\'s multi-pass UI structure generator.',
      'Output layout structure in HTML.',
      'No colors, no styles, no CSS classes beyond semantic hooks.',
      'Only semantic sections, element hierarchy, and content placement.',
      'Return only HTML.',
    ].join('\n');
    userPrompt = [
      variantInstruction,
      'Wireframes:',
      input.wireframes || '',
      '',
      'Spec:',
      input.spec || '',
    ].filter(Boolean).join('\n');
  }

  if (passNumber === 2) {
    const structure = input.structure || input.previousOutputs?.structure;
    if (!structure) {
      throw new Error('Pass 2 requires structure HTML');
    }
    systemPrompt = [
      'You are NORD\'s multi-pass styling engine.',
      'Apply the provided design tokens to this HTML structure.',
      'Add colors, typography, spacing, border radius, and shadows.',
      'Do not change layout, semantic structure, or element order.',
      'Return only HTML.',
    ].join('\n');
    userPrompt = [
      'Structure HTML:',
      structure,
      '',
      'Design tokens:',
      JSON.stringify(input.tokens || {}, null, 2),
    ].join('\n');
  }

  if (passNumber === 3) {
    const styled = input.styled || input.previousOutputs?.styled;
    if (!styled) {
      throw new Error('Pass 3 requires styled HTML');
    }
    systemPrompt = [
      'You are NORD\'s UI polish pass.',
      'Refine spacing, add micro-interactions, improve accessibility, and tighten implementation detail.',
      'Do not change colors or layout.',
      'Return only HTML.',
    ].join('\n');
    userPrompt = [
      'Styled HTML:',
      styled,
      '',
      'Standards:',
      input.standards || '',
    ].join('\n');
  }

  const response = await callModel({
    candidates,
    provider: primary.provider,
    model: primary.model,
    temperature: primary.temperature,
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    onChunk: () => {},
  });

  return stripCodeFences(normalizeModelContent(response));
}

async function runMultiPass(input = {}) {
  const structure = await executePass(1, input);
  const styled = await executePass(2, { ...input, structure, previousOutputs: { structure } });
  const final = await executePass(3, { ...input, structure, styled, previousOutputs: { structure, styled } });

  return { structure, styled, final };
}

async function runSinglePass(passNumber, input = {}) {
  return executePass(passNumber, input);
}

module.exports = { runMultiPass, runSinglePass };
