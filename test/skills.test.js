/* node test/skills.test.js — the agent's owned SKILL library (H4).
   Part 1 (the store): a skill round-trips through a fresh instance (durable), a same-name write edits IN PLACE
   (no duplicate), list() returns METADATA only (progressive disclosure — name+summary, never the body), view()
   returns the full body by name or id, the per-agent cap refuses a new skill when full, skills are agent-scoped,
   and secrets are redacted on write. Pure + deterministic (in-memory io + injected clock). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const runtimeSkills = require('../sidecar/skills/runtime.js');
const skillReview = require('../sidecar/skillreview.js');
const skillGuard = require('../sidecar/skills/guard.js');
const skillCurator = require('../sidecar/skillcurator.js');
const { makePackageStore } = require('../sidecar/skills/package.js');

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
  A.eq(tools.manageTool.name, 'skill.manage', 'skill.manage is exposed');
  A.ok(/create complete/.test(tools.manageTool.run({ action: 'create', name: 'Review PRs', summary: 'review code', body: 'inspect diff' }, ctx).content), 'skill.manage creates');
  A.ok(/patch complete/.test(tools.manageTool.run({ action: 'patch', target: 'Review PRs', find: 'diff', replace: 'tests and diff' }, ctx).content), 'skill.manage patches');
  A.ok(/tests and diff/.test(tools.viewTool.run({ name: 'Review PRs' }, ctx).content), 'patched body is viewable');
}

// ---- H. skill.manage lifecycle: archive/restore, support files, usage, curator ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact });
  clk = 2000;
  const c = s.manage({ agentId: 'a', action: 'create', name: 'Ship App', summary: 'ship safely', body: 'run tests\nship' });
  A.ok(c.ok, 'manage create succeeds');
  A.ok(!('body' in s.list('a')[0]), 'manage-created skills still list as metadata only');
  A.ok(s.manage({ agentId: 'a', action: 'write_file', target: 'Ship App', path: 'references/checklist.md', content: 'verify rollback' }).ok, 'support file writes under allowed dirs');
  A.ok(!s.manage({ agentId: 'a', action: 'write_file', target: 'Ship App', path: '../oops.md', content: 'x' }).ok, 'unsafe support paths are rejected');
  clk = 2001;
  const v1 = s.view('a', 'Ship App');
  A.eq(v1.viewCount, 1, 'skill.view increments viewCount');
  A.eq(v1.useCount, 1, 'skill.view also counts as use');
  s.markUsed('a', 'Ship App');
  A.eq(s.view('a', 'Ship App', { bump: false }).useCount, 2, 'markUsed increments useCount without loading body');
  A.ok(s.manage({ agentId: 'a', action: 'archive', target: 'Ship App' }).ok, 'archive succeeds');
  A.eq(s.list('a').length, 0, 'archived skills are hidden from default list/prompt index');
  A.eq(s.view('a', 'Ship App'), null, 'archived skills are hidden from default view');
  A.ok(s.manage({ agentId: 'a', action: 'restore', target: 'Ship App' }).ok, 'restore succeeds');
  A.eq(s.list('a').length, 1, 'restored skills return to the list');
  clk = 10000;
  A.ok(s.manage({ agentId: 'a', action: 'pin', target: 'Ship App' }).ok, 'pin succeeds');
  const cur = s.curate('a', { now: 10000 + 100000, staleMs: 1, archiveMs: 2 });
  A.eq(cur.archived, 0, 'pinned skills are not auto-archived');
}

// ---- I. runtime prompt index: metadata only, mandatory skill.view instruction, budgeted ----
{
  const s = makeSkillStore({ io: memIo(), clock, redact });
  s.write({ agentId: 'a', name: 'Deploy', summary: 'ship safely', body: 'SECRET BODY SHOULD NOT LEAK' });
  const out = runtimeSkills.composeIndex(s.list('a'), { budget: 200, canManage: true });
  A.ok(/SAVED AGENT SKILLS/.test(out.text), 'runtime skill index has a mandatory header');
  A.ok(/Deploy/.test(out.text) && /ship safely/.test(out.text), 'index includes skill metadata');
  A.ok(out.text.indexOf('SECRET BODY') === -1, 'index does not inject skill body');
  A.ok(/skill.view/.test(out.text) && /skill.manage/.test(out.text), 'index instructs view-before-use and manage-on-learning');
  A.eq(out.ids.length, 1, 'compose returns ids for use-count bumping');
  const hidden = runtimeSkills.composeIndex([{ id: 'w', name: 'Windows only', summary: 'x', platforms: ['windows'], state: 'active' }], { platform: 'linux' });
  A.eq(hidden.text, '', 'platform filters hide incompatible skills from the prompt index');
  A.eq(runtimeSkills.extractInvocations([{ role: 'user', content: '/skill Deploy\ncontinue' }])[0], 'Deploy', 'slash /skill invocation is parsed');
  A.ok(/PRELOADED SKILLS/.test(runtimeSkills.composeLoaded([s.view('a', 'Deploy', { bump: false })])), 'explicit preload composes full skill bodies');
}

// ---- J. background skill review helpers: complex-run trigger + class-level prompt ----
{
  const simple = { reason: 'done', turns: 1, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }] };
  A.eq(skillReview.shouldReviewRun(simple), false, 'trivial completed run does not trigger skill review');
  const complex = { reason: 'done', turns: 2, messages: [
    { role: 'user', content: 'do a task' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'fs.read' } }, { function: { name: 'shell.exec' } }, { function: { name: 'verify.run' } }, { function: { name: 'fs.edit' } }] }
  ] };
  A.eq(skillReview.shouldReviewRun(complex), true, 'tool-heavy completed run triggers skill review');
  const prompt = skillReview.buildPrompt({ messages: complex.messages, skills: [{ name: 'Existing', summary: 'umbrella', state: 'active' }] });
  A.ok(/update an existing skill/.test(prompt) && /create a new skill only/.test(prompt), 'review prompt prefers patching existing umbrella skills');
  const prompt2 = skillReview.buildPrompt({ messages: complex.messages, loadedSkills: [{ name: 'Loaded Skill', summary: 'was used' }], memories: [{ kind: 'profile', content: 'prefers short answers' }] });
  A.ok(/Loaded Skill/.test(prompt2) && /Recent durable memory context/.test(prompt2), 'review prompt includes loaded skill and memory context');
}

// ---- K. package-backed skills: SKILL.md, support files, setup/platform metadata, guard scan ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-skills-'));
  const packages = makePackageStore({ fs, pathMod: path, root });
  const s = makeSkillStore({ io: memIo(), clock, redact, packageStore: packages, guard: skillGuard });
  const r = s.manage({
    agentId: 'a', action: 'create', name: 'Package Demo', summary: 'package test',
    description: 'writes a package', setup: 'Install deps first.', platforms: ['windows'],
    body: 'Use the package safely.'
  });
  A.ok(r.ok && r.skill.packagePath, 'package-backed create returns a package path');
  A.ok(fs.existsSync(path.join(r.skill.packagePath, 'SKILL.md')), 'SKILL.md is written to disk');
  s.manage({ agentId: 'a', action: 'write_file', target: 'Package Demo', path: 'references/notes.md', content: 'linked detail' });
  const viewed = s.view('a', 'Package Demo', { bump: false });
  A.ok(viewed.files.some(f => f.path === 'references/notes.md' && /linked detail/.test(f.content)), 'view hydrates linked support files');
  A.ok(/Install deps/.test(fs.readFileSync(path.join(viewed.packagePath, 'SKILL.md'), 'utf8')), 'setup notes are rendered into SKILL.md');
  A.eq(viewed.scan.verdict, 'safe', 'safe package records a guard verdict');
  s.manage({ agentId: 'a', action: 'patch', target: 'Package Demo', find: 'safely', replace: 'with curl ${API_TOKEN}' });
  A.eq(s.view('a', 'Package Demo', { bump: false }).scan.verdict, 'dangerous', 'guard scan flags exfiltration-shaped content');
}

// ---- L. curator helpers: agent-created clusters only, pinned/protected filtered out ----
{
  const skills = [
    { name: 'deploy-api', summary: 'x', state: 'active', createdBy: 'agent' },
    { name: 'deploy-ui', summary: 'x', state: 'active', createdBy: 'background-review' },
    { name: 'research-news', summary: 'x', state: 'active', createdBy: 'agent', pinned: true },
    { name: 'bundled-plan', summary: 'x', state: 'active', createdBy: 'builtin' }
  ];
  const cls = skillCurator.clusters(skills);
  A.eq(cls.length, 1, 'curator clusters unpinned agent-created siblings');
  A.eq(cls[0].key, 'deploy', 'cluster key comes from skill prefix');
  A.ok(/deploy-api/.test(skillCurator.buildPrompt({ skills })), 'curator prompt includes candidate skills');
}

A.report('skills.test');
