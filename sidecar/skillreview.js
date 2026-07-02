/* sidecar/skillreview.js - background skill review loop helpers.

   This is intentionally small and conservative. The sidecar decides whether a
   completed run was substantial enough to review, builds a Hermes-style prompt,
   and index.js runs a quiet tool-restricted agent loop with only skill tools.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillreview = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function str(v) { return v == null ? '' : String(v); }

  function stats(messages) {
    let chars = 0, toolCalls = 0, userTurns = 0, assistantTurns = 0;
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m) continue;
      if (typeof m.content === 'string') chars += m.content.length;
      if (m.role === 'user') userTurns++;
      if (m.role === 'assistant') assistantTurns++;
      if (Array.isArray(m.tool_calls)) toolCalls += m.tool_calls.length;
    }
    return { chars, toolCalls, userTurns, assistantTurns };
  }

  function shouldReviewRun(result, opts) {
    opts = opts || {};
    if (opts.enabled === false) return false;
    if (!result || result.reason !== 'done') return false;
    const s = stats(result.messages);
    const minToolCalls = opts.minToolCalls == null ? 4 : opts.minToolCalls;
    const minTurns = opts.minTurns == null ? 8 : opts.minTurns;
    const minChars = opts.minChars == null ? 5000 : opts.minChars;
    return s.toolCalls >= minToolCalls || (result.turns || 0) >= minTurns || s.chars >= minChars;
  }

  function transcript(messages, cap) {
    cap = cap || 12000;
    const lines = [];
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) continue;
      let c = typeof m.content === 'string' ? m.content : '';
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) c += '\n[tool calls: ' + m.tool_calls.map(tc => tc && tc.function && tc.function.name).filter(Boolean).join(', ') + ']';
      if (c) lines.push(m.role.toUpperCase() + ': ' + c);
    }
    const body = lines.join('\n');
    return body.length > cap ? body.slice(body.length - cap) : body;
  }

  function buildPrompt(input) {
    input = input || {};
    const skills = Array.isArray(input.skills) ? input.skills : [];
    const loaded = Array.isArray(input.loadedSkills) ? input.loadedSkills : [];
    const managed = Array.isArray(input.managedSkills) ? input.managedSkills : [];
    const memories = Array.isArray(input.memories) ? input.memories : [];
    const skillLines = skills.length ? skills.map(s => '- ' + s.name + (s.summary ? ' -- ' + s.summary : '') + ' [' + (s.state || 'active') + ']').join('\n') : '(none)';
    const loadedLines = loaded.length ? loaded.map(s => '- ' + s.name + (s.summary ? ' -- ' + s.summary : '')).join('\n') : '(none)';
    const managedLines = managed.length ? managed.map(s => '- ' + s.name + ' (' + s.action + ')').join('\n') : '(none)';
    const memoryLines = memories.length ? memories.map(m => '- ' + (m.kind || 'note') + ': ' + str(m.content || m.body || '').replace(/\s+/g, ' ').slice(0, 220)).join('\n') : '(none)';
    return [
      'You are StarNet background skill review. Improve the agent skillbase after a completed run.',
      '',
      'Rules:',
      '- Be active: most substantial sessions should produce at least one skill update, but never invent a lesson.',
      '- Target class-level umbrella skills with rich SKILL.md bodies plus references/, templates/, scripts/, or assets/ support files.',
      '- Most useful reviews update an existing skill; prefer patching over creating duplicates.',
      '- Preference order: 1) patch a loaded skill, 2) patch an existing umbrella, 3) add a support file under an umbrella, 4) create a new class-level umbrella.',
      '- create a new skill only when no existing umbrella skill fits.',
      '- Skills capture how to do this class of task for this user. Memory captures facts/preferences/state.',
      '- Do not capture one-off facts, transient setup failures, random command output, or negative claims like "tool X is broken". Capture the fix or retry pattern instead.',
      '- If a loaded skill was wrong, missing a step, or stale, patch it now.',
      '- If two skills overlap, prefer widening one umbrella and archiving the narrow sibling.',
      '- Use skill.list, skill.view, and skill.manage. Do not answer the user; only maintain skills.',
      '',
      'Loaded skills this run, patch these first when relevant:',
      loadedLines,
      '',
      'Skills already managed this run:',
      managedLines,
      '',
      'Existing skills:',
      skillLines,
      '',
      'Recent durable memory context; do not duplicate this into skills unless it changes procedure:',
      memoryLines,
      '',
      'Completed run transcript:',
      transcript(input.messages, input.cap || 12000)
    ].join('\n');
  }

  return { stats, shouldReviewRun, buildPrompt };
});
