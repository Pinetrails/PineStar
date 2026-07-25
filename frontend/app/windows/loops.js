/* STARNET — windows/loops.js : the LOOPS window (standing objectives).

   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow; the only
   stationui internals it touches are the enumerated StationUI.h helper surface.

   ROUTINES answer WHEN. LOOPS answer UNTIL. A loop keeps working at one standing objective and stops for the
   Commander's verdict — the verdict is what starts the next pass, not a clock. This panel is a thin polling
   client over /api/loops (the sidecar owns the record, the ledger and the gate), exactly as windows/routines.js
   is over /api/cron.

   THE PROBLEM THIS WINDOW EXISTS TO SOLVE is that loops are confusing to set up and nothing shows you how to
   do one properly. So START A LOOP does not offer a blank objective box — it offers SHAPES (loop-templates.js),
   each of which already knows its cycle, its stopping condition and its guard rails. Two fields and go.

   TRUTHFUL TELEMETRY, the three places it bites here:
     · a loop that is quiet always says WHY (the server's `binding` — never a spinner over an unknown);
     · a template's rigor is shown, because "runs until the tests pass" and "runs until it stops finding
       things" are different promises and the second is a convention, not a proof;
     · REJECT states what it will destroy BEFORE the click, because rejecting a stacked candidate discards
       everything built on top of it. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const esc = H.esc, sfx = H.sfx, notify = H.notify, fmtRel = H.fmtRel;
  const mountConsole = H.mountConsole, consoleSection = H.consoleSection;

  let pickedId = 'build-test-verify';   // window-local: which shape the START pane is showing
  let loopAgentId = 'agent';
  let pickedDir = '';                   // the blessed project root for a project-shaped loop
  let dailyCap = 5;                     // $/day — a real default, so an unattended loop is never born uncapped

  const T = () => (typeof LoopTemplates !== 'undefined' ? LoopTemplates : null);

  function buildLoops(body) {
    const roster = H.present.length ? H.present : [{ id: 'agent', name: 'Agent', color: 'var(--ph)' }];
    if (!roster.some(a => a && a.id === loopAgentId)) loopAgentId = (H.present[H.sel] && H.present[H.sel].id) || roster[0].id || 'agent';

    const secActive =
      '<div id="lp-gate" class="set-about"></div>' +
      '<div id="lp-list" class="mc-list"><span class="loading pulse">loading…</span></div>';
    /* THE STEPPED CREATE FLOW. The old pane put eight controls on screen at once, with the scariest field
       (the check command) as a bare textbox and no way to know if any of it was right. Now: one decision at a
       time, revealed as the previous one is answered, ending in a plain-English confirmation that says what
       will happen, when it stops, and what it costs. No step is ever HIDDEN as a gate — later steps simply
       have nothing to show until they do (this is a sandbox product; nothing is locked). */
    const secStart =
      '<div class="lp-wiz">' +
        '<div class="lp-step-h"><span class="lp-num">1</span> WHAT KIND OF LOOP?</div>' +
        '<div id="lp-shapes" class="lp-shapes"></div>' +
        '<div id="lp-s2" class="lp-stage" hidden>' +
          '<div class="lp-step-h"><span class="lp-num">2</span> WHAT SHOULD IT WORK ON?</div>' +
          '<div id="lp-form" class="mc-form"></div>' +
        '</div>' +
        '<div id="lp-s3" class="lp-stage" hidden>' +
          '<div class="lp-step-h"><span class="lp-num">3</span> READY</div>' +
          '<div id="lp-ready" class="lp-ready"></div>' +
          '<button class="bb sm lp-go" id="lp-create">✦ START THIS LOOP</button>' +
        '</div>' +
      '</div>' +
      '<div id="lp-msg" class="msg"></div>';
    const frag = h => (el => { el.innerHTML = h; });
    mountConsole(body, 'loops', [
      { id: 'active', label: 'ACTIVE LOOPS', glyph: '∞', desc: 'Standing objectives, what each is waiting on, and the work queued for your verdict.', build: frag(secActive) },
      { id: 'start', label: 'START A LOOP', glyph: '✦', desc: 'Pick a shape — build/test/verify, sweep & fix, or research — fill two blanks, and it goes.', build: frag(secStart) }
    ], { search: false });

    const listEl = body.querySelector('#lp-list'), gateEl = body.querySelector('#lp-gate');
    const shapesEl = body.querySelector('#lp-shapes'), formEl = body.querySelector('#lp-form'), msgEl = body.querySelector('#lp-msg');
    const post = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    /* ---------- the live stepper: which stage of its cycle a loop is in RIGHT NOW ----------
       Derived only from server state. `running` means an iteration is genuinely in flight; a pending candidate
       means it is on the Commander; anything else is the honest resting state named by `binding`. */
    function stepper(l) {
      const t = T() && T().get((l.meta && l.meta.templateId) || '');
      const shape = (t && t.shape) || ['WORK', 'CHECK', 'REVIEW'];
      /* ONLY LIGHT WHAT THE SERVER PROVES. An earlier version inferred the middle stage from "a check exists
         and we are not waiting", which lit RUN YOUR CHECK on a loop that was idle between passes — inference
         dressed as state, in the one panel built to be honest. Two provable stages: an iteration is genuinely
         in flight (stage 0), or work is queued on the Commander (the last stage). Anything else lights
         nothing and the binding line carries the truth. */
      let at = -1;
      if (l.state === 'running') at = 0;
      else if (l.pendingCount > 0) at = shape.length - 1;
      return '<div class="lp-step">' + shape.map((s, i) =>
        '<span class="lp-step-i' + (i === at ? ' on' : '') + '">' + esc(s) + '</span>'
      ).join('<span class="lp-step-sep">›</span>') + '</div>';
    }

    // the honest one-line answer to "why isn't it doing anything?" — always from the server's binding.
    function bindingLine(l) {
      if (l.state === 'running') return '<span style="color:var(--gold)">● working</span>';
      const b = l.binding, d = l.bindingDetail || l.stopReason || '';
      if (!b) return '<span style="color:var(--gold)">● ready</span>';
      const map = {
        'queue-full': ['◆', 'waiting on your review'],
        'done': ['✓', 'objective met'],
        'dormant': ['◌', 'nothing left to do'],
        'paused': ['⏸', 'paused'],
        'stopped': ['■', 'stopped'],
        'budget': ['$', 'daily budget spent'],
        'halted': ['✕', 'E-STOP engaged'],
        'precheck': ['!', 'not ready'],
        'concurrency': ['…', 'agent busy'],
        'in-flight': ['●', 'working'],
        'max-iterations': ['#', 'iteration limit reached'],
        'disabled': ['○', 'disabled']
      };
      const m = map[b] || ['○', b];
      const bad = (b === 'halted' || b === 'precheck');
      // Prefer the server's own detail when it already SAYS the generic label ("3 waiting on your review"
      // contains "waiting on your review") — otherwise the line reads as a stutter.
      const generic = m[1];
      const text = (d && d.toLowerCase().indexOf(generic.toLowerCase()) >= 0) ? d
        : (d ? generic + ' — ' + d : generic);
      return '<span' + (bad ? ' style="color:var(--bad)"' : ' class="dim"') + '>' + m[0] + ' ' + esc(text) + '</span>';
    }

    // the last check result, stated by the exit code — never a bare summary that could flatter a red run.
    function checkLine(l) {
      const c = l.lastCheck;
      if (!c) return '';
      if (c.tampered) {
        return '<div class="mc-detail" style="color:var(--bad)">⚠ this pass changed the check itself (' +
          esc((c.tamperedPaths || []).slice(0, 3).join(', ')) + ') — a pass here proves nothing until you look</div>';
      }
      if (!c.passed) return '<div class="mc-detail" style="color:var(--bad)">✕ check failed — ' + esc(c.summary || '') + '</div>';
      if (!c.trusted) return '<div class="mc-detail">✓ check passed <span class="dim">— but unverifiable: ' + esc(c.note || '') + '</span></div>';
      return '<div class="mc-detail"><span class="pos">✓ check passed</span> <span class="dim">' + esc(c.summary || '') + '</span></div>';
    }

    /* diffHTML — colourise a unified diff. Every line is escaped FIRST and only then wrapped in a span, so
       diff content (which is arbitrary file text the agent wrote) can never inject markup into the panel. */
    function diffHTML(text) {
      return String(text || '').split('\n').map(line => {
        const safe = esc(line);
        if (/^\+\+\+|^---/.test(line)) return '<span class="d-file">' + safe + '</span>';
        if (line.charAt(0) === '@') return '<span class="d-hunk">' + safe + '</span>';
        if (line.charAt(0) === '+') return '<span class="d-add">' + safe + '</span>';
        if (line.charAt(0) === '-') return '<span class="d-del">' + safe + '</span>';
        return '<span class="d-ctx">' + safe + '</span>';
      }).join('\n');
    }

    /* a pending candidate — the review gate. The REJECT button carries its true cost in the label, because a
       stacked queue means rejecting #3 also discards #4 and #5 (they were built on top of it). */
    function pendingCard(l, p, idx, pending) {
      const stacked = pending.length - 1 - idx;   // un-approved candidates ABOVE this one
      const rejectLabel = stacked > 0 ? '✕ REJECT (+' + stacked + ' built on it)' : '✕ REJECT';
      return '<div class="lp-pend" data-n="' + p.n + '">' +
        '<div class="lp-pend-h"><b>#' + p.n + ' ' + esc(p.title || 'untitled') + '</b>' +
          (p.usd ? ' <span class="dim">$' + esc(String(p.usd.toFixed ? p.usd.toFixed(3) : p.usd)) + '</span>' : '') +
          ' <span class="dim">' + esc(fmtRel(p.endedAt)) + '</span></div>' +
        (p.summary ? '<div class="lp-pend-b">' + esc(String(p.summary).slice(0, 400)) + '</div>' : '') +
        (p.commit ? '<div class="mc-detail dim">commit ' + esc(String(p.commit).slice(0, 8)) + '</div>' : '') +
        /* WHAT CHANGED. "Deliverable = OPEN, not read" is a locked product law — approving work you cannot
           see makes the review gate theatre. The file list is the minimum honest answer to "what did it do". */
        /* THE DIFF. "Deliverable = OPEN, not read" is a locked product law, and a review gate you cannot see
           through is theatre — the file list said WHICH files, this says WHAT CHANGED. Folded by default so a
           queue of candidates stays scannable; the label states exactly what it is measured against, because a
           loop does not commit between passes and an earlier un-approved pass may have touched these files too. */
        (p.diff
          ? '<details class="lp-diff"><summary>▸ view the change</summary>' +
            '<div class="lp-diff-note dim">unified diff for the files this pass touched, against your last commit</div>' +
            '<pre class="lp-diff-body">' + diffHTML(p.diff) + '</pre></details>'
          : '') +
        ((p.files && p.files.length)
          ? '<div class="lp-files"><span class="dim">changed ' + p.files.length + ' file' + (p.files.length === 1 ? '' : 's') + ':</span> ' +
            p.files.slice(0, 6).map(f => '<code>' + esc(String(f.path || f).split(/[\/]/).pop()) + '</code>').join(' ') +
            (p.files.length > 6 ? ' <span class="dim">+' + (p.files.length - 6) + ' more</span>' : '') + '</div>'
          : '') +
        '<div class="mc-acts">' +
          '<button class="bb xs" data-vact="approve" data-n="' + p.n + '">✓ APPROVE</button>' +
          '<button class="bb xs danger" data-vact="reject" data-n="' + p.n + '" data-stacked="' + stacked + '">' + rejectLabel + '</button>' +
        '</div>' +
        /* THE REJECTION REASON, inline. This was a window.prompt() — a native modal, wrong for the station's
           vocabulary and unreliable in the Tauri webview — holding the single most valuable input in the whole
           subsystem: the reason rides into the NEXT pass's prompt and is what stops the loop repeating itself. */
        '<div class="lp-why" hidden>' +
          '<textarea class="key-input lp-why-in" rows="2" placeholder="why? the loop is told this, so it does not repeat the mistake" style="resize:vertical"></textarea>' +
          '<div class="mc-acts">' +
            '<button class="bb xs danger" data-vact="reject-confirm" data-n="' + p.n + '">✕ CONFIRM REJECT</button>' +
            '<button class="bb xs" data-vact="reject-cancel">CANCEL</button>' +
            '<span class="dim lp-why-cost"></span>' +
          '</div>' +
        '</div></div>';
    }

    /* askLine — the loop's own objective, trimmed to one readable line, plus the folder it works in. A loop
       can sit for days; nobody remembers exactly how they worded it, and a panel that shows STATE without
       PURPOSE forces you to open the record just to recall what the thing is for. */
    function askLine(l) {
      const obj = String(l.objective || '').split('\n').map(s => s.trim()).filter(Boolean);
      // the objective's first meaningful line is the goal; the template preamble that follows is boilerplate.
      const goal = obj.find(s => /^(GOAL|HUNTING|QUESTION):/i.test(s)) || obj[0] || '';
      const text = goal.replace(/^(GOAL|HUNTING|QUESTION):\s*/i, '');
      if (!text) return '';
      const where = l.workdir ? String(l.workdir).split(/[\\/]/).filter(Boolean).pop() : '';
      return '<div class="lp-ask">' + esc(text.slice(0, 160)) + (text.length > 160 ? '…' : '') +
        (where ? ' <span class="dim">in ' + esc(where) + '</span>' : '') + '</div>';
    }

    /* historyFold — what this loop has actually DONE. Approving a candidate used to make it vanish: the row
       kept a count and nothing else, so there was no way to see what you had accepted, what you rejected, or
       WHY. `recent` has carried all of it (including your own rejection note) since the projection was
       written — the panel simply never rendered it. Folded, because the live queue outranks the archive. */
    function historyFold(l) {
      const past = (l.recent || []).filter(r => r.outcome !== 'running' && !(r.outcome === 'candidate' && !r.verdict));
      if (!past.length) return '';
      const mark = {
        approved:  ['✓', 'var(--gold)'],
        rejected:  ['✕', 'var(--bad)'],
        discarded: ['⌫', 'var(--ph-dim)']
      };
      const rowOf = (r) => {
        const m = r.verdict ? (mark[r.verdict] || ['·', 'var(--ph-dim)']) : null;
        const what = r.outcome === 'noop' ? 'found nothing'
          : r.outcome === 'red' ? 'check failed'
          : r.outcome === 'failed' ? ('failed — ' + String(r.error || '').slice(0, 60))
          : r.outcome === 'cancelled' ? 'stopped'
          : (r.title || 'untitled');
        return '<div class="lp-hist-r">' +
          '<span class="lp-hist-n">#' + r.n + '</span>' +
          (m ? '<span class="lp-hist-v" style="color:' + m[1] + '">' + m[0] + '</span>' : '<span class="lp-hist-v dim">·</span>') +
          '<span class="lp-hist-t">' + esc(what) + '</span>' +
          '</div>' +
          // the Commander's own words are the most valuable line in the archive — never drop them.
          (r.verdictNote && r.verdict === 'rejected'
            ? '<div class="lp-hist-why">“' + esc(String(r.verdictNote).slice(0, 180)) + '”</div>' : '');
      };
      return '<details class="lp-hist"><summary>' + past.length + ' earlier pass' + (past.length === 1 ? '' : 'es') +
        '</summary>' + past.slice().reverse().map(rowOf).join('') + '</details>';
    }

    function row(l) {
      const t = T() && T().get((l.meta && l.meta.templateId) || '');
      // a loop created from a shape defaults its NAME to that shape's name, so printing both reads
      // "Research Loop ◈ Research Loop". Show the shape only when it adds something.
      const shapeName = !t ? 'custom' : (t.name === (l.name || '') ? t.emoji : (t.emoji + ' ' + t.name));
      const pending = l.pending || [];
      // spend against its cap — a number with no ceiling beside it tells the Commander nothing about risk.
      const bg = l.budget || {};
      const spent = bg.spentTodayUsd
        ? ' · $' + bg.spentTodayUsd.toFixed(2) + (bg.perDayUsd ? ' of $' + Number(bg.perDayUsd).toFixed(2) : '') + ' today'
        : (bg.perDayUsd ? ' · $' + Number(bg.perDayUsd).toFixed(2) + '/day cap' : '');
      return '<div class="mc-row" data-id="' + esc(l.id) + '">' +
        '<div class="mc-top"><b>' + esc(l.name || '(unnamed)') + '</b> <span class="dim">' + esc(shapeName) + '</span> ' + bindingLine(l) + '</div>' +
        /* WHAT YOU ASKED FOR. A loop can sit for days; nobody remembers the exact wording, and a panel that
           shows a loop's state without its purpose makes you open the record to find out what it is doing. */
        askLine(l) +
        stepper(l) +
        '<div class="mc-url dim">pass ' + (l.iterationCount || 0) +
          (l.maxIterations ? '/' + l.maxIterations : '') +
          ' · ' + (l.approvedCount || 0) + ' approved · ' + (l.rejectedCount || 0) + ' rejected' + esc(spent) + '</div>' +
        checkLine(l) +
        historyFold(l) +
        (l.lastError ? '<div class="mc-detail" style="color:var(--bad)">' + esc(l.lastError) + '</div>' : '') +
        (pending.length ? '<div class="lp-pends">' + pending.map((p, i) => pendingCard(l, p, i, pending)).join('') + '</div>' : '') +
        '<div class="mc-acts">' +
          (l.state === 'paused' || l.state === 'dormant' || l.state === 'done'
            ? '<button class="bb xs" data-act="resume">▶ RESUME</button>'
            : '<button class="bb xs" data-act="pause">⏸ PAUSE</button>') +
          '<button class="bb xs danger" data-act="remove">✕ DELETE</button>' +
        '</div></div>';
    }

    async function refresh() {
      try {
        const j = await Harness.api.get('/api/loops');
        const loops = (j && j.loops) || [];
        // HONEST ARM STATE. `armed` is whether a timer is genuinely running — not whether loops exist. A halted
        // station must say so loudly, with the one-click lift, rather than showing loops that will never advance.
        if (j && j.halted) {
          gateEl.innerHTML = '<div class="brief-block" style="border-left-color:var(--bad);margin-bottom:8px">' +
            '<div class="brief-k" style="color:var(--bad)">✕ LOOPS ARE STOPPED (E-STOP)</div>' +
            '<div class="brief-v">Your loops are saved but <b>will not run</b> — an emergency stop is engaged and it survives a restart.' +
            '<div style="margin-top:8px"><button class="bb xs" id="lp-unhalt">▶ RESUME LOOPS</button></div></div></div>';
          const ub = gateEl.querySelector('#lp-unhalt');
          if (ub) ub.addEventListener('click', async () => {
            ub.disabled = true; sfx('click');
            try { await post('/api/loops/control', { action: 'unhalt' }); notify('loops resumed', 'good'); } catch (_) { notify('could not reach the station', 'warn'); }
            refresh();
          });
        } else if (loops.length) {
          gateEl.innerHTML = j.armed
            ? '<span style="color:var(--gold)">● loops running</span> <span class="dim">— they advance when you rule on their work' +
              (j.inFlight ? ', ' + j.inFlight + ' working now' : '') + '.</span>'
            : '<span class="dim">○ nothing to advance right now — every loop is waiting, paused or finished.</span>';
        } else gateEl.innerHTML = '';

        if (loops.length) listEl.innerHTML = loops.map((l, i) => row(l).replace('<div class="mc-row"', '<div class="mc-row" style="--ci:' + i + '"')).join('');
        else {
          listEl.innerHTML = '<div class="empty-state"><span class="es-glyph">∞</span>' +
            '<b>NO LOOPS YET</b><span>A loop keeps working at one objective and stops for your verdict. Pick a shape and it sets itself up.</span>' +
            '<button class="es-cta" id="lp-empty-cta" type="button">✦ START A LOOP</button></div>';
          const cta = listEl.querySelector('#lp-empty-cta');
          if (cta) cta.addEventListener('click', () => {
            sfx('click');
            consoleSection['loops'] = 'start';
            const tab = body.querySelector('#con-tab-loops-start'); if (tab) tab.click();
          });
        }
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">station offline — start it to manage loops.</div>'; }
    }

    // ---------- row + verdict actions ----------
    listEl.addEventListener('click', async ev => {
      const vb = ev.target.closest('button[data-vact]');
      const rowEl = ev.target.closest('.mc-row');
      const id = rowEl && rowEl.dataset.id; if (!id) return;

      if (vb) {
        const act = vb.dataset.vact;
        const card = vb.closest('.lp-pend');

        // REJECT opens the reason panel inline and STATES ITS COST there — a stacked queue means rejecting
        // this one also discards everything built on top of it, and the UI must never destroy work the
        // Commander can still see without saying so first.
        if (act === 'reject') {
          const stacked = parseInt(vb.dataset.stacked, 10) || 0;
          const why = card.querySelector('.lp-why');
          why.hidden = false;
          why.querySelector('.lp-why-cost').textContent = stacked > 0
            ? 'also discards ' + stacked + ' built on top of this' : '';
          why.querySelector('.lp-why-in').focus();
          sfx('bad');
          return;
        }
        if (act === 'reject-cancel') { card.querySelector('.lp-why').hidden = true; sfx('click'); return; }

        const n = parseInt(vb.dataset.n, 10);
        const verdict = act === 'approve' ? 'approved' : 'rejected';
        const note = verdict === 'rejected' ? ((card.querySelector('.lp-why-in') || {}).value || '') : undefined;
        vb.disabled = true; sfx('click');
        try {
          const r = await (await post('/api/loops/verdict', { id, n, verdict, note })).json();
          if (r && r.error) { notify(r.error, 'warn'); sfx('bad'); }
          else {
            const cas = (r && r.cascaded && r.cascaded.length) || 0;
            notify(verdict === 'approved' ? 'approved #' + n + ' — the loop continues'
              : 'rejected #' + n + (cas ? ' (+' + cas + ' discarded)' : '') + ' — the loop will try again', verdict === 'approved' ? 'good' : 'warn');
          }
        } catch (_) { notify('could not reach the station', 'warn'); sfx('bad'); }
        refresh(); return;
      }

      const btn = ev.target.closest('button[data-act]'); if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'remove') {
        if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = '✕ CONFIRM'; sfx('bad'); setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '✕ DELETE'; } }, 5000); return; }
        sfx('bad'); try { await post('/api/loops/remove', { id }); notify('loop deleted'); } catch (_) {} refresh(); return;
      }
      if (act === 'pause' || act === 'resume') {
        sfx('click');
        try { await post('/api/loops/control', { id, action: act }); } catch (_) {}
        refresh(); return;
      }
    });

    // ---------- START A LOOP: pick a shape, fill two blanks ----------
    // ---------- STEP 1: pick a shape ----------
    function shapeCards() {
      const tpl = T(); if (!tpl) { shapesEl.innerHTML = '<div class="mc-detail">loop shapes unavailable</div>'; return; }
      shapesEl.innerHTML = tpl.list().map(t =>
        '<button type="button" class="lp-shape' + (t.id === pickedId ? ' on' : '') + '" data-tpl="' + esc(t.id) + '">' +
          '<span class="lp-shape-e">' + esc(t.emoji) + '</span>' +
          '<span class="lp-shape-n">' + esc(t.name) + '</span>' +
          '<span class="lp-shape-t">' + esc(t.tagline) + '</span>' +
          // rigor is on the CARD, not buried — it is the difference between a proof and a convention.
          '<span class="lp-shape-r ' + (t.rigor === 'hard' ? 'hard' : 'soft') + '">' +
            (t.rigor === 'hard' ? '✓ ends on a real check' : '~ ends on its own report') + '</span>' +
        '</button>').join('');
      shapesEl.querySelectorAll('.lp-shape').forEach(b => b.addEventListener('click', () => {
        pickedId = b.dataset.tpl; sfx('click'); shapeCards(); renderForm();
      }));
    }

    // ---------- STEP 2: describe it ----------
    // one field per row, each with clickable worked examples — a placeholder is passive, an example teaches.
    function fieldRow(pm) {
      const ex = (pm.examples || []).slice(0, 3);
      return '<label class="mc-lbl">' + esc(pm.label) +
        (pm.required ? ' <span style="color:var(--bad)">*</span>' : ' <span class="dim">(optional)</span>') +
        '<textarea class="key-input lp-p" data-key="' + esc(pm.key) + '" rows="2" placeholder="' + esc(pm.placeholder || '') + '" style="resize:vertical"></textarea>' +
        (ex.length
          ? '<div class="lp-ex"><span class="dim">try:</span> ' +
            ex.map(e => '<button type="button" class="lp-ex-b" data-for="' + esc(pm.key) + '" data-val="' + esc(e) + '">' + esc(e) + '</button>').join('') +
            '</div>'
          : '') +
        '</label>';
    }

    function renderForm() {
      const tpl = T(); if (!tpl) return;
      const t = tpl.get(pickedId); if (!t) return;
      body.querySelector('#lp-s2').hidden = false;

      const projectRow = t.needsProject
        ? '<label class="mc-lbl">Which project? <span style="color:var(--bad)">*</span>' +
          '<div class="lp-dir"><input id="lp-dir" class="key-input" placeholder="the folder this loop works in" value="' + esc(pickedDir) + '" autocomplete="off">' +
          '<button class="bb xs" id="lp-pick" type="button">📁 PICK</button></div></label>'
        : '';
      const checkRow = t.check
        ? '<label class="mc-lbl">The command you run to check it <span style="color:var(--bad)">*</span>' +
          '<div class="lp-dir"><input id="lp-check" class="key-input lp-p" data-key="check" placeholder="npm test" autocomplete="off">' +
          '<button class="bb xs" id="lp-test" type="button">▶ TEST</button></div>' +
          '<div id="lp-testout" class="lp-testout dim">the station runs this itself after every pass — test it here first</div></label>'
        : '';

      formEl.innerHTML =
        '<div class="lp-cycle"><span class="dim">each pass:</span> ' +
          t.shape.map(s => '<span class="lp-step-i">' + esc(s) + '</span>').join('<span class="lp-step-sep">›</span>') + '</div>' +
        '<div class="mc-detail ' + (t.rigor === 'hard' ? '' : 'dim') + '" style="margin-bottom:8px">' + esc(tpl.rigorNote(t)) + '</div>' +
        projectRow +
        t.params.filter(pm => pm.key !== 'check').map(fieldRow).join('') +
        checkRow +
        '<details class="lp-adv"><summary>more options</summary>' +
          '<label class="mc-lbl">Stop for the day after <span class="dim">(0 = no limit)</span>' +
            '<div class="lp-dir"><span class="dim">$</span><input id="lp-cap" class="key-input" type="number" min="0" step="0.5" value="' + esc(String(dailyCap)) + '"></div></label>' +
          '<label class="mc-lbl">Which agent runs it' +
            '<div class="lp-agent-pick" role="group" aria-label="Loop agent">' +
              roster.map(a => '<button type="button" class="rt-agent-btn' + (a.id === loopAgentId ? ' active' : '') + '" data-agent="' + esc(a.id) + '" style="--rt-agent-color:' + esc(a.color || 'var(--ph)') + '">' +
                '<span class="rt-agent-dot"></span><span class="rt-agent-name">' + esc(a.name || a.id) + '</span></button>').join('') +
            '</div></label>' +
          '<details class="lp-preview"><summary>what the agent will be told</summary><pre id="lp-prev"></pre></details>' +
        '</details>';

      // an example chip fills its field — the fastest way to learn what belongs there.
      formEl.querySelectorAll('.lp-ex-b').forEach(btn => btn.addEventListener('click', () => {
        const el = formEl.querySelector('.lp-p[data-key="' + btn.dataset.for + '"]');
        if (el) { el.value = btn.dataset.val; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); }
        sfx('click');
      }));
      formEl.querySelectorAll('.rt-agent-btn').forEach(b => b.addEventListener('click', () => {
        loopAgentId = b.dataset.agent || 'agent'; sfx('click'); renderForm();
      }));

      const dirEl = formEl.querySelector('#lp-dir');
      const checkEl = formEl.querySelector('#lp-check');
      const testOut = formEl.querySelector('#lp-testout');
      const capEl = formEl.querySelector('#lp-cap');

      if (dirEl) {
        const detect = async () => {
          const val = (dirEl.value || '').trim();
          if (val && checkEl) {
            try {
              const r = await (await post('/api/loops/detect', { path: val })).json();
              if (r && r.ok && r.cmd) { checkEl.value = r.cmd; testOut.textContent = 'suggested "' + r.cmd + '" — ' + r.why + '. Test it to be sure.'; }
              else if (r && r.ok) testOut.textContent = r.why || 'type the command you run yourself';
            } catch (_) { /* detection is a convenience; never block the form on it */ }
          }
          gate();
        };
        dirEl.addEventListener('change', detect);
        dirEl.addEventListener('input', gate);
        const pick = formEl.querySelector('#lp-pick');
        if (pick) pick.addEventListener('click', async () => {
          sfx('click');
          try {
            const r = await (await post('/api/folderpick', {})).json();
            if (r && r.path) { pickedDir = r.path; dirEl.value = r.path; dirEl.dispatchEvent(new Event('change')); }
          } catch (_) { notify('could not open the folder picker — type the path instead', 'warn'); }
        });
      }

      /* TEST IT. The check command was the one field with no feedback, so people guessed. Running it once,
         now, turns three expensive failures into instant ones — and the important one is a check that
         ALREADY PASSES: without this the loop spends a pass, gets a trusted green and declares "objective
         met" having done nothing, which is the app claiming a success that never happened. */
      const testBtn = formEl.querySelector('#lp-test');
      if (testBtn) testBtn.addEventListener('click', async () => {
        const dir = dirEl ? (dirEl.value || '').trim() : '';
        const cmd = (checkEl.value || '').trim();
        if (!dir || !cmd) { testOut.innerHTML = '<span style="color:var(--bad)">pick a project and type a command first</span>'; sfx('bad'); return; }
        testBtn.disabled = true; testOut.textContent = 'running it…';
        try {
          // approving the folder is what lets the station run anything there — the same gate the loop uses.
          const b = await (await post('/api/projects/bless', { path: dir, surface: 'interactive' })).json();
          if (!b || !b.ok) { testOut.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((b && b.reason) || 'that folder could not be approved') + '</span>'; sfx('bad'); }
          else {
            const r = await (await post('/api/loops/testcheck', { path: dir, cmd: cmd })).json();
            if (r && r.error) { testOut.innerHTML = '<span style="color:var(--bad)">✕ ' + esc(r.error) + '</span>'; sfx('bad'); }
            else if (r && r.alreadyGreen) {
              testOut.innerHTML = '<span style="color:var(--gold)">⚠ this check ALREADY passes</span> <span class="dim">— ' + esc(r.summary || '') +
                '. A loop would finish immediately with nothing to do. Point it at a check that is currently failing.</span>';
              sfx('bad');
            } else if (r && r.couldNotRun) {
              // never call a typo a good target — but do not assert it IS broken either; show it and say what it looks like.
              testOut.innerHTML = '<span style="color:var(--bad)">✕ that command could not run</span> <span class="dim">— ' + esc((r.summary || '').slice(0, 120)) + '. Check the command and the folder.</span>';
              sfx('bad');
            } else {
              testOut.innerHTML = '<span class="pos">✓ ran it — it fails right now</span> <span class="dim">— ' + esc((r.summary || '').slice(0, 120)) + '. If that is a real test failure, it is a good target; if it looks like an error in the command itself, fix the command.</span>';
              sfx('click');
            }
          }
        } catch (_) { testOut.innerHTML = '<span style="color:var(--bad)">✕ could not reach the station</span>'; sfx('bad'); }
        testBtn.disabled = false; gate();
      });

      formEl.querySelectorAll('.lp-p').forEach(el => el.addEventListener('input', gate));
      if (capEl) capEl.addEventListener('input', gate);
      gate();
    }

    // ---------- STEP 3: the plain-English confirmation ----------
    function currentValues() {
      const values = {};
      formEl.querySelectorAll('.lp-p').forEach(el => { values[el.dataset.key] = el.value; });
      return values;
    }
    function currentExtra() {
      const dirEl = formEl.querySelector('#lp-dir');
      const capEl = formEl.querySelector('#lp-cap');
      return {
        workdir: dirEl ? (dirEl.value || '').trim() : '',
        agentId: loopAgentId,
        perDayUsd: capEl ? Math.max(0, parseFloat(capEl.value) || 0) : 0
      };
    }
    /* gate — reveal step 3 once the loop is actually describable, and keep the summary + prompt preview in
       sync. Nothing is DISABLED here: a missing field simply means there is not yet a loop to summarise,
       which is a statement of fact rather than a permission wall. */
    function gate() {
      const tpl = T(); const t = tpl && tpl.get(pickedId); if (!t) return;
      const values = currentValues(), extra = currentExtra();
      const missing = tpl.requiredMissing(t, values);
      const needDir = t.needsProject && !extra.workdir;
      const s3 = body.querySelector('#lp-s3');
      const prev = formEl.querySelector('#lp-prev');
      if (prev) { const sp = tpl.buildSpec(t, values, extra); prev.textContent = sp ? sp.objective : ''; }
      if (missing.length || needDir) { s3.hidden = true; return; }
      s3.hidden = false;
      body.querySelector('#lp-ready').innerHTML = tpl.readySummary(t, values, extra)
        .map(r => '<div class="lp-ready-r"><b>' + esc(r.k) + '</b><span>' + esc(r.v) + '</span></div>').join('');
    }

    async function createLoop() {
      const tpl = T(); const t = tpl && tpl.get(pickedId); if (!t) return;
      const values = currentValues(), extra = currentExtra();
      const missing = tpl.requiredMissing(t, values);
      if (missing.length) {
        sfx('bad');
        const el = formEl.querySelector('.lp-p[data-key="' + missing[0] + '"]');
        if (el) { el.classList.add('mkt-bad'); el.focus(); }
        msgEl.innerHTML = '<span style="color:var(--bad)">fill in: ' + esc(missing.join(', ')) + '</span>';
        return;
      }
      if (t.needsProject && !extra.workdir) { sfx('bad'); msgEl.innerHTML = '<span style="color:var(--bad)">this shape needs a project folder</span>'; return; }
      pickedDir = extra.workdir; dailyCap = extra.perDayUsd;

      msgEl.textContent = 'starting…';
      if (extra.workdir) {
        try {
          const b = await (await post('/api/projects/bless', { path: extra.workdir, surface: 'interactive' })).json();
          if (!b || !b.ok) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((b && b.reason) || 'that folder could not be approved') + '</span>'; sfx('bad'); return; }
        } catch (_) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ could not reach the station</span>'; sfx('bad'); return; }
      }
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;
      const spec = tpl.buildSpec(t, values, Object.assign({}, extra, { provider: provider, workdir: extra.workdir || undefined }));
      try {
        const r = await (await post('/api/loops', spec)).json();
        if (r && r.error) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc(r.error) + '</span>'; sfx('bad'); return; }
        msgEl.textContent = '';
        notify('loop started — it runs until ' + (t.rigor === 'hard' ? 'your check passes' : 'it stops finding things'), 'good');
        sfx('click');
        formEl.querySelectorAll('.lp-p').forEach(el => { el.value = ''; });
        body.querySelector('#lp-s3').hidden = true;
        consoleSection['loops'] = 'active';
        const tab = body.querySelector('#con-tab-loops-active'); if (tab) tab.click();
        refresh();
      } catch (e) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'could not reach the station') + '</span>'; sfx('bad'); }
    }
    body.querySelector('#lp-create').addEventListener('click', createLoop);
    shapeCards(); renderForm(); refresh();
    // poll while the window is open — a loop advances on its own tick, so the panel must not go stale.
    const poll = setInterval(() => { if (body.isConnected) refresh(); else clearInterval(poll); }, 4000);
  }

  StationUI.registerWindow('loops', 'LOOPS', buildLoops, { console: true });

  /* ================= THE WATCHER — a loop that needs you must SAY so =====================================
     A loop's whole cadence depends on the Commander noticing that it stopped. Without this it parks on a full
     queue and waits in silence forever, which turns "it stops for your verdict" into "it stops" — the loop
     looks broken and the feature quietly fails. This runs whenever the app is up (not only while the window
     is open) and does two things:

       · a COUNT BADGE on the ∞ LOOPS dock button, so the state is visible at a glance;
       · ONE toast per newly-arrived candidate, keyed by (loopId, iteration) so a poll never re-announces
         work already announced — including across a reload, because the seen-set is persisted.

     Deliberately NOT a COMMS beat: the beat slot is governed by locked rules (one post-run beat at a time,
     decided cards vanish) and a loop finishing is not a conversational turn. A badge plus a toast is the
     honest, low-risk surface; a channel ping for a Commander who is genuinely away is a later, separate call
     that belongs server-side next to cron's autoNotify. */
  const SEEN_KEY = 'starnet.loops.seen.v1';
  const loadSeen = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch (_) { return new Set(); } };
  const saveSeen = (s) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-400))); } catch (_) {} };

  function paintBadge(n) {
    const btn = document.querySelector('.bb[data-term="loops"]');
    if (!btn) return;
    let dot = btn.querySelector('.lp-badge');
    if (!n) { if (dot) dot.remove(); return; }
    if (!dot) { dot = document.createElement('span'); dot.className = 'lp-badge'; btn.appendChild(dot); }
    dot.textContent = String(n);
    dot.title = n + ' loop result' + (n === 1 ? '' : 's') + ' waiting on you';
  }

  async function watch() {
    let j;
    try { j = await (await fetch('/api/loops', { headers: { 'X-StarNet-Token': window.__STARNET_API_TOKEN__ || '' } })).json(); }
    catch (_) { return; }                       // station offline — say nothing rather than guess
    const loops = (j && j.loops) || [];
    let waiting = 0;
    const seen = loadSeen();
    const fresh = [];
    for (const l of loops) {
      waiting += (l.pendingCount || 0);
      for (const p of (l.pending || [])) {
        const key = l.id + ':' + p.n;
        if (!seen.has(key)) { seen.add(key); fresh.push({ l, p }); }
      }
    }
    paintBadge(waiting);
    saveSeen(seen);
    // announce at most one line per sweep — N new candidates at once is one event to a human, not N.
    if (fresh.length && typeof StationUI !== 'undefined' && StationUI.h && StationUI.h.notify) {
      const f = fresh[0];
      StationUI.h.notify(fresh.length === 1
        ? '∞ ' + (f.l.name || 'a loop') + ' has work for you — #' + f.p.n + ' ' + (f.p.title || '')
        : '∞ ' + fresh.length + ' loop results are waiting on your review', 'good');
    }
  }
  // first sweep after boot settles, then a slow heartbeat — this is a notifier, not a live view.
  setTimeout(() => { watch(); setInterval(watch, 25000); }, 6000);
})();
