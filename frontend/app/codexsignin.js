/* STARNET — codexsignin.js : the ONE ChatGPT (Codex) device-code sign-in driver.

   Extracted from app.js's connect-screen flow (start → show code → open page → poll → connected) so the
   Settings→PROVIDERS panel can offer RE-SIGN-IN without duplicating the poll loop. DOM-free by design:
   callers pass callbacks and render into their own surface (the brain screen's #codex-* block, or the
   settings row's inline box). Tokens never touch this module — it only sees the sidecar's public
   device-flow endpoints (user_code / verification_uri / status strings).

   Callbacks (all optional):
     onRequesting()                                — the start call is in flight
     onCode({ user_code, verification_uri })       — show the code; the caller opens the URL its own way
     onConnected()                                 — the sidecar exchanged + persisted tokens
     onError(message)                              — start failed or the poll reported a hard error
     onTimeout()                                   — the device code expired before the user finished

   Single-flight: start() cancels any in-flight flow first; cancel() aborts silently (screen change /
   disconnect). Matches the app.js behavior it replaces exactly, including the transient-network
   keep-polling rule. */
'use strict';

const CodexSignIn = (() => {
  let flow = null;    // { device_auth_id, user_code, deadline } — the in-flight device-code login
  let timer = null;   // the poll setTimeout handle

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
    flow = null;
  }

  // Kick off the device-code flow: request a code, hand it to the caller, then poll until done.
  async function start(cb) {
    cb = cb || {};
    cancel();
    if (cb.onRequesting) cb.onRequesting();
    let d;
    try {
      const r = await fetch('/api/auth/codex/start', { method: 'POST' });
      d = await r.json();
      if (!r.ok) throw new Error(d.error || ('start failed (' + r.status + ')'));
    } catch (e) {
      if (cb.onError) cb.onError('could not start sign-in: ' + ((e && e.message) || e));
      return;
    }
    const my = flow = {
      device_auth_id: d.device_auth_id,
      user_code: d.user_code,
      deadline: Date.now() + ((d.expires_in || 900) * 1000)
    };
    if (cb.onCode) cb.onCode({ user_code: d.user_code, verification_uri: d.verification_uri });
    poll(my, d.interval || 5, cb);
  }

  // One poll tick on a timer; the sidecar reports pending until the user finishes, then connects + persists.
  function poll(my, intervalS, cb) {
    timer = setTimeout(async () => {
      if (flow !== my) return;   // superseded / cancelled while waiting
      if (Date.now() > my.deadline) { flow = null; if (cb.onTimeout) cb.onTimeout(); return; }
      let j;
      try {
        const r = await fetch('/api/auth/codex/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: my.device_auth_id, user_code: my.user_code }) });
        j = await r.json();
      } catch (e) { j = { status: 'pending' }; }   // transient network blip — keep polling
      if (flow !== my) return;                       // bailed out (back/disconnect) while awaiting
      if (j.status === 'connected') { flow = null; if (cb.onConnected) cb.onConnected(); return; }
      if (j.status === 'error') { flow = null; if (cb.onError) cb.onError('sign-in failed: ' + (j.error || 'try again')); return; }
      poll(my, intervalS, cb);                       // pending — schedule the next tick
    }, Math.max(2, intervalS) * 1000);
  }

  // Forget the stored ChatGPT credentials (the sidecar clears tokens AND any recorded dead-sign-in state).
  async function logout() {
    cancel();
    try { await fetch('/api/auth/codex/logout', { method: 'POST' }); } catch (_) {}
  }

  return { start, cancel, logout, active: () => !!flow };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CodexSignIn;
