import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, JsonRpcProvider, Wallet, type Block } from "ethers";
import type { WorkflowConfig } from "@agentfuel/pi-loop/workflow";
import { readHostedFinance, type HostedFinanceObservation } from "../src/finance-reader.js";
import type { HostedTaskExecutorConfig } from "../src/task-executor.js";
import type { HostedAgent } from "../src/types.js";
import { runTempoFinanceProbe } from "../../../scripts/tempo-finance-probe.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
function fixture(directory = "/private/controlled") {
  const wallet = new Wallet(`0x${"14".padStart(64, "0")}`).address, asset = "0x20c0000000000000000000000000000000000000";
  const workflow: WorkflowConfig = { chainId: "42431", agentId: "1", account: address(1), asset, escrowAddress: address(2), tasks: [], allowCredit: true,
    maxPrice: "100", deadlineMs: Date.now() + 60000, minRemainingMs: 100, maxCompletionTokens: 256, providers: [{ id: "controlled", payTo: address(7),
      relayUrl: "http://127.0.0.1:3010/v1/chat", service: "infercredit/solve-fixed", model: "pi-fixed-v1", routes: [{ tier: "cheap", price: "100", capabilities: ["python3-json-stdio"],
        solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 2, maxCompletionTokens: 256 } }] }] };
  const config: HostedTaskExecutorConfig = { version: 1, identity: address(3), guardianKeyFile: join(directory, "must-not-read-guardian.key"), rpcUrlFile: join(directory, "must-not-read-rpc-url"),
    rpcTransport: "direct", publicRpcUrl: "https://rpc.moderato.tempo.xyz", walletDirectory: join(directory, "wallets"), arenaUrl: "http://127.0.0.1:3011", underwriterUrl: "http://127.0.0.1:3012",
    models: [{ id: "kimi-k2.6", physicalModels: { cheap: "controlled", strong: "controlled-strong" }, templates: { conservative: workflow, balanced: structuredClone(workflow), aggressive: structuredClone(workflow) } }] };
  const agent: HostedAgent = { id: "1ae67a98-87d2-433a-9559-6f2101478599", owner: address(8), wallet, name: "Controlled", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "100",
    totalBudgetRaw: "200", allowCredit: true, spentRaw: "0", reservedRaw: "0", status: "Ready", createdAt: "now", updatedAt: "now", binding: { chainId: "42431", agentId: "1", wallet } };
  const snapshot = { agentId: "1", configuration: { chainId: "42431", settlementAsset: asset, assetDecimals: "6" },
    addresses: { account: address(1), escrow: address(2), identity: address(3), manager: address(4), adapter: address(5), reputation: address(6) },
    identity: { owner: wallet, wallet, version: "1" }, terms: { feeBps: "1500", score: "570", tier: "C" }, truth: { repayment: "1", default: "0" },
    mirror: { repayment: "1", success: "1", default: "0" }, tierCap: "150000", eligible: true, rejection: null, block: { number: 7, hash: `0x${"a".repeat(64)}`, timestamp: 1000 } };
  const abi = new Interface(["function creditManager() view returns(address)", "function adapter() view returns(address)", "function settlementAsset() view returns(address)",
    "function cash(uint256) view returns(uint256)", "function getPolicy(uint256) view returns(tuple(uint256 maxCashPerTx,uint256 maxDebtPerTx,uint256 maxDebtPerDay,bool ownerFrozen))",
    "function nextTaskId() view returns(uint256)", "function decimals() view returns(uint8)", "function agentAccount() view returns(address)", "function taskEscrow() view returns(address)",
    "function identity() view returns(address)", "function reputation() view returns(address)", "function resolveAgent(uint256) view returns(address owner,address wallet)",
    "function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))",
    "function getLoan(uint256) view returns(tuple(uint256 agentId,uint256 principal,uint256 fee,uint256 loanDueAt,uint8 status))"]);
  const provider = new JsonRpcProvider("http://127.0.0.1:1"), calls: { method: string; id?: number; block?: unknown }[] = [];
  provider.send = async method => { assert.equal(method, "eth_chainId"); calls.push({ method }); return "0xa5bf"; };
  provider.getBlock = async block => { assert.equal(block, 7); calls.push({ method: "block", block }); return snapshot.block as unknown as Block; };
  provider.call = async transaction => {
    const parsed = abi.parseTransaction({ data: String(transaction.data) })!, method = parsed.name, id = parsed.args.length ? Number(parsed.args[0]) : undefined;
    calls.push({ method, id, block: transaction.blockTag }); assert.equal(transaction.blockTag, 7);
    const simple: Record<string, unknown[]> = { creditManager: [address(4)], adapter: [address(5)], settlementAsset: [asset], cash: [58000n],
      getPolicy: [[100n, 100n, 200n, false]], nextTaskId: [9n], decimals: [6n], agentAccount: [address(1)], taskEscrow: [address(2)], identity: [address(3)], reputation: [address(6)], resolveAgent: [wallet, wallet] };
    const own = [1, 3, 5].includes(id ?? 0), status = id === 1 || id === 5 ? 1 : id === 3 ? 2 : 0;
    const values = method === "getTask" ? [[address(9), 150000n, 0n, own ? 1n : 2n, 2000n, 0n, 1n]]
      : method === "getLoan" ? [[own ? 1n : 0n, id === 5 ? 20n : 10n, id === 5 ? 3n : 2n, 2000n, BigInt(status)]] : simple[method];
    return abi.encodeFunctionResult(method, values);
  };
  const fetcher = (async (_url, options) => { assert.equal(options?.method, undefined); return Response.json(snapshot); }) as typeof fetch;
  return { config, agent, snapshot, provider, calls, fetcher };
}

test("finance observations preserve same-block full eight-task debt scanning and final canonical checks without adding public fields", async () => {
  const f = fixture(), events: HostedFinanceObservation[] = [];
  try {
    const finance = await readHostedFinance(f.config, f.agent, { provider: f.provider, fetcher: f.fetcher, observer: event => { events.push(event); } });
    assert.equal(finance.status, "confirmed"); if (finance.status !== "confirmed") throw new Error("EXPECTED_CONFIRMED");
    assert.equal(finance.scannedTaskCount, 8); assert.equal(finance.ownedTaskCount, 3); assert.equal(finance.debtRaw, "35"); assert.equal(finance.cashRaw, "58000");
    assert.deepEqual(f.calls.filter(call => call.method === "getTask").map(call => call.id).sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(f.calls.filter(call => call.method === "getLoan").map(call => call.id).sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(f.calls.filter(call => call.method === "eth_chainId").length, 2); assert.equal(f.calls.filter(call => call.method === "block").length, 2);
    assert.deepEqual(events.filter(event => event.phase === "complete").map(event => event.stage), ["network", "underwriter", "snapshot", "account", "bindings", "ledger", "final", "total"]);
    assert.equal(events.find(event => event.stage === "underwriter" && event.phase === "complete")?.httpStatus, 200);
    assert.equal(events.find(event => event.stage === "ledger" && event.phase === "complete")?.scannedTaskCount, 8);
    assert.ok(events.every(event => event.elapsedMs >= 0 && event.totalElapsedMs >= 0));
    assert.equal("observations" in finance, false); assert.equal("stages" in finance, false);
  } finally { f.provider.destroy(); }
});

test("observer errors cannot change finance failure and private RPC errors emit only safe stage codes and HTTP status", async () => {
  const f = fixture(), events: HostedFinanceObservation[] = [];
  try {
    const unavailable = await readHostedFinance(f.config, f.agent, { provider: f.provider,
      fetcher: (async () => Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 })) as typeof fetch,
      observer: event => { events.push(event); if (event.phase === "start") return Promise.reject(new Error("PRIVATE_OBSERVER_ERROR")); throw new Error("PRIVATE_OBSERVER_ERROR"); } });
    assert.equal(unavailable.status, "unavailable"); if (unavailable.status === "unavailable") assert.equal(unavailable.reason, "HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE");
    assert.equal(events.find(event => event.stage === "underwriter" && event.phase === "failed")?.httpStatus, 503);
    assert.equal(events.at(-1)?.code, "HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE");
    events.length = 0;
    f.provider.call = async () => { throw Object.assign(new Error("https://private.invalid/secret-token Authorization: secret-key"),
      { code: "SERVER_ERROR", info: { responseStatus: "429 Too Many Requests" } }); };
    const limited = await readHostedFinance(f.config, f.agent, { provider: f.provider, fetcher: f.fetcher, observer: event => { events.push(event); } });
    assert.equal(limited.status, "unavailable"); assert.equal(events.find(event => event.stage === "account" && event.phase === "failed")?.httpStatus, 429);
    assert.equal(events.at(-1)?.code, "SERVER_ERROR");
    for (const secret of ["private.invalid", "secret-token", "Authorization", "secret-key", "PRIVATE_OBSERVER_ERROR"]) assert.equal(JSON.stringify(events).includes(secret), false);
    events.length = 0;
    await readHostedFinance(f.config, f.agent, { provider: f.provider, fetcher: (async () => { throw new DOMException("private timeout URL", "TimeoutError"); }) as typeof fetch,
      observer: event => { events.push(event); } });
    assert.equal(events.find(event => event.stage === "underwriter" && event.phase === "failed")?.code, "TIMEOUT");
    assert.equal("rpcCode" in events.at(-1)!, false, "DOMException code 23 is not an RPC code");
  } finally { f.provider.destroy(); }
});

test("finance CLI probe selects the existing database agent without reading role keys or rewriting runtime files", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-finance-probe-"))), f = fixture(directory);
  try {
    const hostedDirectory = join(directory, "hosted"), hosted = { directory: hostedDirectory, origin: "http://localhost:3028", chainId: "42431", models: [{ id: "kimi-k2.6", label: "Controlled" }],
      maxAgentsPerOwner: 2, maxPerRunBudgetRaw: "100", maxTotalBudgetRaw: "200" };
    await mkdir(join(hostedDirectory, "database"), { recursive: true });
    const values: Record<string, unknown> = { "ready.json": { chainId: "42431", hostedConfigFile: join(directory, "hosted.json") },
      "hosted.json": { hosted, executor: { taskConfigFile: join(directory, "task.json") } }, "task.json": f.config,
      "acceptance.json": { chainId: "42431", agents: { cheap: { agent: { id: f.agent.id, wallet: f.agent.wallet } } } },
      "hosted/database/session.json": { version: 1, configBinding: createHash("sha256").update(JSON.stringify({ origin: hosted.origin, chainId: hosted.chainId })).digest("hex"), agents: [f.agent] } };
    for (const [file, value] of Object.entries(values)) await writeFile(join(directory, file), JSON.stringify(value), { mode: 0o600 });
    const files = async () => Object.fromEntries(await Promise.all((await readdir(directory, { recursive: true })).sort().map(async file => {
      const path = join(directory, file), metadata = await stat(path, { bigint: true }); return [file, metadata.isFile() ? { bytes: await readFile(path), mtimeNs: metadata.mtimeNs } : null];
    })));
    const before = await files(), output: Record<string, unknown>[] = [];
    const report = await runTempoFinanceProbe(directory, "cheap", { output: event => { output.push(event); }, reader: async (config, agent, dependencies) => {
      assert.equal(config.guardianKeyFile, f.config.guardianKeyFile); assert.equal(agent.id, f.agent.id);
      dependencies?.observer?.({ stage: "underwriter", phase: "failed", elapsedMs: 1, totalElapsedMs: 1, httpStatus: 503, code: "HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE" });
      return { status: "unavailable", observedAt: new Date().toISOString(), reason: "HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE" };
    } });
    assert.equal(report.agentId, "1"); assert.equal(report.finance.status, "unavailable"); assert.equal(output.length, 2);
    assert.deepEqual(await files(), before);
    for (const secret of [directory, "must-not-read-guardian.key", "must-not-read-rpc-url", f.config.underwriterUrl]) assert.equal(JSON.stringify(output).includes(secret), false);
  } finally { f.provider.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("Tempo finance has 60s Underwriter and 120s total budgets while Monad and local retain their existing deadlines", async () => {
  const originalAbortTimeout = AbortSignal.timeout, originalTimer = globalThis.setTimeout;
  let httpTimeout = 0; const timers: number[] = [];
  AbortSignal.timeout = milliseconds => { httpTimeout = milliseconds; return new AbortController().signal; };
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], milliseconds: number, ...args: unknown[]) => {
    timers.push(milliseconds); return originalTimer(callback, milliseconds, ...args);
  }) as typeof setTimeout;
  try {
    for (const [chainId, httpMs, totalMs] of [["42431", 60000, 120000], ["10143", 30000, 45000], ["31337", 10000, 45000]] as const) {
      const f = fixture();
      try {
        for (const workflow of Object.values(f.config.models[0].templates)) workflow.chainId = chainId;
        f.agent.binding!.chainId = chainId; f.snapshot.configuration.chainId = chainId;
        f.provider.send = async () => `0x${BigInt(chainId).toString(16)}`;
        timers.length = 0;
        const finance = await readHostedFinance(f.config, f.agent, { provider: f.provider, fetcher: f.fetcher });
        assert.equal(finance.status, "confirmed"); assert.equal(httpTimeout, httpMs); assert.ok(timers.includes(totalMs));
      } finally { f.provider.destroy(); }
    }
  } finally { AbortSignal.timeout = originalAbortTimeout; globalThis.setTimeout = originalTimer; }
});

test("overall finance deadline remains distinct from the Underwriter HTTP timeout and never returns partial balances", async () => {
  const originalTimer = globalThis.setTimeout, f = fixture(), events: HostedFinanceObservation[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], milliseconds: number, ...args: unknown[]) =>
    originalTimer(callback, milliseconds === 120000 ? 0 : milliseconds, ...args)) as typeof setTimeout;
  try {
    const finance = await readHostedFinance(f.config, f.agent, { provider: f.provider, fetcher: (async () => new Promise<Response>(() => {})) as typeof fetch,
      observer: event => { events.push(event); } });
    assert.equal(finance.status, "unavailable"); if (finance.status === "unavailable") assert.equal(finance.reason, "HOSTED_FINANCE_TIMEOUT");
    assert.equal(events.find(event => event.stage === "underwriter" && event.phase === "failed")?.code, "HOSTED_FINANCE_TIMEOUT");
    assert.equal(events.at(-1)?.code, "HOSTED_FINANCE_TIMEOUT"); assert.equal("httpStatus" in events.at(-1)!, false);
    assert.equal("cashRaw" in finance, false); assert.equal("debtRaw" in finance, false);
  } finally { globalThis.setTimeout = originalTimer; f.provider.destroy(); }
});
