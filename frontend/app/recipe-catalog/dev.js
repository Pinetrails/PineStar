/* STARNET — recipe-catalog/dev.js : DEVELOPER persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogDev` global in the browser, module.exports under
   node, so the catalog aggregator can concat it either way. NO logic here — pure data.

   Content contract: every record must clear THE RECIPE BAR documented in core.js (earns its tap /
   drives the station / lands somewhere / compounds when recurring). Voice matches the core
   builtins: every `task` is an imperative DIRECTIVE that leads with the bottom-line ask, uses
   {token} params (0–2 each), and reads like the harness wrote it. Gear is honest (cabinet=files,
   dish=web, workbench=shell/tests, studio=media, notebook=memory). cadence only where the use
   case is naturally recurring; else null. skills only where a bundled skill genuinely pairs.
   Schema v2:
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
      blurb: 'Clusters a backlog into real root causes, then ranks by user impact — with a starting point for each.',
      tags: { code: 0.8, general: 0.2 },
      params: [{ key: 'reports', label: 'Bug reports', placeholder: 'paste the issues — or point me at the tracker / repo' }],
      task: 'Triage these bug reports:\n\n{reports}\n\nFirst cluster duplicates and symptoms of the same root cause — a pile of twenty reports is usually six real problems. Then rank the clusters by real user impact (data loss > broken flow > friction > cosmetic), never by who shouted loudest. For each cluster: the likely root cause in one line, a quick-or-deep estimate, and — if the repo is reachable — where in the code to start looking. Flag anything that is actually working-as-intended, and say why.',
      category: 'developer', gear: ['cabinet'], skills: ['systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'pr-sweep', name: 'PR Sweep', emoji: '⊟', tagline: 'Review the open PRs, worst risk first',
      accent: '#cf8a7d',
      blurb: 'Reads the actual diffs and sorts the open PRs into real risk, fast merges, and stale — with reasons.',
      tags: { code: 1 },
      params: [{ key: 'scope', label: 'Repo / area', placeholder: 'e.g. the frontend, or the whole repo', required: false, default: 'the open pull requests' }],
      task: 'Sweep {scope} and tell me which pull requests actually need my attention. Read the diffs, not just the titles. Judge each by what its code touches (hot paths, auth, data migrations count double), whether the change is tested, and how long it has sat. Sort into: real risk / fast merge / stale. Lead with the risky ones, one line of reasoning each — and flag any PR whose description does not match its diff, because that is where surprises live.',
      category: 'developer', gear: ['cabinet'], skills: ['code-review'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'dependency-audit', name: 'Dependency Audit', emoji: '⊡', tagline: 'What is outdated, risky, or unused',
      intake: [
        { dimension: "scope", question: "Report or act?", options: ["report only","draft the upgrades too"], recommended: "report only", reason: "acting mutates the project; reporting never does" }
      ],
      accent: '#d9a85a',
      blurb: 'Reads the manifest and lockfile, ranks the real risk, and gives a safe upgrade order — not a wall of bumps.',
      tags: { code: 0.8, research: 0.2 },
      params: [{ key: 'project', label: 'Project / manifest', placeholder: 'e.g. this repo, or package.json', required: false, default: 'this project' }],
      task: 'Audit the dependencies of {project}. Read the manifest and lockfile, then check each major dependency for known advisories, how far behind it is, and whether the code even still uses it. Rank by REAL risk — a vulnerable transitive dep of a dev tool is not a page-one item. Give the safe upgrade path in order: what to bump first, what to run after each bump to prove nothing broke, and any package worth replacing outright rather than upgrading. Never suggest a bump you have not sanity-checked.',
      category: 'developer', gear: ['cabinet', 'workbench'], skills: ['security-sweep'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'flaky-test-hunt', name: 'Flaky-Test Hunt', emoji: '⊘', tagline: 'Find the tests that fail at random',
      accent: '#b790c0',
      blurb: 'Runs the suite repeatedly, diffs the failures, names each flake\'s cause class — and proves one fix.',
      tags: { code: 1 },
      params: [{ key: 'suite', label: 'Test suite / command', placeholder: 'e.g. npm test, or a specific dir', required: false, default: 'the test suite' }],
      task: 'Hunt the flaky tests in {suite}. Run the suite several times and diff the failures — a test that fails differently across runs is your target. For each flake, isolate its cause class: timing/race, shared state bleeding between tests, order dependence, or a real intermittent bug (that last one is gold, not noise — say so loudly). Rank the shortlist by how often each fires, give a concrete fix per test, and prove at least one fix by re-running before you report.',
      category: 'developer', gear: ['workbench', 'cabinet'], skills: ['systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'changelog-draft', name: 'Changelog Draft', emoji: '⊞', tagline: 'Turn commits into a readable changelog',
      intake: [
        { dimension: "audience", question: "Who reads it?", options: ["end users","developers"], recommended: "end users", reason: "decides vocabulary and what counts as a highlight" }
      ],
      accent: '#7bc88a',
      blurb: 'Reads the history AND the diffs — commit messages lie by omission — and writes it for humans.',
      tags: { code: 0.7, general: 0.3 },
      params: [{ key: 'range', label: 'Since', placeholder: 'e.g. the last release, or a tag/date', required: false, default: 'the last release' }],
      task: 'Draft a changelog covering changes since {range}. Read the actual commit history AND spot-check the diffs — commit messages lie by omission. Group into Added / Changed / Fixed with breaking changes clearly at the top, written for a reader who does not know the codebase. Lead with what users will actually notice. Cross-check anything that sounds important against the code itself, so the changelog never claims something that did not really ship.',
      category: 'developer', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'refactor-scout', name: 'Refactor Scout', emoji: '⌘', tagline: 'Find the code most worth cleaning up',
      intake: [
        { dimension: "scope", question: "Scout or clean?", options: ["scout + report","apply the safest cleanups"], recommended: "scout + report", reason: "applying changes code; scouting never does" }
      ],
      accent: '#b790c0',
      blurb: 'Maps the highest-leverage cleanups by payoff-vs-risk — only debt that pays rent, no cosmetic churn.',
      tags: { code: 1 },
      params: [{ key: 'area', label: 'Code area', placeholder: 'e.g. the auth module, or a file' }],
      task: 'Scout {area} for the refactors actually worth doing. Read the code and rank cleanups by payoff-versus-risk: duplication that keeps causing divergent fixes, functions doing three jobs, dead branches, abstractions leaking their internals. For each: what it costs today, the safe refactor shape, and how contained the blast radius is. Do NOT change anything — give me the map with a one-line rationale each so I can pick. Skip cosmetic churn; only debt that pays rent makes the list.',
      category: 'developer', gear: ['cabinet'], skills: ['simplify-code', 'codebase-inspection'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'error-log-triage', name: 'Error-Log Triage', emoji: '⚠', tagline: 'Cluster the noise into real incidents',
      accent: '#cf8a7d',
      blurb: 'Groups a wall of errors by root cause — the same bug wears five stack traces — and names today\'s chase.',
      tags: { code: 0.8, general: 0.2 },
      params: [{ key: 'logs', label: 'Error logs', placeholder: 'paste the logs — or point me at the log file' }],
      task: 'Triage these error logs:\n\n{logs}\n\nIf that is a file path, read the real file. Cluster by underlying cause, not by message text — the same bug often wears five different stack traces. For each cluster: how often it fires, how bad it is (crashing users vs logging noise), the most likely root cause read from the traces, and where in the code to look first. Lead with the ONE incident worth chasing today. Call out what is pure noise worth silencing at the logger, and any cluster that looks like it is growing.',
      category: 'developer', gear: ['cabinet'], skills: ['systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'onboard-codebase', name: 'Onboard a Codebase', emoji: '◱', tagline: 'Get oriented in unfamiliar code fast',
      accent: '#6fa8bf',
      blurb: 'Maps an unfamiliar repo by how it actually works — entry points, data flow, and where newcomers get bitten.',
      tags: { code: 0.7, research: 0.3 },
      params: [{ key: 'target', label: 'Repo / directory', placeholder: 'e.g. this repo, or a subfolder', required: false, default: 'this repository' }],
      task: 'Orient me in {target}. Read enough to map it honestly: the entry points, how data flows through it, where the core logic lives versus the plumbing, and the conventions the code actually follows — not what the README claims. Lead with a two-sentence "what this is", then the tour in reading order. End with the three files that teach the most per minute, and the one part of the system most likely to bite a newcomer.',
      category: 'developer', gear: ['cabinet'], skills: ['codebase-inspection'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'perf-pass', name: 'Performance Pass', emoji: '◈', tagline: 'Find where the time and memory go',
      intake: [
        { dimension: "scope", question: "Measure or fix?", options: ["measure + report","apply safe optimizations"], recommended: "measure + report", reason: "fixing mutates code; measuring never does" }
      ],
      accent: '#d9a85a',
      blurb: 'Measures before guessing, names the top bottlenecks with evidence, and estimates each win before selling it.',
      tags: { code: 1 },
      params: [{ key: 'target', label: 'What is slow', placeholder: 'e.g. a slow endpoint, a build step' }],
      task: 'Do a performance pass on {target}. Measure FIRST — profile it or instrument the hot code path; never optimize from vibes. Find where the time or memory actually goes, then report the top two bottlenecks with the evidence and the cheapest fix for each — including "stop doing that work at all" when it applies. Estimate the win before recommending each fix, and say plainly what is NOT worth optimizing so nobody burns a week on it later.',
      category: 'developer', gear: ['workbench', 'cabinet'], skills: ['node-inspect-debugger', 'systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'release-notes', name: 'Release Notes', emoji: '⊛', tagline: 'Write the notes users will read',
      intake: [
        { dimension: "audience", question: "Who reads the notes?", options: ["end users","developers"], recommended: "end users", reason: "decides vocabulary and what counts as a highlight" }
      ],
      accent: '#7bc88a',
      blurb: 'Leads with what users feel, spells out breaking changes exactly, and matches your past notes\' voice.',
      tags: { code: 0.5, general: 0.5 },
      params: [
        { key: 'version', label: 'Version', placeholder: 'e.g. 1.4.0' },
        { key: 'changes', label: 'What shipped', placeholder: 'paste the changelog / commit summary', required: false, default: 'the changes since the last release' }
      ],
      task: 'Write release notes for {version} from {changes}. Lead with the two or three changes a user actually FEELS, written as benefits, not commit prose. Then the fuller list grouped sensibly, then upgrade steps and breaking changes spelled out with exact before/after. Find our previous release notes if you can and match their voice, so the series reads consistent. Draft only — do not publish anything.',
      category: 'developer', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
