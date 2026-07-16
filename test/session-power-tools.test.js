/* node test/session-power-tools.test.js — Wave 4A session search/export/recovery/bulk cleanup. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const W = require('../frontend/app/workstreams.js');

const DAY = 86400000;
const NOW = 200 * DAY;
const rows = [{ id: 'general', title: null, kind: 'chat', lane: 'active', createdAt: NOW, lastActiveAt: NOW, history: [] }];
for (let i = 1; i <= 50; i++) {
  rows.push({
    id: 's' + i,
    title: i === 17 ? 'Orchid launch notes' : 'Session ' + i,
    kind: 'chat', lane: i % 7 === 0 ? 'shipped' : 'active',
    createdAt: NOW - i * DAY, lastActiveAt: NOW - i * DAY,
    pinned: i === 49,
    history: i % 5 === 0 ? [] : [
      { role: 'user', content: i === 23 ? 'The body contains NEBULA-NEEDLE.' : 'Question ' + i },
      { role: 'assistant', content: 'Answer ' + i }
    ]
  });
}
W.init({ workstreams: rows, activeId: 's17', generalId: 'general' });

/* one surface searches all 50 title and transcript records */
A.eq(W.search('orchid').map(x => x.id), ['s17'], 'title search finds the known session');
A.eq(W.search('nebula-needle').map(x => x.id), ['s23'], 'body search finds the known transcript hit');
A.ok(W.search('answer').length === 40, 'search spans all seeded transcript bodies');
A.ok(!W.search('nebula-needle')[0].snippet.startsWith('Session 23'), 'body snippet does not repeat the separately rendered title');

/* export: visible dialogue only, obvious secrets scrubbed, hidden/system material absent */
const active = W.get('s17');
active.history.push(
  { role: 'system', content: 'HIDDEN-SYSTEM-SENTINEL' },
  { role: 'assistant', sys: true, content: 'LOCAL-MARKER-SENTINEL' },
  { role: 'user', content: 'token sk-abcdefghijklmnopqrstuvwxyz123456 and Bearer ABCDEFGHIJKLMNOPQRSTUV' },
  { role: 'assistant', content: 'safe visible answer' }
);
const json = W.exportConversation('s17', 'json', { exportedAt: 123 });
A.ok(json && json.mime === 'application/json', 'JSON export has an explicit MIME type');
A.ok(!/HIDDEN-SYSTEM|LOCAL-MARKER/.test(json.text), 'JSON excludes hidden system/local rows');
A.ok(!/sk-abcdefghijklmnopqrstuvwxyz|ABCDEFGHIJKLMNOPQRSTUV/.test(json.text), 'JSON scrubs obvious credential material');
A.ok(/\[redacted\]/.test(json.text), 'JSON visibly marks scrubbed values');
const parsed = W.parseConversationExport(json.text);
A.eq(parsed.title, 'Orchid launch notes', 'JSON export round-trips its title');
A.ok(parsed.messages.some(m => m.content === 'safe visible answer'), 'JSON export round-trips visible dialogue');
A.ok(parsed.messages.every(m => m.role === 'user' || m.role === 'assistant'), 'round-trip contains dialogue roles only');
const md = W.exportConversation('s17', 'markdown', { exportedAt: 123 });
A.ok(md && md.mime === 'text/markdown' && /^# Orchid launch notes/m.test(md.text), 'Markdown export has heading and MIME');
A.ok(/## Commander[\s\S]*## Agent/.test(md.text), 'Markdown labels both visible speakers');
A.ok(!/HIDDEN-SYSTEM|LOCAL-MARKER/.test(md.text), 'Markdown excludes hidden/system rows too');

/* clear checkpoints only the active transcript; another session and memory-shaped metadata stay intact */
const otherBefore = JSON.stringify(W.get('s23'));
const runIdsBefore = active.runIds.slice();
const cleared = W.clearConversation('s17', { at: 777 });
A.ok(cleared && cleared.kind === 'clear' && cleared.count > 0, 'clear creates a named recovery checkpoint');
A.eq(active.history, [], 'clear removes the selected conversation history');
A.eq(active.runIds, runIdsBefore, 'clear does not erase run/deliverable metadata');
A.eq(JSON.stringify(W.get('s23')), otherBefore, 'clear never changes an unrelated session');
const afterClearSave = JSON.parse(JSON.stringify(W.serialize()));
W.init(afterClearSave);
A.ok(W.canUndo(), 'clear recovery checkpoint survives serialize/restart');
A.ok(W.undoLast(), 'undo restores the clear checkpoint after restart');
A.ok(W.get('s17').history.some(m => m.content === 'safe visible answer'), 'undo restores the exact transcript');

/* bulk preview is exact; pinned and General are protected; only previewed ids move; undo survives restart */
const preview = W.previewArchive({ empty: true, completed: true, olderThanMs: 30 * DAY }, { now: NOW });
A.ok(preview.ids.length > 0, 'bulk criteria produce a non-empty preview');
A.ok(!preview.ids.includes('general'), 'bulk preview always protects General');
A.ok(!preview.ids.includes('s49'), 'bulk preview protects pinned sessions by default');
const beforeArchived = Object.fromEntries(W.all().map(w => [w.id, !!w.archived]));
const result = W.archivePreview(preview, { at: 888 });
A.eq(result.ids, preview.ids, 'bulk archive affects the exact previewed id list');
for (const w of W.all()) {
  const shouldMove = preview.ids.includes(w.id);
  A.eq(!!w.archived, shouldMove ? true : beforeArchived[w.id], 'archive membership is exact for ' + w.id);
}
const bulkSave = JSON.parse(JSON.stringify(W.serialize()));
W.init(bulkSave);
A.ok(W.undoLast(), 'bulk recovery checkpoint survives serialize/restart');
for (const id of preview.ids) A.eq(!!W.get(id).archived, beforeArchived[id], 'bulk undo restores ' + id);

/* stale/tampered previews cannot cross the shown set */
const exact = W.previewArchive({ empty: true }, { now: NOW });
const forged = Object.assign({}, exact, { ids: exact.ids.concat('s23') });
A.eq(W.archivePreview(forged), null, 'a forged preview token is rejected without mutation');
A.eq(!!W.get('s23').archived, beforeArchived.s23, 'rejected forged preview cannot archive an unpreviewed session');

/* browser wiring: the power tools are discoverable, confirmed, persisted, and download both formats */
const app = fs.readFileSync(require.resolve('../frontend/app/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
const sui = fs.readFileSync(require.resolve('../frontend/app/stationui.js'), 'utf8');
A.ok(/data-term="sessiontools"/.test(html) && /id="ws-tools-park"/.test(html), 'SESSION TOOLS is discoverable from the SYSTEM menu and the panel is parked outside the rail');
A.ok(!/ws-tools-btn/.test(html), 'rail head stays SESSIONS/PROJECTS + NEW only (no inline TOOLS button)');
A.ok(/sessiontools:\s*\['SESSION TOOLS',\s*buildSessionTools/.test(sui) && /onClose:\s*parkSessionTools/.test(sui), 'the floating window adopts the parked panel and re-parks it on close');
A.ok(/id="ws-tools-archived"[^>]*hidden/.test(html), 'archived mirror row ships hidden until at least one session is archived');
A.ok(/function refreshSessionToolsArchived[\s\S]{0,600}railShowArchived/.test(app), 'archived mirror derives its label from the rail reveal state — one source of truth');
A.ok(/ws-tools-archived'\)\.onclick[\s\S]{0,300}setRailView\('sessions'\)[\s\S]{0,100}toggleArchived\(\)/.test(app), 'mirror click forces the sessions view then flips the rail’s own reveal');
A.ok(/id="ws-search"[\s\S]*search sessions \+ transcripts/.test(html), 'one labelled search surface covers sessions and transcripts');
A.ok(/EXPORT \.MD[\s\S]*EXPORT \.JSON/.test(html), 'both conversation export formats are visible');
A.ok(/CONFIRM CLEAR/.test(app) && /clearConversation\(w\.id\)/.test(app), 'clear requires an explicit second confirmation');
A.ok(/archivePreview\(sessionToolsPreview\)/.test(app), 'bulk apply consumes the exact stored preview');
A.ok(/sessionUndo:\s*saved\.sessionUndo/.test(app), 'durable recovery checkpoint is hydrated on restart');
A.ok(/Workstreams\.undoLast\(\)[\s\S]*persist\(\)/.test(app), 'undo is immediately persisted');
A.ok(/URL\.revokeObjectURL/.test(app), 'export object URL is always revoked');

A.report('session-power-tools.test');
