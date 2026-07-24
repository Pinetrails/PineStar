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

// RECOMMENDATION MATCHING — a formatting slip must not silently cost the Commander the ★ suggestion, and a
// rescue must never resolve to the WRONG chip. Every accepted form returns the CANONICAL option text.
{
  const opts = ['operators', 'executives', 'customers'];
  for (const near of ['operators', 'Operators', 'operators.', 'operators!', '"operators"', '“operators”', 'the operators', '  operators  ']) {
    A.eq(Policy.matchOption(opts, near), 'operators', 'near-miss recommendation resolves to the canonical option: ' + JSON.stringify(near));
    A.eq(Policy.validateQuestion(material({ recommended: near }), { questions: [] }).question.recommended, 'operators', 'the stored recommendation is canonical, never the model spelling: ' + JSON.stringify(near));
  }
  for (const miss of ['', 'not listed', 'ops team', 'whoever']) {
    A.eq(Policy.matchOption(opts, miss), '', 'a genuine miss stays rejected rather than guessing: ' + JSON.stringify(miss));
  }
  A.eq(Policy.matchOption(['ship it', 'do not ship it'], 'ship'), '', 'an ambiguous substring matching two options fails closed');
  A.eq(Policy.matchOption(['ship it', 'do not ship it'], 'do not ship it.'), 'do not ship it', 'negation is never collapsed into its opposite');
  A.eq(Policy.matchOption(['A. keep it', 'B. drop it'], 'keep it'), 'A. keep it', 'an enumerator prefix still resolves uniquely');
}
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
  await s2.ask(second.id, material(), 210); await s2.prepare({ key: 'stream:w2', text: 'operators' }, 220); await s2.complete(second.id, 'run4', 230);
  A.eq(s2.patterns(5)[0].count, 2, 'repeated identical decisions compound into bounded weak evidence');

  // A DIFFERENT question in the same dimension sharing an answer is a different decision — never merged.
  const cousin = await s2.prepare({ id: 'tb_cousin', key: 'stream:w2b', text: 'Build a status page' }, 232);
  await s2.ask(cousin.id, material({ question: 'Who will use this status page day to day?' }), 234);
  await s2.prepare({ key: 'stream:w2b', text: 'operators' }, 236); await s2.complete(cousin.id, 'run4b', 238);
  A.eq(s2.patterns(5).length, 1, 'same dimension + same answer under a different question never merges into the bin');

  const incomplete = await s2.prepare({ id: 'tb_incomplete', key: 'stream:w3', text: 'Build a third dashboard' }, 240);
  await s2.ask(incomplete.id, material({ question: 'Which group owns this dashboard?' }), 250);
  await s2.prepare({ key: 'stream:w3', text: 'operators' }, 260);
  A.eq(s2.patterns(5)[0].count, 2, 'unfinished work never contributes relationship evidence');

  // GROUNDED RECOMMENDATION — the suggestion drawn from the Commander's OWN answered history. It is the only
  // provable one on this surface, so it must appear ONLY when actually observed (>=2), and never leak across
  // questions or outlive its own answer.
  {
    const open = { text: parsed.question, options: parsed.options, answer: '' };
    const g = s2.groundedFor(open);
    A.ok(g && g.option === 'operators' && g.count === 2, 'a decision answered twice becomes a grounded suggestion with its real count');
    A.eq(s2.groundedFor({ text: parsed.question, options: parsed.options, answer: 'customers' }), null, 'an already-answered question is never re-suggested');
    A.eq(s2.groundedFor({ text: 'what output format do you want?', options: ['PDF', 'HTML'], answer: '' }), null, 'a different question never inherits another decision history');
    A.eq(s2.groundedFor({ text: parsed.question, options: ['interns', 'vendors'], answer: '' }), null, 'history that is no longer an offered option cannot ground a chip');
    A.eq(s2.groundedFor({ text: parsed.question, options: ['operators'], answer: '' }), null, 'a one-option question is never grounded');
    // the count is REAL: it is the same number patterns() reports, not a fabricated confidence
    A.eq(g.count, s2.patterns(5).find(p => p.answer === 'operators').count, 'the displayed count IS the observed pattern count');
  }

  const cancelled = await s2.prepare({ id: 'tb_cancel', key: 'stream:cancel', text: 'Build a report' }, 300);
  await s2.ask(cancelled.id, material(), 310);
  const cancelResult = await s2.prepare({ key: 'stream:cancel', text: 'never mind' }, 320);
  A.eq(cancelResult.status, 'cancelled', 'explicit cancel closes rather than answers the pending brief');
  A.eq(cancelResult.questions[0].answer, '', 'cancel text is never learned as a task answer');

  // Marker path: a plain TASK_QUESTION reply persists honestly — nothing the model didn't say is recorded.
  const marker = await s2.prepare({ id: 'tb_marker', key: 'stream:marker', text: 'Build a landing page' }, 340);
  const mq = await s2.ask(marker.id, { question: 'dark theme or light theme?', options: ['dark', 'light'] }, 342, { source: 'marker' });
  A.eq(mq.status, 'clarifying', 'a marker question still leaves the brief waiting');
  A.eq(mq.questions[0].dimension, '', 'marker questions record no fabricated dimension');
  A.eq(mq.questions[0].recommended, '', 'marker questions record no fabricated recommendation');
  A.eq(mq.questions[0].reason, '', 'marker questions record no fabricated reason');
  A.eq(await s2.ask(marker.id, { question: 'serif or sans?', options: ['serif', 'sans'] }, 344, { source: 'marker' }), null, 'a marker second question requires an answered first question');
  await s2.prepare({ key: 'stream:marker', text: 'dark' }, 346);
  A.ok(await s2.ask(marker.id, { question: 'serif or sans?', options: ['serif', 'sans'] }, 348, { source: 'marker' }), 'a marker second question is allowed once the first is answered');
  A.eq(await s2.ask(marker.id, { question: 'hero image?', options: ['yes', 'no'] }, 350, { source: 'marker' }), null, 'the marker path still enforces the whole-task two-question cap');
  const soloBrief = await s2.prepare({ id: 'tb_solo', key: 'stream:solo', text: 'Build a page' }, 352);
  A.eq(await s2.ask(soloBrief.id, { question: 'only one?', options: ['solo'] }, 354, { source: 'marker' }), null, 'a one-option marker fails closed in the store too');
  // Marker questions (empty dimension) still feed pattern learning, binned by their question text.
  await s2.prepare({ key: 'stream:marker', text: 'sans' }, 356); await s2.complete(marker.id, 'run-m1', 358);
  const marker2 = await s2.prepare({ id: 'tb_marker2', key: 'stream:marker2', text: 'Build a second landing page' }, 360);
  await s2.ask(marker2.id, { question: 'dark theme or light theme?', options: ['dark', 'light'] }, 362, { source: 'marker' });
  await s2.prepare({ key: 'stream:marker2', text: 'dark' }, 364); await s2.complete(marker2.id, 'run-m2', 366);
  A.ok(s2.patterns(5).some(p => p.question === 'dark theme or light theme?' && p.count === 2), 'repeated marker decisions bin by question text');

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
  A.ok(/\{ source: 'marker' \}/.test(indexSrc) && !/The model identified a material unresolved decision/.test(indexSrc), 'the marker settle path records honestly instead of fabricating validation metadata');
  A.ok(/bufferedTaskEnd/.test(indexSrc) && /taskQuestionAsked\s*\?\s*'clarifying'/.test(indexSrc) && !/taskQuestionAsked\s*\?\s*'cancelled'/.test(indexSrc), 'clarification ends as the honest additive clarifying terminal before global completed-work listeners run');
  // Lane D — the additive contract change: 'clarifying' joined the run-end enum; every prior reason survives.
  const eventsSrc = fs.readFileSync(path.join(__dirname, '../shared/events.js'), 'utf8');
  const reasonEnum = /'agent\.run\.end'[\s\S]{0,1500}?reason:\s*\{\s*enum:\s*\[([^\]]+)\]/.exec(eventsSrc);
  A.ok(reasonEnum, 'run-end reason enum is declared in the shared contract');
  for (const r of ['done', 'max_iters', 'budget', 'cancelled', 'error', 'refusal', 'empty', 'clarifying']) {
    A.ok(reasonEnum[1].indexOf("'" + r + "'") >= 0, 'run-end reason enum carries ' + r + ' (additive-only contract)');
  }
  A.ok(/reason === 'clarifying'\) return ''/.test(hubSrc), 'channel endNote treats a clarifying end as the reply itself, never a stopped note');

  // Live-caught 2026-07-16 (real haiku-4.5 run): the internal brief controls must never route through the
  // external-unknown per-call confirmation, and the model must SEE the legal dimensions in the tool schema.
  const InputPolicy = require('../sidecar/inputpolicy.js');
  {
    const reg2 = makeRegistry();
    registerTaskBriefTools(reg2, { ask: async () => null, proceed: async () => null }, { brief: { id: 'x', status: 'ready', questions: [] } }, { now: () => 1 });
    const authority = InputPolicy.makeRunAuthority({ surface: 'interactive', isTask: true, confirm: () => { throw new Error('brief controls must not need confirmation'); } });
    for (const nm of ['brief.ask', 'brief.proceed']) {
      const t2 = reg2.get(nm);
      A.eq(t2.capability, 'taskbrief', nm + ' carries the internal taskbrief capability');
      const auth = await authority.authorize({ name: nm }, t2);
      A.eq(auth.ok, true, nm + ' authorizes without an external-unknown confirmation');
      A.ok(auth.oneShot !== true, nm + ' is not the one-shot external-unknown lease');
    }
    const dimSchema = reg2.get('brief.ask').schema.properties.dimension;
    A.ok(Array.isArray(dimSchema.enum) && dimSchema.enum.length === Policy.DIMENSIONS.size && dimSchema.enum.every(d => Policy.DIMENSIONS.has(d)), 'the wire schema enum IS the policy dimension whitelist');
  }
  A.ok(/dimension must be one of:/.test(Policy.validateQuestion(material({ dimension: 'dashboard_tech' }), { questions: [] }).error), 'a rejected dimension names the legal set in the error');
  const loopSrc = fs.readFileSync(path.join(__dirname, '../sidecar/loop.js'), 'utf8');
  A.ok(/delta: '\\n\\n' \+ controlText/.test(loopSrc), 'the final-control marker streams on its own line so the client line-anchored parse always hits');
  A.ok(/endReason === 'clarifying'\) restoreTaskQuestion\(ws\)/.test(chatSrc), 'a clarifying end without a parsed marker re-presents from the durable brief');

  // TASTE EXTRACTION slice 1 — announce-and-act: the settled read surfaces, corrections steer the live run.
  A.ok(/'taskbrief\.settled': obj\(\['agentId', 'runId', 'objective'\]/.test(eventsSrc), 'the settled-read event is declared additively in the shared contract');
  A.ok(/emit\('taskbrief\.settled'/.test(indexSrc) && /c\.name === 'brief\.proceed'/.test(indexSrc), 'a successful brief.proceed emits the settled read');
  A.ok(/wireBriefRead/.test(chatSrc) && /taskbrief\.settled/.test(chatSrc), 'COMMS renders the READ card from the settled event');
  A.ok(/\/api\/run\/steer/.test(chatSrc) && /folded into the run/.test(chatSrc), 'READ-card corrections fold into the live run via steer');
  A.ok(/run already ended|run already finished/.test(chatSrc), 'a correction after run end is refused honestly, never faked');
  A.ok(/STYLE, TONE, and AESTHETIC as explicit assumptions/.test(TaskIntent.directive('')), 'the doctrine demands bold, correctable taste assumptions in brief_proceed');
  A.ok(/endReason !== 'clarifying'/.test(chatSrc), 'COMMS never renders a clarifying end as a stopped run');
  A.ok(/offerTaskQuestion/.test(chatSrc) && /TaskIntent\.strip/.test(chatSrc), 'COMMS strips the marker and renders the natural decision');
  A.ok(/clarificationRuns\.has\(runId\)/.test(chatSrc) && /clarificationRuns\.add\(thisRunId\)/.test(chatSrc), 'clarification turns do not count as completed-work beats');
  A.ok(/endReason !== 'done' && endReason !== 'clarifying' && !taskQuestion/.test(chatSrc), 'the neutral clarification terminal is not rendered as a stopped/error run');
  A.ok(/endReason:\s*taskQuestion\s*\?\s*'done'/.test(chatSrc), 'the visible presence line describes the completed decision turn without claiming task delivery');
  A.ok(/function restoreTaskQuestion/.test(chatSrc) && /status=clarifying/.test(chatSrc), 'reload or stream-switch re-presents the real unanswered durable brief');
  const offer = chatSrc.slice(chatSrc.indexOf('function offerTaskQuestion'), chatSrc.indexOf('function offerTaskQuestion') + 1400);
  A.ok(!/DossierStore\.upsert/.test(offer), 'task-specific answers never pollute the global dossier');
  A.ok(/taskKey: 'channel:'/.test(hubSrc) && /Reply with a choice/.test(hubSrc), 'messaging channels share brief continuity with a text-choice fallback');

  // TASK BRIEF v2 — the stored recommendation reaches every surface, and only when it is real.
  const cssSrc = fs.readFileSync(path.join(__dirname, '../frontend/css/app.css'), 'utf8');
  A.ok(/function presentTaskQuestion/.test(chatSrc) && /presentTaskQuestion\(ws, taskQuestion\)/.test(chatSrc), 'run-end questions render through the brief-enriched presenter');
  A.ok(/it\.suggested \? ' suggested'/.test(chatSrc) && /tq-reason/.test(chatSrc), 'COMMS marks the recommended chip and renders the one-line why');
  A.ok(/recommended: q\.recommended \|\| ''/.test(chatSrc), 'restore-on-reload passes the stored recommendation through');
  A.ok(/\.choice\.suggested/.test(cssSrc) && /--gold-rgb/.test(cssSrc.slice(cssSrc.indexOf('.choice.suggested'), cssSrc.indexOf('.choice.suggested') + 700)), 'the suggested chip uses the theme gold vocabulary, never a literal amber');
  A.ok(/briefFor/.test(hubSrc) && /suggested: ' \+ q\.recommended/.test(hubSrc), 'the channel fallback carries the stored recommendation');
  A.ok(/briefFor: \(key\) => taskBriefStore\.active\(key\)/.test(indexSrc), 'both hub compositions read recommendations from the durable store');

  // GROUNDED SUGGESTION wiring — the observed-history recommendation must reach every surface, outrank the
  // model's guess, and stay visually separable from it (provable vs asserted must never look identical).
  A.ok(/grounded = q0 \? taskBriefStore\.groundedFor\(q0, pats\)/.test(indexSrc), 'the briefs route serves the grounded suggestion for the open question');
  A.ok(/j\.grounded \|\| null/.test(chatSrc), 'COMMS reads the grounded field the response already carried');
  A.ok(/you chose this ' \+ g\.count \+ ' times before/.test(chatSrc), 'the grounded why-line states a real observed count, never a vague confidence');
  A.ok(/tq-reason' \+ \(g \? ' grounded' : ''\)/.test(chatSrc), 'a grounded suggestion is marked so it cannot be mistaken for the model guess');
  A.ok(/\.tq-reason\.grounded/.test(cssSrc), 'the grounded why-line has its own provable-source styling');
  A.ok(/groundedFor: \(q\) => taskBriefStore\.groundedFor\(q\)/.test(indexSrc) && /groundedFor \? groundedFor\(q\)/.test(hubSrc), 'messaging channels carry the same grounded suggestion as COMMS');
  A.ok(/console\.warn\('\[taskbrief\] brief_ask rejected/.test(fs.readFileSync(path.join(__dirname, '../sidecar/taskbrief-tools.js'), 'utf8')), 'a hidden-tool rejection is logged instead of silently downgrading the surface');

  // TASK BRIEF v2 — recipe intake: declared material decisions, settled at launch or aimed mid-run.
  const Recipes = require('../frontend/app/recipes.js');
  for (const r of Recipes.list()) {
    for (const e of (r.intake || [])) {
      A.ok(Policy.DIMENSIONS.has(e.dimension), 'recipe intake dimension is a policy dimension: ' + r.id + '/' + e.dimension);
      A.ok(e.options.some(o => o.toLowerCase() === e.recommended.toLowerCase()), 'recipe intake recommended is one of its options: ' + r.id);
    }
  }
  const dr = Recipes.get('deep-research');
  A.eq((dr.intake || []).length, 2, 'the flagship intake survived catalog normalization');
  const filled = Recipes.fillTask('deep-research', { topic: 'X', __intake: { deliverable: 'tight brief' } });
  A.ok(/Decisions \(chosen at launch/.test(filled) && /- deliverable: tight brief/.test(filled), 'launch-tapped intake decisions ride the directive itself');
  A.ok(!/Decisions \(chosen at launch/.test(Recipes.fillTask('deep-research', { topic: 'X' })), 'no tapped decisions -> no decisions block');
  const cxIntake = CommanderContext.compose({ recipeIntake: dr.intake });
  A.ok(/<recipe_intake provenance="recipe-declared">/.test(cxIntake) && /suggested: tight brief/.test(cxIntake), 'composer renders the declared decisions with their suggested defaults');
  A.ok(CommanderContext.compose({}).indexOf('recipe_intake') < 0, 'no recipe -> no intake block');
  const mktSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/marketplace.js'), 'utf8');
  A.ok(/values\.__intake = intake/.test(mktSrc) && /mkt-intake-opt/.test(mktSrc), 'the launch form collects one-tap intake decisions');
  A.ok(/recipeIntake/.test(indexSrc) && /Recipes\.get\(String\(o\.recipeId\)\)/.test(indexSrc), 'a recipe-launched run injects its declared intake');

  A.report('taskintent.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
