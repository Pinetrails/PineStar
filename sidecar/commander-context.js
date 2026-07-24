/* sidecar/commander-context.js — bounded server-side context composer for ordinary task runs.

   This is the common seam interactive COMMS and messaging channels can share. It composes only durable,
   provenance-labelled facts the harness can prove: active task brief, explicit dossier/goal text, and repeated
   task-decision patterns. It does not infer certainty and does not duplicate a dossier already present in the
   caller's system prompt. */
'use strict';

function clip(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
function compose(input) {
  input = input || {}; const lines = [];
  const b = input.brief;
  if (b && b.originalDirective) {
    lines.push('<task_brief id="' + clip(b.id, 100).replace(/["<>]/g, '') + '" status="' + clip(b.status, 20) + '">');
    lines.push('ORIGINAL REQUEST: ' + clip(b.originalDirective, 4000));
    for (const q of (b.questions || []).slice(-4)) {
      lines.push('DECISION: ' + clip(q.text, 240) + (q.answer ? (' => ' + clip(q.answer, 500)) : ' => unanswered'));
    }
    for (const a of (b.assumptions || []).slice(-6)) lines.push('ASSUMPTION: ' + clip(a, 300));
    lines.push('Continue this same task. Do not re-ask answered decisions. Verify the result against the original request and decisions.');
    lines.push('</task_brief>');
  }
  // TASK BRIEF v2 — recipe intake: the launching recipe's DECLARED material decisions (normalized by
  // recipes.js — dimension ∈ the taskbrief-policy set). Aims any mid-run question at the right dimension
  // even when the Commander skipped the launch chips; launch-tapped answers already ride the directive.
  const intake = Array.isArray(input.recipeIntake) ? input.recipeIntake.slice(0, 3) : [];
  if (intake.length) {
    lines.push('<recipe_intake provenance="recipe-declared">');
    lines.push('MATERIAL DECISIONS for this task type — resolve each from the request, launch decisions, or dossier before consequential work; if one is genuinely unresolved and material, it is THE thing to ask about. Default everything else:');
    for (const e of intake) {
      lines.push('- ' + clip(e.dimension, 24) + ': ' + clip(e.question, 160) + ' [' + (Array.isArray(e.options) ? e.options.map(o => clip(o, 72)).join(' | ') : '') + ']'
        + (e.recommended ? ' (suggested: ' + clip(e.recommended, 72) + (e.reason ? ' — ' + clip(e.reason, 160) : '') + ')' : ''));
    }
    lines.push('</recipe_intake>');
  }
  const dossier = clip(input.dossier, 5000), existing = String(input.existingSystem || '');
  if (dossier && existing.indexOf(dossier) < 0) lines.push('<commander_context provenance="commander-dossier">\n' + dossier + '\n</commander_context>');
  const goal = input.goal && (input.goal.title || input.goal.text || input.goal.goal);
  if (goal) lines.push('<active_goal provenance="commander-confirmed">' + clip(goal, 500) + '</active_goal>');
  // ASK-WORTHINESS: dimensions the Commander has repeatedly waved off with "use your judgment". The tool gate
  // (taskbrief-tools) refuses these outright; saying so here spends no turn discovering that, and names the
  // honest alternative — decide it, then surface the choice as a correctable assumption.
  const deferred = Array.isArray(input.deferredDimensions) ? input.deferredDimensions.slice(0, 8) : [];
  if (deferred.length) {
    lines.push('<deferred_decisions provenance="commander-observed">');
    lines.push('The Commander has repeatedly answered "use your judgment" on these decision dimensions: '
      + deferred.map(d => clip(d, 24)).join(', ') + '. Do NOT ask about them. Choose the most sensible reversible default and state it as a correctable assumption in brief_proceed.');
    lines.push('</deferred_decisions>');
  }
  const patterns = Array.isArray(input.patterns) ? input.patterns : [];
  if (patterns.length) {
    lines.push('<observed_task_patterns strength="weak; never override current instructions">');
    for (const p of patterns.slice(0, 5)) lines.push('- ' + clip(p.question, 180) + ' => ' + clip(p.answer, 240) + ' (' + Number(p.count || 0) + ' times)');
    lines.push('</observed_task_patterns>');
  }
  return lines.join('\n\n');
}

module.exports = { compose };
