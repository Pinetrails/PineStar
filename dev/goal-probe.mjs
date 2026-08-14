/* dev/goal-probe.mjs — one-off: why does a confirmed goal not reach the track? Dev-only. */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.SKYNET_PORT || '8745';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9797);

const PROBE = `(async () => {
  StationUI.openTerm('quests');
  await new Promise(r => setTimeout(r, 2000));
  const goal = GoalStore.confirm({ id: null, text: 'Launch StarNet to my first 100 users' },
    ['Write the launch announcement', 'Record a 60-second demo', 'Line up ten beta testers', 'Ship the v1 installer']);
  await new Promise(r => setTimeout(r, 400));
  const gq = GoalStore.quests();
  const active = GoalStore.activeGoal();
  const view = QuestStore.view();
  const arcInView = view.quests.filter(q => /^arc-/.test(q.kind));
  const visible = (typeof QuestStateStore !== 'undefined' && QuestStateStore.visible)
    ? QuestStateStore.visible(view.quests).filter(q => /^arc-/.test(q.kind)) : null;
  return JSON.stringify({
    confirmed: !!goal, goalId: goal && goal.id, milestones: goal && goal.milestones.length,
    activeGoal: active ? active.id : null,
    goalStoreQuests: gq.length, goalStoreKinds: gq.map(q => q.kind),
    arcInQuestStoreView: arcInView.length,
    arcAfterVisibleFilter: visible ? visible.length : 'no-store'
  });
})()`;

(async () => {
  const { proc } = launchChrome({ cdpPort: CDP_PORT, win: '1200,900', profileDir: join(HERE, '.shots-goal-track', '_probe') });
  try {
    await sleep(1800);
    const cdp = await connectCDP(CDP_PORT);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 200);' });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT });
    await sleep(9000);
    console.log('probe ->', await evalJS(cdp, PROBE));
  } finally { try { proc.kill(); } catch (_) {} }
})();
