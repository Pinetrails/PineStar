/* node test/skills.test.js — the agent's owned SKILL library (H4).
   Part 1 (the store): a skill round-trips through a fresh instance (durable), a same-name write edits IN PLACE
   (no duplicate), list() returns METADATA only (progressive disclosure — name+summary, never the body), view()
   returns the full body by name or id, the per-agent cap refuses a new skill when full, skills are agent-scoped,
   and secrets are redacted on write. Pure + deterministic (in-memory io + injected clock). */
'use strict';
const A = require('./_assert.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');

function memIo() { const lines = []; return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } }; }
let clk = 1000; const clock = { now: () => clk };
const redact = (t) => String(t).replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]');

// ---- A. write returns the skill; list is metadata-only; view returns the body ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact });
  clk = 1111;
  const r = s.write({ agentId: 'a', name: 'Deploy the site', summary: 'build, test, push', body: '1. npm ci\n2. npm test\n3. npm run deploy' });
  A.ok(r.ok && r.skill, 'write succeeds');
  A.eq(r.skill.updatedAt, 1111, 'stamps updatedAt from the clock');
  A.eq(r.edited, false, 'first write is a create, not an edit');
  const list = s.list('a');
  A.eq(list.length, 1, 'one skill listed');
  A.eq(list[0].name, 'Deploy the site', 'list carries the name');
  A.ok(list[0].summary === 'build, test, push', 'list carries the summary');
  A.ok(!('body' in list[0]), 'list is METADATA only — no body (progressive disclosure)');
  const v = s.view('a', 'Deploy the site');
  A.ok(v && /npm run deploy/.test(v.body), 'view returns the full body');
  A.eq(s.view('a', list[0].id).name, 'Deploy the site', 'view also resolves by id');
  A.ok(v.files && v.files['SKILL.md'].indexOf('npm run deploy') >= 0, 'body is stored as SKILL.md in the skill package');
  A.ok(list[0].files.indexOf('SKILL.md') >= 0, 'list exposes file names for progressive disclosure');
}

// ---- A2. package support files, patch, search, prompt summaries, and archive ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact });
  s.write({ agentId: 'a', name: 'Release', summary: 'ship app releases', body: '1. build\n2. test' });
  A.ok(s.patch({ agentId: 'a', name: 'Release', patch: '3. publish the release notes' }).ok, 'patch appends to SKILL.md');
  A.ok(/publish the release notes/.test(s.view('a', 'Release').body), 'patch is visible in SKILL.md');
  A.ok(s.writeFile({ agentId: 'a', name: 'Release', path: 'references/api.md', content: 'release API token docs sk-ABCDEFGH' }).ok, 'support file write works');
  const file = s.view('a', 'Release', 'references/api.md');
  A.ok(file.file && /release API/.test(file.file.content), 'support file can be viewed on demand');
  A.ok(file.file.content.indexOf('sk-ABCDEFGH') === -1, 'support file content is redacted');
  A.ok(s.search('a', 'release notes').length >= 1, 'saved skill summaries/bodies are searchable');
  A.ok(s.composeForPrompt('a', 'release notes').indexOf('Release') >= 0, 'relevant skill summaries are injectable');
  A.ok(s.removeFile({ agentId: 'a', name: 'Release', path: 'references/api.md' }).ok, 'support file remove works');
  A.eq(s.view('a', 'Release', 'references/api.md'), null, 'removed support file no longer views');
  A.ok(s.archive({ agentId: 'a', name: 'Release' }).ok, 'archive works');
  A.eq(s.list('a').length, 0, 'archived skill hidden by default');
  A.eq(s.list('a', { includeArchived: true }).length, 1, 'archived skill visible when requested');
  A.ok(!s.writeFile({ agentId: 'a', name: 'Release', path: '../escape.md', content: 'x' }).ok, 'bad support paths rejected');
}

// ---- B. same-name write edits IN PLACE (no duplicate) ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact });
  s.write({ agentId: 'a', name: 'Release', summary: 'v1', body: 'old steps' });
  const r2 = s.write({ agentId: 'a', name: 'Release', summary: 'v2', body: 'new steps' });
  A.eq(r2.edited, true, 'second same-name write is an edit');
  A.eq(s.list('a').length, 1, 'still ONE skill (edit in place, no duplicate)');
  A.ok(/new steps/.test(s.view('a', 'Release').body), 'the body was updated');
}

// ---- C. durable: a fresh store rebuilds the library from the on-disk log, edits-latest-wins ----
{
  const io = memIo();
  let s = makeSkillStore({ io, clock, redact });
  s.write({ agentId: 'a', name: 'Backup', summary: 's', body: 'first' });
  s.write({ agentId: 'a', name: 'Backup', summary: 's2', body: 'second' });   // edit
  s = makeSkillStore({ io, clock, redact });   // simulate a RESTART, rebuilt from the same io
  A.eq(s.list('a').length, 1, 'replayed: one skill (not two — fold to latest)');
  A.ok(/second/.test(s.view('a', 'Backup').body), 'replayed: the latest body wins');
}

// ---- D. per-agent cap refuses a NEW skill when full (edits still allowed) ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact, maxPerAgent: 2 });
  A.ok(s.write({ agentId: 'a', name: 'one', body: 'x' }).ok, 'first ok');
  A.ok(s.write({ agentId: 'a', name: 'two', body: 'x' }).ok, 'second ok');
  const over = s.write({ agentId: 'a', name: 'three', body: 'x' });
  A.ok(!over.ok && /full/.test(over.error), 'a NEW skill past the cap is refused');
  A.ok(s.write({ agentId: 'a', name: 'one', body: 'edited' }).ok, 'editing an existing skill still works at the cap');
}

// ---- E. agent isolation + redaction ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact });
  s.write({ agentId: 'a', name: 'mine', body: 'secret token sk-ABCD1234EFGH' });
  s.write({ agentId: 'b', name: 'theirs', body: 'other' });
  A.eq(s.list('a').length, 1, 'agent a sees only its own skill');
  A.eq(s.view('a', 'theirs'), null, 'agent a cannot view agent b\'s skill');
  A.ok(s.view('a', 'mine').body.indexOf('sk-ABCD1234') === -1, 'secrets are redacted in the stored body');
}

// ---- F. a nameless write is rejected (no crash) ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact });
  A.ok(!s.write({ agentId: 'a', body: 'x' }).ok, 'a skill with no name is refused');
}

// ---- G. (H4.2) the skill tools delegate to the store: write saves, list=metadata, view=body ----
{
  const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');
  const store = makeSkillStore({ io: memIo(), clock, redact });
  const tools = makeSkillTools({ store });
  const ctx = { agentId: 'a' };
  A.eq(tools.writeTool.capability, 'memory', 'skill.write joins the NOTEBOOK (memory) capability');
  const w = tools.writeTool.run({ name: 'Deploy', summary: 'ship it', body: 'step 1\nstep 2 deploy' }, ctx);
  A.ok(/Saved skill/.test(w.content), 'skill.write saves');
  const l = tools.listTool.run({}, ctx);
  A.ok(/Deploy/.test(l.content) && /ship it/.test(l.content), 'skill.list shows name + summary');
  A.ok(l.content.indexOf('step 2 deploy') === -1, 'skill.list does NOT leak the body (progressive disclosure)');
  const v = tools.viewTool.run({ name: 'Deploy' }, ctx);
  A.ok(/step 2 deploy/.test(v.content), 'skill.view loads the full body');
  A.ok(/No skill named/.test(tools.viewTool.run({ name: 'ghost' }, ctx).content), 'skill.view on a missing name -> helpful message');
  A.ok(/Updated/.test(tools.writeTool.run({ name: 'Deploy', body: 'v2' }, ctx).content), 'same-name write reports edited');
  A.ok(/Updated/.test(tools.writeTool.run({ name: 'Deploy', mode: 'patch', body: 'v3 patch' }, ctx).content), 'skill.write patch mode works');
  A.ok(/file/.test(tools.writeTool.run({ name: 'Deploy', mode: 'write_file', path: 'templates/checklist.md', content: '- verify' }, ctx).content), 'skill.write support-file mode works');
  A.ok(/verify/.test(tools.viewTool.run({ name: 'Deploy', path: 'templates/checklist.md' }, ctx).content), 'skill.view loads support file');
  A.ok(/Removed/.test(tools.writeTool.run({ name: 'Deploy', mode: 'remove_file', path: 'templates/checklist.md' }, ctx).content), 'skill.write support-file remove works');
  A.ok(/Archived/.test(tools.writeTool.run({ name: 'Deploy', mode: 'archive' }, ctx).content), 'skill.write archive mode works');
  A.ok(/Deploy/.test(tools.listTool.run({ includeArchived: true }, ctx).content), 'skill.list can include archived skills');
}

A.report('skills.test');
