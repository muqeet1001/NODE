const { callModel } = require('../ipc/apiCaller');
const { readFileNested, writeFileNested } = require('../ipc/fileSystem');

const DEFAULT_MODEL_CONFIG = {
  provider: 'nvidia',
  model: 'moonshotai/kimi-k2-instruct',
  temperature: 0.2,
};

const TOKEN_SCHEMA = `{
  "colors": {
    "primary": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "background": { "primary": "#hex", "secondary": "#hex", "elevated": "#hex" },
    "text": { "primary": "#hex", "secondary": "#hex", "muted": "#hex" },
    "semantic": { "success": "#hex", "warning": "#hex", "error": "#hex", "info": "#hex" },
    "border": "#hex"
  },
  "typography": {
    "fontFamily": { "primary": "Font Name", "mono": "Font Name" },
    "fontSize": { "xs": "12px", "sm": "14px", "base": "16px", "lg": "18px", "xl": "20px", "2xl": "24px", "3xl": "30px" },
    "fontWeight": { "normal": 400, "medium": 500, "semibold": 600, "bold": 700 },
    "lineHeight": { "tight": 1.25, "normal": 1.5, "relaxed": 1.75 }
  },
  "spacing": {
    "unit": "4px",
    "scale": ["4px", "8px", "12px", "16px", "24px", "32px", "48px", "64px"]
  },
  "borderRadius": { "sm": "4px", "md": "8px", "lg": "12px", "xl": "16px", "full": "9999px" },
  "shadows": {
    "sm": "0 1px 2px rgba(0,0,0,0.05)",
    "md": "0 4px 6px rgba(0,0,0,0.1)",
    "lg": "0 10px 15px rgba(0,0,0,0.15)"
  }
}`;

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
    throw new Error('Model returned empty token payload');
  }

  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Unable to locate JSON object in token response');
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function collectColorErrors(node, path = 'colors', errors = []) {
  if (typeof node === 'string') {
    if (!/^#[0-9a-fA-F]{6}$/.test(node)) {
      errors.push(`${path} must be a valid 6-digit hex color`);
    }
    return errors;
  }

  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectColorErrors(value, `${path}.${key}`, errors);
    }
  }

  return errors;
}

function validateTokens(tokens) {
  const errors = [];
  const requiredKeys = ['colors', 'typography', 'spacing', 'borderRadius', 'shadows'];

  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return { valid: false, errors: ['Token payload must be a JSON object'] };
  }

  for (const key of requiredKeys) {
    if (!(key in tokens)) {
      errors.push(`Missing required key: ${key}`);
    }
  }

  if (tokens.colors) {
    collectColorErrors(tokens.colors, 'colors', errors);
  }

  const expectedScale = ['4px', '8px', '12px', '16px', '24px', '32px', '48px', '64px'];
  const actualScale = tokens?.spacing?.scale;
  if (!Array.isArray(actualScale) || actualScale.length !== expectedScale.length || actualScale.some((value, index) => value !== expectedScale[index])) {
    errors.push(`spacing.scale must exactly match ${JSON.stringify(expectedScale)}`);
  }

  const primaryColorCount = ['primary', 'secondary', 'accent']
    .map((key) => tokens?.colors?.[key])
    .filter(Boolean)
    .length;
  if (primaryColorCount > 3) {
    errors.push('Only 3 primary palette colors are allowed');
  }

  const primaryFont = tokens?.typography?.fontFamily?.primary;
  if (typeof primaryFont !== 'string' || primaryFont.trim().length === 0) {
    errors.push('typography.fontFamily.primary must be a non-empty concrete font name');
  } else if (/sans[- ]?serif|serif|monospace|display/i.test(primaryFont.trim()) && !/[A-Za-z]+\s+[A-Za-z]+/.test(primaryFont.trim())) {
    errors.push('typography.fontFamily.primary must be a concrete font family name');
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

function buildTokenPrompt(input, validationErrors = []) {
  return [
    'Extract and normalize design tokens from these design agent outputs.',
    'Return a single valid JSON object that exactly matches this schema:',
    TOKEN_SCHEMA,
    'Additional constraints:',
    '- Maximum 3 primary colors total: primary, secondary, accent.',
    '- spacing.scale must be exactly ["4px","8px","12px","16px","24px","32px","48px","64px"].',
    '- Font family names must be specific Google Fonts names.',
    '- Every color value must be a valid 6-digit hex code.',
    '- Do not wrap the JSON in markdown fences.',
    '',
    'Input context:',
    JSON.stringify({
      agentOutputs: input.agentOutputs || {},
      references: input.references || [],
      designDirection: input.designDirection || {},
    }, null, 2),
    validationErrors.length > 0
      ? `Previous validation errors to fix:\n${validationErrors.map((error) => `- ${error}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
}

async function generateDesignTokens(input = {}) {
  const modelConfig = { ...DEFAULT_MODEL_CONFIG, ...(input.modelConfig || {}) };
  // Normalize to candidates array
  const candidates = modelConfig.candidates || [modelConfig];
  const primary = candidates[0] || DEFAULT_MODEL_CONFIG;
  
  let validationErrors = [];
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await callModel({
        candidates,
        provider: primary.provider,
        model: primary.model,
        temperature: primary.temperature,
        systemPrompt: 'You are NORD\'s design token engine. Return only valid JSON.',
        messages: [{ role: 'user', content: buildTokenPrompt(input, validationErrors) }],
        onChunk: () => {},
      });

      const tokens = extractJson(normalizeModelContent(response));
      const validation = validateTokens(tokens);
      if (validation.valid) {
        return tokens;
      }

      validationErrors = validation.errors || [];
      lastError = new Error(validationErrors.join('; '));
    } catch (error) {
      lastError = error;
      validationErrors = [error.message];
    }
  }

  throw lastError || new Error('Failed to generate valid design tokens');
}

function buildStandardsContent(tokens) {
  const spacingScale = Array.isArray(tokens?.spacing?.scale) ? tokens.spacing.scale : [];

  return [
    '# Design Standards',
    '',
    '## Spacing Rules',
    `- Base unit: ${tokens?.spacing?.unit || '4px'}`,
    `- Approved scale: ${spacingScale.join(', ') || '4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px'}`,
    '- Use the approved scale only; avoid one-off spacing values.',
    '',
    '## Color Usage',
    `- Primary: ${tokens?.colors?.primary || '#000000'}`,
    `- Secondary: ${tokens?.colors?.secondary || '#000000'}`,
    `- Accent: ${tokens?.colors?.accent || '#000000'}`,
    `- Backgrounds: primary ${tokens?.colors?.background?.primary || '#000000'}, secondary ${tokens?.colors?.background?.secondary || '#000000'}, elevated ${tokens?.colors?.background?.elevated || '#000000'}`,
    `- Text: primary ${tokens?.colors?.text?.primary || '#000000'}, secondary ${tokens?.colors?.text?.secondary || '#000000'}, muted ${tokens?.colors?.text?.muted || '#000000'}`,
    '- Reserve semantic colors for system states and feedback only.',
    '',
    '## Typography Scale',
    `- Primary font: ${tokens?.typography?.fontFamily?.primary || 'Inter'}`,
    `- Mono font: ${tokens?.typography?.fontFamily?.mono || 'JetBrains Mono'}`,
    `- Sizes: ${Object.entries(tokens?.typography?.fontSize || {}).map(([key, value]) => `${key} ${value}`).join(', ')}`,
    `- Weights: ${Object.entries(tokens?.typography?.fontWeight || {}).map(([key, value]) => `${key} ${value}`).join(', ')}`,
    `- Line heights: ${Object.entries(tokens?.typography?.lineHeight || {}).map(([key, value]) => `${key} ${value}`).join(', ')}`,
    '',
    '## Application Rules',
    '- Maintain consistent border radius and shadow usage across components.',
    '- Preserve visual hierarchy with token-driven spacing and type scale before introducing additional decoration.',
    '- Accessibility adjustments should refine contrast and interaction feedback without introducing new palette values.',
    '',
  ].join('\n');
}

async function generateStandards(tokens, projectPath) {
  const existing = readFileNested(projectPath, 'design/standards.md');
  if (typeof existing === 'string' && existing.trim()) {
    return existing;
  }
  if (existing && typeof existing === 'object' && existing.success === false) {
    throw new Error(existing.error || 'Failed to read standards.md');
  }

  const content = buildStandardsContent(tokens);
  const writeResult = writeFileNested(projectPath, 'design/standards.md', content);
  if (!writeResult?.success) {
    throw new Error(writeResult?.error || 'Failed to write standards.md');
  }

  return content;
}

module.exports = { generateDesignTokens, validateTokens, generateStandards };
