import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeeData, Interface, JsonRpcProvider, Network, Transaction, Wallet, ZeroAddress } from "ethers";
import type { WorkflowConfig } from "@agentfuel/pi-loop/workflow";
import { openHostedPlannerConnection } from "../src/autonomy-executor.js";
import { validateHostedGameExecutorConfig } from "../src/game-executor.js";
import { validateHostedConfig } from "../src/service.js";
import { HostedTaskExecutor, validateHostedTaskExecutorConfig, type HostedTaskExecutorConfig } from "../src/task-executor.js";
import type { HostedExecution } from "../src/types.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function taskConfig(directory: string): HostedTaskExecutorConfig {
  const workflow: WorkflowConfig = { agentId: "1", chainId: "42431", account: address(1), asset: "0x20c0000000000000000000000000000000000000", escrowAddress: address(2),
    tasks: [{ taskId: "1", problemId: "sum-integers", deadlineMs: Date.now() + 60000, creditLimit: "100" }], allowCredit: true, maxPrice: "100", deadlineMs: Date.now() + 60000,
    minRemainingMs: 100, maxCompletionTokens: 256, providers: [{ id: "controlled", payTo: address(3), relayUrl: "http://127.0.0.1:3010/v1/chat", service: "infercredit/solve-fixed", model: "pi-fixed-v1",
      routes: [{ tier: "cheap", price: "100", capabilities: ["python3-json-stdio", "sum-integers"], solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 2, maxCompletionTokens: 256 } }] }] };
  return { version: 1, identity: address(4), guardianKeyFile: join(directory, "guardian.key"), rpcUrlFile: join(directory, "rpc-url"), rpcTransport: "direct",
    publicRpcUrl: "https://rpc.moderato.tempo.xyz", walletDirectory: join(directory, "wallets"), arenaUrl: "http://127.0.0.1:3021", underwriterUrl: "http://127.0.0.1:3022",
    models: [{ id: "kimi-k2.6", physicalModels: { cheap: "controlled", strong: "controlled-strong" }, templates: { conservative: structuredClone(workflow), balanced: structuredClone(workflow), aggressive: structuredClone(workflow) } }] };
}

test("Tempo hosted configuration accepts TIP-20 and private RPC paths, rejects native gas grants and native settlement", () => {
  const config = taskConfig("/private/controlled");
  assert.equal(validateHostedTaskExecutorConfig(config).models[0].templates.balanced.chainId, "42431");
  assert.throws(() => validateHostedTaskExecutorConfig({ ...config, gasGrantWei: "1", gasSponsorBudgetWei: "2", gasSponsorKeyFile: config.guardianKeyFile }), /HOSTED_TEMPO_NATIVE_GAS_GRANT_UNSUPPORTED/);
  const native = structuredClone(config); for (const workflow of Object.values(native.models[0].templates)) workflow.asset = ZeroAddress;
  assert.throws(() => validateHostedTaskExecutorConfig(native), /HOSTED_TEMPO_TIP20_ASSET_REQUIRED/);
  assert.equal(validateHostedConfig({ directory: "/private/controlled", origin: "http://localhost:3020", chainId: "42431", models: [{ id: "kimi-k2.6", label: "Kimi" }],
    maxAgentsPerOwner: 2, maxPerRunBudgetRaw: "100", maxTotalBudgetRaw: "200" }).chainId, "42431");
  const game = { version: 1, chainId: "42431", identity: address(1), account: address(2), token: config.models[0].templates.balanced.asset,
    rpcUrlFile: config.rpcUrlFile, rpcTransport: "direct", sponsorKeyFile: config.guardianKeyFile, opponent: { binding: { chainId: "42431", agentId: "1", wallet: address(3) },
      keyFile: "/private/controlled/bot.key", modelId: "kimi-k2.6", strategy: "balanced" }, models: [{ id: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", keyFile: "/private/controlled/model.key" }],
    creditsDirectory: "/private/controlled/credits", walletDirectory: config.walletDirectory };
  assert.equal(validateHostedGameExecutorConfig(game).chainId, "42431");
  assert.throws(() => validateHostedGameExecutorConfig({ ...game, token: address(9) }), /HOSTED_GAME_ASSET_MISMATCH/);
  assert.throws(() => validateHostedGameExecutorConfig({ ...game, rpcUrlFile: undefined, publicRpcUrl: "https://rpc.moderato.tempo.xyz/private-key" }), /HOSTED_GAME_RPC_INVALID/);
});

test("Tempo provisioning ignores native gas balance and durably signs its estimated storage gas with chain 42431", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-tempo-hosted-")));
  const provider = new JsonRpcProvider("http://127.0.0.1:1");
  const config = taskConfig(directory), wallet = new Wallet(key(20));
  const bindings = new Interface(["function creditManager() view returns(address)", "function adapter() view returns(address)", "function settlementAsset() view returns(address)",
    "function taskEscrow() view returns(address)", "function agentAccount() view returns(address)", "function identity() view returns(address)"]);
  const results: Record<string, string> = { creditManager: address(5), adapter: address(6), settlementAsset: config.models[0].templates.balanced.asset,
    taskEscrow: address(2), agentAccount: address(1), identity: address(4) };
  let nativeReads = 0, estimates = 0; const broadcasts: string[] = [];
  provider.send = async method => { assert.equal(method, "eth_chainId"); return "0xa5bf"; };
  provider.getNetwork = async () => Network.from(42431);
  provider.call = async transaction => { const parsed = bindings.parseTransaction({ data: String(transaction.data) })!; return bindings.encodeFunctionResult(parsed.name, [results[parsed.name]]); };
  provider.getBalance = async () => { nativeReads++; return 0n; };
  provider.estimateGas = async () => { estimates++; return 1500000n; };
  provider.getFeeData = async () => new FeeData(1n, 2n, 1n);
  provider.getTransactionCount = async () => 0;
  provider.getTransactionReceipt = async () => null;
  provider.getTransaction = async () => null;
  provider.broadcastTransaction = async raw => { broadcasts.push(raw); throw new Error("controlled response loss"); };
  try {
    await writeFile(config.guardianKeyFile, key(1), { mode: 0o600 });
    const keyFile = join(directory, "actor.key"); await writeFile(keyFile, key(20), { mode: 0o600 });
    const agentId = randomUUID(), requestId = randomUUID(), input: HostedExecution = { directory: join(directory, "run"), keyFile, recover: false,
      agent: { id: agentId, owner: new Wallet(key(21)).address, wallet: wallet.address, name: "Controlled Tempo actor", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "200",
        allowCredit: true, spentRaw: "0", reservedRaw: "0", status: "Pending", createdAt: "now", updatedAt: "now" },
      run: { requestId, agentId, action: "provision", status: "Queued", reservedRaw: "0", chargedRaw: "0", recoverable: false, createdAt: "now", updatedAt: "now" } };
    const executor = new HostedTaskExecutor(config, { provider });
    const result = await executor.execute(input);
    assert.equal(result.reason, "HOSTED_TRANSACTION_UNCERTAIN"); assert.equal(nativeReads, 0); assert.equal(estimates, 1); assert.equal(broadcasts.length, 1);
    const journal = JSON.parse(await readFile(join(input.directory, "task-executor", "session.json"), "utf8"));
    const signed = Transaction.from(journal.transactions.register.raw);
    assert.equal(signed.chainId, 42431n); assert.equal(signed.gasLimit, 1800000n); assert.equal(signed.value, 0n); assert.equal(signed.to, config.identity);
    assert.equal(journal.transactions.register.raw, broadcasts[0]);
    const recovered = await executor.execute({ ...input, recover: true });
    assert.equal(recovered.reason, "HOSTED_TRANSACTION_UNCERTAIN"); assert.equal(estimates, 1); assert.equal(nativeReads, 0); assert.deepEqual(broadcasts, [broadcasts[0], broadcasts[0]]);
  } finally { provider.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("Tempo autonomous planner binds its configured chain and releases the RPC transport", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0xa5bf" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const connection = await openHostedPlannerConnection(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "42431", "direct");
  try { assert.equal((await connection.provider.getNetwork()).chainId, 42431n); assert.equal(await connection.provider.send("eth_chainId", []), "0xa5bf"); }
  finally { connection.close(); assert.equal(connection.provider.destroyed, true); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
