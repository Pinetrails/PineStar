/* test/org-validator.test.js - pure org graph validator coverage. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const OV = require('../frontend/app/orgvalidator.js');

function twoAgentStation() {
  const s = WM.create();
  const hab = s.roomById(s.spawnRoomId()).rects[0];
  const lab = s.addRoom({ kind: 'lab', rect: { x1: 18, y1: 0, x2: 26, y2: 8 } }).id;
  const b1 = s.addProp({ t: 'bay', x: hab.x1 + 2, y: hab.y1 + 2, w: 2, h: 2, block: false, agentId: 'lead' });
  const c1 = s.addProp({ t: 'console', x: hab.x1 + 6, y: hab.y1 + 2, w: 2, h: 1, block: true, agentId: 'lead' });
  const b2 = s.addProp({ t: 'bay', x: 21, y: 2, w: 2, h: 2, block: false, agentId: 'worker' });
  const c2 = s.addProp({ t: 'console', x: 24, y: 2, w: 2, h: 1, block: true, agentId: 'worker' });
  A.ok(b1.ok && c1.ok && b2.ok && c2.ok && lab, 'fixture places two agents with compute');
  s.addPipelineEdge({ from: 'lead', to: 'worker', whenKind: 'handoff', lane: 'primary' });
  return s;
}

{
  const s = twoAgentStation();
  const v = OV.validateOrg(s);
  A.ok(v.ok, 'connected agents with compute validate');
  A.eq(v.graph.edges[0].runnable, true, 'PipelineEdge is runnable when bay anchors have a path');
  A.eq(v.graph.edgeRunnable['lead>worker:handoff:primary'], true, 'graph carries stable edge readiness lookup');
  A.ok(v.graph.agents.lead.objects.some(o => o.objectType === 'computer'), 'lead compute grant resolves to a placed object');
}

{
  const s = WM.create();
  const r = s.roomById(s.spawnRoomId()).rects[0];
  s.addProp({ t: 'bay', x: r.x1 + 2, y: r.y1 + 2, w: 2, h: 2, block: false, agentId: 'dup' });
  s.addProp({ t: 'bay', x: r.x1 + 6, y: r.y1 + 2, w: 2, h: 2, block: false, agentId: 'dup' });
  const v = OV.validateOrg(s);
  A.ok(!v.ok, 'duplicate bay anchor is invalid');
  A.ok(v.errors.some(e => e.code === 'AGENT_DUPLICATE_ANCHOR' && e.agentId === 'dup'), 'duplicate anchor has a stable reason code');
}

{
  const s = WM.create();
  const r = s.roomById(s.spawnRoomId()).rects[0];
  s.addProp({ t: 'bay', x: r.x1 + 2, y: r.y1 + 2, w: 2, h: 2, block: false, agentId: 'bare' });
  const v = OV.validateOrg(s);
  A.ok(!v.ok, 'agent with no compute is invalid');
  A.ok(v.errors.some(e => e.code === 'AGENT_MISSING_COMPUTE' && e.agentId === 'bare'), 'missing compute has a stable reason code');
}

{
  const s = WM.create();
  const lab = s.addRoom({ kind: 'lab', rect: { x1: 22, y1: 0, x2: 30, y2: 8 } });
  A.ok(lab.ok, 'isolated lab fixture places');
  s.addProp({ t: 'bay', x: 24, y: 2, w: 2, h: 2, block: false, agentId: 'stranded' });
  s.addProp({ t: 'console', x: 27, y: 2, w: 2, h: 1, block: true, agentId: 'stranded' });
  const v = OV.validateOrg(s);
  A.ok(!v.ok, 'agent in a disconnected room is invalid');
  A.ok(v.errors.some(e => e.code === 'AGENT_UNREACHABLE_ANCHOR' && e.agentId === 'stranded'), 'unreachable anchor has a stable reason code');
}

{
  const s = WM.create();
  const r = s.roomById(s.spawnRoomId()).rects[0];
  s.addProp({ t: 'bay', x: r.x1 + 2, y: r.y1 + 2, w: 2, h: 2, block: false, agentId: 'ops' });
  s.addProp({ t: 'console', x: r.x1 + 6, y: r.y1 + 2, w: 2, h: 1, block: true, agentId: 'ops' });
  s.addProp({ t: 'connector_portal', x: r.x1 + 9, y: r.y1 + 2, w: 1, h: 2, block: true });
  const v = OV.validateOrg(s);
  A.ok(!v.ok, 'unbound connector portal is invalid');
  A.ok(v.errors.some(e => e.code === 'CONNECTOR_UNBOUND'), 'unbound connector has a stable reason code');
}

{
  const s = twoAgentStation();
  const doc = s.serialize();
  doc.props.push({ id: 'rogue-console', t: 'console', x: 6, y: 2, w: 2, h: 1, block: true, agentId: 'ghost' });
  doc.props.push({ id: 'bad-console', t: 'console', x: 7, y: 3, w: 2, h: 1, block: true, agentId: 'bad agent id' });
  const snapshot = {
    serialize: () => doc,
    projectGeometry: () => s.projectGeometry(),
    roomAt: (x, y) => s.roomAt(x, y),
    spawnRoomId: () => s.spawnRoomId(),
    roomById: id => s.roomById(id)
  };
  const v = OV.validateOrg(snapshot);
  A.ok(!v.ok, 'grant bound to an invalid or unknown agent is invalid');
  A.ok(v.errors.some(e => e.code === 'GRANT_UNKNOWN_AGENT' && e.agentId === 'ghost'), 'unknown grant agent has a stable reason code');
  A.ok(v.errors.some(e => e.code === 'GRANT_BAD_AGENT' && e.agentId === 'bad agent id'), 'bad grant agent id has a stable reason code');
}

{
  const s = twoAgentStation();
  const doc = s.serialize();
  doc.props.push({ id: 'misbound-console', t: 'console', x: 6, y: 2, w: 2, h: 1, block: true, agentId: 'worker' });
  const snapshot = {
    serialize: () => doc,
    projectGeometry: () => s.projectGeometry(),
    roomAt: (x, y) => s.roomAt(x, y),
    spawnRoomId: () => s.spawnRoomId(),
    roomById: id => s.roomById(id)
  };
  const v = OV.validateOrg(snapshot);
  A.ok(!v.ok, 'grant bound to an agent in another room is invalid');
  A.ok(v.errors.some(e => e.code === 'GRANT_WRONG_ROOM' && e.agentId === 'worker' && e.propId === 'misbound-console'), 'wrong-room grant has a stable reason code');
}

{
  const s = twoAgentStation();
  const al = s.addProp({ t: 'airlock', x: 20, y: 4, w: 1, h: 1, block: false, door: 'closed' });
  A.ok(al.ok, 'sealed airlock fixture places');
  const v = OV.validateOrg(s);
  A.ok(!v.ok, 'sealed target room makes the handoff invalid');
  A.ok(v.errors.some(e => e.code === OV.codes.SEVERED && e.from === 'lead' && e.to === 'worker'), 'severed handoff uses PIPELINE_SEVERED_CONNECT_CORRIDOR');
  A.eq(v.graph.edges[0].runnable, false, 'severed edge is not runnable');
  A.eq(v.graph.edges[0].reason, OV.codes.SEVERED, 'edge graph carries the legible severed reason');
}

{
  const s = twoAgentStation();
  const doc = s.serialize();
  doc.edges.push({ from: 'lead', to: 'worker', whenKind: 'handoff', lane: 'primary' });
  const migrated = WM.deserialize(doc);
  const v = OV.validateOrg(migrated);
  A.ok(!v.ok, 'duplicate PipelineEdge definitions are invalid');
  A.ok(v.errors.some(e => e.code === OV.codes.DUP_EDGE && e.from === 'lead' && e.to === 'worker'), 'duplicate edge has a stable reason code');
  A.eq(v.graph.edgeRunnable['lead>worker:handoff:primary'], false, 'duplicate edge readiness is false instead of ambiguous');
}

{
  const s = twoAgentStation();
  const doc = s.serialize();
  doc.edges = [{ from: 'lead', to: 'lead', whenKind: 'handoff', lane: 'self' }];
  const snapshot = {
    serialize: () => doc,
    projectGeometry: () => s.projectGeometry(),
    roomAt: (x, y) => s.roomAt(x, y),
    spawnRoomId: () => s.spawnRoomId(),
    roomById: id => s.roomById(id)
  };
  const v = OV.validateOrg(snapshot);
  A.ok(!v.ok, 'self PipelineEdge is invalid even when raw snapshots bypass worldmodel mutators');
  A.ok(v.errors.some(e => e.code === OV.codes.SELF_EDGE && e.from === 'lead' && e.to === 'lead'), 'self edge has a stable reason code');
  A.eq(v.graph.edgeRunnable['lead>lead:handoff:self'], false, 'self edge readiness is false');
}

A.report('org-validator');
