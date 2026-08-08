/* node test/journeystore.test.js — browser citizen for the durable journey route. */
'use strict';
const A = require('./_assert.js');
const calls = [], notes = [];
global.document = { body: { dataset: {} } };
global.StationUI = { rerender: key => calls.push({ rerender: key }), notify: (text, tone) => notes.push({ text, tone }) };
global.SFX = { milestone: () => calls.push({ sfx: 'milestone' }) };
let responseJourney = { evolution: { stage: 1, name: 'VECTOR', goalsReached: 1 }, metrics: [], mastery: [], receipts: [], outcomes: [], suppressed: {} };
global.fetch = async (url, opts) => {
  calls.push({ url, opts: opts || {} });
  return { ok: true, json: async () => ({ ok: true, journey: responseJourney, metric: { id: 'jm:1' } }) };
};
const { JourneyStore } = require('../frontend/app/journeystore.js');

(async () => {
  JourneyStore._apply({ evolution: { stage: 0, name: 'DRIFT', goalsReached: 0 }, metrics: [], mastery: [], receipts: [], outcomes: [], suppressed: {} });
  A.eq(notes.length, 0, 'initial hydration never fabricates an evolution celebration');
  JourneyStore._apply(responseJourney);
  A.eq(document.body.dataset.journeyStage, '1', 'proof-backed stage projects into the world dataset');
  A.eq(notes[0].tone, 'gold', 'a later proven stage increase produces one visible receipt beat');

  const created = await JourneyStore.createMetric({ label: 'Users', baseline: 0, target: 10 });
  A.ok(created.ok, 'metric create returns the sidecar acknowledgement');
  let post = calls.filter(c => c.url === '/api/journey').pop();
  A.eq(JSON.parse(post.opts.body).op, 'metric.create', 'metric create uses the narrow journey operation');
  await JourneyStore.updateMetric('jm:1', 5, 'billing');
  post = calls.filter(c => c.url === '/api/journey').pop();
  A.eq(JSON.parse(post.opts.body), { op: 'metric.update', id: 'jm:1', current: 5, note: 'billing' }, 'metric update sends the explicit Commander value and note');
  await JourneyStore.suppress('builder', 'building');
  A.eq(JSON.parse(calls.filter(c => c.url === '/api/journey').pop().opts.body).op, 'adaptation.suppress', 'Commander correction reaches the reversible adaptation operation');
  await JourneyStore.reset();
  A.eq(JSON.parse(calls.filter(c => c.url === '/api/journey').pop().opts.body).op, 'journey.reset', 'new-Commander reset clears the server-owned journey too');
  A.report('journeystore.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
