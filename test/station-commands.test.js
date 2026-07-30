/* node test/station-commands.test.js — the PAGE half of the station bridge, run for real.

   stationcommands.js is a browser IIFE, but it is self-contained: it touches only Workstreams / App / Chat /
   U / fetch. So it is loaded here in a vm with the REAL workstreams.js underneath it and the page bridges
   stubbed. That means station.deliver is exercised against genuine session records — the fold, the append,
   the idempotency and the refusals are proven against the same code the app runs, not a paraphrase of it.

   What this exists to stop: delegation used to be agent-addressed only, so a run the Commander asked to
   happen in "research" was filed wherever the lead happened to be. These two verbs are how a session target
   becomes real — station.sessions is what a name is resolved against, station.deliver is what the Commander
   actually sees. Both must refuse loudly rather than half-succeed. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'frontend', 'app', 'stationcommands.js');
const src = fs.readFileSync(SRC, 'utf8');

// Boot a fresh page: real Workstreams, stub bridges. Returns the module surface plus what the page recorded.
function boot(opts) {
  opts = opts || {};
  delete require.cache[require.resolve('../frontend/app/workstreams.js')];
  const Workstreams = require('../frontend/app/workstreams.js');
  Workstreams.reset();
  const page = { rail: 0, persisted: 0, loaded: [], acks: [] };
  const sandbox = {
    Workstreams,
    App: { refreshRail: () => page.rail++, persist: () => page.persisted++, agents: opts.agents || (() => []) },
    Chat: { load: ws => page.loaded.push(ws.id) },
    U: { bus: { on: () => {} } },
    VoiceLive: opts.voiceLive,
    fetch: async (url, init) => { page.acks.push(JSON.parse(init.body)); return { ok: true }; },
    document: { addEventListener: () => {} },
    console, setTimeout, clearTimeout, Date, JSON
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // a top-level `const` is NOT a property of the context object (the same reason the module probes App/Chat by
  // bare identifier rather than window.App), so take the module as the script's completion value.
  const S = vm.runInContext(src + '\n;StationCommands;', sandbox, { filename: 'stationcommands.js' });
  return { S, W: Workstreams, page };
}
// run a verb through the module's real dispatch path (the same one U.bus drives) and read the ack it posted
async function call(env, verb, args) {
  await env.S.run('cmd-' + env.page.acks.length, verb, args);
  return env.page.acks[env.page.acks.length - 1];
}

(async () => {

// ---- station.sessions: the list a session NAME is resolved against ----
{
  const env = boot();
  const r1 = env.W.create('research');
  env.W.create('Billing rewrite');
  const out = await call(env, 'station.sessions', {});
  A.eq(out.ok, true, 'the page can list its sessions');
  const titles = out.result.sessions.map(s => s.title);
  A.ok(titles.indexOf('research') >= 0, 'a named session is listed by its real title');
  A.ok(titles.indexOf('General') >= 0, 'the untitled home stream is listed under the name the UI shows it by');
  A.eq(out.result.activeId, r1 && out.result.sessions.find(s => s.active).id, 'the active session is flagged');
  A.ok(out.result.sessions.every(s => s.id && s.agentId), 'every row carries the id and agent a dispatch needs');
}

// ---- station.deliver: the worker's answer lands in the session the Commander named ----
{
  const env = boot();
  const ws = env.W.create('research');
  env.W.switch(env.W.generalId());          // the Commander is looking at General, not research
  const before = env.page.rail;
  const out = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', prompt: 'summarise X', text: 'X in three points…' });
  A.eq(out.ok, true, 'the fold succeeded');
  A.eq(out.result.session, 'research', 'and reports which session it went into');
  const h = env.W.get(ws.id).history;
  A.eq(h.length, 2, 'two turns: the framing marker and the real answer');
  A.eq(h[0].sys, true, 'the delegated instruction is a sys marker, not a user turn the Commander never typed');
  A.ok(/delegated to researcher/.test(h[0].content), 'the marker names who it went to');
  A.eq(h[1].role, 'assistant', "the worker's answer is real dialogue");
  A.eq(h[1].content, 'X in three points…', 'delivered verbatim');
  A.eq(h[1].agentId, 'researcher', 'attributed to the WORKER, so renderHistory names the right speaker');
  A.ok(env.W.get(ws.id).runIds.indexOf('run-1') >= 0, 'the run is filed onto that session');
  A.eq(env.W.get(ws.id).lane, 'active', 'a real run advances the lane (hybrid-honest)');
  A.ok(env.W.unread(ws.id), 'the rail flags it unread — the Commander has genuinely not seen this yet');
  A.ok(env.page.rail > before && env.page.persisted > 0, 'the rail re-renders and the save is written');
  A.eq(env.page.loaded.length, 0, 'a session that is NOT open is not force-rendered');
}

// delivering into the session the Commander is WATCHING re-renders it immediately
{
  const env = boot();
  const ws = env.W.create('research');       // create() activates it
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'done' });
  A.eq(env.page.loaded[0], ws.id, 'the open session is reloaded so the answer appears at once');
  A.ok(!env.W.unread(ws.id), 'and it is not marked unread — it is on screen');
}

/* ⛔ APPEND, NEVER REPLACE. A targeted session usually already holds the Commander's own conversation. The
   cron auto-session path may replace a history because it OWNS its stream; this one does not, and replacing
   here would silently delete the thread the Commander asked to add work to. */
{
  const env = boot();
  const ws = env.W.create('research');
  ws.history.push({ role: 'user', content: 'my own question' }, { role: 'assistant', content: 'my own answer' });
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'delegated result' });
  const h = env.W.get(ws.id).history;
  A.eq(h.length, 3, 'the existing conversation survives');
  A.eq(h[0].content, 'my own question', 'the Commander\'s first turn is untouched');
  A.eq(h[2].content, 'delegated result', 'the delegated answer is appended after it');
}

// the same run never posts twice (a retry, a duplicate command, a re-delivered background worker)
{
  const env = boot();
  const ws = env.W.create('research');
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'once' });
  const second = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'once' });
  A.eq(second.ok, true, 'a repeat delivery is not an error');
  A.eq(second.result.folded, false, 'but it reports that nothing was folded');
  A.eq(env.W.get(ws.id).history.length, 1, 'and the answer appears exactly once');
}

// ---- refusals: every one is ok:false with a reason, never a quiet success ----
{
  const env = boot();
  const ws = env.W.create('research');
  const gone = await call(env, 'station.deliver', { streamId: 'ws_nope', agentId: 'r', runId: 'x', text: 'hi' });
  A.eq(gone.ok, false, 'delivering to a session that does not exist fails');
  A.ok(/no session with id ws_nope/.test(gone.error), 'and says so precisely');
  const empty = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'r', runId: 'x', text: '   ' });
  A.eq(empty.ok, false, 'an empty answer is refused rather than posting a blank turn');
  A.eq(env.W.get(ws.id).history.length, 0, 'and nothing was written');
  const unknown = await call(env, 'station.nonsense', {});
  A.eq(unknown.ok, false, 'an unknown verb fails instead of resolving true');
  A.ok(/unknown station verb/.test(unknown.error), 'naming the verb it could not run');
}

// station.status refuses honestly when the view is not up yet (rather than inventing an empty station)
{
  const env = boot();
  const out = await call(env, 'station.status', {});
  A.eq(out.ok, false, 'no VoiceLive snapshot yet -> an honest refusal');
  A.ok(/not ready/.test(out.error), 'and it says the view is not ready');
}

// station.crew reports the real roster, and refuses when there is none
{
  const empty = boot({ agents: () => [] });
  A.eq((await call(empty, 'station.crew', {})).ok, false, 'an empty roster is a refusal, not a fake crew');
  const crewed = boot({ agents: () => [{ id: 'researcher', name: 'RESEARCHER', model: 'm1' }] });
  const out = await call(crewed, 'station.crew', {});
  A.eq(out.ok, true, 'a real roster answers');
  A.eq(out.result.crew[0].id, 'researcher', 'with the ids a dispatch has to address');
}

/* ---- station.new_session: the agent can OPEN a session by name — the half "make a session called
   research and have them work in it" was missing (dispatch could target one, nothing could create one) ---- */
{
  const env = boot({ agents: () => [{ id: 'researcher', name: 'RESEARCHER' }] });
  const out = await call(env, 'station.new_session', { title: 'research', agentId: 'researcher' });
  A.eq(out.ok, true, 'a named session is created');
  A.eq(out.result.title, 'research', 'with the title the Commander said');
  A.eq(out.result.agentId, 'researcher', 'bound to the named crew member');
  A.eq(out.result.focused, false, 'not focused unless asked');
  A.ok(env.W.list().some(w => w.title === 'research'), 'and it exists in the real session store');
  A.eq(env.W.activeId(), env.W.generalId(), 'a background create never steals what the Commander is looking at');
  A.ok(env.page.rail > 0 && env.page.persisted > 0, 'the rail re-rendered and the save was written');

  // focus:true is the explicit "open it" ask — active session moves, thread renders
  const f = await call(env, 'station.new_session', { title: 'billing', focus: true });
  A.eq(f.ok, true, 'a focused create succeeds');
  A.eq(env.W.activeId(), f.result.id, 'and the Commander is now looking at it');
  A.eq(env.page.loaded[env.page.loaded.length - 1], f.result.id, 'the thread rendered');
}

// a duplicate title is REFUSED — a twin would make every later name-addressed action ambiguous
{
  const env = boot();
  env.W.create('research');
  const dup = await call(env, 'station.new_session', { title: 'RESEARCH' });
  A.eq(dup.ok, false, 'a case-different duplicate is still a duplicate');
  A.ok(/already exists/.test(dup.error), 'and the refusal says so');
  const gen = await call(env, 'station.new_session', { title: 'General' });
  A.eq(gen.ok, false, 'the untitled home stream\'s display name is reserved too');
  const ghost = await call(env, 'station.new_session', { title: 'ops', agentId: 'nobody' });
  A.eq(ghost.ok, false, 'an unknown agentId is refused, not silently dropped');
  A.ok(/no crew member/.test(ghost.error), 'naming what was wrong');
  A.ok(!env.W.list().some(w => w.title === 'ops'), 'and no session was created');
}

/* ---- station.switch_session: focus by the name the Commander says — same resolution law as dispatch
   (exact id → exact title → unique substring; anything else refuses with the real names) ---- */
{
  const env = boot();
  const r = env.W.create('research');
  env.W.create('Billing rewrite');
  env.W.switch(env.W.generalId());
  const out = await call(env, 'station.switch_session', { session: 'research' });
  A.eq(out.ok, true, 'an exact title switches');
  A.eq(env.W.activeId(), r.id, 'the Commander is now looking at it');
  A.eq(env.page.loaded[env.page.loaded.length - 1], r.id, 'and the thread rendered');
  const part = await call(env, 'station.switch_session', { session: 'billing' });
  A.eq(part.ok, true, 'a unique substring resolves');
  const gen = await call(env, 'station.switch_session', { session: 'general' });
  A.eq(gen.ok, true, 'the home stream is addressable by the name the UI shows');
  A.eq(env.W.activeId(), env.W.generalId(), 'and focuses General');
}

// the refusals — never a guess, and always the list the model needs to correct itself
{
  const env = boot();
  env.W.create('research plan');
  env.W.create('research notes');
  env.W.switch(env.W.generalId());   // the Commander is looking at General; a refusal must leave them there
  const ambig = await call(env, 'station.switch_session', { session: 'research' });
  A.eq(ambig.ok, false, 'an ambiguous name refuses');
  A.ok(/more than one session matches/.test(ambig.error) && /research plan/.test(ambig.error), 'explaining the ambiguity with the real names');
  A.eq(env.W.activeId(), env.W.generalId(), 'and the focus did NOT move');
  const none = await call(env, 'station.switch_session', { session: 'marketing' });
  A.eq(none.ok, false, 'an unknown name refuses');
  A.ok(/no session called "marketing"/.test(none.error) && /research plan/.test(none.error), 'and lists what does exist');
}

// every verb the sidecar can ask for is implemented here (a missing one would fail as "unknown verb" live)
{
  const env = boot();
  const verbs = env.S.verbs();
  for (const v of ['station.status', 'station.crew', 'station.sessions', 'station.deliver', 'station.new_session', 'station.switch_session']) {
    A.ok(verbs.indexOf(v) >= 0, 'the page implements ' + v);
  }
  for (const file of ['orchestration.js', 'station.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', file), 'utf8');
    for (const m of src.match(/(?:station|ask)\('(station\.[^']+)'/g) || []) {
      const verb = /'([^']+)'/.exec(m)[1];
      A.ok(verbs.indexOf(verb) >= 0, file + ' asks for ' + verb + ', and the page can answer it');
    }
  }
}

A.report('station-commands.test');

})().catch(error => { console.error(error); process.exit(1); });
