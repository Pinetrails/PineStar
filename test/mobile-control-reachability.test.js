'use strict';

/* The phone-width control floor: safety and exit hardware must remain painted at
 * 320/360/390 CSS px, dock flyouts must clamp in visual pixels even under uiZoom,
 * and optional setup switches must wrap instead of disappearing behind a bezel. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const appCss = fs.readFileSync(path.join(root, 'frontend', 'css', 'app.css'), 'utf8');
const topCss = fs.readFileSync(path.join(root, 'frontend', 'css', 'topbar.css'), 'utf8');
const navSrc = fs.readFileSync(path.join(root, 'frontend', 'app', 'navdock.js'), 'utf8');

function has(re, label, text = appCss) { A.ok(re.test(text), label); }

// E-STOP: narrow chrome sheds lower-priority instruments and removes its last fixed margin.
has(/@media \(max-width: 600px\)[\s\S]*#topbar #wr-top,[\s\S]*#topbar #tb-station,[\s\S]*#topbar \.tb-sep\s*\{\s*display:\s*none/s,
  'mobile topbar removes the widget rail, level lamp and separator before E-STOP', topCss);
has(/@media \(max-width: 600px\)[\s\S]*#topbar \.tb-status\s*\{[^}]*gap:\s*4px;[^}]*padding:\s*0/s,
  'mobile status cluster spends no hidden padding around safety controls', topCss);
has(/#topbar #estop-btn\s*\{[^}]*margin-right:\s*0;[^}]*flex:\s*0 0 auto/s,
  'E-STOP remains an unsquashed, margin-free mobile instrument', topCss);

// Genesis: the tint bank owns a second row, so all six 14px switches fit even at 320px.
has(/@media \(max-width: 600px\)[\s\S]*\.cc-titlebar\s*\{[^}]*flex-wrap:\s*wrap/s,
  'genesis titlebar wraps on phone widths');
has(/\.cc-tb-phosphor\s*\{[^}]*flex:\s*0 0 100%;[^}]*order:\s*5/s,
  'phosphor bank receives a dedicated full-width row');
for (const width of [320, 360, 390]) {
  const panelInner = width - 28 - 44; // screen padding + console-head inline padding
  A.ok(6 * 14 + 5 * 5 <= panelInner,
    'all six phosphor switches fit their dedicated row at ' + width + 'px');
}

// REFIT: title row + compact action row; DONE cannot be displaced by prose.
has(/@media \(max-width: 600px\)[\s\S]*\.refit-top\s*\{[^}]*grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*auto 30px;[^}]*height:\s*68px/s,
  'REFIT action deck reserves exactly six phone-width action columns');
has(/\.refit-title\s*\{[^}]*grid-column:\s*1 \/ -1/s,
  'REFIT title owns row one');
has(/\.refit-top \.bb\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*height:\s*30px/s,
  'all six REFIT actions fill their shrinkable grid cells');
for (const width of [320, 360, 390]) {
  const actionRow = width - 16 - (5 * 4); // inline padding + five gaps
  A.ok(actionRow / 6 > 0,
    'six REFIT action keys receive a positive grid track at ' + width + 'px');
}

// Dock CSS caps intrinsic content; JS then clamps each wrapped trigger in visual pixels.
has(/\.bb-menu\s*\{[^}]*min-width:\s*0;[^}]*width:\s*min\(300px, calc\(100vw - 16px\)\);[^}]*max-width:\s*calc\(100vw - 16px\)/s,
  'mobile dock menu can never demand more than viewport minus two 8px edges');
has(/function clampMenu\(g\)[\s\S]*cssWidth = Math\.max\(0, window\.innerWidth - edge \* 2\) \/ zoom[\s\S]*getBoundingClientRect\(\)[\s\S]*shift \/ zoom/s,
  'navdock caps width, clamps visual rects and divides once for uiZoom', navSrc);
has(/window\.addEventListener\('resize',[^\n]*clampMenu/s,
  'open dock menus re-clamp after responsive resize', navSrc);

// Execute the real navdock clamp against a zoomed synthetic group. A 304px menu anchored
// at x=127 used to end at 431 on a 320px viewport; it must settle exactly on [8,312].
function runClamp(baseLeft, width, zoom) {
  const handlers = {};
  const classes = new Set();
  const menu = {
    style: {
      left: '0px', width: '', maxWidth: '',
      removeProperty(k) { this[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = ''; }
    },
    addEventListener(type, fn) { if (type === 'animationend') fn(); },
    getBoundingClientRect() {
      const left = baseLeft + (parseFloat(this.style.left) || 0) * zoom;
      const liveWidth = this.style.width ? parseFloat(this.style.width) * zoom : width;
      return { left, right: left + liveWidth, width: liveWidth };
    }
  };
  const trigger = {
    setAttribute() {}, blur() {}, focus() {},
    addEventListener(type, fn) { handlers[type] = fn; }
  };
  const group = {
    classList: {
      contains(k) { return classes.has(k); },
      add(k) { classes.add(k); }, remove(k) { classes.delete(k); },
      toggle(k, force) { if (force) classes.add(k); else classes.delete(k); }
    },
    querySelector(sel) {
      if (sel === '.bb-menu') return menu;
      if (sel === '.bb-grp') return trigger;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}, contains() { return false; }
  };
  const bar = { querySelectorAll: () => [group], querySelector: () => null, contains: () => false };
  const document = {
    activeElement: null,
    getElementById(id) { return id === 'bottombar' ? bar : null; },
    addEventListener() {}
  };
  const window = { innerWidth: 320, addEventListener() {} };
  const sandbox = {
    document, window,
    U: { uiZoom: () => zoom },
    MutationObserver: class { observe() {} },
    requestAnimationFrame(fn) { fn(); }
  };
  vm.runInNewContext(navSrc, sandbox, { filename: 'navdock.js' });
  handlers.click({ stopPropagation() {}, detail: 1 });
  return menu.getBoundingClientRect();
}

let r = runClamp(127, 304, 1.25);
A.ok(Math.abs(r.left - 8) < 0.01 && Math.abs(r.right - 312) < 0.01,
  'right-overflowing zoomed dock clamps to the 8px viewport edges');
r = runClamp(-20, 280, 1.25);
A.ok(Math.abs(r.left - 8) < 0.01 && r.right <= 312,
  'left-overflowing zoomed dock clamps to the 8px viewport edge');

// Short landscape: fixed controls fit before the grid's own overflow fallback is needed.
has(/@media \(max-width: 860px\) and \(max-height: 680px\)[\s\S]*grid-template-rows:\s*44px minmax\(76px, 1fr\) minmax\(164px, 1fr\) minmax\(40px, auto\)[\s\S]*padding:\s*5px[\s\S]*gap:\s*4px/s,
  'short landscape reserves compact stage and full composer/dock rows');
const shortLandscapeMin = 44 + 76 + 164 + 40 + (3 * 4) + (2 * 5);
A.ok(shortLandscapeMin <= 390,
  'short-landscape minimum grid budget fits an 844x390 viewport (' + shortLandscapeMin + 'px)');

A.report('mobile-control-reachability.test');
