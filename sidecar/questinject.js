/* sidecar/questinject.js — fold an agent's OPEN quests (the harness-owned QUEST LEDGER, quest-store.js) into its
   system prompt as a `STATION QUESTS` block, so a run can SEE and ACT ON its quests (QUEST V2, plan §B — agent
   awareness). The v1 system had zero agent visibility: nothing in the prompt, no tool — asking an agent about a
   quest could never work. This is the read half; the write half is the quest.update tool (tools/builtin/quests.js).

   Two functions, mirroring dossierinject.js exactly:
     questBlock(quests) — format an array of open quest records into the STATION QUESTS block, or '' when empty.
     withQuests(system, block) — append the block to a system prompt; an empty/whitespace block is a STRICT no-op
       (byte-identical to a quest-less run — the invariant the cron no-op tests depend on). Idempotent.

   PURE (a `withQuests`/`questBlock` on the SK namespace in the browser UMD shape, module.exports under node) +
   node-testable: no Date.now / Math.random / fs / network — exactly what lint-determinism.js requires of a helper
   that rides the run-composition path. The caller passes questStore.openForAgent(agentId); this never reads a store. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).questInject = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // keep the whole block bounded so a large open ledger can't crowd out the rest of the prompt. Past the cap the
  // OLDEST quests are dropped first (a "…and N more in the QUEST LOG" line replaces them) — the newest direction
  // is what the agent should act on now, and nothing is silently lost (the full ledger is one tool/route call away).
  const BLOCK_CAP = 2000;

  const HEADER = 'STATION QUESTS — your standing objectives for the Commander. These progress the game in sync '
    + 'with the Commander\'s real work. To interact, use the quest.update tool: op:"progress" ticks a named step '
    + '(pass a short note on what you did); op:"attest_complete" PROPOSES a quest done with concrete evidence — it '
    + 'is NEVER complete until the Commander confirms. Never claim a quest done in prose alone; a mechanical quest '
    + 'completes on its own when the harness proves it.';

  // contract type → the one-line "how this completes" phrasing the agent reads under each quest.
  function completesWhen(contract) {
    const type = (contract && contract.type) || '';
    switch (type) {
      case 'run': return 'completes when: the bound run finishes successfully';
      case 'prop': return 'completes when: the required capability goes live on the station';
      case 'fact': return 'completes when: the harness learns this about the Commander';
      case 'artifact': return 'completes when: the named deliverable exists in the workspace';
      case 'attest': return 'completes when you attest with concrete evidence and the Commander confirms';
      default: return 'completes when: the harness proves it';
    }
  }

  // first not-yet-done step of a quest, or null (no steps, or all ticked).
  function nextStep(q) {
    const steps = (q && Array.isArray(q.steps)) ? q.steps : [];
    for (const s of steps) { if (s && !s.done) return s; }
    return null;
  }

  // render ONE quest into a compact stanza. Order: id + title, next step, completes-when, why (groundedIn),
  // and any prior decline note (so the agent addresses it before re-attesting).
  function stanza(q) {
    const lines = [];
    const title = String((q && q.title) || '(untitled)').trim() || '(untitled)';
    lines.push('- [' + String((q && q.id) || '?') + '] ' + title);
    const ns = nextStep(q);
    if (ns) lines.push('    next step (' + ns.key + '): ' + (String(ns.label || ns.key).trim() || ns.key)
      + ' — tick it with quest.update op:"progress" stepKey:"' + ns.key + '"');
    lines.push('    ✓ ' + completesWhen(q && q.contract));
    const grounded = q && q.groundedIn != null ? String(q.groundedIn).trim() : '';
    if (grounded) lines.push('    why: ' + grounded);
    const dn = q && q.declineNote;
    if (dn) {
      const note = String((dn && dn.note) || '').trim();
      lines.push('    ⚑ your last completion claim was declined' + (note ? ': ' + note : '')
        + ' — address it before re-attesting.');
    }
    return lines.join('\n');
  }

  // format an agent's OPEN quests into the STATION QUESTS block. Empty/absent list → '' (the exact empty string,
  // so withQuests stays a strict no-op). Defensively clips to BLOCK_CAP, dropping the OLDEST quests first.
  function questBlock(quests) {
    const list = Array.isArray(quests) ? quests.filter(Boolean) : [];
    if (!list.length) return '';

    // build stanzas in ledger order (oldest→newest), then keep from the NEWEST end until the cap is reached, so
    // the quests dropped under pressure are the oldest ones. The header always rides (it's the how-to contract).
    const stanzas = list.map(stanza);
    const headerLen = HEADER.length + 2;   // + the '\n\n' that joins the header to the first stanza

    let used = headerLen;
    let firstKept = stanzas.length;        // index of the oldest stanza we keep (exclusive-below = dropped)
    for (let i = stanzas.length - 1; i >= 0; i--) {
      const add = stanzas[i].length + 2;   // + the '\n\n' separator
      if (used + add > BLOCK_CAP && firstKept < stanzas.length) break;   // keep at least the newest one
      used += add;
      firstKept = i;
    }
    const dropped = firstKept;             // stanzas[0..firstKept) were dropped
    const kept = stanzas.slice(firstKept);
    const parts = [HEADER];
    if (dropped > 0) parts.push('…and ' + dropped + ' more open quest' + (dropped === 1 ? '' : 's') + ' in the QUEST LOG.');
    for (const s of kept) parts.push(s);
    return parts.join('\n\n');
  }

  // append the quest block to a system prompt. Empty/whitespace block → the system is returned UNCHANGED
  // (byte-identical to a quest-less run — the no-op invariant). Idempotent: a system already containing the
  // block is never doubled. Identical shape to dossierinject.withDossier.
  function withQuests(system, block) {
    const sys = String(system == null ? '' : system);
    const b = String(block == null ? '' : block).trim();
    if (!b) return sys;
    if (sys.indexOf(b) >= 0) return sys;   // already present — never double-append
    return sys ? (sys + '\n\n' + b) : b;
  }

  return { questBlock: questBlock, withQuests: withQuests, _internals: { completesWhen: completesWhen, nextStep: nextStep, stanza: stanza, BLOCK_CAP: BLOCK_CAP } };
});
