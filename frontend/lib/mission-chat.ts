import type { HostedRun } from './hosted-client';
import { tabbyScene } from './tabby-scenes';
/** Presentation derives only from public, persisted mission facts. */
export function missionChatState(run: HostedRun, history = false, disconnected = false) {
  const view = run.mission ?? run.result?.mission;
  const delivered = run.status === 'Succeeded' && run.result?.success !== false && view?.stage === 'completed' && view.review?.passed !== false;
  const live = !history && !disconnected && !run.stopRequested && ['Running', 'Queued'].includes(run.status) && !['needs-input', 'paused', 'cancelled', 'completed'].includes(view?.stage ?? '');
  const label = disconnected ? '连接中断 · 保留已确认内容' : tabbyScene(run, {history}).label;
  return {view, delivered, live, label, completedPhases: view?.phases.filter(p => !!p.output).length ?? 0};
}
