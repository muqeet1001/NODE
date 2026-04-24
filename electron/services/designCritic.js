// ─────────────────────────────────────────────────────────────
// designCritic.js — Evaluates design output against the
// project-specific Design DNA and Quality Bar.
// Stage 2: Upgraded rubric (100-point scale), hard fail
// conditions, rerun_targets, DESIGN_REVIEW output format.
// ─────────────────────────────────────────────────────────────

const SCORE_RUBRIC = {
  intent_alignment: 20,
  design_dna_fidelity: 20,
  visual_polish: 20,
  ux_clarity: 15,
  accessibility: 10,
  token_consistency: 10,
  implementation_readiness: 5,
};

/**
 * Hard-fail patterns. If any match, force score < 80 and fail.
 */
const HARD_FAIL_PATTERNS = [
  { pattern: /lorem ipsum/i, reason: 'Contains placeholder lorem ipsum content' },
  { pattern: /placeholder\s+(?:text|image|icon)/i, reason: 'Contains placeholder elements' },
  { pattern: /(?:^|\s)TODO(?:\s|$)/i, reason: 'Contains unresolved TODO markers' },
  { pattern: /generic\s+saas/i, reason: 'Self-describes as generic SaaS' },
];

/**
 * Anti-slop patterns. Each deducts points from visual_polish.
 */
const ANTI_SLOP_PATTERNS = [
  { pattern: /(?:clean|modern|minimal)\s+design/i, deduct: 5, reason: 'Vague "modern clean" language' },
  { pattern: /(?:sleek|beautiful|stunning)\s+(?:ui|interface|design)/i, deduct: 3, reason: 'Filler praise words' },
  { pattern: /(?:inter|roboto|arial)\s*,?\s*sans-serif/i, deduct: 3, reason: 'Default font stack without justification' },
  { pattern: /#(?:6366f1|8b5cf6|7c3aed|4f46e5)/i, deduct: 3, reason: 'Default purple/violet without justification' },
  { pattern: /🎨|🚀|✨|💡|🎯|📊|⚡/g, deduct: 2, reason: 'Emoji decoration in design output' },
];

/**
 * Evaluate a design output and produce a score and issues list.
 *
 * @param {Object} params
 * @param {string} params.design - The consolidated design output
 * @param {Object} [params.tokens] - Design tokens for consistency checking
 * @param {string|Array} [params.references] - Reference analysis for alignment
 * @param {string} [params.patterns] - UI patterns output
 * @param {Object} [params.modelConfig] - Model config (unused for rule-based critic)
 * @returns {{ score: number, pass: boolean, issues: Object[], summary: string, rerun_targets: string[], user_safe_summary: string }}
 */
function evaluateDesign({ design, tokens, references, patterns, modelConfig }) {
  if (!design || typeof design !== 'string' || design.trim().length < 50) {
    return {
      score: 0,
      pass: false,
      issues: [{ type: 'generic', severity: 'blocking', description: 'No design content to evaluate', recommended_action: 'rerun_visual_system' }],
      summary: 'No design content provided',
      rerun_targets: ['design_visual_system', 'design_ui_pattern', 'design_ux_flow'],
      best_variant: null,
      user_safe_summary: 'Design output was empty. Retrying.',
    };
  }

  const issues = [];
  const scores = { ...SCORE_RUBRIC }; // Start with max points per dimension
  let hardFailed = false;

  // ── Hard fail checks ──────────────────────────────────────
  for (const { pattern, reason } of HARD_FAIL_PATTERNS) {
    if (pattern.test(design)) {
      hardFailed = true;
      issues.push({
        type: 'generic',
        severity: 'blocking',
        description: reason,
        recommended_action: 'rerun_screen_variant',
      });
    }
  }

  // ── Anti-slop checks ──────────────────────────────────────
  for (const { pattern, deduct, reason } of ANTI_SLOP_PATTERNS) {
    const matches = design.match(pattern);
    if (matches) {
      scores.visual_polish = Math.max(0, scores.visual_polish - deduct);
      issues.push({
        type: 'visual_polish',
        severity: deduct >= 5 ? 'high' : 'medium',
        description: `${reason} (found ${matches.length}x)`,
        recommended_action: 'rerun_visual_system',
      });
    }
  }

  // ── Token consistency checks ──────────────────────────────
  if (tokens && typeof tokens === 'object') {
    const tokenStr = JSON.stringify(tokens);
    const tokenColors = (tokenStr.match(/#[0-9a-fA-F]{6}/g) || []).map(c => c.toLowerCase());
    const designColors = (design.match(/#[0-9a-fA-F]{6}/g) || []).map(c => c.toLowerCase());

    if (designColors.length > 0 && tokenColors.length > 0) {
      const tokenColorSet = new Set(tokenColors);
      const unmatchedColors = designColors.filter(c => !tokenColorSet.has(c));
      const unmatchedRatio = unmatchedColors.length / designColors.length;

      if (unmatchedRatio > 0.5) {
        scores.token_consistency = Math.max(0, scores.token_consistency - 6);
        issues.push({
          type: 'token_consistency',
          severity: 'high',
          description: `${unmatchedColors.length}/${designColors.length} colors in design don't match token values`,
          recommended_action: 'rerun_visual_system',
        });
      } else if (unmatchedRatio > 0.2) {
        scores.token_consistency = Math.max(0, scores.token_consistency - 3);
        issues.push({
          type: 'token_consistency',
          severity: 'medium',
          description: `${unmatchedColors.length} colors deviate from token system`,
          recommended_action: 'rerun_visual_system',
        });
      }
    }
  }

  // ── Structure checks ──────────────────────────────────────
  const hasNavigation = /nav|sidebar|menu|header|toolbar/i.test(design);
  const hasLayout = /grid|flex|layout|column|row|container/i.test(design);
  const hasResponsive = /responsive|mobile|tablet|breakpoint|@media/i.test(design);
  const hasAccessibility = /aria-|role=|focus|contrast|keyboard|screen.?reader/i.test(design);

  if (!hasNavigation) {
    scores.ux_clarity = Math.max(0, scores.ux_clarity - 5);
    issues.push({
      type: 'ux_clarity',
      severity: 'medium',
      description: 'No navigation pattern detected',
      recommended_action: 'rerun_ui_pattern',
    });
  }
  if (!hasLayout) {
    scores.ux_clarity = Math.max(0, scores.ux_clarity - 5);
    issues.push({
      type: 'ux_clarity',
      severity: 'medium',
      description: 'No layout structure detected',
      recommended_action: 'rerun_ui_pattern',
    });
  }
  if (!hasResponsive) {
    scores.accessibility = Math.max(0, scores.accessibility - 4);
    issues.push({
      type: 'accessibility',
      severity: 'medium',
      description: 'No responsive design indicators found',
      recommended_action: 'rerun_ui_pattern',
    });
  }
  if (!hasAccessibility) {
    scores.accessibility = Math.max(0, scores.accessibility - 3);
    issues.push({
      type: 'accessibility',
      severity: 'low',
      description: 'No accessibility attributes found',
      recommended_action: 'rerun_screen_variant',
    });
  }

  // ── Design DNA fidelity ───────────────────────────────────
  const hasConcreteColors = (design.match(/#[0-9a-fA-F]{6}/g) || []).length >= 3;
  const hasConcreteFont = /font-family:\s*['"][^'"]+['"]|fontFamily:\s*['"][^'"]+['"]/i.test(design);
  const hasConcreteSpacing = /\d+px|\d+rem|\d+em/i.test(design);

  if (!hasConcreteColors) {
    scores.design_dna_fidelity = Math.max(0, scores.design_dna_fidelity - 8);
    issues.push({
      type: 'design_dna',
      severity: 'high',
      description: 'Fewer than 3 concrete hex color values',
      recommended_action: 'rerun_visual_system',
    });
  }
  if (!hasConcreteFont) {
    scores.design_dna_fidelity = Math.max(0, scores.design_dna_fidelity - 5);
    issues.push({
      type: 'design_dna',
      severity: 'medium',
      description: 'No concrete font family specified',
      recommended_action: 'rerun_visual_system',
    });
  }
  if (!hasConcreteSpacing) {
    scores.design_dna_fidelity = Math.max(0, scores.design_dna_fidelity - 4);
    issues.push({
      type: 'design_dna',
      severity: 'medium',
      description: 'No concrete spacing values found',
      recommended_action: 'rerun_visual_system',
    });
  }

  // ── Implementation readiness ──────────────────────────────
  const hasHTML = /<html|<div|<section|<main/i.test(design);
  const hasCSS = /style=|className=|class=/i.test(design);
  if (!hasHTML && !hasCSS) {
    scores.implementation_readiness = Math.max(0, scores.implementation_readiness - 3);
  }

  // ── Compute final score ───────────────────────────────────
  let totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);

  if (hardFailed) {
    totalScore = Math.min(totalScore, 75);
  }

  const pass = totalScore >= 80;
  const strong = totalScore >= 88;

  // ── Determine rerun targets ───────────────────────────────
  const rerunTargets = [];
  const actionCounts = {};
  for (const issue of issues) {
    if (issue.recommended_action && issue.severity !== 'low') {
      actionCounts[issue.recommended_action] = (actionCounts[issue.recommended_action] || 0) + 1;
    }
  }
  for (const [action, count] of Object.entries(actionCounts)) {
    if (count >= 1) {
      const agentId = action.replace('rerun_', 'design_');
      if (!rerunTargets.includes(agentId)) {
        rerunTargets.push(agentId);
      }
    }
  }

  const summary = strong
    ? `Score: ${totalScore}/100 — Strong. Ready for user review.`
    : pass
      ? `Score: ${totalScore}/100 — Acceptable with ${issues.length} issue(s). Review recommended.`
      : `Score: ${totalScore}/100 — Below bar. ${issues.filter(i => i.severity === 'blocking' || i.severity === 'high').length} critical issue(s).`;

  const userSafeSummary = strong
    ? 'The design looks solid and ready for your review.'
    : pass
      ? 'The design is acceptable but has some areas that could be improved.'
      : 'The design needs more work before it can be shown. NORD is iterating.';

  return {
    score: totalScore,
    pass,
    issues,
    summary,
    rerun_targets: rerunTargets,
    best_variant: null,
    user_safe_summary: userSafeSummary,
  };
}

/**
 * Classify the root cause of critic issues and suggest a rerun action.
 * Stage 2: Expanded action types for 6 agents.
 *
 * @param {Object[]} issues - List of critic issues
 * @returns {{ action: string, affected_agents: string[], severity: string }}
 */
function classifyFailureSource(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return { action: 'approve', affected_agents: [], severity: 'none' };
  }

  const actionVotes = {};
  let maxSeverity = 'low';

  for (const issue of issues) {
    if (issue.recommended_action) {
      actionVotes[issue.recommended_action] = (actionVotes[issue.recommended_action] || 0) + 1;
    }
    if (issue.severity === 'blocking') maxSeverity = 'blocking';
    else if (issue.severity === 'high' && maxSeverity !== 'blocking') maxSeverity = 'high';
    else if (issue.severity === 'medium' && maxSeverity === 'low') maxSeverity = 'medium';
  }

  // Find most-voted action
  let topAction = 'approve';
  let topCount = 0;
  for (const [action, count] of Object.entries(actionVotes)) {
    if (count > topCount) {
      topAction = action;
      topCount = count;
    }
  }

  // Map actions to affected agents
  const agentMap = {
    rerun_visual_system: ['design_visual_system'],
    rerun_visual_ref: ['design_visual_system'], // Stage 2 redirect
    rerun_ui_pattern: ['design_ui_pattern'],
    rerun_ux_flow: ['design_ux_flow'],
    rerun_reference: ['design_competitor'],
    rerun_screen_variant: ['design_screen_variant'],
    design_head_decision_needed: [],
    approve: [],
    // Legacy Stage 1 actions
    rerun_pass1: ['design_ui_pattern'],
    rerun_pass2: ['design_visual_system', 'design_competitor'],
    rerun_pass3: ['design_ux_flow'],
  };

  return {
    action: topAction,
    affected_agents: agentMap[topAction] || [],
    severity: maxSeverity,
  };
}

module.exports = { evaluateDesign, classifyFailureSource };
