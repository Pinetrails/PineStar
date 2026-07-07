---
name: starnet-debugging
description: How to diagnose a broken StarNet behavior — reproduce-first discipline, where truth lives (events, stores, logs), the recurring bug classes, and how to avoid pattern-match fixes.
---

# Debugging StarNet — reproduce, trace, one hypothesis

## Discipline
1. **Reproduce live BEFORE reading code.** Boot the real app (`npm start`, replay provider),
   trigger the failure, and capture the artifact (console line, event payload, wrong DOM
   state). A bug you can't reproduce is a bug you can't verify you fixed.
2. **Trace the seam, not the symptom.** Truth lives in layers — find which layer is wrong:
   sidecar log → emitted U.bus event → store/save state → world model → render. The first
   layer where reality diverges from expectation is where the bug lives; everything
   downstream is just faithfully rendering the lie.
3. **One hypothesis per edit.** Form it, state it, test it with the smallest change. If it
   didn't fix it, REVERT before trying the next — stacked failed fixes are how hotfiles rot.
4. **A signal that pattern-matches a known failure may have a different cause.** Grep the
   current code before applying a remembered fix; half this repo's folklore is already stale.

## Recurring bug classes (check these first)
- **Survives-restart failures:** state correct until sidecar restart → persistence seam
  (store write missing or not replayed on boot).
- **Merge ghosts:** a hotfile auto-merge dropped/duplicated a function — `node --check` +
  grep the called symbols across loop.js/billing.js/router.js/worldmodel.js.
- **UI lies:** panel shows a state no backend route/store proves — the fix is in the claim's
  data source, not the CSS.
- **Event shape drift:** a consumer expecting a field the producer stopped/never sent —
  check `shared/events.js` (additive-only contract; a rename there is itself the bug).
- **Canvas "invisible" bugs:** wrong foot anchor, NN-crush, z/floor-line issues — sample
  pixels via preview_eval; screenshots time out on the canvas.
- **BOM/NUL file damage** from bad authoring — shows as parser errors on untouched-looking
  files; re-author via git binary-safe writes.
- **Secret destroyed without proof of new home:** a migrate/strip/clear removes the last
  durable copy of a credential while the write to its new home (keychain, new path) was
  best-effort/swallowed. Symptom: config intact, `enabled:true`, but the token/key is
  nowhere after a restart. Check every save/migration around the secret for
  strip-without-read-back, catch-and-continue around keychain/fs writes, and "load failed →
  save empty over good file" sequences. (Telegram-token escape, 2026-07-07.)

## Closing a bug
The fix is done when the ORIGINAL reproduction now shows the correct behavior live, the gate
is green, and you can say in one sentence why the bug happened. "It seems fixed" is not a
sentence — if you can't explain the mechanism, you've suppressed the symptom.
