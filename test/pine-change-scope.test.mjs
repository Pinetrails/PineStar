import A from './_assert.js';
import { analyzeScope } from '../scripts/pine-change-scope.mjs';

const clear = analyzeScope({ changeId: 'PS-2026-020', intent: 'add change scope detector', files: [
  { path: 'scripts/pine-change-scope.mjs', additions: 80, deletions: 0 },
  { path: 'test/pine-change-scope.test.mjs', additions: 20, deletions: 0 },
  { path: 'docs/change-records/PS-2026-020.md', additions: 30, deletions: 0 }
] });
A.eq(clear.disposition, 'CLEAR', 'coherent implementation, test, and change record are clear');
A.eq(clear.totals.additions, 130, 'churn totals are deterministic');

const review = analyzeScope({ intent: 'fix objective cancellation', files: [
  { path: 'sidecar/objective-store.js', additions: 8, deletions: 2 },
  { path: 'frontend/world.js', additions: 900, deletions: 0 },
  { path: 'package.json', additions: 1, deletions: 0 },
  { path: 'native/src/main.rs', additions: 2, deletions: 2 },
  { path: 'scripts/build.mjs', additions: 4, deletions: 0 }
] });
A.eq(review.disposition, 'REVIEW', 'mixed broad work produces an advisory review');
A.ok(review.signals.likelyCreep.some(x => x.path === 'frontend/world.js'), 'unrelated path is surfaced without claiming proof');
A.eq(review.signals.dependencyFiles, ['package.json'], 'manifest edits receive a dedicated signal');
A.eq(review.signals.broadSubsystemChange, true, 'cross-subsystem breadth is visible');
A.eq(review.signals.highChurn, true, 'large churn is visible');
A.ok(/cannot prove/.test(review.caveat), 'report states the heuristic limit');
A.report('pine-change-scope.test');
