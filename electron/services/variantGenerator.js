const { runMultiPass, runSinglePass } = require('./multiPassEngine');
const { evaluateDesign } = require('./designCritic');
const { writeFileNested } = require('../ipc/fileSystem');

function toScreenSlug(screenName) {
  return String(screenName || 'screen')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'screen';
}

async function regenerateVariant(baseVariant, input, rerunPasses = []) {
  const orderedPasses = Array.from(new Set(rerunPasses)).sort((a, b) => a - b);
  let structure = baseVariant.structure || '';
  let styled = baseVariant.styled || '';
  let final = baseVariant.content || baseVariant.final || '';

  if (orderedPasses.includes(1)) {
    structure = await runSinglePass(1, {
      ...input,
      variantParams: baseVariant.variantParams,
    });
    styled = await runSinglePass(2, {
      ...input,
      variantParams: baseVariant.variantParams,
      structure,
      previousOutputs: { structure },
    });
    final = await runSinglePass(3, {
      ...input,
      variantParams: baseVariant.variantParams,
      styled,
      previousOutputs: { styled, structure },
    });
    return { structure, styled, final };
  }

  if (orderedPasses.includes(2)) {
    styled = await runSinglePass(2, {
      ...input,
      variantParams: baseVariant.variantParams,
      structure,
      previousOutputs: { structure },
    });
    final = await runSinglePass(3, {
      ...input,
      variantParams: baseVariant.variantParams,
      styled,
      previousOutputs: { styled, structure },
    });
    return { structure, styled, final };
  }

  if (orderedPasses.includes(3)) {
    final = await runSinglePass(3, {
      ...input,
      variantParams: baseVariant.variantParams,
      styled,
      previousOutputs: { styled, structure },
    });
    return { structure, styled, final };
  }

  return {
    structure,
    styled,
    final,
  };
}

async function generateVariants(input = {}) {
  const screenSlug = toScreenSlug(input.screenName);
  const variantDefs = [
    { emphasis: 'default', density: 'normal', hierarchy: 'standard' },
    { emphasis: 'compact', density: 'high', hierarchy: 'standard' },
    { emphasis: 'bold', density: 'normal', hierarchy: 'alternative' },
  ];

  const baseVariants = Array.isArray(input.baseVariants) ? input.baseVariants : [];
  const rerunPasses = Array.isArray(input.rerunPasses) ? input.rerunPasses : [];

  const variantResults = await Promise.all(
    variantDefs.map(async (variantParams, index) => {
      const existingVariant = baseVariants.find((variant) => Number(variant.variantIndex) === index + 1);
      let result = existingVariant && rerunPasses.length > 0
        ? await regenerateVariant(existingVariant, input, rerunPasses)
        : await runMultiPass({ ...input, variantParams });

      if (!existingVariant && rerunPasses.length > 0) {
        result = await regenerateVariant({
          structure: result.structure,
          styled: result.styled,
          content: result.final,
          variantParams,
        }, input, rerunPasses);
      }

      const critique = await evaluateDesign({
        design: result.final,
        tokens: input.tokens,
        references: input.references,
        patterns: input.patterns,
        modelConfig: input.criticModelConfig,
      });

      const writeResult = writeFileNested(input.projectPath, `design/variants/${screenSlug}_v${index + 1}.html`, result.final);
      if (!writeResult?.success) {
        throw new Error(writeResult?.error || 'Failed to write variant file');
      }

      return {
        content: result.final,
        structure: result.structure,
        styled: result.styled,
        score: critique.score,
        issues: critique.issues,
        variantIndex: index + 1,
        variantParams: existingVariant?.variantParams || variantParams,
        projectPath: input.projectPath,
        screenName: input.screenName,
        screenSlug,
        generationInput: {
          wireframes: input.wireframes,
          spec: input.spec,
          tokens: input.tokens,
          standards: input.standards,
          references: input.references,
          patterns: input.patterns,
          modelConfig: input.modelConfig,
          criticModelConfig: input.criticModelConfig,
          projectPath: input.projectPath,
          screenName: input.screenName,
        },
      };
    })
  );

  return variantResults;
}

async function selectBestVariant(variants = []) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return { selected: null, all: [] };
  }

  const sortedVariants = [...variants].sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = sortedVariants[0];
  const writeResult = writeFileNested(best.projectPath, `design/screens/${best.screenSlug}.html`, best.content || '');

  if (!writeResult?.success) {
    throw new Error(writeResult?.error || 'Failed to write selected screen');
  }

  return { selected: best, all: sortedVariants };
}

module.exports = { generateVariants, selectBestVariant };
