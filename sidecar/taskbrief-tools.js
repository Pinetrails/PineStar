'use strict';
const Policy = require('./taskbrief-policy.js');

function registerTaskBriefTools(registry, store, state, clock) {
  const now = () => clock && clock.now ? clock.now() : 0;
  registry.register({
    // capability 'taskbrief' marks these as the host's OWN internal controls (inputpolicy SAFE_BUILTIN_CAPS):
    // read-only bookkeeping, zero external effect — never routed through the external-unknown confirmation.
    name: 'brief.ask', scope: 'read', readOnly: true, capability: 'taskbrief',
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
      if (!checked.ok) throw new Error(checked.error + '. Correct the arguments and call brief_ask again — do NOT ask in plain prose; if you cannot satisfy the validator, end your reply with: TASK_QUESTION: <question> || <option A> | <option B>');
      const saved = await store.ask(state.brief.id, args, now());
      if (!saved) throw new Error('question was rejected by the Task Brief policy');
      state.brief = saved;
      const q = checked.question;
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
