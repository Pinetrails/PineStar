'use strict';

const WorldModel = require('../frontend/app/worldmodel.js');

function makeStationStore(o) {
  o = o || {};
  const model = o.worldModel || WorldModel;
  let station = null;
  let doc = null;

  function validateStationDoc(nextDoc) {
    if (!nextDoc || typeof nextDoc !== 'object' || Array.isArray(nextDoc)) return { ok: false, error: 'station document required' };
    if (nextDoc.schema && nextDoc.schema !== 'starnet.station') return { ok: false, error: 'unsupported station schema' };
    if (!nextDoc.rooms || typeof nextDoc.rooms !== 'object' || Array.isArray(nextDoc.rooms)) return { ok: false, error: 'station rooms required' };
    if (!Array.isArray(nextDoc.order) || nextDoc.order.length < 1) return { ok: false, error: 'station must contain at least one room' };
    if (!Array.isArray(nextDoc.props)) return { ok: false, error: 'station props must be an array' };
    let parsed;
    try { parsed = model.deserialize(nextDoc); } catch (e) { return { ok: false, error: (e && e.message) || 'station rejected' }; }
    if (!parsed || typeof parsed.bayObjects !== 'function' || typeof parsed.serialize !== 'function') return { ok: false, error: 'station model unavailable' };
    if (!parsed.rooms || !parsed.rooms().length) return { ok: false, error: 'station must contain at least one room' };
    return { ok: true, station: parsed, doc: parsed.serialize() };
  }

  function setStation(nextDoc) {
    const v = validateStationDoc(nextDoc);
    if (!v.ok) return { ok: false, error: v.error };
    station = v.station;
    doc = v.doc;
    return { ok: true, rooms: station.rooms().length, props: station.props().length };
  }

  function clearStation() { station = null; doc = null; return { ok: true, cleared: true }; }
  function hasStation() { return !!station; }
  function getStation() { return doc; }
  function bayObjects(agentId) { return station ? station.bayObjects(agentId) : null; }

  return { validateStationDoc, setStation, clearStation, hasStation, getStation, bayObjects };
}

module.exports = { makeStationStore };
