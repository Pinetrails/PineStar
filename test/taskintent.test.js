/* node test/taskintent.test.js — task-context protocol + durable Task Brief lifecycle. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const TaskIntent = require('../frontend/app/fork.js').TaskIntent;
const CommanderContext = require('../sidecar/commander-context.js');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');
const Policy = require('../sidecar/taskbrief-policy.js');
const { registerTaskBriefTools } = require('../sidecar/taskbrief-tools.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const LoopModule = require('../sidecar/loop.js');
const Loop = LoopModule._internals;

function memFs() {
  const files = new Map();
  return {
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); }, renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}, _files: files
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const makeStore = disk => makeTaskBriefStore({ fs: disk, path, workspaces: '/ws', writeDurable });

const parsed = TaskIntent.parse('I can build that.\nTASK_QUESTION: who is this dashboard primarily for? || operators | executives | customers');
const material = q => Object.assign({
  dimension: 'audience', recommended: 'operators', reason: 'Audience changes information density and navigation.', discoverable: false
}, parsed, q || {});
A.eq(parsed.question, 'who is this dashboard primarily for?', 'protocol parses one concrete question');
A.eq(parsed.options, ['operators', 'executives', 'customers'], 'protocol parses 2-3 options');
A.eq(TaskIntent.strip('Ready.\nTASK_QUESTION: format? || PDF | HTML'), 'Ready.', 'internal marker is stripped from the visible reply');
A.eq(TaskIntent.parse('TASK_QUESTION: only one? || yes'), null, 'one-option marker fails closed instead of rendering a broken choice');
A.eq(TaskIntent.answerMessage('who is this for?', 'operators'), 'operators', 'choice continuation preserves the actual answer without UI annotation noise');
const doctrine = TaskIntent.directive('KNOWN: existing React admin shell');
A.ok(/Research before asking/.test(doctrine) && /what does good look like/.test(doctrine), 'doctrine says discover first and bans vague questions');
A.ok(/use your judgment/i.test(doctrine) && /Proceed immediately/.test(doctrine), 'doctrine preserves autonomy for clear/defaultable tasks');
A.ok(/at most two questions total/.test(doctrine) && /second is allowed only/.test(doctrine), 'doctrine caps the whole task and permits a second question only when blocking');
A.ok(/brief_proceed/.test(doctrine) && /brief_ask/.test(doctrine), 'doctrine names the structured host controls');

const replyCases = [
  ['cancel', 'cancel'], ['never mind.', 'cancel'], ['drop that', 'cancel'],
  ['instead, export a PDF', 'replace'], ['new task: audit billing', 'replace'], ['operators', 'answer']
];
for (const [input, action] of replyCases) {
  A.eq(Policy.routeReply(input).action, action, 'reply router: ' + JSON.stringify(input) + ' -> ' + action);
  A.eq(TaskIntent.routeReply(input).action, action, 'browser reply router matches host: ' + JSON.stringify(input));
}
const valid = Policy.validateQuestion(material(), { questions: [] });
A.eq(valid.ok, true, 'a concrete researched material decision passes host validation');
A.eq(Policy.validateQuestion(material({ question: 'What does good look like?', options: ['simple', 'detailed'] }), { questions: [] }).ok, false, 'vague quality prompts fail closed');
A.eq(Policy.validateQuestion(material({ options: ['operators', 'Operators'] }), { questions: [] }).ok, false, 'duplicate options do not masquerade as distinct choices');
A.eq(Policy.validateQuestion(material({ discoverable: true }), { questions: [] }).ok, false, 'a discoverable gap must be researched instead of asked');
A.eq(Policy.validateQuestion(material({ recommended: 'not listed' }), { questions: [] }).ok, false, 'recommended default must be one of the visible choices');
A.eq(Policy.validateQuestion(material({ dimension: 'vibes' }), { questions: [] }).ok, false, 'unknown decision dimensions fail closed');
A.eq(Policy.validateQuestion(material({ newBlocker: false }), { questions: [{ answer: 'operators' }] }).ok, false, 'second question requires a newly exposed blocker');
A.eq(Policy.validateQuestion(material({ newBlocker: true }), { questions: [{ answer: '' }] }).ok, false, 'second question cannot precede the first answer');
A.eq(Policy.validateQuestion(material(), { questions: [{ answer: 'a' }, { answer: 'b' }] }).ok, false, 'host enforces the whole-task two-question cap');
A.eq(Policy.validateProceed({ objective: '' }).ok, false, 'empty settled briefs cannot unlock mutation');
A.eq(Policy.canMutate({ status: 'ready' }, { scope: 'write' }).ok, false, 'writes are locked while intent is unsettled');
A.eq(Policy.canMutate({ status: 'ready' }, { scope: 'read' }).ok, true, 'reads remain available for pre-question research');
A.eq(Policy.canMutate({ status: 'executing' }, { scope: 'execute' }).ok, true, 'settling the brief unlocks consequential tools');

(async () => {
  const disk = memFs(); const s1 = makeStore(disk);
  const first = await s1.prepare({ id: 'tb_run1', key: 'stream:w1', streamId: 'w1', agentId: 'agent', text: 'Build me a dashboard' }, 100);
  A.eq(first.status, 'ready', 'a new directive opens a ready brief');
  await s1.ask(first.id, material(), 110);
  A.eq(s1.active('stream:w1').status, 'clarifying', 'a material question leaves the brief waiting');

  const s2 = makeStore(disk); // restart: fresh store over the same durable bytes
  const waiting = s2.active('stream:w1');
  A.eq(waiting.originalDirective, 'Build me a dashboard', 'original directive survives a store restart');
  A.eq(waiting.questions[0].text, parsed.question, 'visible question survives restart');

  const resumed = await s2.prepare({ id: 'ignored', key: 'stream:w1', text: 'operators', taskAction: 'answer' }, 120);
  A.eq(resumed.id, first.id, 'answer resumes the SAME task brief');
  A.eq(resumed.questions[0].answer, 'operators', 'answer is recorded on the pending decision');
  A.eq(resumed.status, 'ready', 'answered brief is ready to execute');
  const settled = await s2.proceed(resumed.id, { objective: 'Build the requested dashboard', deliverable: 'Existing admin shell', assumptions: ['Use the existing admin shell'] }, 125);
  A.eq(settled.status, 'executing', 'structured proceed durably unlocks execution');
  A.eq(settled.settled.objective, 'Build the requested dashboard', 'settled brief preserves the explicit objective');
  await s2.complete(resumed.id, 'run2', 130, ['Use the existing admin shell']);
  A.eq(s2.active('stream:w1').status, 'done', 'successful continuation completes the brief');

  // Same decision twice becomes weak observed relationship evidence, never a standing order.
  const second = await s2.prepare({ id: 'tb_run3', key: 'stream:w2', text: 'Build another dashboard' }, 200);
  await s2.ask(second.id, material({ question: 'Who will use this dashboard day to day?' }), 210); await s2.prepare({ key: 'stream:w2', text: 'operators' }, 220); await s2.complete(second.id, 'run4', 230);
  A.eq(s2.patterns(5)[0].count, 2, 'repeated identical decisions compound into bounded weak evidence');

  const incomplete = await s2.prepare({ id: 'tb_incomplete', key: 'stream:w3', text: 'Build a third dashboard' }, 240);
  await s2.ask(incomplete.id, material({ question: 'Which group owns this dashboard?' }), 250);
  await s2.prepare({ key: 'stream:w3', text: 'operators' }, 260);
  A.eq(s2.patterns(5)[0].count, 2, 'unfinished work never contributes relationship evidence');

  const cancelled = await s2.prepare({ id: 'tb_cancel', key: 'stream:cancel', text: 'Build a report' }, 300);
  await s2.ask(cancelled.id, material(), 310);
  const cancelResult = await s2.prepare({ key: 'stream:cancel', text: 'never mind' }, 320);
  A.eq(cancelResult.status, 'cancelled', 'explicit cancel closes rather than answers the pending brief');
  A.eq(cancelResult.questions[0].answer, '', 'cancel text is never learned as a task answer');

  const pivoted = await s2.prepare({ id: 'tb_pivot', key: 'stream:pivot', text: 'Build a report' }, 400);
  await s2.ask(pivoted.id, material(), 410);
  const replacement = await s2.prepare({ id: 'tb_replacement', key: 'stream:pivot', text: 'instead, export the raw CSV' }, 420);
  A.eq(replacement.inputAction, 'replace', 'a clear pivot opens a replacement instead of contaminating the old brief');
  A.eq(replacement.originalDirective, 'export the raw CSV', 'replacement brief strips the pivot preamble');
  A.eq(s2.list({ key: 'stream:pivot' }).filter(b => b.status === 'cancelled').length, 1, 'replaced brief retains an honest cancelled predecessor');

  // Structured internal tools preserve control metadata through the registry and stop the same batch before
  // any later call can run. They are hidden from ordinary tool telemetry by the run host.
  const controlBrief = await s2.prepare({ id: 'tb_control', key: 'stream:control', text: 'Build something' }, 500);
  const state = { brief: controlBrief }; const registry = makeRegistry();
  registerTaskBriefTools(registry, s2, state, { now: () => 510 });
  const askResult = await registry.dispatch({ name: 'brief.ask', args: material(), argsRaw: '{}' }, {});
  A.ok(askResult.ok, 'structured brief.ask dispatches through the normal host registry: ' + JSON.stringify(askResult));
  A.eq(askResult.control && askResult.control.final, true, 'registry preserves the internal final-control signal');
  A.ok(/^TASK_QUESTION:/.test(askResult.control.text), 'structured ask emits the backward-compatible UI marker');
  let laterRan = false;
  const calls = [
    { id: 'a', name: 'brief_ask', argsRaw: '{}' },
    { id: 'b', name: 'fs_write', argsRaw: '{}' }
  ];
  const controlResults = await Loop.executeCalls(calls, async c => c.id === 'a'
    ? { ok: true, isError: false, content: 'wait', summary: 'wait', control: { final: true, text: 'TASK_QUESTION: format? || PDF | HTML' } }
    : (laterRan = true, { ok: true, isError: false, content: 'wrote' }), {}, () => {}, { agentId: 'agent', runId: 'run', clock: { now: () => 1 }, hiddenTools: new Set(['brief_ask']) });
  A.eq(laterRan, false, 'a final brief control skips later calls in the same model batch');
  A.eq(controlResults.length, 2, 'skipped calls still receive paired tool results');
  A.eq(controlResults[1].isError, true, 'the paired skipped result is explicitly an error');
  const emitted = [];
  const loopResult = await LoopModule.runAgentLoop({
    messages: [{ role: 'user', content: 'Build something' }],
    provider: { async *stream() {
      yield { type: 'tool_start', index: 0, id: 'ask1', name: 'brief_ask' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: {} }; yield { type: 'done', finishReason: 'tool_calls' };
    } },
    emit: (name, payload) => emitted.push({ name, payload }),
    dispatch: async () => ({ ok: true, isError: false, content: 'wait', summary: 'wait', control: { final: true, reason: 'done', text: 'TASK_QUESTION: format? || PDF | HTML' } }),
    hiddenTools: ['brief_ask'], limits: { maxIters: 2 }, signal: { aborted: false }, clock: { now: () => 1 },
    cost: { estimate: () => ({ usd: 0 }), reconcile: () => ({ usd: 0, tokensIn: 0, tokensOut: 0 }) },
    capCtx: { canRun: () => true }, agentId: 'agent', runId: 'control-run', model: 'replay/model'
  });
  A.eq(loopResult.reason, 'done', 'final Task Brief control ends the loop without a second paid model turn');
  A.ok(loopResult.messages.some(m => m.role === 'assistant' && /^TASK_QUESTION:/.test(m.content)), 'loop appends the compatible question marker after paired tool results');
  A.eq(emitted.some(e => e.name === 'agent.tool_call'), false, 'internal brief controls stay out of user-facing tool telemetry');

  const cx = CommanderContext.compose({ brief: resumed, dossier: 'COMMANDER DOSSIER\n- Goals: ship', existingSystem: '', patterns: s2.patterns(5) });
  A.ok(/ORIGINAL REQUEST: Build me a dashboard/.test(cx) && /=> operators/.test(cx), 'composer carries original task + answered decision');
  A.ok(/strength="weak; never override current instructions"/.test(cx), 'relationship evidence is truthfully labelled weak');

  // Source guards lock the full seam: central run host, browser chips, channel fallback, and no dossier write.
  const indexSrc = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
  const hubSrc = fs.readFileSync(path.join(__dirname, '../sidecar/channels/hub.js'), 'utf8');
  const orchestrationSrc = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/orchestration.js'), 'utf8');
  A.ok(/taskBriefStore\.prepare/.test(indexSrc) && /TaskIntent\.directive/.test(indexSrc), 'runOnce prepares the durable brief and injects the shared doctrine');
  A.ok(/taskContext:\s*taskContextBlock/.test(indexSrc) && /workerSystem/.test(orchestrationSrc), 'delegated workers inherit the settled brief without re-questioning the Commander');
  A.ok(/taskQuestionAsked/.test(indexSrc) && /!taskQuestionAsked/.test(indexSrc), 'clarifications suppress completed-task learning sweeps');
  A.ok(/bufferedTaskEnd/.test(indexSrc) && /taskQuestionAsked\s*\?\s*'cancelled'/.test(indexSrc), 'clarification maps to the contract-safe neutral terminal before global completed-work listeners run');
  A.ok(/offerTaskQuestion/.test(chatSrc) && /TaskIntent\.strip/.test(chatSrc), 'COMMS strips the marker and renders the natural decision');
  A.ok(/clarificationRuns\.has\(runId\)/.test(chatSrc) && /clarificationRuns\.add\(thisRunId\)/.test(chatSrc), 'clarification turns do not count as completed-work beats');
  A.ok(/endReason !== 'done' && !taskQuestion/.test(chatSrc), 'the neutral clarification terminal is not rendered as a stopped/error run');
  A.ok(/endReason:\s*taskQuestion\s*\?\s*'done'/.test(chatSrc), 'the visible presence line describes the completed decision turn without claiming task delivery');
  A.ok(/function restoreTaskQuestion/.test(chatSrc) && /status=clarifying/.test(chatSrc), 'reload or stream-switch re-presents the real unanswered durable brief');
  const offer = chatSrc.slice(chatSrc.indexOf('function offerTaskQuestion'), chatSrc.indexOf('function offerTaskQuestion') + 1400);
  A.ok(!/DossierStore\.upsert/.test(offer), 'task-specific answers never pollute the global dossier');
  A.ok(/taskKey: 'channel:'/.test(hubSrc) && /Reply with a choice/.test(hubSrc), 'messaging channels share brief continuity with a text-choice fallback');

  A.report('taskintent.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
