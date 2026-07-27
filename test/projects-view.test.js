/* node test/projects-view.test.js — the PROJECTS rail view shaping (frontend/app/projects.js, NS-5c).
   Locks: toRows mirrors GET /api/projects EXACTLY (a blessed:false row is kept + flagged REVOKED, never hidden —
   truthful telemetry), basename handles win32 + posix paths, relTime speaks the rail's own now/2m/1h/3d vocabulary,
   and panels() is the toggle's show/hide truth table. Pure + headless like workstreams.test.js. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/projects.js');
const fs = require('fs');
const path = require('path');
const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');

/* ---------- basename: win32 + posix, trailing separators ignored ---------- */
A.eq(P.basename('C:\\Users\\me\\project'), 'project', 'win32 basename');
A.eq(P.basename('/home/me/proj'), 'proj', 'posix basename');
A.eq(P.basename('/home/me/proj/'), 'proj', 'trailing slash ignored');
A.eq(P.basename('C:\\Users\\me\\proj\\'), 'proj', 'trailing backslash ignored');
A.eq(P.basename(''), '', 'empty path -> empty basename');

/* ---------- relTime: the SAME compact vocabulary as the sessions rail ---------- */
const NOW = 1_000_000_000_000;
A.eq(P.relTime(0, NOW), '', 'no timestamp -> empty (no honest "last worked")');
A.eq(P.relTime(NOW - 30_000, NOW), 'now', 'under a minute reads now');
A.eq(P.relTime(NOW - 5 * 60_000, NOW), '5m', 'minutes');
A.eq(P.relTime(NOW - 3 * 3_600_000, NOW), '3h', 'hours');
A.eq(P.relTime(NOW - 2 * 86_400_000, NOW), '2d', 'days');

/* ---------- toRows: mirrors /api/projects, including a REVOKED (blessed:false) row ---------- */
const apiProjects = [
  { root: '/home/me/repo', displayPath: '/home/me/repo', isGitRepo: true, lastTouchedAt: NOW - 60_000, blessed: true },
  { root: '/home/me/plain', displayPath: '/home/me/plain', isGitRepo: false, lastTouchedAt: NOW - 2 * 3_600_000, blessed: false },
  { root: 'C:\\proj\\win', displayPath: 'C:\\proj\\win', isGitRepo: true, lastTouchedAt: null, blessed: true }
];
const rows = P.toRows(apiProjects, NOW);
A.eq(rows.length, 3, 'every API row is rendered (a revoked row is NOT hidden)');

A.eq(rows[0].name, 'repo', 'row name is the basename');
A.eq(rows[0].blessed, true, 'blessed row stays blessed');
A.eq(rows[0].state, 'blessed', 'blessed state');
A.eq(rows[0].isGitRepo, true, 'git flag carried');
A.eq(rows[0].rel, '1m', 'lastTouchedAt -> relative stamp');

A.eq(rows[1].blessed, false, 'blessed:false is preserved verbatim (truthful telemetry)');
A.eq(rows[1].state, 'revoked', 'blessed:false -> REVOKED state, shown not hidden');
A.eq(rows[1].name, 'plain', 'revoked row still names its folder');

A.eq(rows[2].rel, '', 'a never-touched project has an empty stamp, not a fake time');
A.eq(rows[2].name, 'win', 'win32 displayPath basename');

// a missing `blessed` field (older payload) defaults to blessed:true; a bad input is a safe empty list.
A.eq(P.toRows([{ root: '/a/b', displayPath: '/a/b' }], NOW)[0].blessed, true, 'absent blessed defaults true');
A.eq(P.toRows(null).length, 0, 'null input -> empty rows');

/* ---------- sessionsFor: the REAL stored w.projectRoot link, never a title guess ---------- */
const wsList = [
  { id: 'a', title: 'repo work', projectRoot: '/home/me/repo', archived: false, lastActiveAt: NOW - 60_000 },
  { id: 'b', title: 'older repo work', projectRoot: '/home/me/repo', archived: false, lastActiveAt: NOW - 3_600_000 },
  { id: 'c', title: 'repo-ish but unanchored', projectRoot: null, archived: false, lastActiveAt: NOW },
  { id: 'd', title: 'archived repo work', projectRoot: '/home/me/repo', archived: true, lastActiveAt: NOW },
  { id: 'e', title: null, projectRoot: '/other', archived: false, lastActiveAt: NOW - 1000 }
];
const sess = P.sessionsFor('/home/me/repo', wsList, NOW);
A.eq(sess.length, 2, 'only live sessions with the EXACT stored root attach (no title guessing, archived excluded)');
A.eq(sess[0].id, 'a', 'most-recently-active first');
A.eq(sess[1].id, 'b', 'older second');
A.eq(sess[0].rel, '1m', 'session rows speak the rail relTime vocabulary');
A.eq(P.sessionsFor('/other', wsList, NOW)[0].title, 'General', 'a null-title record reads as General');
A.eq(P.sessionsFor('', wsList, NOW).length, 0, 'empty root -> no attachments');
A.eq(P.sessionsFor('/nowhere', wsList, NOW).length, 0, 'unknown root -> empty, never a fake list');
A.eq(P.sessionsFor('/home/me/repo', null, NOW).length, 0, 'bad workstreams input -> safe empty');

/* ---------- sameRoot: the two anchor doors may differ only in case/slash shape on Windows ---------- */
A.eq(P.sameRoot('C:\\Proj\\Repo', 'c:\\proj\\repo'), true, 'win32 roots match case-insensitively');
A.eq(P.sameRoot('C:/proj/repo', 'C:\\proj\\repo'), true, 'win32 separators unify');
A.eq(P.sameRoot('C:\\proj\\repo\\', 'C:\\proj\\repo'), true, 'trailing separator ignored');
A.eq(P.sameRoot('/home/me/Repo', '/home/me/repo'), false, 'posix roots stay case-SENSITIVE');
A.eq(P.sameRoot('/home/me/repo/', '/home/me/repo'), true, 'posix trailing slash ignored');
A.eq(P.sameRoot('', ''), false, 'empty never matches (no fake attachment)');
A.eq(P.sameRoot(null, null), false, 'null never matches');
// and sessionsFor attaches through the SAME matcher: a Windows-case-variant stored anchor still lists.
const winWs = [{ id: 'w1', title: 'win work', projectRoot: 'c:\\proj\\WIN', archived: false, lastActiveAt: NOW }];
A.eq(P.sessionsFor('C:\\proj\\win', winWs, NOW).length, 1, 'win32 case-variant anchor still attaches to its project');

/* ---------- panels: the SESSIONS ↔ PROJECTS toggle truth table ---------- */
const s = P.panels('sessions');
A.eq(s.sessionsList, true, 'sessions view shows the sessions list');
A.eq(s.projectsList, false, 'sessions view hides the projects list');
A.eq(s.newBtn, true, 'sessions view shows + NEW');
A.eq(s.addBtn, false, 'sessions view hides + ADD');
const pr = P.panels('projects');
A.eq(pr.sessionsList, false, 'projects view hides the sessions list');
A.eq(pr.projectsList, true, 'projects view shows the projects list');
A.eq(pr.newBtn, false, 'projects view hides + NEW');
A.eq('archivedBtn' in pr, false, 'no ARCHIVED head action exists — the archived reveal is a footer row inside #workstreams');
A.eq(pr.addBtn, true, 'projects view shows + ADD');

/* ---------- revoked scope: browse history, but never mint work against an untrusted root ---------- */
const headAction = appSrc.slice(
  appSrc.indexOf('function updateProjHeadAction()'),
  appSrc.indexOf('function setRailView(', appSrc.indexOf('function updateProjHeadAction()'))
);
const newInProject = appSrc.slice(
  appSrc.indexOf('function newSessionInProject('),
  appSrc.indexOf('// the project row actions menu', appSrc.indexOf('function newSessionInProject('))
);
A.ok(/b\.disabled\s*=\s*!projScopeBlessed/.test(headAction),
  'entered revoked project disables + NEW from the fetched path-grant truth');
A.ok(/!projScopeBlessed/.test(newInProject),
  'newSessionInProject refuses to anchor a new session after trust is revoked');
A.ok(/Access revoked[\s\S]{0,180}existing sessions/i.test(appSrc),
  'revoked project empty-state copy says existing sessions remain browseable instead of promising new work');

A.report('projects-view.test');
