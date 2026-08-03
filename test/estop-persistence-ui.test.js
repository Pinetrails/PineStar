/* node test/estop-persistence-ui.test.js — the E-STOP UI distinguishes current-process aborts
   from durable restart protection using the exact /api/halt receipt fields. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const safetySrc = fs.readFileSync(path.join(root, 'frontend/app/safety.js'), 'utf8');
const harnessSrc = fs.readFileSync(path.join(root, 'frontend/app/harness.js'), 'utf8');

async function drive(receipt) {
  let click = null, aborted = 0, alarmed = 0;
  const notices = [];
  const button = {
    id: '', type: '', textContent: '', title: '',
    setAttribute() {},
    addEventListener(type, fn) { if (type === 'click') click = fn; }
  };
  const cluster = { firstChild: null, insertBefore() {} };
  const document = {
    readyState: 'complete',
    querySelector(sel) { return sel === '#topbar .tb-status' ? cluster : null; },
    getElementById() { return null; },
    createElement() { return button; },
    addEventListener() {}
  };
  const sandbox = {
    document,
    window: { addEventListener() {} },
    Harness: { haltAll: async () => receipt },
    Chat: { abort() { aborted++; } },
    StationUI: { notify(message, kind) { notices.push({ message, kind }); } },
    SFX: { alarm() { alarmed++; } }
  };
  vm.runInNewContext(safetySrc, sandbox, { filename: 'safety.js' });
  A.ok(typeof click === 'function', 'visible E-STOP click handler was wired');
  await click();
  return { notices, aborted, alarmed };
}

(async () => {
  const durable = await drive({ halted: 2, nightshiftHaltPersisted: true, cronHaltPersisted: true, loopsHaltPersisted: true });
  A.eq(durable.notices[0], { message: 'HALT — stopped 2 runs', kind: 'warn' },
    'all-true receipt reports the honest abort count without inventing a durability warning');
  A.eq(durable.aborted, 1, 'local COMMS stream still aborts after the authoritative receipt');

  const partial = await drive({ halted: 1, nightshiftHaltPersisted: false, cronHaltPersisted: true, loopsHaltPersisted: false });
  A.ok(/stopped 1 run now/.test(partial.notices[0].message),
    'partial failure still says the current process stopped now');
  A.ok(/restart protection failed for night shift, loops/.test(partial.notices[0].message),
    'partial failure names only subsystems whose durable writes failed');
  A.eq(partial.notices[0].kind, 'bad', 'restart persistence failure is presented as a fault, not routine warning chrome');
  A.eq(partial.alarmed, 1, 'the emergency alarm still fires on partial persistence failure');

  for (const field of ['nightshiftHaltPersisted', 'cronHaltPersisted', 'loopsHaltPersisted']) {
    A.ok(harnessSrc.includes(field + ': j.' + field), 'Harness preserves /api/halt receipt field ' + field);
  }
  A.ok(/halted:\s*n\('halted'\) \+ n\('cronAborted'\) \+ n\('beatAborted'\)/.test(harnessSrc),
    'Harness still totals every real abort source before returning the receipt');

  A.report('estop-persistence-ui.test');
})().catch(err => { console.error(err); process.exit(1); });
