import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet } from "ethers";
import { HostedService } from "../src/service.js";
import type { HostedConfig, HostedExecutor } from "../src/types.js";

async function files(directory: string) {
  const result: Record<string, { bytes: Buffer; mtimeNs: bigint }> = {};
  for (const name of (await readdir(directory, { recursive: true })).sort()) {
    const path = join(directory, name), metadata = await stat(path, { bigint: true });
    if (metadata.isFile()) result[name] = { bytes: await readFile(path), mtimeNs: metadata.mtimeNs };
  }
  return result;
}

test("Tempo recovery rejects a persisted Monad hosted database without dispatch or rewriting database and custody wallets", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-tempo-isolation-")));
  const config: HostedConfig = { directory, origin: "http://localhost:3020", chainId: "10143", models: [{ id: "kimi-k2.6", label: "Controlled model" }],
    maxAgentsPerOwner: 2, maxPerRunBudgetRaw: "100", maxTotalBudgetRaw: "200" };
  let sourceDispatches = 0, tempoDispatches = 0;
  const sourceExecutor: HostedExecutor = { async execute(input) {
    sourceDispatches++;
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0",
      binding: { chainId: "10143", agentId: "7", wallet: input.agent.wallet } };
    throw new Error("CONTROLLED_MONAD_EXECUTION_UNKNOWN");
  } };
  const tempoExecutor: HostedExecutor = { async execute() { tempoDispatches++; throw new Error("MUST_NOT_DISPATCH_FOREIGN_STATE"); } };
  let source: HostedService | undefined, unexpected: HostedService | undefined;
  try {
    source = await HostedService.open(config, sourceExecutor);
    const owner = Wallet.createRandom().address, agent = await source.create(owner, { requestId: randomUUID(), name: "Persisted Monad agent", modelId: "kimi-k2.6",
      strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "200", allowCredit: true });
    await source.waitUntilIdle();
    const requestId = randomUUID(); await source.command(owner, agent.id, { action: "task", requestId }); await source.waitUntilIdle();
    const view = await source.snapshot(owner);
    assert.equal(view.agents[0].binding?.chainId, "10143");
    assert.equal(view.runs.find(run => run.requestId === requestId)?.recoverable, true);
    assert.equal(sourceDispatches, 2);
    await source.close(); source = undefined;
    const before = await files(directory), walletFile = join("agents", agent.id, "wallet.key");
    assert.equal(new Wallet(before[walletFile].bytes.toString().trim()).address, agent.wallet);
    assert.equal(JSON.parse(before[join("database", "session.json")].bytes.toString()).agents[0].binding.chainId, "10143");
    await assert.rejects(async () => { unexpected = await HostedService.open({ ...config, chainId: "42431" }, tempoExecutor, { recover: true }); },
      /^Error: HOSTED_CONFIG_BINDING_CHANGED$/);
    assert.equal(tempoDispatches, 0); assert.equal(sourceDispatches, 2);
    assert.deepEqual(await files(directory), before, "foreign-chain recovery must not create or rewrite persisted state or wallet files");
  } finally { await source?.close(); await unexpected?.close(); await rm(directory, { recursive: true, force: true }); }
});
