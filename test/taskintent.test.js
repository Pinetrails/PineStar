/* node test/taskintent.test.js — task-context protocol + durable Task Brief lifecycle. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const TaskIntent = require('../frontend/app/fork.js').TaskIntent;
const CommanderContext = require('../sidecar/commander-context.js');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');

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
A.eq(parsed.question, 'who is this dashboard primarily for?', 'protocol parses one concrete question');
A.eq(parsed.options, ['operators', 'executives', 'customers'], 'protocol parses 2-3 options');
A.eq(TaskIntent.strip('Ready.\nTASK_QUESTION: format? || PDF | HTML'), 'Ready.', 'internal marker is stripped from the visible reply');
A.eq(TaskIntent.parse('TASK_QUESTION: only one? || yes'), null, 'one-option marker fails closed instead of rendering a broken choice');
const doctrine = TaskIntent.directive('KNOWN: existing React admin shell');
A.ok(/Research before asking/.test(doctrine) && /what does good look like/.test(doctrine), 'doctrine says discover first and bans vague questions');
A.ok(/use your judgment/i.test(doctrine) && /Proceed immediately/.test(doctrine), 'doctrine preserves autonomy for clear/defaultable tasks');
A.ok(/at most two questions total/.test(doctrine) && /second is allowed only/.test(doctrine), 'doctrine caps the whole task and permits a second question only when blocking');

(async () => {
  const disk = memFs(); const s1 = makeStore(disk);
  const first = await s1.prepare({ id: 'tb_run1', key: 'stream:w1', streamId: 'w1', agentId: 'agent', text: 'Build me a dashboard' }, 100);
  A.eq(first.status, 'ready', 'a new directive opens a ready brief');
  await s1.ask(first.id, parsed, 110);
  A.eq(s1.active('stream:w1').status, 'clarifying', 'a material question leaves the brief waiting');

  const s2 = makeStore(disk); // restart: fresh store over the same durable bytes
  const waiting = s2.active('stream:w1');
  A.eq(waiting.originalDirective, 'Build me a dashboard', 'original directive survives a store restart');
  A.eq(waiting.questions[0].text, parsed.question, 'visible question survives restart');

  const resumed = await s2.prepare({ id: 'ignored', key: 'stream:w1', text: 'operators' }, 120);
  A.eq(resumed.id, first.id, 'answer resumes the SAME task brief');
  A.eq(resumed.questions[0].answer, 'operators', 'answer is recorded on the pending decision');
  A.eq(resumed.status, 'ready', 'answered brief is ready to execute');
  await s2.complete(resumed.id, 'run2', 130, ['Use the existing admin shell']);
  A.eq(s2.active('stream:w1').status, 'done', 'successful continuation completes the brief');

  // Same decision twice becomes weak observed relationship evidence, never a standing order.
  const second = await s2.prepare({ id: 'tb_run3', key: 'stream:w2', text: 'Build another dashboard' }, 200);
  await s2.ask(second.id, parsed, 210); await s2.prepare({ key: 'stream:w2', text: 'operators' }, 220); await s2.complete(second.id, 'run4', 230);
  A.eq(s2.patterns(5)[0].count, 2, 'repeated identical decisions compound into bounded weak evidence');

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
  A.ok(/offerTaskQuestion/.test(chatSrc) && /TaskIntent\.strip/.test(chatSrc), 'COMMS strips the marker and renders the natural decision');
  A.ok(/clarificationRuns\.has\(runId\)/.test(chatSrc) && /clarificationRuns\.add\(thisRunId\)/.test(chatSrc), 'clarification turns do not count as completed-work beats');
  A.ok(/function restoreTaskQuestion/.test(chatSrc) && /status=clarifying/.test(chatSrc), 'reload or stream-switch re-presents the real unanswered durable brief');
  const offer = chatSrc.slice(chatSrc.indexOf('function offerTaskQuestion'), chatSrc.indexOf('function offerTaskQuestion') + 1400);
  A.ok(!/DossierStore\.upsert/.test(offer), 'task-specific answers never pollute the global dossier');
  A.ok(/taskKey: 'channel:'/.test(hubSrc) && /Reply with a choice/.test(hubSrc), 'messaging channels share brief continuity with a text-choice fallback');

  A.report('taskintent.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
