/* STARNET — windows/logbook.js : the LOGBOOK window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (mountConsole, the shared per-agent roster switcher, and the live present/sel views). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const esc = H.esc, fmtRel = H.fmtRel, mountConsole = H.mountConsole;
  const rosterSwitchHtml = H.rosterSwitchHtml, wireRosterSwitch = H.wireRosterSwitch;

  /* ============== LOGBOOK — the reviewable run-history + SLAG post-mortems (the durable record) ==============
     Two read-only surfaces the audit found were written-but-never-read: RUNS folds the append-only run-history
     logbook (GET /api/runs — every finished run's outcome/reason), and SLAG renders World.slagLog() — the
     unproductive-run post-mortems (cause + fix) that used to live only as a fading toast. (WIRING_AUDIT P7.) */
  const LB_REASON = { done: '✓ done', max_iters: '⟳ looped out', budget: 'over budget', cancelled: '⏹ cancelled', error: '✕ error', refusal: '⊘ refused' };
  function buildLogbook(body) {
    const a = H.present[H.sel] || {};   // live core state via the h getters
    const agentId = a.id || 'agent';
    const nm = a.name || agentId;   // the LOGBOOK is agent-scoped — name it, don't imply a station-wide record
    // CONSOLE MODE: RUNS · SLAG · INSIGHTS as three sections instead of an inline tab strip. Each section owns its
    // OWN list host (#lb-list / #lb-slag / #lb-insights) so a mid-fetch close of one can't overwrite another. The
    // per-section desc carries the honest copy #lb-about used to hold. mountConsole appends its host to `body`, so
    // the section-scoped body.querySelector loads below resolve against the mounted panes.
    const frag = h => (el => { el.innerHTML = h; });
    mountConsole(body, 'logbook', [
      { id: 'runs', label: 'RUNS', glyph: '▦', desc: 'Real work by ' + nm + ', newest first — runs that used tools, produced files, or failed. Chat-only replies are folded at the bottom.',
        build: frag('<div id="lb-list" class="mc-list"><span class="loading pulse">loading…</span></div>') },
      { id: 'slag', label: 'SLAG — DEAD RUNS', glyph: '⚠', desc: 'Post-mortems for ' + nm + ' runs that ended without a deliverable, diagnosed into a real, fixable cause.',
        build: frag('<div id="lb-slag" class="mc-list"><span class="loading pulse">loading…</span></div>') },
      { id: 'insights', label: 'INSIGHTS', glyph: '◨', desc: 'Run totals, success rate, and model distribution for ' + nm + '.',
        build: frag('<div id="lb-insights" class="mc-list"><span class="loading pulse">loading…</span></div>') }
    ], {
      // name the agent + a compact switcher at the top of the rail (mirrors the dossier roster) so it's never
      // mistaken for "the station's event record" — it's THIS agent's run history.
      railTop: (top) => {
        top.innerHTML = '<div class="lb-agent-h">LOGBOOK · <b>' + esc(nm) + '</b></div>' + rosterSwitchHtml(agentId);
        wireRosterSwitch(top, 'logbook');
      }
    });
    const listEl = body.querySelector('#lb-list');
    function runRow(r) {
      const when = r.ts ? esc(fmtRel(new Date(r.ts).toISOString())) : '';
      const rl = LB_REASON[r.reason] || esc(r.reason || 'done');
      const title = r.title ? esc(r.title) : esc(String(r.runId || 'run').slice(0, 12));
      const model = esc(r.model || '(unknown)');
      // H3.2: a run with a streamId can OPEN its transcript inline (the join the audit found was missing).
      const sid = r.streamId ? esc(String(r.streamId)) : '';
      const cls = sid ? 'mc-row lb-run-open' : 'mc-row';
      const attr = sid ? ' data-stream="' + sid + '"' : '';
      // explicit ▸ toggle button for the transcript (keyboard-reachable), plus the whole row stays clickable —
      // but the row handler ignores clicks made while selecting text (so you can copy a title without collapsing).
      const txBtn = sid ? ' <button type="button" class="lb-tx-btn" aria-expanded="false" title="show / hide this run\'s transcript">▸ transcript</button>' : '';
      return '<div class="' + cls + '"' + attr + '><div class="mc-top"><b>' + title + '</b> <span class="dim">' + when + '</span>' + txBtn + '</div>' +
        '<div class="mc-url dim">' + rl + ' · ' + model + ' · ' + (r.turns || 0) + ' turn' + (r.turns === 1 ? '' : 's') + '</div>' +
        (sid ? '<div class="lb-tx" hidden></div>' : '') + '</div>';
    }
    function insightsHtml(j) {
      j = j || {};
      if (!j.totalRuns) return '<div class="fb-empty">NO DATA YET.<br><span>Insights appear once this agent finishes some runs.</span></div>';
      const ov = '<div class="mc-row"><div class="mc-top"><b>' + j.totalRuns + ' run' + (j.totalRuns === 1 ? '' : 's') + '</b></div>' +
        '<div class="mc-url dim">' + (j.successPct == null ? '—' : j.successPct + '% success') + '</div></div>';
      const models = (j.byModel || []).slice(0, 8).map(m =>
        '<div class="mc-row"><div class="mc-top"><b>' + esc(m.model) + '</b> <span class="dim">' + m.runs + ' run' + (m.runs === 1 ? '' : 's') + '</span></div></div>').join('');
      // pretty-label the outcome enum with the same map RUNS uses (LB_REASON) instead of leaking raw keys.
      const reasons = Object.keys(j.byReason || {}).map(k => (LB_REASON[k] || esc(k)) + ' ' + j.byReason[k]).join(' · ');
      return ov + '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">BY MODEL</div>' + (models || '<div class="mc-detail dim">—</div>') +
        '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">OUTCOMES</div><div class="mc-detail dim">' + (reasons || '—') + '</div>';
    }
    function noSpendText(s) {
      return String(s || '')
        .replace(/\bspend\b/ig, 'run resources')
        .replace(/\bdollars?\b/ig, 'limits')
        .replace(/billed at full price every turn/ig, 'processed cold every turn')
        .replace(/~10× cheaper input/ig, 'more efficient input');
    }
    function slagRow(d) {
      return '<div class="mc-row"><div class="mc-top"><b style="color:var(--bad)">⚠ ' + esc(noSpendText(d.title || 'unproductive run')) + '</b></div>' +
        '<div class="mc-url dim">' + esc(noSpendText(d.cause || '')) + '</div>' +
        (d.fix ? '<div class="mc-detail">→ ' + esc(noSpendText(d.fix)) + '</div>' : '') + '</div>';
    }
    // RUNS: the append-only run history (GET /api/runs), with each run's transcript lazy-expandable inline.
    // Each loader re-queries its host by id after the await so a panel closed mid-fetch is a safe no-op (mirrors
    // loadMemoryCore), and only ever writes its OWN section host — never a sibling's.
    async function loadRuns() {
      const host = body.querySelector('#lb-list'); if (!host) return;
      try {
        const j = await Harness.api.get('/api/runs?agent=' + encodeURIComponent(agentId) + '&limit=100');
        const h = body.querySelector('#lb-list'); if (!h) return;
        const runs = (j && j.runs) || [];
        // PRACTICAL FOLD: every chat message is a run, so an interactive station's history is mostly talk-only
        // rows that bury the record that matters (away/cron runs, failures, real work). A row is CHATTER when the
        // run ended fine with ZERO successful tool calls and ZERO artifacts — provable from the row's own recorded
        // fields (toolsOk / artifacts), never a guess. Chatter folds behind an honest count; work renders up front.
        const isChat = r => r.reason === 'done' && !(r.toolsOk > 0) && !(r.artifacts && r.artifacts.length);
        const work = runs.filter(r => !isChat(r));
        const chatter = runs.filter(isChat);
        const foldLabel = open => (open ? '▾ ' : '▸ ') + chatter.length + ' CHAT-ONLY ' + (chatter.length === 1 ? 'REPLY' : 'REPLIES') + ' — no tools, no files';
        h.innerHTML = runs.length
          ? (work.length ? work.map(runRow).join('')
              : '<div class="fb-empty">NO TASK RUNS YET.<br><span>Runs that use tools, write files, or fail land here.</span></div>')
            + (chatter.length
              ? '<button type="button" class="bb sm" id="lb-chat-fold" aria-expanded="false" style="margin-top:8px">' + foldLabel(false) + '</button>'
                + '<div id="lb-chat-rows" hidden>' + chatter.map(runRow).join('') + '</div>'
              : '')
          : '<div class="fb-empty">NO RUNS YET.<br><span>Finished runs appear here once this agent does real work.</span></div>';
        const fold = h.querySelector('#lb-chat-fold');
        if (fold) fold.addEventListener('click', () => {
          const rowsEl = h.querySelector('#lb-chat-rows'); if (!rowsEl) return;
          rowsEl.hidden = !rowsEl.hidden;
          fold.setAttribute('aria-expanded', String(!rowsEl.hidden));
          fold.textContent = foldLabel(!rowsEl.hidden);
        });
        // H3.2: a run opens its durable transcript (GET /api/transcript?stream=) inline — toggle + lazy-load.
        const toggleTx = async (row) => {
          const tx = row.querySelector('.lb-tx'); if (!tx) return;
          const btn = row.querySelector('.lb-tx-btn');
          if (!tx.hidden) { tx.hidden = true; row.classList.remove('tx-open'); if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = '▸ transcript'; } return; }
          tx.hidden = false; row.classList.add('tx-open'); if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = '▾ transcript'; }
          if (tx.dataset.loaded) return;
          tx.innerHTML = '<div class="mc-detail"><span class="loading">loading transcript…</span></div>';
          try {
            const t = await Harness.api.get('/api/transcript?stream=' + encodeURIComponent(row.dataset.stream) + '&agent=' + encodeURIComponent(agentId) + '&limit=50');
            const turns = (t && t.turns) || [];
            tx.innerHTML = turns.length ? turns.map(m => '<div class="mc-detail"><b>' + esc(m.role) + ':</b> ' + esc(String(m.content || '').slice(0, 400)) + '</div>').join('') : '<div class="mc-detail">no transcript recorded for this workstream.</div>';
            tx.dataset.loaded = '1';
          } catch (_) { tx.innerHTML = '<div class="mc-detail">could not load transcript.</div>'; }
        };
        h.querySelectorAll('.lb-run-open').forEach(row => {
          row.addEventListener('click', ev => {
            if (ev.target.closest('.lb-tx-btn')) return;                 // the button owns its own click (below)
            if (ev.target.closest('.lb-tx')) return;                     // clicks inside an open transcript don't collapse it
            const selTxt = (window.getSelection && window.getSelection().toString()) || '';
            if (selTxt.trim()) return;                                   // dragging to SELECT text must not toggle
            toggleTx(row);
          });
          const btn = row.querySelector('.lb-tx-btn');
          if (btn) btn.addEventListener('click', ev => { ev.stopPropagation(); toggleTx(row); });
        });
      } catch (_) { const h = body.querySelector('#lb-list'); if (h) h.innerHTML = '<div class="mc-detail">sidecar offline — start it to see run history.</div>'; }
    }
    // SLAG: the unproductive-run post-mortems (World.slagLog), synchronous — no fetch, just the live ring.
    function loadSlag() {
      const host = body.querySelector('#lb-slag'); if (!host) return;
      let slag = [];
      try { if (typeof World !== 'undefined' && World.slagLog) slag = World.slagLog().slice().reverse(); } catch (_) {}
      host.innerHTML = slag.length ? slag.map(slagRow).join('') : '<div class="fb-empty">NO SLAG — clean line.<br><span>A post-mortem appears here when a run ends without producing a result.</span></div>';
    }
    // INSIGHTS: aggregate outcomes folded from the run history (GET /api/insights). H3.3.
    async function loadInsights() {
      const host = body.querySelector('#lb-insights'); if (!host) return;
      try {
        const j = await Harness.api.get('/api/insights?agent=' + encodeURIComponent(agentId));
        const h = body.querySelector('#lb-insights'); if (h) h.innerHTML = insightsHtml(j);
      } catch (_) { const h = body.querySelector('#lb-insights'); if (h) h.innerHTML = '<div class="mc-detail">sidecar offline — start it to see insights.</div>'; }
    }
    // all three panes exist up-front (mountConsole keeps them all in the DOM), so load each once — no tab gating.
    loadRuns(); loadSlag(); loadInsights();
  }

  StationUI.registerWindow('logbook', 'LOGBOOK', buildLogbook, { console: true });
})();
