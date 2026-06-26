/* frontend/app/orgvalidator.js - pure AgentOrg validator for placed stations.

   Validates the org graph before runtime: each agent has one bay anchor, grants are
   backed by placed props, and PipelineEdge handoffs are runnable only when the
   projected room/door path graph can connect the two bay anchors. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.OrgValidator = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEVERED = 'PIPELINE_SEVERED_CONNECT_CORRIDOR';
  const DUP_EDGE = 'PIPELINE_DUPLICATE_EDGE';
  const SELF_EDGE = 'PIPELINE_SELF_EDGE';
  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const WHEN_RE = /^[A-Za-z0-9_.:-]{1,40}$/;

  const clone = o => JSON.parse(JSON.stringify(o));
  const asArray = a => Array.isArray(a) ? a : [];
  const capFor = p => {
    const m = {
      console: 'computer', consoleL: 'computer', desk: 'computer', desk2: 'computer', pixelrig: 'computer', bench: 'computer',
      war_intelcab: 'cabinet', safe: 'cabinet', vault: 'cabinet', rack: 'cabinet', shelf: 'cabinet',
      comms_dish: 'dish', comms_uplink: 'dish', comms_beacon: 'dish',
      gigs_servercart: 'notebook', bridge_relaystack: 'notebook', core: 'notebook',
      connector_portal: 'connector',
      workbench: 'workbench'
    };
    return m[p && p.t] || null;
  };
  const isComputer = p => capFor(p) === 'computer';
  const center = p => ({ x: (p.x | 0) + Math.floor(((p.w || 1) - 1) / 2), y: (p.y | 0) + Math.floor(((p.h || 1) - 1) / 2) });
  const edgeKey = e => e.from + '>' + e.to + ':' + e.whenKind + ':' + (e.lane || '');
  function footprintRoom(prop, roomAt) {
    const w = Math.max(1, prop && prop.w | 0 || 1);
    const h = Math.max(1, prop && prop.h | 0 || 1);
    let roomId = null;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const rid = roomAt((prop.x | 0) + xx, (prop.y | 0) + yy);
      if (!rid) return { ok: false, roomId: roomId || null };
      if (roomId == null) roomId = rid;
      else if (roomId !== rid) return { ok: false, roomId };
    }
    return { ok: true, roomId };
  }

  function stationParts(input) {
    const model = input && typeof input.projectGeometry === 'function' && typeof input.serialize === 'function' ? input : null;
    const doc = model ? input.serialize() : (input && typeof input.doc === 'function' ? input.doc() : input);
    const geo = input && typeof input.projectGeometry === 'function' ? input.projectGeometry() : null;
    return { model, doc: doc || {}, geo };
  }

  function localAnchor(geo, prop) {
    const c = center(prop);
    return { x: c.x - geo.origin.tx, y: c.y - geo.origin.ty };
  }

  function localRoomCenter(geo, room) {
    const r = room && room.rects && room.rects[0];
    if (!r) return null;
    return {
      x: (Math.floor((r.x1 + r.x2) / 2) | 0) - geo.origin.tx,
      y: (Math.floor((r.y1 + r.y2) / 2) | 0) - geo.origin.ty
    };
  }

  function hasCompute(agentId, roomId, props, roomAt) {
    const boundBays = props.filter(p => p.t === 'bay' && p.agentId && roomAt(p.x, p.y) === roomId).length;
    const soloRoom = boundBays <= 1;
    return props.some(p => isComputer(p) && roomAt(p.x, p.y) === roomId && (p.agentId === agentId || (!p.agentId && soloRoom)));
  }

  function validateOrg(input, opts) {
    const parts = stationParts(input);
    const doc = parts.doc;
    const props = asArray(doc.props);
    const edges = asArray(doc.edges);
    const errors = [];
    const warnings = [];
    const agents = {};
    const graphEdges = [];
    const byAgent = {};
    const geo = parts.geo;
    const roomAt = parts.model && typeof parts.model.roomAt === 'function'
      ? (x, y) => parts.model.roomAt(x, y)
      : () => null;

    for (const p of props) {
      if (p.t !== 'bay' || !p.agentId) continue;
      if (!AID_RE.test(p.agentId)) {
        errors.push({ code: 'AGENT_BAD_ID', propId: p.id || null, agentId: p.agentId });
        continue;
      }
      (byAgent[p.agentId] = byAgent[p.agentId] || []).push(p);
    }

    const spawnRoomId = parts.model && typeof parts.model.spawnRoomId === 'function' ? parts.model.spawnRoomId() : doc.meta && (doc.meta.trunkRoomId || doc.meta.spawnRoomId);
    const spawnRoom = parts.model && typeof parts.model.roomById === 'function' && spawnRoomId ? parts.model.roomById(spawnRoomId) : null;
    const spawnAnchor = geo ? localRoomCenter(geo, spawnRoom) : null;

    for (const agentId of Object.keys(byAgent).sort()) {
      const bays = byAgent[agentId];
      if (bays.length !== 1) {
        errors.push({ code: 'AGENT_DUPLICATE_ANCHOR', agentId, propIds: bays.map(p => p.id || null) });
        continue;
      }
      const bay = bays[0];
      const anchorFootprint = footprintRoom(bay, roomAt);
      const roomId = anchorFootprint.roomId;
      if (!anchorFootprint.ok) {
        errors.push({ code: roomId ? 'AGENT_ANCHOR_BAD_FOOTPRINT' : 'AGENT_ANCHOR_OFF_DECK', agentId, propId: bay.id || null });
        continue;
      }
      agents[agentId] = { agentId, bayPropId: bay.id || null, roomId, objects: [] };
      if (geo && typeof geo.path === 'function' && spawnAnchor && roomId !== spawnRoomId) {
        const bayAnchor = localAnchor(geo, bay);
        if (!geo.path(spawnAnchor.x, spawnAnchor.y, bayAnchor.x, bayAnchor.y)) {
          errors.push({ code: 'AGENT_UNREACHABLE_ANCHOR', agentId, propId: bay.id || null, roomId });
        }
      }
      if (!hasCompute(agentId, roomId, props, roomAt)) errors.push({ code: 'AGENT_MISSING_COMPUTE', agentId, propId: bay.id || null });
    }

    const seenGrants = {};
    for (const p of props) {
      const cap = capFor(p);
      if (!cap) continue;
      const placedFootprint = footprintRoom(p, roomAt);
      const roomId = placedFootprint.roomId;
      if (!placedFootprint.ok) {
        errors.push({ code: roomId ? 'GRANT_BAD_FOOTPRINT' : 'GRANT_UNPLACED_OBJECT', propId: p.id || null, objectType: cap });
        continue;
      }
      if (p.agentId) {
        if (!AID_RE.test(p.agentId)) errors.push({ code: 'GRANT_BAD_AGENT', propId: p.id || null, agentId: p.agentId, objectType: cap });
        else if (!agents[p.agentId]) errors.push({ code: 'GRANT_UNKNOWN_AGENT', propId: p.id || null, agentId: p.agentId, objectType: cap });
        else if (agents[p.agentId].roomId !== roomId) errors.push({ code: 'GRANT_WRONG_ROOM', propId: p.id || null, agentId: p.agentId, objectType: cap, roomId });
      }
      if (cap === 'connector' && !p.connectorId) errors.push({ code: 'CONNECTOR_UNBOUND', propId: p.id || null });
      for (const agentId of Object.keys(agents)) {
        const a = agents[agentId];
        if (a.roomId !== roomId) continue;
        if (cap === 'computer' && !(p.agentId === agentId || (!p.agentId && props.filter(q => q.t === 'bay' && q.agentId && roomAt(q.x, q.y) === roomId).length <= 1))) continue;
        if (cap === 'connector' && !p.connectorId) continue;
        const objectType = cap === 'connector' ? 'connector' : cap;
        const k = agentId + ':' + objectType + ':' + (p.connectorId || '');
        if (!seenGrants[k]) {
          seenGrants[k] = true;
          a.objects.push(cap === 'connector' ? { objectType, connectorId: p.connectorId, propId: p.id || null } : { objectType, propId: p.id || null });
        }
      }
    }

    const edgeCounts = {};
    for (const e of edges) {
      const edge = { from: String(e.from || '').trim(), to: String(e.to || '').trim(), whenKind: e.whenKind == null ? '' : String(e.whenKind).trim() };
      if (e.lane) edge.lane = String(e.lane).trim();
      const k = edgeKey(edge);
      edgeCounts[k] = (edgeCounts[k] || 0) + 1;
    }

    const validEdges = {};
    for (const e of edges) {
      const edge = { from: String(e.from || '').trim(), to: String(e.to || '').trim(), whenKind: e.whenKind == null ? '' : String(e.whenKind).trim() };
      if (e.lane) edge.lane = String(e.lane).trim();
      const from = agents[edge.from], to = agents[edge.to];
      const out = { from: edge.from, to: edge.to, whenKind: edge.whenKind, lane: edge.lane || null, runnable: false, reason: null };
      if (!AID_RE.test(edge.from) || !AID_RE.test(edge.to) || !WHEN_RE.test(edge.whenKind) || (edge.lane && !WHEN_RE.test(edge.lane))) out.reason = 'PIPELINE_BAD_EDGE';
      else if (edge.from === edge.to) out.reason = SELF_EDGE;
      else if (edgeCounts[edgeKey(edge)] > 1) out.reason = DUP_EDGE;
      else if (!from || !to) out.reason = 'PIPELINE_UNKNOWN_AGENT';
      else if (!geo || typeof geo.path !== 'function') out.reason = 'PIPELINE_NO_PATH_GRAPH';
      else {
        const fb = props.find(p => p.id === from.bayPropId);
        const tb = props.find(p => p.id === to.bayPropId);
        const a = localAnchor(geo, fb), b = localAnchor(geo, tb);
        const path = geo.path(a.x, a.y, b.x, b.y);
        if (path) { out.runnable = true; out.pathLength = path.length; }
        else out.reason = SEVERED;
      }
      if (!out.runnable) errors.push({ code: out.reason, from: out.from, to: out.to, whenKind: out.whenKind, lane: out.lane || undefined });
      validEdges[edgeKey(edge)] = out.runnable;
      graphEdges.push(out);
    }

    const graph = { agents, edges: graphEdges, edgeRunnable: validEdges };
    return { ok: errors.length === 0, errors, warnings, graph };
  }

  return { validateOrg, validate: validateOrg, codes: { SEVERED, DUP_EDGE, SELF_EDGE, BAD_EDGE: 'PIPELINE_BAD_EDGE' } };
});
