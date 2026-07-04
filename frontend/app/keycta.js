/* STARNET — keycta.js : the honest "your agent is awake but has no working brain" call-to-action.

   THE ASYMMETRY THIS CLOSES: a Commander can complete the ENTIRE awakening with no key configured — the
   ceremony degrades to its scripted spine (no live model), the agent ends up "ready" on screen, yet the
   first real task would fail with harness.js's honest 'no API key set'. This surfaces that gap the moment
   the awakening lands, in the world, as ONE standing banner pointing at SETTINGS.

   TRUTHFUL TELEMETRY (the product's core law): the banner is a PURE PROJECTION of backend state. It shows
   IFF the active provider genuinely needs a key AND `Harness.hasStoredCredential` reports none is stored
   (never fabricated by DEVMODE, unlike configured()). The instant a key lands it re-evaluates and vanishes —
   it can never assert a missing connection that actually exists, nor linger once one does. A Codex (OAuth)
   or ollama/custom (keyless-by-design) station never trips it. */
'use strict';

const KeyCTA = (() => {
  const el = id => document.getElementById(id);
  let armed = false;      // only after an awakening lands (arm()) — never on the connect screen / mid-ceremony
  let timer = null;

  function normProv(p) {
    p = String(p || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return p;
  }
  function providerNeedsKey(p) {
    p = normProv(p);
    return p !== 'codex' && p !== 'ollama' && p !== 'custom';
  }
  function activeProvider() {
    return normProv((typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter');
  }
  // The one truth question: does the FOCUSED agent lack a run-able brain purely for want of a key?
  function missingKey() {
    // only once the awakening has actually landed (a fully onboarded hero on the floor)
    if (typeof App === 'undefined' || !App.currentAgent) return false;
    const a = App.currentAgent();
    if (!a || !a.onboarded) return false;
    const p = activeProvider();
    if (!providerNeedsKey(p)) return false;
    try {
      if (typeof Harness !== 'undefined' && Harness.hasStoredCredential) return !Harness.hasStoredCredential(p);
    } catch (_) {}
    return false;
  }

  function openSettings() {
    if (typeof StationUI !== 'undefined' && StationUI.openTerm) { StationUI.openTerm('settings'); return; }
    const b = document.querySelector('.bb[data-term="settings"]'); if (b) b.click();
  }

  function ensureBanner() {
    let b = el('key-cta');
    if (b) return b;
    const wrap = el('stage-wrap');
    if (!wrap) return null;
    b = document.createElement('div');
    b.id = 'key-cta';
    b.className = 'key-cta';
    b.setAttribute('role', 'status');
    b.hidden = true;
    b.innerHTML =
      '<span class="key-cta-glyph" aria-hidden="true">⚠</span>' +
      '<span class="key-cta-txt"></span>' +
      '<button type="button" class="key-cta-act">⚙ ADD IN SETTINGS</button>';
    b.querySelector('.key-cta-act').addEventListener('click', openSettings);
    wrap.appendChild(b);
    return b;
  }

  // pure render off live state — safe to call from a tick, from settings key edits, or from arm()
  function render() {
    const show = armed && missingKey();
    const b = ensureBanner();
    if (!b) return;
    if (!show) { b.hidden = true; return; }
    const label = activeProvider().toUpperCase();
    b.querySelector('.key-cta-txt').textContent =
      'your agent is awake — but it has no ' + label + ' key, so it can’t run a task yet.';
    b.hidden = false;
  }

  // begin watching AFTER the awakening lands. Idempotent. A light 2s re-eval is the backstop; settings/key
  // paths also call refresh() for an instant clear, so this never feels laggy.
  function arm() {
    armed = true;
    render();
    if (timer) return;
    timer = setInterval(render, 2000);
  }

  return { arm, refresh: render };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KeyCTA;
