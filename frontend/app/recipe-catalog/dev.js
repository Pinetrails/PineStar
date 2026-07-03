/* STARNET — recipe-catalog/dev.js : DEVELOPER persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogDev` global in the browser, module.exports under
   node, so the catalog aggregator can concat it either way. NO logic here — pure data.

   Voice contract (match the 10 builtins in recipes.js exactly): every `task` is an imperative
   DIRECTIVE that leads with the bottom-line ask, uses {token} params (0–2 each), and reads like
   the harness wrote it. Gear is honest (cabinet=files, dish=web, workbench=shell/tests,
   studio=media). cadence only where the use case is naturally recurring; else null. skills only
   where a bundled skill genuinely pairs. Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogDev = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'bug-triage', name: 'Bug Triage', emoji: '⌦', tagline: 'Sort a pile of bugs by what to fix first',
      accent: '#cf8a7d',
      blurb: 'Reads a backlog of reports and ranks them by real user impact — with a one-line fix hunch each.',
      tags: { code: 0.8, general: 0.2 },
      params: [{ key: 'reports', label: 'Bug reports', placeholder: 'paste the issues / error list' }],
      task: 'Triage these bug reports:\n\n{reports}\n\nRank them by real user impact (blocker → cosmetic), not by how loud they are. For each, give a one-line likely cause and whether it looks quick or deep. Flag any duplicates and anything that is actually working-as-intended.',
      category: 'developer', gear: ['cabinet'], skills: ['systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'pr-sweep', name: 'PR Sweep', emoji: '⊟', tagline: 'Review the open PRs, worst risk first',
      accent: '#cf8a7d',
      blurb: 'Walks the open pull requests and flags the ones that are risky, stale, or a fast merge.',
      tags: { code: 1 },
      params: [{ key: 'scope', label: 'Repo / area', placeholder: 'e.g. the frontend, or the whole repo', required: false, default: 'the open pull requests' }],
      task: 'Sweep {scope} and tell me which pull requests need my attention. For each: is it safe to merge, risky, or stale? Lead with the ones carrying real risk — untested changes, big diffs, touched hot paths — then the quick wins. One line of reasoning each.',
      category: 'developer', gear: ['cabinet'], skills: ['code-review'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'dependency-audit', name: 'Dependency Audit', emoji: '⊡', tagline: 'What is outdated, risky, or unused',
      accent: '#d9a85a',
      blurb: 'Checks the dependency tree for stale, vulnerable, or dead packages and ranks what to touch.',
      tags: { code: 0.8, research: 0.2 },
      params: [{ key: 'project', label: 'Project / manifest', placeholder: 'e.g. this repo, or package.json', required: false, default: 'this project' }],
      task: 'Audit the dependencies of {project}. Read the manifest and lockfile, then report: what is meaningfully outdated, anything with a known advisory, and packages that look unused. Rank by risk and give the safe upgrade path — never suggest a bump you have not sanity-checked.',
      category: 'developer', gear: ['cabinet', 'workbench'], skills: ['security-sweep'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'flaky-test-hunt', name: 'Flaky-Test Hunt', emoji: '⊘', tagline: 'Find the tests that fail at random',
      accent: '#b790c0',
      blurb: 'Runs the suite, isolates non-deterministic tests, and points at the likely source of the flake.',
      tags: { code: 1 },
      params: [{ key: 'suite', label: 'Test suite / command', placeholder: 'e.g. npm test, or a specific dir', required: false, default: 'the test suite' }],
      task: 'Hunt the flaky tests in {suite}. Run it enough to surface non-deterministic failures, isolate which tests fail intermittently, and for each name the likely cause — timing, shared state, ordering, or real bug. Give me the shortlist worth fixing first, not every red run.',
      category: 'developer', gear: ['workbench', 'cabinet'], skills: ['systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'changelog-draft', name: 'Changelog Draft', emoji: '⊞', tagline: 'Turn commits into a readable changelog',
      accent: '#7bc88a',
      blurb: 'Reads the recent history and drafts a human changelog grouped by what users actually notice.',
      tags: { code: 0.7, general: 0.3 },
      params: [{ key: 'range', label: 'Since', placeholder: 'e.g. the last release, or a tag/date', required: false, default: 'the last release' }],
      task: 'Draft a changelog covering changes since {range}. Read the commit history, then write it for a reader — grouped into Added / Changed / Fixed, plain language, no raw commit noise. Lead with anything user-facing. Flag breaking changes clearly at the top.',
      category: 'developer', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'refactor-scout', name: 'Refactor Scout', emoji: '⌘', tagline: 'Find the code most worth cleaning up',
      accent: '#b790c0',
      blurb: 'Scans a codebase area and points at the highest-leverage cleanups — no edits, just the map.',
      tags: { code: 1 },
      params: [{ key: 'area', label: 'Code area', placeholder: 'e.g. the auth module, or a file' }],
      task: 'Scout {area} for refactors worth doing. Read the code and rank the highest-leverage cleanups — duplication, tangled functions, dead branches, leaky abstractions — by payoff vs risk. Do NOT change anything yet; give me the map and a one-line rationale each so I can pick.',
      category: 'developer', gear: ['cabinet'], skills: ['simplify-code', 'codebase-inspection'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'error-log-triage', name: 'Error-Log Triage', emoji: '⚠', tagline: 'Cluster the noise into real incidents',
      accent: '#cf8a7d',
      blurb: 'Takes a wall of error logs and groups them into distinct problems, ranked by frequency and severity.',
      tags: { code: 0.8, general: 0.2 },
      params: [{ key: 'logs', label: 'Error logs', placeholder: 'paste the log output / stack traces' }],
      task: 'Triage these error logs:\n\n{logs}\n\nCluster them into distinct underlying problems (not per-line). For each cluster: how often it fires, how bad it is, and the most likely root cause. Lead with the one incident actually worth chasing today, and call out anything that is just noise.',
      category: 'developer', gear: ['cabinet'], skills: ['systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'onboard-codebase', name: 'Onboard a Codebase', emoji: '◱', tagline: 'Get oriented in unfamiliar code fast',
      accent: '#6fa8bf',
      blurb: 'Maps an unfamiliar repo — the entry points, the shape, where the important logic lives.',
      tags: { code: 0.7, research: 0.3 },
      params: [{ key: 'target', label: 'Repo / directory', placeholder: 'e.g. this repo, or a subfolder', required: false, default: 'this repository' }],
      task: 'Orient me in {target}. Read enough to map it: the entry points, the overall architecture, where the core logic lives, and the conventions I should follow. Lead with a two-sentence "what this is", then the tour. Flag the two or three files I should read first.',
      category: 'developer', gear: ['cabinet'], skills: ['codebase-inspection'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'perf-pass', name: 'Performance Pass', emoji: '◈', tagline: 'Find where the time and memory go',
      accent: '#d9a85a',
      blurb: 'Profiles a hot path or slow flow and names the real bottleneck before touching anything.',
      tags: { code: 1 },
      params: [{ key: 'target', label: 'What is slow', placeholder: 'e.g. a slow endpoint, a build step' }],
      task: 'Do a performance pass on {target}. Measure before you guess — profile or reason from the code to find where the time or memory actually goes. Report the top one or two bottlenecks with evidence, and the cheapest fix for each. Do not micro-optimize what does not matter.',
      category: 'developer', gear: ['workbench', 'cabinet'], skills: ['node-inspect-debugger', 'systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'release-notes', name: 'Release Notes', emoji: '⊛', tagline: 'Write the notes users will read',
      accent: '#7bc88a',
      blurb: 'Turns a set of changes into polished release notes — highlights first, upgrade steps clear.',
      tags: { code: 0.5, general: 0.5 },
      params: [
        { key: 'version', label: 'Version', placeholder: 'e.g. 1.4.0' },
        { key: 'changes', label: 'What shipped', placeholder: 'paste the changelog / commit summary', required: false, default: 'the changes since the last release' }
      ],
      task: 'Write release notes for {version} from {changes}. Lead with the two or three highlights a user cares about, then the fuller list, then any upgrade or breaking-change steps spelled out. Warm and concise — this is what people actually read. Draft only; do not publish anything.',
      category: 'developer', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
