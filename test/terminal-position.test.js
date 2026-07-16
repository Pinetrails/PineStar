'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { visibleTerminalRect } = require('../frontend/app/stationui.js');

function invariant(rect, viewport, label) {
  const padX = Math.min(8, viewport.width / 4);
  const padY = Math.min(8, viewport.height / 4);
  A.ok(rect.top >= padY, label + ': titlebar remains vertically reachable');
  A.ok(rect.left < viewport.width - padX, label + ': titlebar intersects the viewport');
  A.ok(rect.left + rect.width <= viewport.width - padX, label + ': right-side close control remains reachable');
}

// PU-04: Settings was persisted at x:-996 while desktop-wide, then reopened in a phone-sized
// viewport. The old clamp pins an oversized pre-responsive rect to x:8, leaving its right-side
// close control hundreds of pixels beyond the viewport.
const phone = { width: 390, height: 844 };
const staleWide = visibleTerminalRect(
  { left: -996, top: -40, width: 1060, height: 720 },
  phone
);
invariant(staleWide, phone, 'desktop-wide Settings restored on phone');

// The delayed responsive pass sees Settings at 94vw and rebases it to an ordinary inset.
const responsivePhone = visibleTerminalRect(
  { left: staleWide.left, top: staleWide.top, width: 366, height: 709 },
  phone
);
invariant(responsivePhone, phone, 'responsive phone Settings');
A.eq(responsivePhone.left, 8, 'responsive width is rebased to the normal left inset');

const desktop = { width: 1440, height: 900 };
const backOnDesktop = visibleTerminalRect(
  { left: responsivePhone.left, top: responsivePhone.top, width: 1060, height: 720 },
  desktop
);
invariant(backOnDesktop, desktop, 'phone Settings restored to desktop');
A.eq(backOnDesktop.left, 8, 'desktop restore keeps the repaired coordinate');

const negativeSaved = visibleTerminalRect(
  { left: -5000, top: -5000, width: 480, height: 320 },
  desktop
);
invariant(negativeSaved, desktop, 'negative saved position');
A.eq(negativeSaved.left, 8, 'negative saved X is repaired');
A.eq(negativeSaved.top, 8, 'negative saved Y is repaired');

const oversized = visibleTerminalRect(
  { left: 900, top: 900, width: 1200, height: 1200 },
  phone
);
invariant(oversized, phone, 'oversized terminal');
A.eq(oversized.left + oversized.width, phone.width - 8, 'oversized terminal aligns its close edge inside viewport');
A.eq(oversized.top, 8, 'oversized terminal keeps its titlebar at the top inset');

const tiny = { width: 12, height: 12 };
invariant(visibleTerminalRect({ left: -996, top: -996, width: 480, height: 320 }, tiny), tiny, 'viewport smaller than terminal minimum');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
A.ok((source.match(/visibleTerminalRect\(/g) || []).length >= 4, 'shared clamp drives drag, placement, and repair paths');
A.ok(/requestAnimationFrame\(\(\) => fitTermInViewport\(w, key, true\)\)/.test(source), 'open/restore reruns the clamp after responsive layout');
A.ok(/rememberTermPosition\(resolvedKey, repaired\.left, repaired\.top\)/.test(source), 'repaired coordinates are persisted');
A.ok(!/Math\.max\(64 - ww/.test(source), 'legacy 64px drag-only clamp is removed');

A.report('terminal-position.test');
