'use strict';
const Policy = require('./taskbrief-policy.js');

function registerTaskBriefTools(registry, store, state, deps) {
  const now = () => deps && deps.now ? deps.now() : 0;
  // IN-TURN CLARIFY (2026-07-31, Hermes-parity): on a WATCHED run the host wires a blocking asker —
  // the question renders live, the answer resumes THIS turn, and "which approach?" stops costing the
  // whole run its plan and context. Absent (unattended/channel runs), behavior is byte-identical to
  // before: the question ends the run and the durable brief resumes on the next reply.
  const askCommander = deps && typeof deps.askCommander === 'function' ? deps.askCommander : null;
  registry.register({
    // capability 'taskbrief' marks these as the host's OWN internal controls (inputpolicy SAFE_BUILTIN_CAPS):
    // read-only bookkeeping, zero external effect — never routed through the external-unknown confirmation.
    name: 'brief.ask', scope: 'read', readOnly: true, capability: 'taskbrief',
    // The clarify wait blocks INSIDE run(), so the default 30s ctx.timeoutMs would kill it mid-question
    // (same shape as browser.login's hour). The wait itself is bounded by the consent waiter's fail-closed
    // timer + one ack extension; this ceiling only has to sit safely above that.
    timeoutMs: 20 * 60 * 1000,
    description: 'Ask the Commander one host-validated material question, then stop. Use only after inspecting available context. If a call is rejected, CORRECT the arguments and call again — never ask in plain prose; as a last resort end your reply with the TASK_QUESTION: line.',
    schema: { type: 'object', required: ['dimension', 'question', 'options', 'recommended', 'reason', 'discoverable'], properties: {
      // the enum IS the whitelist (taskbrief-policy DIMENSIONS) — live-caught 2026-07-16: without it the
      // model invents dimensions ('dashboard_tech'), burns retries on rejections, then falls back to prose.
      dimension: { type: 'string', enum: Array.from(Policy.DIMENSIONS) },
      question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
      recommended: { type: 'string' }, reason: { type: 'string' },
      // live-caught 2026-07-16: with no description the model reads 'discoverable' as an open judgment call
      // and stalls; it is an attestation, not a research report.
      discoverable: { type: 'boolean', description: 'Pass false to attest you checked the available context (conversation, task brief, granted files) and the answer is not there. Only false is accepted.' },
      newBlocker: { type: 'boolean' }
    } },
    run: async args => {
      const checked = Policy.validateQuestion(args, state.brief);
      // A rejection is model-facing steering: name the fix and forbid the prose fallback (live-caught
      // 2026-07-16: after rejections the model asked in plain prose and escaped the brief lifecycle).
      if (!checked.ok) {
        // brief_ask is a HIDDEN tool, so a rejection reaches neither the transcript nor telemetry. Left
        // unlogged it was invisible: a model that chronically fails the validator quietly downgrades to the
        // marker fallback (no recommendation at all) and the Commander just stops seeing ★ chips with no
        // way to know why. One warn line makes that rate knowable without surfacing model churn as UI noise.
        try { console.warn('[taskbrief] brief_ask rejected: ' + checked.error); } catch (_) {}
        throw new Error(checked.error + '. Correct the arguments and call brief_ask again — do NOT ask in plain prose; if you cannot satisfy the validator, end your reply with: TASK_QUESTION: <question> || <option A> | <option B>');
      }
      // ASK-WORTHINESS GATE: the Commander has repeatedly answered "use your judgment" in this dimension, so
      // asking again spends one of only two questions on something they have already told us to decide. Refuse
      // and steer to the honest alternative — pick a reversible default and SURFACE it as a correctable
      // assumption in brief_proceed, where the read card makes it visible and steerable.
      let deferred = [];
      try { deferred = typeof store.deferredDimensions === 'function' ? store.deferredDimensions() : []; } catch (_) { deferred = []; }
      if (deferred.indexOf(checked.question.dimension) >= 0) {
        try { console.warn('[taskbrief] brief_ask suppressed: ' + checked.question.dimension + ' is a habitually deferred dimension'); } catch (_) {}
        throw new Error('the Commander has repeatedly answered "use your judgment" on ' + checked.question.dimension
          + ' decisions — do not ask this. Choose the most sensible reversible default, call brief_proceed, and state that choice as a correctable assumption.');
      }
      const saved = await store.ask(state.brief.id, args, now());
      if (!saved) throw new Error('question was rejected by the Task Brief policy');
      state.brief = saved;
      const q = checked.question;
      if (askCommander) {
        let res = null;
        try {
          res = await askCommander({ question: q.question, options: q.options.slice(), recommended: q.recommended || '', reason: q.reason || '' });
        } catch (_) { res = null; }
        if (res && res.answered && res.text && typeof store.answerInTurn === 'function') {
          const updated = await store.answerInTurn(state.brief.id, res.text, now());
          if (updated) {
            state.brief = updated;
            return { content: 'The Commander answered: "' + res.text + '". Continue the task with this decision applied — do not re-ask it.', summary: 'answered in turn' };
          }
        }
        // no live answer (walked away, disconnected, or the store refused a stale write): fall through to
        // the durable end-run question below, exactly today's flow — the answer then arrives as a new run.
      }
      return { content: 'Waiting for the Commander\'s decision.', summary: 'task question ready', control: {
        final: true, reason: 'done', text: 'TASK_QUESTION: ' + q.question + ' || ' + q.options.join(' | ')
      } };
    }
  });
  registry.register({
    name: 'brief.proceed', scope: 'read', readOnly: true, capability: 'taskbrief',
    description: 'Settle the Task Brief and unlock consequential tools. Call immediately before the first write/execute action.',
    schema: { type: 'object', required: ['objective'], properties: {
      objective: { type: 'string' }, deliverable: { type: 'string' }, audience: { type: 'string' }, success: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } }
    } },
    run: async args => {
      const checked = Policy.validateProceed(args); if (!checked.ok) throw new Error(checked.error);
      const saved = await store.proceed(state.brief.id, checked.brief, now());
      if (!saved) throw new Error('Task Brief cannot proceed from its current state');
      state.brief = saved;
      return { content: 'Task Brief settled. Consequential tools are unlocked.', summary: 'task brief settled' };
    }
  });
  return ['brief.ask', 'brief.proceed'];
}

module.exports = { registerTaskBriefTools };
