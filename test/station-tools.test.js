/* node test/station-tools.test.js — session.list / session.create / session.focus (the agent's session
   verbs over the station bridge). Driven against a stub bridge: what these tools OWN is the honesty
   contract — a bridge refusal, a silent page, or a missing bridge must come back as an explicit REFUSED
   the model cannot misread as success, because "created the research session" with no session behind it
   is the exact lie the bridge exists to prevent. The page half is proven against the REAL Workstreams in
   station-commands.test.js; the two meet in the cross-check there and live in the e2e. */
'use strict';
const A = require('./_assert.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');

function stubBridge(impl) {
  const seen = [];
  return { seen, request: async (verb, args) => { seen.push({ verb, args }); return impl(verb, args); } };
}

(async () => {

// ---- passthrough: each tool asks its verb and returns the page's real answer ----
{
  const bridge = stubBridge(verb => {
    if (verb === 'station.sessions') return { ok: true, result: { count: 2, sessions: [{ id: 'a', title: 'research' }, { id: 'b', title: 'General' }] } };
    if (verb === 'station.new_session') return { ok: true, result: { id: 'c', title: 'ops', focused: false } };
    if (verb === 'station.switch_session') return { ok: true, result: { id: 'a', title: 'research' } };
    return { ok: false, error: 'unknown' };
  });
  const t = makeStationTools({ station: bridge });
  const list = await t.listTool.run({});
  A.eq(JSON.parse(list.content).count, 2, 'session.list returns the real session list');
  A.eq(list.summary, '2 session(s)', 'and a truthful summary');
  const made = await t.createTool.run({ title: 'ops', agentId: 'researcher' });
  A.eq(JSON.parse(made.content).id, 'c', 'session.create returns the created id');
  A.eq(bridge.seen[1].args.title, 'ops', 'the title travels verbatim');
  A.eq(bridge.seen[1].args.agentId, 'researcher', 'and the crew binding travels');
  A.eq(bridge.seen[1].args.focus, false, 'focus is never implied');
  const foc = await t.focusTool.run({ session: 'research' });
  A.eq(JSON.parse(foc.content).title, 'research', 'session.focus returns where the Commander now is');
}

// ---- ⛔ the honesty contract: every failure is an explicit REFUSED, never a soft nothing ----
{
  const t = makeStationTools({});   // no bridge at all (bare host / headless composition)
  for (const [tool, args] of [[t.listTool, {}], [t.createTool, { title: 'x' }], [t.focusTool, { session: 'x' }]]) {
    const out = await tool.run(args);
    A.ok(/^REFUSED:/.test(out.content), tool.name + ' without a bridge refuses explicitly');
    A.ok(/do not report this action as done/.test(out.content), 'and tells the model not to claim it');
  }
  const down = makeStationTools({ station: stubBridge(() => ({ ok: false, error: 'no station page answered — open StarNet to run station commands', unattended: true })) });
  const out = await down.createTool.run({ title: 'research' });
  A.ok(/REFUSED: no station page answered/.test(out.content), 'an unattended station (cron/Night Shift) is named, not papered over');
  const refused = makeStationTools({ station: stubBridge(() => ({ ok: false, error: 'a session called "research" already exists — delegate into it, focus it, or pick another name' })) });
  const dup = await refused.createTool.run({ title: 'research' });
  A.ok(/already exists/.test(dup.content), "the page's own refusal reaches the model verbatim");
  const thrown = makeStationTools({ station: { request: async () => { throw new Error('bus is down'); } } });
  const boom = await thrown.listTool.run({});
  A.ok(/REFUSED: bus is down/.test(boom.content), 'a throwing bridge refuses instead of crashing the run');
}

// ---- input hygiene runs before the bridge is ever bothered ----
{
  const bridge = stubBridge(() => ({ ok: true, result: {} }));
  const t = makeStationTools({ station: bridge });
  A.ok(/REFUSED: a session needs a title/.test((await t.createTool.run({ title: '   ' })).content), 'a blank title never reaches the page');
  A.ok(/REFUSED: name which session/.test((await t.focusTool.run({})).content), 'a blank focus target never reaches the page');
  A.eq(bridge.seen.length, 0, 'no bridge round-trip was spent on either');
  const long = 'x'.repeat(200);
  await t.createTool.run({ title: long });
  A.eq(bridge.seen[0].args.title.length, 80, 'a runaway title is clamped to the session-title cap');
}

// ---- capability surface: lead-only, and consent-free (a session costs nothing and is reversible) ----
{
  const t = makeStationTools({});
  for (const tool of [t.listTool, t.createTool, t.focusTool]) {
    A.eq(tool.capability, 'orchestrator', tool.name + ' rides the lead-only orchestrator gate');
    A.eq(tool.requiresConsent, false, tool.name + ' needs no consent beat');
  }
  A.eq(t.listTool.scope, 'read', 'listing is a read');
  A.eq(t.createTool.scope, 'write', 'creating is a write');
  const reg = { registered: [], register(x) { this.registered.push(x.name); } };
  t.register(reg);
  A.eq(reg.registered.join(','), 'session.list,session.create,session.focus', 'register() installs exactly the three verbs');
}

/* ---- ⛔ THE CAPABILITY REGISTRY IS AN ALLOWLIST. A tool registered with the host but not declared in
   sidecar/capability/registry.js is exposed to NOBODY — these three shipped exactly that way on the first
   pass and a live model said "I don't have a session tool" while every unit test was green. Registration
   and declaration land together or the tool does not exist. */
{
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sidecar', 'capability', 'registry.js'), 'utf8');
  const orch = src.slice(src.indexOf('orchestrator: ['), src.indexOf(']', src.indexOf('orchestrator: [')));
  for (const name of ['session.list', 'session.create', 'session.focus']) {
    A.ok(orch.indexOf("tool: '" + name + "'") >= 0, name + ' is DECLARED in the orchestrator capability allowlist (registration alone exposes nothing)');
  }
  A.ok(/tool: 'session\.create', scope: 'write', requiresConsent: false/.test(orch), 'session.create is consent-free (spends nothing, reversible)');
}

A.report('station-tools.test');

})().catch(error => { console.error(error); process.exit(1); });
