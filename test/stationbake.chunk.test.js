'use strict';

const A = require('./_assert.js');

global.U = {
  hash(s) {
    let h = 2166136261;
    s = String(s);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  },
  shade(c) { return c; }
};

const canvases = [];
function fakeGradient() {
  return { addColorStop() {} };
}
function fakeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
    beginPath() {}, rect() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, closePath() {},
    clip() {}, save() {}, restore() {}, translate() {}, setTransform() {},
    fill() {}, stroke() {}, fillRect() {}, clearRect() {}, strokeRect() {}, drawImage() {},
    fillText() {}, measureText(s) { return { width: String(s || '').length * 7 }; },
    createRadialGradient: fakeGradient
  };
}
global.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
    const c = { width: 0, height: 0, getContext() { return fakeCtx(); } };
    canvases.push(c);
    return c;
  }
};

const StationBake = require('../frontend/app/stationbake.js');

function makeGeo() {
  const TILE = 12, COLS = 75, ROWS = 52;
  const zoneGrid = new Array(COLS * ROWS).fill(null);
  const idx = (x, y) => y * COLS + x;
  for (let y = 2; y <= 40; y++) for (let x = 2; x <= 60; x++) zoneGrid[idx(x, y)] = 'r1';
  return {
    TILE, COLS, ROWS, W: 900, H: 650, origin: { tx: 0, ty: 0 },
    allRects: [{ z: 'r1', x1: 2, y1: 2, x2: 60, y2: 40 }],
    zones: { r1: { x1: 2, y1: 2, x2: 60, y2: 40 } },
    ROOM_IDS: ['r1'], chamfers: [], windows: [], doorDefs: [], zoneGrid, idx,
    isCorridor: () => false,
    canStep: (x1, y1, x2, y2) => zoneGrid[idx(x1, y1)] === zoneGrid[idx(x2, y2)],
    baseColorOf: () => '#30343a',
    nameOf: () => 'HAB-01',
    kindOf: () => 'hab',
    FLOOR_STYLES: { hull: { base: '#30343a' } }
  };
}

const geo = makeGeo();
canvases.length = 0;
const first = StationBake.bakeIncremental(geo, null, null);
A.ok(first.chunked, 'large bake uses the chunk cache');
A.eq(first.stats.chunkCount, 6, '900x650 bake splits into a 3x2 chunk grid');
A.eq(first.stats.rebakedChunks, 6, 'cold bake renders every chunk once');
A.ok(canvases.every(c => c.width <= StationBake.CHUNK_PX && c.height <= StationBake.CHUNK_PX),
  'chunk bake never allocates a full-world canvas');

const reusedBefore = new Map(first.chunkMap);
canvases.length = 0;
const second = StationBake.bakeIncremental(geo, first, [{ x1: 10, y1: 10, x2: 10, y2: 10 }]);
A.eq(second.stats.fullReset, false, 'same bounds/origin allow incremental reuse');
A.eq(second.stats.dirtyChunks, ['0,0'], 'single tile edit maps to the exact dirty chunk');
A.eq(second.stats.rebakedChunks, 1, 'single tile edit rebakes one chunk');
A.eq(second.stats.reusedChunks, 5, 'single tile edit reuses untouched chunks');
A.ok(second.chunkMap.get('1,0') === reusedBefore.get('1,0'), 'untouched chunk object is reused');
A.ok(canvases.every(c => c.width <= StationBake.CHUNK_PX && c.height <= StationBake.CHUNK_PX),
  'incremental rebake remains bounded to chunk-sized canvases');

const visible = StationBake.visibleChunks(first, { x: 384, y: 0, w: 384, h: 384 });
A.eq(visible.map(c => c.key), ['1,0'], 'visible chunk query returns only chunks intersecting the viewport');
A.eq(StationBake.missingVisibleChunks(first, { x: 384, y: 0, w: 384, h: 384 }), [],
  'complete cache reports no missing visible chunks');

const drawn = [];
const drawCtx = { drawImage(cv, x, y) { drawn.push({ cv, x, y }); } };
StationBake.drawBase(drawCtx, first, 0, 0, { x: 384, y: 0, w: 384, h: 384 });
A.eq(drawn.length, 1, 'drawBase culls chunked composites to the visible viewport');
A.eq(drawn[0].x, 384, 'drawBase preserves chunk world offset when culling');

canvases.length = 0;
const visibleCold = StationBake.bakeIncremental(geo, null, null, {
  visibleRect: { x: 384, y: 0, w: 384, h: 384 },
  maxRetainedChunks: 2
});
A.eq(visibleCold.stats.chunkCount, 1, 'cold visible bake renders only requested chunks');
A.eq(visibleCold.stats.dirtyChunks, ['1,0'], 'cold visible bake reports the rendered visible chunk');
A.eq(visibleCold.stats.evictedChunks, 0, 'cold visible bake does not evict when under the retention cap');
A.eq(StationBake.missingVisibleChunks(visibleCold, { x: 768, y: 0, w: 132, h: 384 }), ['2,0'],
  'visible-only cache reports newly exposed chunks after panning');
const panned = StationBake.bakeIncremental(geo, visibleCold, null, {
  visibleRect: { x: 768, y: 0, w: 132, h: 384 },
  maxRetainedChunks: 2,
  onlyMissingVisible: true
});
A.eq(panned.stats.dirtyChunks, [], 'pan-only visible fill does not dirty the whole station');
A.eq(panned.stats.rebakedChunks, 1, 'pan-only visible fill bakes only the newly exposed chunk');
A.ok(panned.chunkMap.has('2,0'), 'pan-only visible fill caches the newly exposed chunk');

const retained = StationBake.bakeIncremental(geo, first, [{ x1: 4, y1: 4, x2: 4, y2: 4 }], {
  visibleRect: { x: 384, y: 0, w: 384, h: 384 },
  maxRetainedChunks: 2
});
A.eq(retained.stats.chunkCount, 2, 'LRU retention bounds the cached chunk count');
A.ok(retained.chunkMap.has('0,0'), 'dirty chunk is retained even when outside the visible viewport');
A.ok(retained.chunkMap.has('1,0'), 'visible chunk is retained for the current frame');
A.ok(retained.stats.evictedChunks >= 4, 'LRU retention evicts older non-required chunks');

A.report('stationbake.chunk');
