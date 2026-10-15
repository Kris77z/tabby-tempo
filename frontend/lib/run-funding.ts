import type { HostedCapabilities, HostedRun } from "./hosted-client";
/** Old autonomous journals predate fundingNeed. Only the legacy executor (no
 * games capability) admits their cash top-up; explicit reward funding wins. */
export function pausedRunFunding(run: HostedRun | undefined, capabilities?: HostedCapabilities): "cash" | "reward-tokens" | undefined {
  if (run?.status !== "Paused") return;
  if (run.fundingNeed) return run.fundingNeed;
  if (run.reason !== "INFERENCE_FUNDING_REQUIRED") return;
  if (run.action === "reward-task") return "reward-tokens";
  if (["goal", "metered-task"].includes(run.action) || run.action === "autonomous" && !capabilities?.autonomy?.games) return "cash";
}
