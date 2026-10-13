import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import { readHostedFinance, type HostedFinanceObservation } from "../services/hosted-agents/src/finance-reader.js";
import { validateHostedFinance } from "../services/hosted-agents/src/finance-projection.js";
import { validateHostedConfig } from "../services/hosted-agents/src/service.js";
import { validateHostedTaskExecutorConfig } from "../services/hosted-agents/src/task-executor.js";
import type { HostedAgent } from "../services/hosted-agents/src/types.js";
import { journalDiagnostic } from "./demo-common.js";

function fail(code: string): never { throw new Error(code); }
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

/** Reads configuration and the selected existing agent; never loads role/custody keys or opens a state writer. */
export async function runTempoFinanceProbe(runtime: string, label: string, dependencies: {
  reader?: typeof readHostedFinance; output?: (event: Record<string, unknown>) => void;
} = {}) {
  if (!["cheap", "strong", "autonomy"].includes(label)) fail("TEMPO_FINANCE_PROBE_LABEL_INVALID");
  const directory = resolve(runtime), ready = await json(join(directory, "ready.json"));
  if (ready.chainId !== "42431") fail("TEMPO_FINANCE_PROBE_CHAIN_INVALID");
  const daemon = await json(ready.hostedConfigFile), hosted = validateHostedConfig(daemon.hosted);
  if (hosted.chainId !== "42431") fail("TEMPO_FINANCE_PROBE_CHAIN_INVALID");
  // Pure validation deliberately avoids loadHostedTaskExecutorConfig, which reads operator keys.
  const config = validateHostedTaskExecutorConfig(await json(daemon.executor.taskConfigFile));
  const acceptance = await json(join(directory, "acceptance.json")), selected = acceptance.agents?.[label]?.agent;
  if (acceptance.chainId !== "42431" || !selected?.id || !selected?.wallet) fail("TEMPO_FINANCE_PROBE_AGENT_REQUIRED");
  const database = await json(join(hosted.directory, "database", "session.json"));
  const binding = createHash("sha256").update(JSON.stringify({ origin: hosted.origin, chainId: hosted.chainId })).digest("hex");
  if (database.version !== 1 || database.configBinding !== binding) fail("TEMPO_FINANCE_PROBE_DATABASE_BINDING_INVALID");
  const agent = (database.agents as HostedAgent[]).find(candidate => candidate.id === selected.id);
  if (!agent?.binding || agent.binding.chainId !== "42431" || getAddress(agent.wallet) !== getAddress(selected.wallet)
    || getAddress(agent.binding.wallet) !== getAddress(agent.wallet)) fail("TEMPO_FINANCE_PROBE_AGENT_BINDING_INVALID");
  const output = dependencies.output ?? (event => console.log(JSON.stringify(event))), startedAt = performance.now();
  const observer = (event: HostedFinanceObservation) => output({ readOnly: true, label, ...event });
  const result = await (dependencies.reader ?? readHostedFinance)(config, agent, { observer });
  const finance = validateHostedFinance(result, agent, "42431");
  const report = { readOnly: true, label, chainId: "42431", agentId: agent.binding.agentId, elapsedMs: Math.round(performance.now() - startedAt), finance };
  output(report); return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || !process.argv[3] || process.argv.length !== 4) fail("TEMPO_FINANCE_PROBE_USAGE");
    const report = await runTempoFinanceProbe(process.argv[2], process.argv[3]);
    if (report.finance.status !== "confirmed") process.exitCode = 1;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{1,100}$/.test((error as Error)?.message) ? (error as Error).message : "TEMPO_FINANCE_PROBE_FAILED";
    console.error(JSON.stringify({ readOnly: true, code, ...journalDiagnostic(error) })); process.exitCode = 1;
  }
}
