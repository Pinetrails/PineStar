/* node test/routing.b5.test.js — Phase B5: per-bay capability isolation. The router builds a resolveTools
   station from the posted plan's bay objects, so a bay-routed agent's tools are EXACTLY what the floor placed
   in that bay's room. Proves the router→resolveTools wiring; the projection itself is covered by capgate.test. */
'use strict';
const A = require('./_assert.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');

// a deployable intake -> belt -> bay floor (so setPlan accepts it), with the bay enriched as world.js does
function planWith(objects) {
  const geo = {
    belts: [{ x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }],
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'coder' }]
  };
  const plan = Pipeline.compileRoutingPlan(geo);
  plan.bays[0].objects = objects;   // the capability objectTypes world.js attaches from station.bayObjects
  return plan;
}

// a workstation + a cabinet in the bay room -> compute + fs.*
{
  const r = makeRouter();
  A.ok(r.setPlan(planWith(['computer', 'cabinet'])).ok, 'a deployable plan with bay caps is stored');
  const st = r.stationFor('coder');
  A.ok(st && st.rooms.bay.objects.length === 2, 'stationFor builds the bay station from the plan objects');
  A.eq(st.agents.coder.room, 'bay', 'the agent is assigned to its bay room');
  const res = resolveTools('coder', st);
  A.ok(res.hasCompute, 'a computer in the bay room grants compute');
  A.ok(res.tools.indexOf('fs.read') >= 0 && res.tools.indexOf('fs.write') >= 0, 'a cabinet grants fs.*');
}

// a workstation but NO cabinet -> compute, but no fs
{
  const r = makeRouter();
  r.setPlan(planWith(['computer']));
  const res = resolveTools('coder', r.stationFor('coder'));
  A.ok(res.hasCompute, 'compute present');
  A.eq(res.tools.filter(t => t.indexOf('fs.') === 0).length, 0, 'no cabinet in the bay room -> no fs tools');
}

// an UNEQUIPPED bay -> no compute, no tools (the compute gate stays shut; the agent cannot spend — cost-safe)
{
  const r = makeRouter();
  r.setPlan(planWith([]));
  const res = resolveTools('coder', r.stationFor('coder'));
  A.ok(!res.hasCompute, 'an unequipped bay grants NO compute');
  A.eq(res.tools.length, 0, 'an unequipped bay grants no tools');
}

// isolation boundary: an agent with NO bay -> null, so the caller uses its own default office (never starved)
{
  const r = makeRouter();
  r.setPlan(planWith(['computer']));
  A.eq(r.stationFor('someone-else'), null, 'stationFor for a non-bay agent is null (office default applies)');
  A.ok(r.stationFor('coder') !== null, 'stationFor for the bay-bound agent is non-null');
}

// no posted plan -> null (routed-mode off; the office default applies everywhere)
A.eq(makeRouter().stationFor('coder'), null, 'no posted plan -> stationFor null');

// a connector portal carries a per-instance binding: stationFor passes the rich object through verbatim, so the
// connector manager can project THAT server's tools. resolveTools yields no STATIC grant for it (dynamic at run).
{
  const r = makeRouter();
  r.setPlan(planWith(['computer', { objectType: 'connector', connectorId: 'github' }]));
  const st = r.stationFor('coder');
  const objs = st.rooms.bay.objects;
  A.eq(objs.length, 2, 'stationFor keeps both the string cap and the connector object');
  const conn = objs.find(o => o.objectType === 'connector');
  A.ok(conn && conn.connectorId === 'github', 'the connector object passes through with its connectorId intact');
  A.ok(!!conn.instanceId, 'every room object still gets an instanceId');
  const res = resolveTools('coder', st);
  A.ok(res.hasCompute, 'the workstation still grants compute alongside the connector');
  A.eq(res.tools.length, 0, 'a connector adds NO static tool (its MCP tools are projected dynamically at run time)');
}

// the router round-robins SPLITTER dispatch across both bound agents (stateful, matches the engine's spread)
{
  const plan = Pipeline.compileRoutingPlan({
    belts: [{ x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' },
            { x: 2, y: 1, dir: 'S' }, { x: 2, y: 2, dir: 'S' }, { x: 2, y: 3, dir: 'S' }],
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
            { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
            { id: 'br', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'researcher' }]
  });
  const r = makeRouter();
  A.ok(r.setPlan(plan).ok, 'a splitter floor with two bound bays is deployable');
  const seq = [r.resolveTarget({}), r.resolveTarget({}), r.resolveTarget({}), r.resolveTarget({})];
  A.eq(seq.join(','), 'coder,researcher,coder,researcher', 'the router spreads splitter dispatch across both agents (' + seq.join(',') + ')');
  // setPlan resets the round-robin (a new floor starts fresh)
  r.setPlan(plan);
  A.eq(r.resolveTarget({}), 'coder', 're-posting the plan resets the round-robin to the first lane');
}

A.report('routing.b5');
