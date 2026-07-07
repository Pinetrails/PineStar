/* StarNet — dialogue.js : THE FOCUSED DIALOGUE MODE (Fallout-style first-run conversation).

   The first three minutes (the awakening's questions + the first-command tutorial) used to live as
   tappable chips in the COMMS scroll. That invited TYPING — and typed answers fell through or looped,
   because the flow only ever advanced on a tap. This module replaces that with a single, focused
   dialogue surface that TRANSFORMS COMMS while it's open: one short line at a time, a list of
   selectable response options (click OR number key), and an always-available "✎ say it in my own
   words" custom box. Input is captured deterministically — nothing falls through, nothing loops.

   It is pure presentation: it never writes a doc or grants a power itself. onboarding.js and tutorial.js
   drive it (Dialogue.say for narration, Dialogue.node for a choice) and do the real work. It mounts as a
   child overlay of #chat-panel so it naturally covers COMMS and follows the layout; if COMMS is absent it
   falls back to a fixed panel. Promise-based so the callers can `await` each beat in a flat, readable flow.

   Honest by construction: it shows exactly the words/options its caller passes — no invented capability
   claims live here (that's the truthful-telemetry law, enforced where the powers actually are). */
'use strict';

const Dialogue = (() => {
  let host = null, panel = null, speakerEl = null, lineEl = null, optsEl = null;
  let open = false, name = 'AGENT';
  let typer = null;            // active typewriter cancel handle
  let keyHandler = null;       // active option/number keydown handler

  const sfx = n => { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} };
  const reduceMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  function seg(text, cps, hold) { return { text: String(text == null ? '' : text), cps: cps || 46, holdAfter: hold || 0 }; }
  function norm(lines) {
    if (lines == null) return [];
    if (typeof lines === 'string') return [seg(lines)];
    if (!Array.isArray(lines)) return [seg(String(lines))];
    return lines.map(l => (typeof l === 'string') ? seg(l) : seg(l.text, l.cps, l.holdAfter));
  }

  function setName(n) { name = n || name; if (speakerEl) speakerEl.textContent = name; }

  /* mount the panel as a child of COMMS (#chat-panel) so it covers the conversation and tracks layout. */
  function ensure() {
    if (panel) return;
    host = document.getElementById('chat-panel');
    panel = document.createElement('div');
    panel.className = 'fnv-dialogue' + (reduceMotion() ? ' no-anim' : '');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-live', 'polite');
    speakerEl = document.createElement('div'); speakerEl.className = 'fnv-speaker'; speakerEl.textContent = name;
    lineEl = document.createElement('div'); lineEl.className = 'fnv-line';
    optsEl = document.createElement('div'); optsEl.className = 'fnv-opts';
    panel.appendChild(speakerEl); panel.appendChild(lineEl); panel.appendChild(optsEl);
    if (host) { host.classList.add('fnv-host'); host.appendChild(panel); }
    else { panel.classList.add('fnv-floating'); document.body.appendChild(panel); }   // COMMS missing → free-floating fallback
  }

  function openPanel(opts) {
    ensure();
    open = true;
    if (opts && opts.name) setName(opts.name);
    document.body.classList.add('fnv-mode');
    if (panel) panel.classList.add('show');
  }
  function closePanel() {
    cancelType(); clearKeys(); clearOpts();
    open = false;
    document.body.classList.remove('fnv-mode');
    if (host) host.classList.remove('fnv-host');
    if (panel) panel.remove();
    panel = speakerEl = lineEl = optsEl = host = null;
  }

  function cancelType() { if (typer) { try { typer(); } catch (_) {} typer = null; } }
  function clearKeys() { if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; } }
  function clearOpts() { if (optsEl) optsEl.innerHTML = ''; }

  /* typewriter into the single line area — REPLACES the previous beat (never accumulates a scroll). That
     "one beat at a time" is the whole anti-wall-of-text move. onDone ALWAYS fires (even if cancelled). */
  function typeInto(segs, onDone) {
    cancelType();
    if (!lineEl) { if (onDone) onDone(); return; }
    lineEl.textContent = '';
    let si = 0, ci = 0, killed = false, charN = 0;
    const timers = [];
    function done() { typer = null; if (onDone) try { onDone(); } catch (_) {} }
    function step() {
      if (killed) return;
      if (si >= segs.length) { done(); return; }
      const s = segs[si];
      const text = s.text;
      if (ci >= text.length) { si++; ci = 0; timers.push(setTimeout(step, s.holdAfter != null ? s.holdAfter : 0)); return; }
      lineEl.textContent += text[ci++];
      if ((charN++ % 2) === 0 && text[ci - 1] !== ' ') sfx('type');
      const cps = s.cps || 46;
      const base = 1000 / cps;
      const jitter = base * (0.6 + Math.random() * 0.5);
      timers.push(setTimeout(step, reduceMotion() ? 0 : jitter));
    }
    if (reduceMotion()) { lineEl.textContent = segs.map(s => s.text).join(''); done(); return; }
    typer = () => { killed = true; timers.forEach(clearTimeout); lineEl && (lineEl.textContent = segs.map(s => s.text).join('')); };
    step();
  }

  /* NARRATION — type a short beat, no options. Resolves after a small settle so beats breathe. */
  function say(lines) {
    return new Promise(resolve => {
      ensure(); clearKeys(); clearOpts();
      typeInto(norm(lines), () => setTimeout(resolve, 260));
    });
  }

  /* A CHOICE NODE — type the prompt, then render selectable options (+ optional custom box).
     cfg: { lines, options:[{label,value,skip}], allowCustom, customPlaceholder, customLabel }
     Resolves to { value, label, skip, custom }. Exactly one resolution; all handlers torn down first. */
  function node(cfg) {
    cfg = cfg || {};
    return new Promise(resolve => {
      ensure(); clearKeys(); clearOpts();
      let settled = false;
      const finishPick = res => { if (settled) return; settled = true; clearKeys(); sfx('click'); resolve(res); };
      typeInto(norm(cfg.lines), () => renderOptions(cfg, finishPick));
    });
  }

  function renderOptions(cfg, finishPick) {
    if (!optsEl) { finishPick({ value: '', skip: true }); return; }
    optsEl.innerHTML = '';
    const opts = (cfg.options || []).slice();
    const rows = [];
    opts.forEach((o, idx) => {
      const b = document.createElement('button');
      b.className = 'fnv-opt' + (o.skip ? ' skip' : '');
      b.type = 'button';
      const num = document.createElement('span'); num.className = 'fnv-num'; num.textContent = (idx + 1) + '.';
      const lbl = document.createElement('span'); lbl.className = 'fnv-opt-l'; lbl.textContent = o.label;
      b.appendChild(num); b.appendChild(lbl);
      b.onclick = () => finishPick({ value: o.value != null ? o.value : o.label, label: o.label, skip: !!o.skip });
      optsEl.appendChild(b); rows.push(b);
    });
    let customBtn = null;
    if (cfg.allowCustom) {
      customBtn = document.createElement('button');
      customBtn.className = 'fnv-opt custom'; customBtn.type = 'button';
      const num = document.createElement('span'); num.className = 'fnv-num'; num.textContent = '✎';
      const lbl = document.createElement('span'); lbl.className = 'fnv-opt-l'; lbl.textContent = cfg.customLabel || 'say it in my own words';
      customBtn.appendChild(num); customBtn.appendChild(lbl);
      customBtn.onclick = () => openCustom(cfg, finishPick);
      optsEl.appendChild(customBtn); rows.push(customBtn);
    }
    // OPT-IN escape hatch (mid-game asks, Andrew): a caller that presents a *sequence* of asks (e.g. the schedule
    // proposals) passes dismissable:true so Esc — or a quiet "✕ dismiss" row — resolves the node with dismissed:true,
    // letting the caller abandon the WHOLE flow, not just skip one. The GENESIS awakening never sets this, so its
    // ceremony is unchanged (no accidental early-exit from the birth).
    if (cfg.dismissable) {
      const d = document.createElement('button');
      d.className = 'fnv-opt skip dismiss'; d.type = 'button';
      const num = document.createElement('span'); num.className = 'fnv-num'; num.textContent = '✕';
      const lbl = document.createElement('span'); lbl.className = 'fnv-opt-l'; lbl.textContent = cfg.dismissLabel || 'dismiss — not now';
      d.appendChild(num); d.appendChild(lbl);
      d.onclick = () => finishPick({ value: '', skip: true, dismissed: true });
      optsEl.appendChild(d);
    }
    // keyboard: number keys pick an option; the trailing custom row is selectable too.
    keyHandler = e => {
      if (e.key === 'Escape' && cfg.dismissable) { e.preventDefault(); finishPick({ value: '', skip: true, dismissed: true }); return; }
      if (e.key === 'Enter' && cfg.allowCustom) { e.preventDefault(); openCustom(cfg, finishPick); return; }
      const n = parseInt(e.key, 10);
      if (!isNaN(n) && n >= 1 && n <= rows.length) { e.preventDefault(); rows[n - 1].click(); }
    };
    window.addEventListener('keydown', keyHandler);
  }

  /* the custom-speech path — swaps the option list for an input. Enter or ▸ submits; ‹ back restores
     the options. An empty submit on an optional node reads as a skip (caller decides via cfg.skipOnEmpty). */
  function openCustom(cfg, finishPick) {
    clearKeys();
    if (!optsEl) return;
    optsEl.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'fnv-custom';
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'fnv-custom-in';
    inp.placeholder = cfg.customPlaceholder || 'type your answer…';
    inp.setAttribute('aria-label', cfg.customPlaceholder || 'your answer');
    const send = document.createElement('button'); send.className = 'fnv-custom-send'; send.type = 'button'; send.textContent = '▸';
    const back = document.createElement('button'); back.className = 'fnv-custom-back'; back.type = 'button'; back.textContent = '‹ back';
    wrap.appendChild(back); wrap.appendChild(inp); wrap.appendChild(send);
    optsEl.appendChild(wrap);
    const submit = () => {
      const v = inp.value.trim();
      if (!v) { if (cfg.skipOnEmpty) finishPick({ value: '', skip: true, custom: true }); else inp.focus(); return; }
      finishPick({ value: v, label: v, custom: true });
    };
    send.onclick = submit;
    back.onclick = () => { clearKeys(); renderOptions(cfg, finishPick); };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); back.onclick(); }
    });
    setTimeout(() => inp.focus(), 30);
  }

  return { open: openPanel, close: closePanel, say, node, setName, isOpen: () => open };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Dialogue };
