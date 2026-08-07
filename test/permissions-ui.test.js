'use strict';
// permissions-ui.test.js — source-lock that the Permissions Panel is wired into the SETTINGS view (stationui.js):
// the never→fully-autonomous level row, the standing-grant list, and the store hooks that drive them. A grep-style
// guard (mirrors autonomy-ui / autojobs-ui) so the panel can't silently regress out of the build.
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// the reorganized pane: execution profile is independent from approval, then unattended + standing grants
// (no duplicated inner h4 for the SECTION — the PROVIDERS rule), topped by the master FULL BYPASS switch.
// Each block header is a real .ms-h (the shared divider-rule idiom), not body-weight .set-row prose —
// that flatness is exactly what made the pane unreadable before the 08-05 spacing pass.
ok(/<h4 class="ms-h">1 · YOUR CREW/.test(src), 'block 1: the crew list is a real section header');
ok(/<h4 class="ms-h">2 · SKIP EVERY PROMPT/.test(src), 'block 2: the master override is a real section header');
ok(/<h4 class="ms-h">3 · WHILE YOU’RE AWAY/.test(src), 'block 3: unattended-level header is a real section header');
ok(/<h4 class="ms-h">4 · STANDING APPROVALS/.test(src), 'block 4: standing-approvals header is a real section header');
// the flip button may never go back to sitting inline after the row's sentence (the collision bug)
ok(/class="perm-agent/.test(src) && /class="pa-state"/.test(src), 'agent rows are structured (name/state/button), not one inline sentence');

// ── the plain-language pass (2026-08-07) ──
// AT A GLANCE: the pane opens with ONE ordinary sentence about the station's real posture, counted from
// the same live records the rows render — never a fixed string, never a claim the roster can't back.
ok(/id="perm-glance"/.test(src), 'the pane opens with an AT A GLANCE summary card');
ok(/const paintGlance = \(\) =>/.test(src) && /present\.filter\(a => a && a\.approvalMode === 'full'\)\.length/.test(src),
  'the glance sentence COUNTS the live roster rather than asserting a posture');
ok(/paintGlance\(\);\s+\/\/ the glance sentence names the override state/.test(src),
  'the glance repaints with the master switch (summary and switch can never disagree)');
ok(/protected files \(<code>\.env<\/code>, <code>\.git<\/code>\) are never writable/.test(src),
  'the glance states the standing floor in plain words');
// ONE crew row per agent carrying BOTH axes — the two-tables-forty-rows-apart layout is the defect this
// lane closed, so a future split has to break this lock deliberately.
ok(/id="perm-crew"/.test(src), '#perm-crew is the single merged crew list');
ok(!/id="perm-execution"/.test(src) && !/id="perm-approval"/.test(src),
  'reach and approval are NOT two separate crew lists any more');
ok(/data-perm-profile=/.test(src) && /data-ap-flip=/.test(src) && /class="perm-agent perm-crew-row/.test(src),
  'one row carries both the reach chips and the asks-first chips');
ok(/<span class="pc-q">CAN REACH<\/span>/.test(src) && /<span class="pc-q">ASKS FIRST<\/span>/.test(src),
  'each control is preceded by the plain question it answers');
// the reach ladder must stay ORDERED and self-describing: a meter plus one ordinary sentence per rung.
ok(/const reachMeter = \(n\) =>/.test(src) && /class="pc-dots"/.test(src), 'each reach chip wears a reach meter');
ok(/id: 'safe-cell'[\s\S]{0,900}id: 'remote-ssh'[\s\S]{0,900}id: 'station-gear'[\s\S]{0,900}id: 'trusted-project'[\s\S]{0,900}id: 'this-computer'/.test(src),
  'EXECUTION_PROFILES is ordered safest → broadest (the array order IS the chip order)');
ok(/reach: 1,[\s\S]{0,900}reach: 1,[\s\S]{0,900}reach: 2,[\s\S]{0,900}reach: 3,[\s\S]{0,900}reach: 4,/.test(src),
  'the reach meter never decreases down the ladder');
ok(/EXECUTION_PROFILE_DEFAULT = 'station-gear'/.test(src) && !/\|\| EXECUTION_PROFILES\[0\]/.test(src),
  'the profile fallback is the DEFAULT by id, never an index into the reach-ordered array');
ok(/plain: 'None of your files\./.test(src) && /plain: 'Almost any file on this computer/.test(src),
  'every rung carries a plain-English sentence about what it can touch');
// the advanced Docker housekeeping is no longer the first thing under the crew header
ok(/id="perm-advanced"/.test(src) && /ADVANCED — idle Safe Cell cleanup/.test(src),
  'the idle-cell policy lives in a closed ADVANCED disclosure, not above the crew');
ok(/id="perm-bypass" class="perm-master"/.test(src), 'the master switch is a CARD, not a key-list row');
ok(/class="perm-m-act"/.test(src), 'the bypass control sits on its own line, never inside the prose');
ok(/id="perm-desc"/.test(src), '#perm-desc combined-level blurb element present');

// ── 0 · the master FULL BYPASS switch ──
ok(/id="perm-bypass"/.test(src), '#perm-bypass master-switch host present');
// both directions ride ONE flip() helper (it disables the button in flight and records the failure at
// the card) — so lock the helper plus each direction's call site rather than two literal store calls.
ok(/PermissionsStore\.setBypass\(want\)/.test(src), 'the bypass flip drives PermissionsStore.setBypass');
ok(/flip\(onBtn, true,/.test(src) && /flip\(offBtn, false,/.test(src), 'the switch flips both ways');
ok(/btn\.disabled = true;/.test(src), 'a flip in flight disables its button (no double POST)');
ok(/class="perm-m-err"/.test(src) && /bypassErr/.test(src), 'a refused flip reports AT the switch, not in another block');
ok(/ArmConfirm\.wire\(onBtn/.test(src), 'turning FULL BYPASS ON keeps the two-press confirm (destructive-action guard)');
ok(/snap\.envFullAccess/.test(src), 'an env-forced bypass is explained (pinned switch), never a dead toggle');
ok(/protected-file floor/.test(src), 'the bypass copy names the floors that still stand (truthful telemetry)');

// ── 1 · per-agent APPROVAL chips ──
ok(/setApproval/.test(src), 'rows apply through access.config.setApproval (the dossier/-yolo path)');
ok(/ArmConfirm\.wire\(b, \{ armedLabel: 'SURE\? IT WILL NEVER ASK'/.test(src),
  'escalating one agent to no-prompts keeps the two-press confirm');
ok(/id="perm-full-all"/.test(src) && /id="perm-ask-all"/.test(src), 'whole-station FULL ACCESS + everyone-asks switches present');
ok(/ArmConfirm\.wire\(fullAll/.test(src), 'whole-station FULL ACCESS keeps the two-press confirm');

// the level spectrum: never → suggest → draft → full
ok(/id="perm-level"/.test(src), '#perm-level chooser present');
for (const lvl of ['never', 'suggest', 'draft', 'full']) ok(new RegExp('data-level="' + lvl + '"').test(src), 'level button present: ' + lvl);
// 2026-07-15 UX sweep: one ladder, one vocabulary — the level buttons carry the SAME primary words as the
// AUTONOMY dial (WAIT/SUGGEST/BUILD/FREE); FULLY AUTONOMOUS stays in the top label (it states the stakes).
ok(/FULLY AUTONOMOUS/.test(src), 'the "fully autonomous" extreme is offered');
ok(/>WAIT</.test(src), 'the hands-off extreme is offered with the dial\'s word (WAIT)');
ok(/BUILD \(DRAFTS\)/.test(src), 'the draft rung carries the dial\'s word (BUILD)');
ok(/same WAIT \/ SUGGEST \/ BUILD \/ FREE ladder/.test(src), 'the row says it is the SAME ladder as AUTONOMY');

// the standing-grant list + grant/revoke wiring
ok(/id="perm-grants"/.test(src), '#perm-grants standing-grant list present');
ok(/id="perm-status"/.test(src), 'permission authority has a live status/error readout');
ok(/data-perm-grant=|data-perm-revoke=/.test(src), 'per-capability grant/revoke buttons rendered');

// STANDING APPROVALS ledger (P0-5): the section is titled as a ledger, every grant is revocable, provenance +
// teaching empty state are wired, and REVOKE is a destructive two-step arm/confirm (the app's idiom).
ok(/STANDING APPROVALS/.test(src), 'the standing-grant section is titled STANDING APPROVALS');
ok(/data-perm-revoke=/.test(src), 'a REVOKE control is rendered for standing grants');
ok(/pwhen|grantAgeText/.test(src), 'each row shows WHEN it was granted (provenance line)');
ok(/emptyApprovals|No standing approvals yet/.test(src), 'teaching empty state ("answer ALWAYS…") is wired');
// (the arm state itself lives in the shared ArmConfirm helper — the stray dataset.armed the old needle matched
// belonged to the REWIND window, which moved to frontend/app/windows/rewind.js in the BUILDERS split)
ok(/\[data-perm-revoke\]'\)\.forEach\(b => ArmConfirm\.wire\(b/.test(src), 'REVOKE uses the two-step arm/confirm idiom (destructive-action guard)');
ok(/held\.filter\(k => curated\.indexOf\(k\) < 0\)/.test(src), 'NON-curated standing grants are listed too (nothing hidden/irrevocable)');
ok(/pre-approve a capability|pre-bless/i.test(src), 'the curated GRANT offer is kept separate from the active-approvals ledger');
ok(/<b>RUNS WITHOUT PROMPTS<\/b>/.test(src),
  'the per-agent approval copy states the canonical no-prompts meaning without claiming machine access');
ok(/zero-prompt posture applies watched or unattended/.test(src),
  'the permissions panel explicitly applies the posture to unattended tasks too');
ok(!/unattended runs[^.]*never inherit it/.test(src),
  'the panel never contradicts the persisted Full Access contract');
ok(/Full Access is represented only by the canonical per-agent APPROVAL rows/.test(src),
  'Full Access is not duplicated as an ephemeral standing-grant wildcard');
ok(/without approval prompts \(the hard safety floor still applies\)/.test(src),
  'the whole-station copy preserves the automatic hard safety floor');

// the store hooks
ok(/PermissionsStore\.setLevel\(/.test(src), 'level click drives PermissionsStore.setLevel');
ok(/PermissionsStore\.grant\(/.test(src) && /PermissionsStore\.revoke\(/.test(src), 'grant + revoke wired to the store');
ok(/PermissionsStore\.refresh\(/.test(src), 'panel refreshes grants from the sidecar on open');
ok(/snap\.error/.test(src), 'panel surfaces permission load/mutation failures instead of painting fake empty authority');
ok(!/load:\s*\(\)\s*=>[\s\S]{0,300}\{\s*grants:\s*\[\],\s*grantable:\s*\[\]\s*\}/.test(appSrc), 'permission load failures are not synthesized as an authoritative empty ledger');

// bidirectional sync: the granular dial repaints the permissions level (syncPerm) and vice versa (repaintDial)
ok(/syncPerm\s*=\s*repaintPerm/.test(src), 'the dial→permissions sync hook is wired');
ok(/repaintDial\(\)/.test(src), 'a level change repaints the granular dial too');

// guarded behind a typeof check so an older bundle without the store never throws
ok(/typeof PermissionsStore !== 'undefined'/.test(src), 'permissions block is feature-guarded');

// HONESTY (review S1): a granted-but-inert capability (cabinet:write with no cabinet placed) must be flagged via the
// live placed-caps check, never shown as a silent "writes files" lie (object=capability).
ok(/heroCaps/.test(src), 'panel reads the agent live placed caps (World.heroCaps) to judge effectiveness');
ok(/grantEffective|objectHint/.test(src), 'panel flags a granted-but-inert capability with a place-the-object hint');

console.log('permissions-ui.test.js OK —', n, 'assertions');
