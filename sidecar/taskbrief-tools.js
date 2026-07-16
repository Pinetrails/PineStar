'use strict';
const Policy = require('./taskbrief-policy.js');

function registerTaskBriefTools(registry, store, state, clock) {
  const now = () => clock && clock.now ? clock.now() : 0;
  registry.register({
    name: 'brief.ask', scope: 'read', readOnly: true,
    description: 'Ask the Commander one host-validated material question, then stop. Use only after inspecting available context.',
    schema: { type: 'object', required: ['dimension', 'question', 'options', 'recommended', 'reason', 'discoverable'], properties: {
      dimension: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
      recommended: { type: 'string' }, reason: { type: 'string' }, discoverable: { type: 'boolean' }, newBlocker: { type: 'boolean' }
    } },
    run: async args => {
      const checked = Policy.validateQuestion(args, state.brief);
      if (!checked.ok) throw new Error(checked.error);
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
    name: 'brief.proceed', scope: 'read', readOnly: true,
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
