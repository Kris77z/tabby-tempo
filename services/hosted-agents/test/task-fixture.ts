import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Wallet } from "ethers";
import { createWorkflowFixture, GOOD_CODE } from "../../../packages/pi-loop/test/workflow-fixture.js";
import { key, tx } from "../../underwriter/test/fixture.js";
import type { WorkflowConfig } from "@agentfuel/pi-loop/workflow";
import { HostedTaskExecutor, type HostedTaskExecutorConfig } from "../src/task-executor.js";
import type { HostedAgent, HostedExecution, HostedStrategy } from "../src/types.js";

/** Controlled models, own Anvil and independent Arena; catalog assignments resolve actual chain Agent IDs. */
export async function createHostedTaskFixture(directory: string) {
  const fx = await createWorkflowFixture(directory, [{ problemId: "sum-integers", open: true, agentId: null }, { problemId: "unique-sorted", open: true, agentId: null }]);
  const guardianKeyFile = join(directory, "guardian.key"), rpcUrlFile = join(directory, "rpc-url");
  await writeFile(guardianKeyFile, key(1), { mode: 0o600 }); await writeFile(rpcUrlFile, fx.local.rpc, { mode: 0o600 });
  const base = structuredClone(fx.config); base.deadlineMs = Date.now() + 240000;
  const strong = structuredClone(base);
  strong.providers[0].routes[0].tier = "strong"; strong.providers[0].routes[0].solve.tiers = ["strong"];
  strong.providers[0].routes[0].solve.maxRounds = 1;
  const templates = (value: WorkflowConfig) => Object.fromEntries(["conservative", "balanced", "aggressive"].map(strategy => [strategy, structuredClone(value)])) as Record<HostedStrategy, WorkflowConfig>;
  const config: HostedTaskExecutorConfig = { version: 1, identity: await fx.f.identity.getAddress(), guardianKeyFile, initialCashRaw: "40000",
    rpcUrlFile, rpcTransport: "direct", publicRpcUrl: fx.local.rpc, walletDirectory: join(directory, "wallets"), arenaUrl: fx.options.arenaUrl, underwriterUrl: fx.options.underwriterUrl,
    models: [{ id: "cheap", physicalModels: { cheap: "controlled-cheap", strong: "controlled-strong" }, templates: templates(base) },
      { id: "strong", physicalModels: { cheap: "controlled-cheap", strong: "controlled-strong" }, templates: templates(strong) }], timeoutMs: 5000, pollTimeoutMs: 20000 };
  const executor = new HostedTaskExecutor(config, { provider: fx.f.provider });
  const actor = async (index: number, modelId = "cheap", funds = 40000n) => {
    const wallet = new Wallet(key(index)); await fx.f.provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
    if (funds) { fx.f.admin.reset(); await tx(fx.f.token!, fx.f.admin, "mint", [wallet.address, funds]); }
    const keyFile = join(directory, `actor-${index}.key`); await writeFile(keyFile, key(index), { mode: 0o600 });
    const now = new Date().toISOString();
    const agent: HostedAgent = { id: randomUUID(), owner: new Wallet(key(40 + index)).address, wallet: wallet.address, name: `Actor ${index}`, modelId, strategy: "balanced",
      perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: true, createdAt: now, updatedAt: now, status: "Pending", spentRaw: "0", reservedRaw: "0" };
    const input = (action: "provision" | "deposit" | "task", overrides: Partial<HostedAgent> = {}): HostedExecution => {
      const requestId = randomUUID(), selected = { ...structuredClone(agent), ...overrides };
      return { agent: selected, run: { requestId, agentId: agent.id, action, status: "Queued", createdAt: now, updatedAt: now, reservedRaw: action === "task" ? selected.perRunBudgetRaw : "0", chargedRaw: "0", recoverable: false },
        directory: join(directory, "actors", agent.id, "runs", requestId), keyFile, recover: false };
    };
    return { agent, keyFile, wallet, input };
  };
  return { fx, config, executor, actor, GOOD_CODE, close: fx.close };
}
