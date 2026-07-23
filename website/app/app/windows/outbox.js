/* STARNET — windows/outbox.js : the OUTBOX — FINISHED WORK window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (esc/sfx/fmtRel/notify/openTerm, the WS/persistWS workstream seam, and the live present view). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const esc = H.esc, sfx = H.sfx, fmtRel = H.fmtRel, notify = H.notify, openTerm = H.openTerm;
  const WS = H.WS, persistWS = H.persistWS;

  /* ============== OUTBOX — the finished-work window (accordion redesign, 2026-07-16 round 4) ==============
     Andrew's spec, exactly: an EXTREMELY simple list. Collapsed row = the task's TITLE + a small
     description that is what the agent ACTUALLY DID (its real recorded output — never the prompt,
     never a paraphrase). Click the row → it expands into the full breakdown: the ask, the complete
     output readable right there, and a few genuinely relevant actions — ↗ OPEN (jump into the run's
     session to test the output), ⊕ NEW SESSION (dedicate a fresh chat to expanding on it), and the
     rate control (collecting the crate). One row open at a time; no buttons on collapsed rows.
     TRUTHFUL: title/description derive from the run's durable transcript (routine name wins for the
     title); a missing transcript says so; rows come only from ReturnStore's pending ledger. */
  function buildOutbox(body) {
    const RS = (typeof ReturnStore !== 'undefined') ? ReturnStore : null;
    const rows = (RS && RS.pendingRows) ? RS.pendingRows() : [];
    body.innerHTML =
      '<div class="win-note" style="margin-bottom:8px">Work that finished while you were away. Click a task to see the full result.</div>' +
      '<div id="ob-list" class="ob-list"></div>' +
      '<div style="margin-top:10px"><button class="bb sm" id="ob-logbook">▸ FULL RUN HISTORY — LOGBOOK</button></div>';
    const list = body.querySelector('#ob-list');
    const lb = body.querySelector('#ob-logbook');
    if (lb) lb.addEventListener('click', () => openTerm('logbook'));
    function renderEmpty() {
      list.innerHTML = '<div class="fb-empty">NO UNCOLLECTED WORK.<br><span>When a run finishes while you’re away, its crate stacks on the OUTBOX and the full result is readable here.</span></div>';
    }
    if (!rows.length) { renderEmpty(); return; }
    // agent id → display name via the live roster (raw ids read as debug output)
    const agentName = id => { const a = (Array.isArray(H.present) ? H.present.find(x => x && x.id === id) : null); return (a && a.name) || id || 'agent'; };
    const firstLine = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
    // strip markdown scaffolding (fences, table pipes, headings, emphasis) for the one-line glance —
    // the FULL untouched output stays in .ob-out; this only keeps the collapsed desc readable.
    const plain = s => String(s || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[|#*_>`]+/g, ' ').replace(/(^|\s)[-:=]{3,}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    // legacy crates (persisted before streamId rode the rows) — fill their transcript join once, best-effort.
    const fillStreams = (async () => {
      if (rows.every(r => r.streamId)) return;
      try {
        const j = await Harness.api.get('/api/runs?agent=*&limit=200');
        const by = {}; for (const r of ((j && j.runs) || [])) if (r && r.runId) by[r.runId] = String(r.streamId || '');
        for (const rw of rows) if (!rw.streamId && by[rw.runId]) rw.streamId = by[rw.runId];
      } catch (_) {}
    })();
    let open = rows.length;
    const collected = (row) => { row.style.transition = 'opacity .25s ease'; row.style.opacity = '0'; setTimeout(() => { row.remove(); if (--open <= 0) renderEmpty(); }, 300); };
    const closeOthers = (except) => { list.querySelectorAll('.ob-row.open').forEach(r => { if (r !== except) { r.classList.remove('open'); const b = r.querySelector('.ob-body'); if (b) b.hidden = true; } }); };
    for (const rw of rows) {
      const row = document.createElement('div'); row.className = 'ob-row';
      const when = rw.ts ? esc(fmtRel(new Date(rw.ts).toISOString())) : '';
      const usd = (+rw.usd > 0 && typeof U !== 'undefined' && U.usd) ? ' · ' + esc(U.usd(+rw.usd)) : '';
      // title: routine name wins (it's the human name of the job); else the run title until the
      // transcript's real ask replaces it (stored run titles can be prompt+reply mush).
      const provisionalTitle = rw.routine ? ('“' + rw.routine + '”') : firstLine(rw.title || 'an unnamed run', 64);
      row.innerHTML =
        '<div class="ob-head" role="button" tabindex="0" aria-expanded="false">' +
          '<div class="ob-title">◷ <b></b><span class="ob-caret">▸</span></div>' +
          '<div class="ob-desc"><span class="loading">reading the result…</span></div>' +
          '<div class="ob-meta">' + esc(agentName(rw.agentId)) + ' · ' + when + usd + '</div>' +
        '</div>' +
        '<div class="ob-body" hidden>' +
          '<div class="ob-sec">THE ASK</div><div class="ob-ask"><span class="loading">loading…</span></div>' +
          '<div class="ob-sec">WHAT THE AGENT DID</div><div class="ob-out"><span class="loading">loading…</span></div>' +
          '<div class="ob-acts">' +
            '<button type="button" class="consent-btn ob-open">↗ OPEN — test it in the session</button>' +
            '<button type="button" class="consent-btn ob-fork">⊕ NEW SESSION — expand on this</button>' +
            '<span class="ob-rate"></span>' +
          '</div>' +
        '</div>';
      row.querySelector('.ob-title b').textContent = provisionalTitle;
      list.appendChild(row);
      // fill title/description/breakdown from the run's DURABLE transcript (the honest source of
      // "what the agent actually did"). One fetch per row, at build — pending is capped at 24.
      (async () => {
        const desc = row.querySelector('.ob-desc'), ask = row.querySelector('.ob-ask'), out = row.querySelector('.ob-out');
        await fillStreams;
        let turns = null;
        if (rw.streamId) {
          try {
            const t = await Harness.api.get('/api/transcript?stream=' + encodeURIComponent(rw.streamId) + '&agent=' + encodeURIComponent(rw.agentId || 'agent') + '&limit=50');
            turns = (t && t.turns) || [];
          } catch (_) { turns = null; }   // null = fetch FAILED (say so); [] = genuinely empty
        }
        const users = (turns || []).filter(m => m && m.role === 'user' && String(m.content || '').trim());
        const replies = (turns || []).filter(m => m && m.role === 'assistant' && String(m.content || '').trim() && String(m.content).trim() !== '[SILENT]');
        const lastReply = replies.length ? String(replies[replies.length - 1].content) : '';
        if (!rw.routine && users.length) row.querySelector('.ob-title b').textContent = firstLine(users[0].content, 64);
        desc.textContent = lastReply ? firstLine(plain(lastReply), 150)
          : (turns === null ? 'couldn’t read the result — is the station running?'
            : (turns && turns.length ? 'the run finished with nothing to report.' : 'no transcript recorded for this run.'));
        const askFull = users.length ? String(users[0].content) : '';
        ask.textContent = askFull ? (askFull.length > 1500 ? askFull.slice(0, 1500) + ' …' : askFull) : (rw.title || '—');
        out.textContent = lastReply ? (lastReply.length > 4000 ? lastReply.slice(0, 4000) + '\n\n… output truncated — ↗ OPEN shows the full run.' : lastReply)
          : (turns === null ? '⚠ couldn’t load the output — the run’s transcript wasn’t reachable.'
            : 'this run recorded no readable output.');
      })();
      // the row IS the toggle (accordion: one open at a time; collapsed rows stay clean)
      const head = row.querySelector('.ob-head'), bodyEl = row.querySelector('.ob-body'), caret = row.querySelector('.ob-caret');
      const toggle = () => {
        const opening = bodyEl.hidden;
        if (opening) closeOthers(row);
        bodyEl.hidden = !opening;
        row.classList.toggle('open', opening);
        head.setAttribute('aria-expanded', opening ? 'true' : 'false');
        caret.textContent = opening ? '▾' : '▸';
      };
      head.addEventListener('click', () => { const s = (window.getSelection && window.getSelection().toString()) || ''; if (!s.trim()) toggle(); });
      head.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
      // ↗ OPEN — jump into the run's own session (full conversation; test the output there)
      row.querySelector('.ob-open').addEventListener('click', async ev => {
        ev.stopPropagation();
        const b = ev.currentTarget; b.disabled = true;
        const ok = (RS && RS.openWork) ? await RS.openWork(rw) : false;
        b.disabled = false;
        if (!ok) notify('transcript unreachable for that run', 'warn');
      });
      // ⊕ NEW SESSION — dedicate a fresh chat (same agent) to expanding on this work; the composer
      // is prefilled naming the task so the follow-up ask writes itself. No fabricated turns.
      row.querySelector('.ob-fork').addEventListener('click', ev => {
        ev.stopPropagation();
        const w = WS(); if (!w) return;
        const title = (row.querySelector('.ob-title b').textContent || 'finished run').replace(/^[“”"]+|[“”"]+$/g, '');
        const ws = w.create(('follow-up: ' + title).slice(0, 80), { activate: false, agentId: rw.agentId });
        persistWS();
        if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(ws.id);
        if (typeof Chat !== 'undefined' && Chat.prefill) Chat.prefill('About the finished “' + title + '” run — ');
        sfx('click');
      });
      const rateHost = row.querySelector('.ob-rate');
      const mounted = (typeof Chat !== 'undefined' && Chat.awayRate)
        ? Chat.awayRate(rateHost, rw, () => { if (RS && RS.resolve) RS.resolve(rw.runId); collected(row); })
        : false;
      if (!mounted) {   // already judged this session — offer the plain collect so the crate never wedges
        const b = document.createElement('button'); b.type = 'button'; b.className = 'consent-btn'; b.textContent = '✓ collect crate';
        b.addEventListener('click', ev => { ev.stopPropagation(); if (RS && RS.resolve) RS.resolve(rw.runId); collected(row); });
        rateHost.appendChild(b);
      }
    }
  }

  StationUI.registerWindow('outbox', 'OUTBOX — FINISHED WORK', buildOutbox, { w: '620px' });   // the OUTBOX prop's click-through: all uncollected finished runs, readable + rateable in place
})();
