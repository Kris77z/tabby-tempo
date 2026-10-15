import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedAutonomyExecutor, validateHostedAutonomyConfig, openHostedPlannerConnection, createHostedPlannerRequest, reconcileHostedPlannerPayment, type HostedAutonomyConfig } from "../src/autonomy-executor.js";
import { Interface, keccak256, toUtf8Bytes, Wallet, type JsonRpcProvider } from "ethers";
import { accountInterface, managerInterface, EMPTY_AUTH, requestDigest, paymentId, canonical, type PaymentHandle, type Json } from "@agentfuel/sdk";
import {validateHostedActivity as importedValidate} from "../src/scene-types.js";
import type { AutonomyContext } from "../../../packages/pi-loop/src/autonomy.js";
import type { HostedExecution, HostedFinance } from "../src/types.js";
import { HostedError } from "../src/types.js";
import type { HostedTaskExecutor } from "../src/task-executor.js";

const config: HostedAutonomyConfig = { maxTasks: 2, maxDecisions: 3, durationMs: 60000, plannerRelayUrl: "http://127.0.0.1:3010/v1/chat",
  plannerProvider: "0x1111111111111111111111111111111111111111", plannerPriceRaw: "10", plannerService: "planner", plannerModel: "cheap", plannerPhysicalModel: "physical-planner-v1" };
const finance: HostedFinance = { status: "confirmed", observedAt: new Date().toISOString(), chainId: "31337", agentId: "1", wallet: config.plannerProvider,
  block: { number: 1, hash: "0x01", timestamp: 1 }, cashRaw: "500", debtRaw: "20", scannedTaskCount: 2, ownedTaskCount: 0,
  credit: { score: "10", tier: "A", tierCapRaw: "500", feeBps: "100", eligible: true, rejection: null },
  policy: { maxCashPerTxRaw: "100", maxDebtPerTxRaw: "200", maxDebtPerDayRaw: "300", ownerFrozen: false },
  counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
function input(directory: string): HostedExecution { return { directory, keyFile: "/private/test-key", recover: false,
  agent: { id: "agent", owner: "owner", wallet: config.plannerProvider, name: "Agent", modelId: "cheap", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "500", allowCredit: true,
    spentRaw: "0", reservedRaw: "250", activeRequestId: "parent", status: "Ready", createdAt: "now", updatedAt: "now", binding: { chainId: "31337", agentId: "1", wallet: config.plannerProvider } },
  run: { requestId: "parent", agentId: "agent", action: "autonomous" as HostedExecution["run"]["action"], status: "Running", createdAt: "now", updatedAt: "now", reservedRaw: "250", chargedRaw: "0", recoverable: true } }; }
function task(execute: HostedTaskExecutor["execute"], read: () => Promise<HostedFinance> = async () => structuredClone(finance)) {
  const models = ["cheap", "strong"].map(id => ({ id, templates: { balanced: { tasks: [{ creditLimit: "200" }], providers: [{ routes: [{ solve: { tiers: [id] } }] }] } } }));
  return { config: { metered: { priceRaw: "80", creditsRaw: "200000", catalog: [
    { id: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
    { id: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" }] }, models }, finance: read, execute } as unknown as HostedTaskExecutor;
}
async function fixture(work: (directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), "af-hosted-autonomy-")); try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); } }

const automaticGames: NonNullable<HostedAutonomyConfig["games"]> = { maxGames: 2, maxSpendPerGameRaw: "0", rewardKinds: ["usdc", "llm-credits"], rewardTaskMinTokens: 100 };
function rewardAdapter(execute: HostedTaskExecutor["execute"], read: () => Promise<HostedFinance>) {
  const adapter = task(execute, read); adapter.config.models[0].id = "kimi-k2.6"; return adapter;
}
const rewardView = (availableTokens: number) => ({ modelId: "kimi-k2.6", availableTokens, blocked: false });
const noCredit = (cashRaw: string): HostedFinance => ({ ...structuredClone(finance), cashRaw, debtRaw: "0", credit: { ...finance.credit, eligible: false } });

function catalogObservation(adapter: HostedTaskExecutor, count = 1) {
  const account = `0x${"2".repeat(40)}`, escrow = `0x${"3".repeat(40)}`, manager = `0x${"4".repeat(40)}`;
  const deadline = Math.floor(Date.now() / 1000) + 600, block = { number: 5, hash: `0x${"ab".repeat(32)}`, timestamp: Math.floor(Date.now() / 1000) };
  for (const model of adapter.config.models) Object.assign(model.templates.balanced, { chainId: "31337", account, escrowAddress: escrow,
    deadlineMs: deadline * 1000, minRemainingMs: 100, tasks: Array.from({ length: count }, (_, index) => ({ taskId: String(index + 1), problemId: "sum-integers", deadlineMs: deadline * 1000, creditLimit: "200" })),
    providers: [{ routes: [{ capabilities: ["python3-json-stdio", "sum-integers"], solve: { tiers: ["cheap"] } }] }] });
  const escrowInterface = new Interface(["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"]);
  const managerAbi = new Interface(["function agentAccount() view returns(address)", "function taskEscrow() view returns(address)",
    "function getLoan(uint256) view returns(tuple(uint256 agentId,uint256 principal,uint256 fee,uint256 loanDueAt,uint8 status))"]);
  const state = { fail: false, reorg: false, chainId: "0x7a69", taskReads: 0, statuses: Array.from({ length: count }, () => 1n) };
  const provider = { send: async () => state.chainId, getBlock: async () => ({ ...block, hash: state.reorg ? `0x${"ff".repeat(32)}` : block.hash }),
    call: async ({ to, data, blockTag }: { to: string; data: string; blockTag: number }) => {
      assert.equal(blockTag, block.number);
      if (state.fail) throw new Error("controlled RPC read unavailable");
      if (to.toLowerCase() === account.toLowerCase()) return accountInterface.encodeFunctionResult("creditManager", [manager]);
      if (to.toLowerCase() === manager.toLowerCase()) {
        const method = managerAbi.parseTransaction({ data })!.name;
        return managerAbi.encodeFunctionResult(method, method === "agentAccount" ? [account] : method === "taskEscrow" ? [escrow] : [[0, 0, 0, 0, 0]]);
      }
      assert.equal(to.toLowerCase(), escrow.toLowerCase()); state.taskReads++;
      const id = Number(escrowInterface.decodeFunctionData("getTask", data)[0]);
      return escrowInterface.encodeFunctionResult("getTask", [[config.plannerProvider, 150, state.statuses[id - 1] === 1n ? 150 : 0, 0, deadline, 0, state.statuses[id - 1]]]);
    },
  } as unknown as JsonRpcProvider;
  return { state, provider, finance: (cashRaw = "500"): HostedFinance => ({ ...noCredit(cashRaw) as Extract<HostedFinance, { status: "confirmed" }>, block }) };
}

test("after one completed task, a confirmed exhausted catalog stops successfully without another paid plan or child", async () => fixture(async directory => {
  let tasks = 0, plans = 0, games = 0;
  const adapter = task(async () => { tasks++; chain.state.statuses[0] = 3n; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }; }, async () => chain.finance());
  const chain = catalogObservation(adapter);
  const executor = new HostedAutonomyExecutor(adapter, { ...config, games: automaticGames }, { provider: chain.provider,
    games: { rewardBalance: async () => rewardView(4096), execute: async () => { games++; throw new Error("no game after work queue is exhausted"); } },
    planner: async () => { plans++; return { decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "10" }; } });
  const parent = input(directory), result = await executor.execute(parent);
  assert.equal(result.phase, "Stopped"); assert.equal(result.success, true); assert.equal(result.terminal, true);
  assert.equal(result.reason, "AUTONOMY_NO_AVAILABLE_TASKS"); assert.equal(result.autonomousTasks, 1); assert.equal(result.chargedRaw, "90");
  assert.equal(tasks, 1); assert.equal(plans, 1); assert.equal(games, 0); assert.equal(chain.state.taskReads, 1);
  const host = JSON.parse(await readFile(join(directory, "autonomy-host", "session.json"), "utf8")); assert.equal(Object.keys(host.children).length, 1);
  const loop = JSON.parse(await readFile(join(directory, "autonomy-loop", "session.json"), "utf8"));
  assert.equal(loop.steps.at(-1).context.observation.availableTasks, 0); assert.equal(loop.steps.at(-1).decisionChargedRaw, "0");
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), result); assert.equal(chain.state.taskReads, 1); assert.equal(plans, 1);
}));

test("an open catalog continues work; unavailable or noncanonical reads pause instead of claiming an empty queue", async t => {
  for (const scenario of ["open", "read-failure", "reorg", "wrong-chain"]) await t.test(scenario, async () => fixture(async directory => {
    let tasks = 0, plans = 0;
    const adapter = task(async () => { tasks++;
      if (tasks === 1) { chain.state.fail = scenario === "read-failure"; chain.state.reorg = scenario === "reorg"; if (scenario === "wrong-chain") chain.state.chainId = "0x1"; }
      return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }; }, async () => chain.finance());
    const chain = catalogObservation(adapter);
    const executor = new HostedAutonomyExecutor(adapter, { ...config, games: automaticGames }, { provider: chain.provider,
      games: { rewardBalance: async () => rewardView(0), execute: async () => { throw new Error("cash is sufficient"); } },
      planner: async () => { plans++; return { decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "10" }; } });
    const result = await executor.execute(input(directory));
    if (scenario === "open") { assert.equal(result.phase, "Completed"); assert.equal(result.success, true); assert.equal(tasks, 2); assert.equal(plans, 2); }
    else { assert.equal(result.phase, "Paused"); assert.equal(result.terminal, false); assert.equal(result.reason, "AUTONOMY_OBSERVATION_UNAVAILABLE"); assert.equal(tasks, 1); assert.equal(plans, 1); }
  }));
});

test("an accepted pending task resumes its original ID even after an earlier task completed and catalog reads become unavailable", async () => fixture(async directory => {
  let tokens = 150, tasks = 0, games = 0, pendingId = "";
  const adapter = rewardAdapter(async child => {
    if (child.recover) { assert.equal(child.run.requestId, pendingId); return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0" }; }
    tasks++; if (tasks === 1) { chain.state.statuses[0] = 3n; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0" }; }
    pendingId = child.run.requestId; tokens = 20; return { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "INFERENCE_FUNDING_REQUIRED" };
  }, async () => chain.finance("20"));
  const chain = catalogObservation(adapter, 2);
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxDecisions: 5, games: automaticGames }, { provider: chain.provider,
    games: { rewardBalance: async () => rewardView(tokens), execute: async child => {
      games++; assert.equal(child.run.fundingFor, pendingId); tokens = 4096; chain.state.fail = true;
      return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: 4096 };
    } }, planner: async () => { throw new Error("reward tasks require no paid plan"); } });
  const result = await executor.execute(input(directory)); assert.equal(result.phase, "Completed"); assert.equal(result.success, true);
  assert.equal(result.autonomousTasks, 2); assert.equal(tasks, 2); assert.equal(games, 1); assert.equal(chain.state.taskReads, 2);
}));

test("automatic zero-cash participation observes settled reward cash before the paid planner and task", async () => fixture(async directory => {
  let cash = "0", games = 0, plans = 0, tasks = 0;
  const adapter = rewardAdapter(async child => {
    tasks++; assert.equal(child.run.action, "metered-task"); assert.equal(child.agent.allowCredit, false);
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" };
  }, async () => noCredit(cash));
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxTasks: 1, maxDecisions: 5, games: automaticGames }, {
    games: { rewardBalance: async () => rewardView(0), execute: async child => {
      games++; assert.equal(child.run.action, "game"); assert.equal(child.run.rewardKind, "usdc"); assert.equal(child.agent.allowCredit, false);
      assert.equal(child.run.reservedRaw, "0"); assert.equal(child.deadlineMs! > Date.now(), true);
      const snapshot = JSON.parse(await readFile(join(directory, "autonomy-host", "session.json"), "utf8")); assert.equal(snapshot.children[child.run.requestId].run.rewardKind, "usdc");
      cash = "100"; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", rewardRaw: "100", cashRaw: cash };
    } }, planner: async context => {
      plans++; assert.equal(context.observation.cashRaw, "100"); assert.equal(context.completedGames, 1); assert.equal(context.fundingQuote!.options[0].feasible, true);
      return { decision: { action: "run-task", modelId: "kimi-k2.6", funding: "cash" }, chargedRaw: "10" };
    },
  });
  const result = await executor.execute(input(directory)); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90");
  assert.equal(result.autonomousGames, 1); assert.equal(result.autonomousTasks, 1); assert.equal(games, 1); assert.equal(plans, 1); assert.equal(tasks, 1);
}));

test("automatic token reward executes an independently settled reward-task without buying a package", async () => fixture(async directory => {
  let tokens = 0, games = 0, tasks = 0;
  const executor = new HostedAutonomyExecutor(rewardAdapter(async child => {
    tasks++; assert.equal(child.run.action, "reward-task"); assert.equal(child.agent.modelId, "kimi-k2.6"); assert.equal(child.agent.allowCredit, false);
    assert.equal(child.run.reservedRaw, "0"); assert.equal(child.agent.perRunBudgetRaw, "100"); assert.equal(tokens, 4096);
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsUsed: 200, taskId: "11" };
  }, async () => noCredit("20")), { ...config, maxTasks: 1, maxDecisions: 5, games: automaticGames }, {
    games: { rewardBalance: async () => rewardView(tokens), execute: async child => { games++; assert.equal(child.run.rewardKind, "llm-credits");
      tokens = 4096; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: 4096 };
    } }, planner: async () => { throw new Error("package cannot be funded, no paid planner"); },
  });
  const result = await executor.execute(input(directory)); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "0");
  assert.equal(result.autonomousGames, 1); assert.equal(result.autonomousTasks, 1); assert.equal(games, 1); assert.equal(tasks, 1);
}));

test("automatic loss and usage block never fabricate resources or silently fall back to credit", async t => {
  for (const blocked of [false, true]) await t.test(blocked ? "blocked" : "lost", async () => fixture(async directory => {
    let games = 0;
    const executor = new HostedAutonomyExecutor(rewardAdapter(async () => { throw new Error("cannot execute unfunded task"); }, async () => noCredit("0")),
      { ...config, maxTasks: 1, maxDecisions: 5, games: automaticGames }, { games: {
        rewardBalance: async () => ({ ...rewardView(0), blocked }), execute: async child => { games++; assert.equal(child.agent.allowCredit, false);
          return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", rewardRaw: "0" }; },
      }, planner: async () => { throw new Error("cannot pay planner"); } });
    const result = await executor.execute(input(directory)); assert.equal(result.phase, "Stopped"); assert.equal(result.autonomousTasks, 0);
    assert.equal(result.reason, blocked ? "REWARD_ACCOUNT_BLOCKED_BY_USAGE_OVERRUN" : "AUTONOMY_GAME_LIMIT"); assert.equal(games, blocked ? 0 : 2);
  }));
});

test("automatic uncertain match reconciles its persisted entry without another registration or planner", async () => fixture(async directory => {
  let tokens = 0, original = "", entries = 0, recovered = 0;
  const executor = new HostedAutonomyExecutor(rewardAdapter(async () => ({ phase: "Succeeded", terminal: true, success: true, chargedRaw: "0" }), async () => noCredit("20")),
    { ...config, maxTasks: 1, maxDecisions: 5, games: automaticGames }, { games: {
      rewardBalance: async () => rewardView(tokens), execute: async child => {
        if (!child.recover) { entries++; original = child.run.requestId; return { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_GAME_UPSTREAM_UNKNOWN" }; }
        recovered++; assert.equal(child.run.requestId, original); assert.equal(child.run.rewardKind, "llm-credits");
        if (recovered === 1) return { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_GAME_UPSTREAM_UNKNOWN" };
        tokens = 4096; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: tokens };
      },
    }, planner: async () => { throw new Error("must not pay planner"); } });
  const parent = input(directory); assert.equal((await executor.execute(parent)).terminal, false);
  await executor.execute({ ...parent, recover: true }); assert.equal(entries, 1);
  const result = await executor.execute({ ...parent, recover: true }); assert.equal(result.phase, "Completed"); assert.equal(result.autonomousGames, 1);
  assert.equal(entries, 1); assert.equal(recovered, 2);
}));

test("same reward task is replenished after token shortage and resumed with original ID and funding", async () => fixture(async directory => {
  let tokens = 120, original = "", tasks = 0, games = 0, recoveries = 0;
  const executor = new HostedAutonomyExecutor(rewardAdapter(async child => {
    assert.equal(child.run.action, "reward-task");
    if (!child.recover) { tasks++; original = child.run.requestId; return { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "INFERENCE_FUNDING_REQUIRED" }; }
    recoveries++; assert.equal(child.run.requestId, original); assert.equal(child.agent.allowCredit, false); assert.equal(tokens, 4096);
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0" };
  }, async () => noCredit("20")), { ...config, maxTasks: 1, maxDecisions: 2, games: automaticGames }, { games: {
    rewardBalance: async () => rewardView(tokens), execute: async child => {
      games++; assert.equal(child.run.fundingFor, original); assert.equal(child.run.rewardKind, "llm-credits");
      assert.equal(child.directory, join(directory, "children", child.run.requestId)); tokens = 4096;
      return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: 4096 };
    },
  } });
  const result = await executor.execute(input(directory)); assert.equal(result.phase, "Completed"); assert.equal(result.autonomousTasks, 1);
  assert.equal(tasks, 1); assert.equal(games, 1); assert.equal(recoveries, 1); assert.equal(result.chargedRaw, "0");
}));

test("pause after a settled game prevents further paid planning or task dispatch", async () => fixture(async directory => {
  let allowed = true, games = 0;
  const executor = new HostedAutonomyExecutor(rewardAdapter(async () => { throw new Error("must not dispatch task after pause"); }, async () => noCredit("0")),
    { ...config, maxTasks: 1, maxDecisions: 5, games: automaticGames }, { shouldContinue: async () => allowed, games: {
      rewardBalance: async () => rewardView(0), execute: async () => { games++; allowed = false; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", rewardRaw: "0" }; },
    }, planner: async () => { throw new Error("must not plan after pause"); } });
  const result = await executor.execute(input(directory)); assert.equal(result.reason, "HOSTED_AGENT_PAUSED"); assert.equal(result.autonomousTasks, 0); assert.equal(games, 1);
}));

test("manual autonomous refuel resolves only the original known resource-paused child, preserving frozen model and owner", async () => fixture(async directory => {
  let clock = Date.now();
  const executor = new HostedAutonomyExecutor(rewardAdapter(async () => ({ phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "INFERENCE_FUNDING_REQUIRED" }), async () => noCredit("0")),
    { ...config, maxTasks: 1, maxDecisions: 5, games: { ...automaticGames, maxGames: 1 } }, { now: () => clock, games: {
      rewardBalance: async () => rewardView(120), execute: async () => ({ phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: 0 }),
    } });
  const parent = input(directory), result = await executor.execute(parent); assert.equal(result.phase, "Paused"); assert.equal(result.reason, "AUTONOMY_GAME_LIMIT");
  const paused = { ...parent, run: { ...parent.run, status: "Paused" as const, reason: result.reason } };
  const target = await executor.resolveFundingTarget(paused); assert.ok(target); assert.equal(target.modelId, "kimi-k2.6"); assert.equal(target.funding, "reward-tokens");
  const hostPath = join(directory, "autonomy-host", "session.json"), host = JSON.parse(await readFile(hostPath, "utf8"));
  assert.equal(host.children[target.childId].run.action, "reward-task");
  assert.equal(await executor.resolveFundingTarget({ ...paused, agent: { ...paused.agent, owner: "other" } }), undefined);
  assert.equal(await executor.resolveFundingTarget({ ...paused, keyFile: "/private/other-key" }), undefined);
  assert.equal(await executor.resolveFundingTarget({ ...paused, run: { ...paused.run, reason: "AUTONOMY_CHILD_UNKNOWN" } }), undefined);
  clock += config.durationMs; assert.equal(await executor.resolveFundingTarget(paused), undefined, "an expired original task cannot buy time with a new game"); clock -= config.durationMs;
  const changed = structuredClone(host); changed.children[target.childId].directory = join(directory, "another-request"); await writeFile(hostPath, JSON.stringify(changed));
  assert.equal(await executor.resolveFundingTarget(paused), undefined); await writeFile(hostPath, JSON.stringify(host));
  const loopPath = join(directory, "autonomy-loop", "session.json"), loop = JSON.parse(await readFile(loopPath, "utf8"));
  const uncertainGame = loop.steps.find((step: any) => step.decision?.action === "run-game"); uncertainGame.outcome.terminal = false;
  await writeFile(loopPath, JSON.stringify(loop)); assert.equal(await executor.resolveFundingTarget(paused), undefined, "original uncertain match must reconcile before a supplemental entry");
}));

test("sponsor admission refusal is a known terminal result and never dispatches a game or model", async () => fixture(async directory => {
  let admissions = 0, games = 0;
  const executor = new HostedAutonomyExecutor(rewardAdapter(async () => { throw new Error("unfunded task must not execute"); }, async () => noCredit("0")),
    { ...config, maxTasks: 1, games: automaticGames }, {
      games: { rewardBalance: async () => rewardView(0), execute: async () => { games++; throw new Error("denied game must not execute"); } },
      admitGame: async (parent, child) => { admissions++; assert.equal(parent.run.action, "autonomous"); assert.equal(child.run.action, "game"); throw new HostedError("HOSTED_SPONSOR_LIMIT", 409); },
      planner: async () => { throw new Error("unfunded planner must not execute"); },
    });
  const parent = input(directory), result = await executor.execute(parent); assert.equal(result.phase, "Stopped"); assert.equal(result.terminal, true); assert.equal(result.success, false);
  assert.equal(result.reason, "HOSTED_SPONSOR_LIMIT"); assert.equal(result.chargedRaw, "0"); assert.equal(admissions, 1); assert.equal(games, 0);
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), result); assert.equal(admissions, 1);
}));

test("uncertain sponsor admission resumes the same original game ID before any new model call", async () => fixture(async directory => {
  let admissions = 0, games = 0, tokens = 0, firstChild = "";
  const executor = new HostedAutonomyExecutor(rewardAdapter(async () => ({ phase: "Succeeded", terminal: true, success: true, chargedRaw: "0" }), async () => noCredit("20")),
    { ...config, maxTasks: 1, games: automaticGames }, {
      games: { rewardBalance: async () => rewardView(tokens), execute: async () => { games++; tokens = 4096; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: 4096 }; } },
      admitGame: async (_parent, child) => { admissions++; if (!firstChild) { firstChild = child.run.requestId; throw new Error("admission journal uncertain"); } assert.equal(child.run.requestId, firstChild); },
    });
  const parent = input(directory), first = await executor.execute(parent); assert.equal(first.terminal, false); assert.equal(first.reason, "HOSTED_AUTONOMY_GAME_ADMISSION_UNCERTAIN"); assert.equal(games, 0);
  const result = await executor.execute({ ...parent, recover: true }); assert.equal(result.phase, "Completed"); assert.equal(games, 1); assert.equal(admissions, 2);
}));

test("new game defaults recover a legacy paid parent with frozen planner, task ID, decision bound and deadline", async () => fixture(async directory => {
  let plans = 0, tasks = 0, games = 0, original = "";
  const adapter = task(async child => {
    tasks++; if (!original) original = child.run.requestId; assert.equal(child.run.requestId, original);
    return child.recover ? { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }
      : { phase: "Paused", terminal: false, success: false, chargedRaw: "30", reason: "INFERENCE_FUNDING_REQUIRED" };
  });
  const old = { ...config, maxTasks: 1 }, parent = input(directory);
  const dependencies = { planner: async () => { plans++; return { decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "10" }; },
    games: { rewardBalance: async () => rewardView(4096), execute: async () => { games++; throw new Error("legacy session cannot participate in newly enabled games"); } } };
  const previous = new HostedAutonomyExecutor(adapter, old, dependencies), first = await previous.execute(parent); assert.equal(first.terminal, false);
  const oldHost = JSON.parse(await readFile(join(directory, "autonomy-host", "session.json"), "utf8")), oldLoop = JSON.parse(await readFile(join(directory, "autonomy-loop", "session.json"), "utf8"));
  const updated = new HostedAutonomyExecutor(adapter, { ...old, maxDecisions: 6, games: automaticGames }, dependencies);
  const target = await updated.resolveFundingTarget({ ...parent, run: { ...parent.run, status: "Paused", reason: "INFERENCE_FUNDING_REQUIRED" }, recover: true });
  assert.equal(target?.childId, original); assert.equal(target?.funding, "cash");
  const result = await updated.execute({ ...parent, recover: true }); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90");
  assert.equal(plans, 1); assert.equal(tasks, 2); assert.equal(games, 0); assert.equal(result.autonomousGames, undefined);
  const newHost = JSON.parse(await readFile(join(directory, "autonomy-host", "session.json"), "utf8")), newLoop = JSON.parse(await readFile(join(directory, "autonomy-loop", "session.json"), "utf8"));
  assert.deepEqual(newHost.config, oldHost.config); assert.deepEqual(newHost.controller, oldHost.controller); assert.equal(newLoop.config.deadlineMs, oldLoop.config.deadlineMs);
  assert.equal(newLoop.config.maxDecisions, old.maxDecisions); assert.equal(newLoop.config.games, undefined);
  const changedPrice = new HostedAutonomyExecutor(adapter, { ...old, maxDecisions: 6, games: automaticGames, plannerPriceRaw: "11" }, dependencies);
  await assert.rejects(changedPrice.execute({ ...parent, recover: true }), /HOSTED_AUTONOMY_BINDING_CHANGED/); assert.equal(plans, 1); assert.equal(games, 0);
}));

test("hosted autonomous run plans two sequential tasks with isolated budgets and durable snapshots", async () => fixture(async directory => {
  const children: HostedExecution[] = []; let plans = 0;
  const executor = new HostedAutonomyExecutor(task(async child => {
    children.push(structuredClone(child)); const state = JSON.parse(await readFile(join(directory, "autonomy-host", "session.json"), "utf8"));
    assert.equal(state.children[child.run.requestId].run.requestId, child.run.requestId);
    assert.equal(child.run.action, "metered-task"); assert.equal(child.agent.totalBudgetRaw, "500"); assert.equal(child.agent.spentRaw, children.length === 1 ? "30" : "110"); assert.equal(child.recover, false);
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "70" };
  }), config, { planner: async context => { plans++; assert.equal(context.observation.creditAvailableRaw, "180"); assert.equal(context.completedTasks, plans - 1);
    return { decision: { action: "run-task", modelId: plans === 1 ? "cheap" : "strong", funding: plans === 1 ? "credit" : "cash" }, chargedRaw: "10" }; } });
  const parent = input(directory); parent.agent.spentRaw = "20";
  const result = await executor.execute(parent);
  assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "160"); assert.equal((result as any).autonomousTasks, 2); assert.equal(result.success, true);
  assert.equal(children.length, 2); assert.notEqual(children[0].run.requestId, children[1].run.requestId); assert.equal(children[0].agent.allowCredit, true); assert.equal(children[1].agent.allowCredit, false);
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), result); assert.equal(plans, 2); assert.equal(children.length, 2);
}));

test("hosted resume preserves original child snapshot and does not repeat planner or task", async () => fixture(async directory => {
  let plans = 0; const children: HostedExecution[] = [];
  const executor = new HostedAutonomyExecutor(task(async child => { children.push(child); return child.recover
    ? { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }
    : { phase: "Paused", terminal: false, success: false, chargedRaw: "30", reason: "INFERENCE_FUNDING_REQUIRED" }; }), { ...config, maxTasks: 1 },
    { planner: async () => { plans++; return { decision: { action: "run-task", modelId: "strong", funding: "credit" }, chargedRaw: "10" }; } });
  const parent = input(directory); const paused = await executor.execute(parent); assert.equal(paused.terminal, false); assert.equal(paused.chargedRaw, "40");
  const result = await executor.execute({ ...parent, recover: true, agent: { ...parent.agent, modelId: "cheap", perRunBudgetRaw: "90" } });
  assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90"); assert.equal(plans, 1); assert.equal(children.length, 2);
  assert.equal(children[1].run.requestId, children[0].run.requestId); assert.equal(children[1].agent.modelId, "strong"); assert.equal(children[1].agent.perRunBudgetRaw, "100");
}));

test("insufficient cash or total task budget stops before any paid planner or task", async t => {
  for (const reason of ["cash", "budget"] as const) await t.test(reason, async () => fixture(async directory => {
    const parent = input(directory); if (reason === "budget") parent.run.reservedRaw = "89";
    const executor = new HostedAutonomyExecutor(task(async () => { throw new Error("must not execute"); }, async () => ({ ...finance, cashRaw: reason === "cash" ? "0" : "500" })), config,
      { planner: async () => { throw new Error("must not plan"); } });
    const result = await executor.execute(parent); assert.equal(result.phase, "Stopped"); assert.equal(result.chargedRaw, "0"); assert.equal(result.reason, reason === "cash" ? "AUTONOMY_PLANNER_CASH_REQUIRED" : "AUTONOMY_TASK_BUDGET_REQUIRED");
  }));
});

test("unknown planner remains paused and unchanged on hosted recovery", async () => fixture(async directory => {
  let calls = 0; const executor = new HostedAutonomyExecutor(task(async () => { throw new Error("must not execute"); }), config, { planner: async () => { calls++; throw new Error("unknown dispatch"); } });
  const parent = input(directory); const first = await executor.execute(parent); assert.equal(first.reason, "AUTONOMY_DECISION_UNKNOWN"); assert.equal(first.terminal, false);
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), first); assert.equal(calls, 1);
}));

test("model stop text stays private while public result uses a stable machine code", async () => fixture(async directory => {
  const reason = "当前任务不值得执行。模型建议等下一单，并保留所有资金。";
  const executor = new HostedAutonomyExecutor(task(async () => { throw new Error("must not execute"); }), config,
    { planner: async () => ({ decision: { action: "stop", reason }, chargedRaw: "10" }) });
  const result = await executor.execute(input(directory));
  assert.equal(result.terminal, true); assert.equal(result.success, true); assert.equal(result.reason, "AUTONOMY_MODEL_STOPPED");
  assert.match(result.reason!, /^[A-Z][A-Z0-9_]{0,100}$/); assert.equal(JSON.stringify(result).includes(reason), false);
}));

test("confirmed child refund reduces parent net charge and reaches a terminal result", async () => fixture(async directory => {
  let plans = 0;
  const executor = new HostedAutonomyExecutor(task(async child => child.recover
    ? { phase: "Refunded", terminal: true, success: false, chargedRaw: "0", refundedRaw: "80", reason: "SERVICE_UNDELIVERED_REFUNDED" }
    : { phase: "Paused", terminal: false, success: false, chargedRaw: "80", refundedRaw: "0", reason: "SERVICE_PENDING" }), config,
    { planner: async () => { plans++; return { decision: { action: "run-task", modelId: "cheap", funding: "credit" }, chargedRaw: "10" }; } });
  const parent = input(directory); assert.equal((await executor.execute(parent)).chargedRaw, "90");
  const result = await executor.execute({ ...parent, recover: true });
  assert.equal(result.terminal, true); assert.equal(result.success, false); assert.equal(result.chargedRaw, "10"); assert.equal(result.reason, "SERVICE_UNDELIVERED_REFUNDED"); assert.equal(plans, 1);
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), result);
}));

test("planner configuration requires an explicit physical response model", () => {
  assert.equal(validateHostedAutonomyConfig(config).plannerPhysicalModel, "physical-planner-v1");
  for (const model of [undefined, "", "invalid physical model"]) assert.throws(() => validateHostedAutonomyConfig({ ...config, plannerPhysicalModel: model } as HostedAutonomyConfig), /HOSTED_AUTONOMY_CONFIG_INVALID/);
});

test("platform model IDs need not equal internal gateway route IDs", async () => fixture(async directory => {
  const adapter = task(async child => { assert.equal(child.agent.modelId, "kimi-k2.6"); return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }; });
  adapter.config.models = [{ ...adapter.config.models[0], id: "kimi-k2.6" }];
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxTasks: 1 }, { planner: async context => {
    assert.deepEqual(context.models, ["kimi-k2.6"]); return { decision: { action: "run-task", modelId: "kimi-k2.6", funding: "credit" }, chargedRaw: "10" };
  } });
  const result = await executor.execute(input(directory)); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90");
}));

test("pausing the hosted agent prevents the next child even when a planner response arrives", async () => fixture(async directory => {
  let allowed = true, calls = 0;
  const executor = new HostedAutonomyExecutor(task(async () => { calls++; throw new Error("must not execute"); }), config, {
    shouldContinue: async () => allowed,
    planner: async () => { allowed = false; return { decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "10" }; },
  });
  const result = await executor.execute(input(directory));
  assert.equal(result.terminal, true); assert.equal(result.reason, "HOSTED_AGENT_PAUSED"); assert.equal(result.chargedRaw, "10"); assert.equal(calls, 0);
}));

test("default planner connection discovers Anvil chain 31337 and releases its provider", async () => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body.method);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? "0x7a69" : null }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const connection = await openHostedPlannerConnection(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "31337", "direct");
  try {
    assert.equal((await connection.provider.getNetwork()).chainId, 31337n);
    assert.ok(calls.includes("eth_chainId"));
    await assert.rejects(openHostedPlannerConnection("http://127.0.0.1", "31337", "system-https-proxy"), /HOSTED_PLANNER_NETWORK_INVALID/);
  } finally {
    connection.close(); assert.equal(connection.provider.destroyed, true);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
  }
});

test("Kimi planner disables thinking within its completion budget and supports a configured Magpie response model", () => {
  const configured = validateHostedAutonomyConfig({ ...config, plannerPhysicalModel: "cheap/kimi-k2.6", plannerResponseModel: "kimi-k2.6" });
  assert.equal(configured.plannerPhysicalModel, "cheap/kimi-k2.6"); assert.equal(configured.plannerResponseModel, "kimi-k2.6");
  const body = createHostedPlannerRequest(configured, {
    observation: { cashRaw: "500", debtRaw: "0", creditAvailableRaw: "200", inferenceCreditsAvailable: "0" },
    completedTasks: 0, startedTasks: 0, decisions: 0, remainingTasks: 2, remainingSpendRaw: "250", deadlineMs: Date.now() + 60000, models: ["kimi-k2.6"], funding: ["cash", "credit"],
  });
  assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.max_completion_tokens, 512); assert.equal(body.model, config.plannerModel);
  assert.throws(() => validateHostedAutonomyConfig({ ...config, plannerResponseModel: "invalid response model" }), /HOSTED_AUTONOMY_CONFIG_INVALID/);
});

test("real planner prompt separates paid planning, package purchase, borrowing fee and token rates", async () => fixture(async directory => {
  const selected = input(directory); selected.agent.perRunBudgetRaw = "120000"; selected.agent.totalBudgetRaw = "300000"; selected.run.reservedRaw = "300000";
  const adapter = task(async child => {
    assert.equal(child.agent.allowCredit, true); assert.equal(child.agent.modelId, "strong");
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "120000" };
  }, async () => ({ ...finance, cashRaw: "50000", debtRaw: "0", credit: { ...finance.credit, tierCapRaw: "200000", feeBps: "1500" },
    policy: { ...finance.policy, maxCashPerTxRaw: "120000", maxDebtPerTxRaw: "120000", maxDebtPerDayRaw: "300000" } }));
  adapter.config.metered!.priceRaw = "120000";
  for (const model of adapter.config.models) model.templates.balanced.tasks[0].creditLimit = "80000";
  const configured = { ...config, maxTasks: 1, plannerPriceRaw: "10000" };
  const executor = new HostedAutonomyExecutor(adapter, configured, { planner: async context => {
    const request = createHostedPlannerRequest(configured, context);
    const messages = request.messages as { content: string }[];
    const sent = JSON.parse(messages[1].content);
    assert.equal(sent.observation.cashRaw, "50000"); assert.equal(sent.observation.executionCosts.planningCashRaw, "10000");
    assert.equal(sent.observation.executionCosts.taskPackagePriceRaw, "120000"); assert.equal(sent.observation.executionCosts.taskPackageCreditsRaw, "200000");
    assert.equal(sent.fundingQuote.cashAfterPlanningRaw, "40000"); assert.equal(sent.fundingQuote.budgetAfterPlanningRaw, "290000");
    assert.deepEqual(sent.fundingQuote.options, [
      { funding: "cash", feasible: false, fromCashRaw: "120000", fromCreditRaw: "0", borrowerFeeRaw: "0" },
      { funding: "credit", feasible: true, fromCashRaw: "40000", fromCreditRaw: "80000", borrowerFeeRaw: "12000" },
    ]);
    assert.deepEqual(sent.observation.executionCosts.tokenRates, [
      { tier: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
      { tier: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" },
    ]);
    assert.deepEqual(sent.models, ["cheap", "strong"]); assert.match(messages[0].content, /cash FIRST/); assert.match(messages[0].content, /neither the planner charge nor the package price/);
    return { decision: { action: "run-task", modelId: "strong", funding: "credit" }, chargedRaw: "10000" };
  } });
  const result = await executor.execute(selected); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "130000");
}));

test("custom gateway catalog IDs preserve cheap and strong workflow tier pricing", async () => fixture(async directory => {
  let planned = false;
  const adapter = task(async () => ({ phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }));
  adapter.config.metered!.catalog[0].id = "economy-custom";
  adapter.config.metered!.catalog[1].id = "premium-custom";
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxTasks: 1 }, { planner: async context => {
    planned = true;
    assert.deepEqual(context.observation.executionCosts?.tokenRates, [
      { tier: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
      { tier: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" },
    ]);
    return { decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "10" };
  } });
  const result = await executor.execute(input(directory));
  assert.equal(planned, true); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90");
}));

test("planner reconciliation reads the original payment only and requires canonical refund plus operator evidence", async () => {
  const account = "0x2222222222222222222222222222222222222222", manager = "0x3333333333333333333333333333333333333333";
  const txHash = `0x${"11".repeat(32)}`, refundHash = `0x${"22".repeat(32)}`, refundId = `0x${"33".repeat(32)}`, blockHash = `0x${"44".repeat(32)}`;
  const context: AutonomyContext = { observation: { cashRaw: "50", debtRaw: "0", creditAvailableRaw: "80", inferenceCreditsAvailable: "0" }, completedTasks: 0, startedTasks: 0,
    decisions: 0, remainingTasks: 2, remainingSpendRaw: "300", deadlineMs: Date.now() + 60000, models: ["cheap"], funding: ["cash", "credit"] };
  const body = { ...createHostedPlannerRequest(config, context), agentId: "1", taskId: "0" }, digest = requestDigest(body), nonce = `0x${"55".repeat(32)}`, id = paymentId("0", digest, nonce);
  const handle: PaymentHandle = { version: 1, relayUrl: config.plannerRelayUrl, input: body, creditNonce: "1", submission: { from: config.plannerProvider, nonce: 7, txHash },
    quote: { paymentId: id, agentId: "1", taskId: "0", requestDigest: digest, serverNonce: nonce, service: config.plannerService, model: config.plannerModel,
      price: "10", payTo: config.plannerProvider, asset: account, chainId: "31337", account, quoteExpiry: "100000", createdBlock: 1 } };
  const paidEvent = accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!, [1, config.plannerProvider, id, 10, 0]);
  const refundEvent = managerInterface.encodeEventLog(managerInterface.getEvent("RefundProcessed")!, [id, refundId, 10, 0, 10]);
  let refunded = 0n, canonicalRefund = true, gets = 0;
  const provider = { send: async () => "0x7a69", getBlock: async () => ({ number: 5, hash: blockHash }),
    getTransaction: async (hash: string) => { assert.equal(hash, txHash); return { to: account, from: config.plannerProvider, nonce: 7, value: 0n,
      data: accountInterface.encodeFunctionData("payProvider", [1, config.plannerProvider, 10, id, EMPTY_AUTH, "0x"]) }; },
    getTransactionReceipt: async (hash: string) => ({ hash, status: 1, blockNumber: hash === txHash ? 2 : 4, blockHash: hash === refundHash && !canonicalRefund ? "bad" : blockHash,
      logs: hash === txHash ? [{ address: account, ...paidEvent }] : [{ address: manager, ...refundEvent }] }),
    call: async ({ data }: { data: string }) => { const method = accountInterface.parseTransaction({ data })!.name;
      if (method === "getPayment") return accountInterface.encodeFunctionResult("getPayment", [[1, 0, 10, 0, refunded]]);
      assert.equal(method, "creditManager"); return accountInterface.encodeFunctionResult("creditManager", [manager]); },
  } as unknown as JsonRpcProvider;
  const attempts = [{ upstream: "real", model: "real", startedAt: 1, state: "Unknown", httpStatus: 503 }];
  const resolution = { version: 1, paymentId: id, resolutionId: refundId, evidenceDigest: nonce, expectedAttemptsDigest: keccak256(toUtf8Bytes(canonical(attempts as unknown as Json))), reason: "operator-accepted-nondelivery-cost", resolvedAt: 1 };
  const view: any = { state: "Processing", paymentId: id, refundedAmount: "0", upstreamAttempts: attempts };
  const read = (async (url: string | URL | Request, init?: RequestInit) => { gets++; assert.equal(init?.method, "GET"); assert.equal(new URL(String(url)).pathname, `/payments/${id}`); return Response.json(view); }) as typeof fetch;
  const expected = { config, context, chainId: "31337", account, asset: account, agentId: "1", wallet: config.plannerProvider };
  const recover = () => reconcileHostedPlannerPayment(handle, expected, provider, read);
  assert.deepEqual(await recover(), { status: "unknown", chargedRaw: "10", refundedRaw: "0" });
  refunded = 10n; Object.assign(view, { state: "Refunded", refundedAmount: "10", confirmedRefunds: [{ refundId, amount: "10", txHash: refundHash }] });
  assert.equal((await recover()).status, "unknown", "refund alone cannot clear uncertainty");
  view.operatorResolution = resolution; canonicalRefund = false;
  assert.equal((await recover()).status, "unknown", "noncanonical refund cannot clear uncertainty");
  canonicalRefund = true; assert.deepEqual(await recover(), { status: "refunded-undelivered", chargedRaw: "0", refundedRaw: "10", evidence: { paymentId: id, resolutionId: refundId, evidenceDigest: nonce } });
  view.operatorResolution = { ...resolution, expectedAttemptsDigest: nonce };
  assert.equal((await recover()).status, "unknown", "changed attempt evidence cannot clear uncertainty");
  assert.equal(gets, 5);
});

test("hosted paid unknown planner is reconciled without replay and reports refunds separately", async () => fixture(async directory => {
  let plans = 0, cleared = false;
  const executor = new HostedAutonomyExecutor(task(async () => ({ phase: "Succeeded", terminal: true, success: true, chargedRaw: "70" })), config, {
    planner: async () => { if (++plans === 1) throw new Error("unknown paid"); return { decision: { action: "run-task", modelId: "cheap", funding: "credit" }, chargedRaw: "10" }; },
    recoverPlanner: async () => cleared ? { status: "refunded-undelivered", chargedRaw: "0", refundedRaw: "10", evidence: { paymentId: "same", resolutionId: "operator", evidenceDigest: "digest" } }
      : { status: "unknown", chargedRaw: "10", refundedRaw: "0" },
  });
  const parent = input(directory); assert.equal((await executor.execute(parent)).chargedRaw, "10");
  await executor.execute({ ...parent, recover: true }); assert.equal(plans, 1);
  cleared = true; const result = await executor.execute({ ...parent, recover: true });
  assert.equal(result.phase, "Completed"); assert.equal(result.autonomousTasks, 2); assert.equal(result.chargedRaw, "160"); assert.equal(result.refundedRaw, "10"); assert.equal(plans, 3);
}));

test("cached planner recovery requires canonical paid receipt, no child and original deadline; never invokes SDK or model", async () => fixture(async directory => {
  const wallet = Wallet.createRandom(), account = "0x2222222222222222222222222222222222222222", txHash = `0x${"66".repeat(32)}`, blockHash = `0x${"77".repeat(32)}`;
  let originalPlans = 0, tasks = 0, valid = true, clock = Date.now();
  const parent = input(directory); parent.agent.wallet = wallet.address; parent.agent.binding!.wallet = wallet.address; parent.keyFile = join(directory, "wallet.key");
  await writeFile(parent.keyFile, wallet.privateKey, { mode: 0o600 }); parent.keyFile = await realpath(parent.keyFile);
  const adapter = task(async () => { tasks++; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }; });
  Object.assign(adapter.config.models[0].templates.balanced, { chainId: "31337", account, asset: account });
  let handle: PaymentHandle;
  const provider = { send: async (method: string) => { assert.equal(method, "eth_chainId"); return "0x7a69"; },
    getBlock: async () => ({ number: 2, hash: valid ? blockHash : `0x${"00".repeat(32)}`, timestamp: 1000 }),
    getTransaction: async (hash: string) => { assert.equal(hash, txHash); return { to: account, from: wallet.address, nonce: 7, value: 0n,
      data: accountInterface.encodeFunctionData("payProvider", [1, config.plannerProvider, 10, handle.quote.paymentId, EMPTY_AUTH, "0x"]) }; },
    getTransactionReceipt: async (hash: string) => ({ hash, status: 1, blockNumber: 2, blockHash,
      logs: [{ address: account, ...accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!, [1, config.plannerProvider, handle.quote.paymentId, 10, 0]) }] }),
    call: async ({ data }: { data: string }) => { assert.equal(accountInterface.parseTransaction({ data })!.name, "getPayment"); return accountInterface.encodeFunctionResult("getPayment", [[1, 0, 10, 0, 0]]); },
  } as unknown as JsonRpcProvider;
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxTasks: 1 }, { provider, now: () => clock,
    planner: async () => { originalPlans++; return { decision: "old parser rejection", chargedRaw: "10" }; } });
  const first = await executor.execute(parent); assert.equal(first.reason, "AUTONOMY_INVALID_DECISION");
  const loopFile = join(directory, "autonomy-loop", "session.json"), loop = JSON.parse(await readFile(loopFile, "utf8")), step = loop.steps[0];
  const body = { ...createHostedPlannerRequest(config, step.context), agentId: "1", taskId: "0" }, digest = requestDigest(body), nonce = `0x${"88".repeat(32)}`;
  const quote = { paymentId: paymentId("0", digest, nonce), agentId: "1", taskId: "0", requestDigest: digest, serverNonce: nonce, service: config.plannerService, model: config.plannerModel,
    price: "10", payTo: config.plannerProvider, asset: account, chainId: "31337", account, quoteExpiry: "2000", createdBlock: 1 };
  handle = { version: 1, relayUrl: config.plannerRelayUrl, input: body, quote, creditNonce: "1", submission: { from: wallet.address, nonce: 7, txHash } };
  const state = { version: 1, context: step.context, handle, inference: { handle, receipt: { ...quote, txHash, blockNumber: 2, blockHash, timestamp: 1000, fromCash: "10", fromCredit: "0", model: config.plannerPhysicalModel, usage: null, upstream: "cheap" },
    result: { model: config.plannerPhysicalModel, choices: [{ message: { content: '```json\n{"action":"run-task","modelId":"cheap","funding":"credit"}\n```' } }] } } };
  const plannerPath = join(directory, "planner", step.decisionId); await mkdir(plannerPath, { recursive: true }); await writeFile(join(plannerPath, "session.json"), JSON.stringify(state));
  const failed: HostedExecution = { ...parent, recover: true, agent: { ...parent.agent, spentRaw: "10" }, run: { ...parent.run, status: "Failed", chargedRaw: "10", reason: first.reason, result: first } };
  assert.equal(await executor.canRecoverTerminal(failed), true);
  const originalDigest = state.handle.quote.requestDigest; state.handle.quote.requestDigest = `0x${"00".repeat(32)}`;
  await writeFile(join(plannerPath, "session.json"), JSON.stringify(state)); assert.equal(await executor.canRecoverTerminal(failed), false);
  state.handle.quote.requestDigest = originalDigest; await writeFile(join(plannerPath, "session.json"), JSON.stringify(state));
  valid = false; assert.equal(await executor.canRecoverTerminal(failed), false); valid = true;
  clock = loop.config.deadlineMs; assert.equal(await executor.canRecoverTerminal(failed), false); clock--;
  loop.steps[0].childId = "existing-child"; await writeFile(loopFile, JSON.stringify(loop)); assert.equal(await executor.canRecoverTerminal(failed), false);
  delete loop.steps[0].childId; await writeFile(loopFile, JSON.stringify(loop));
  const result = await executor.execute({ ...failed, agent: parent.agent, run: { ...failed.run, status: "Queued" } });
  assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90"); assert.equal(tasks, 1); assert.equal(originalPlans, 1);
  const final = JSON.parse(await readFile(loopFile, "utf8")); assert.equal(final.steps[0].decisionId, step.decisionId); assert.equal(final.steps.length, 1);
}));


test("activity callbacks remain outside snapshots and child facts reach the parent after recovery",async()=>fixture(async directory=>{
 const events:import("../src/scene-types.js").HostedActivityInput[]=[];let plans=0;
 const executor=new HostedAutonomyExecutor(task(async child=>{assert.equal(typeof child.activity,"function");await child.activity?.({scene:"settlement",state:"confirmed",evidence:{taskId:"42",txHash:`0x${"ab".repeat(32)}`,passed:true}});return {phase:"Succeeded",terminal:true,success:true,chargedRaw:"80"};},async()=>({...finance,block:{...finance.block,hash:`0x${"ab".repeat(32)}`}})),{...config,maxTasks:1},{planner:async()=>{plans++;return {decision:{action:"run-task",modelId:"cheap",funding:"credit"},chargedRaw:"10"};}});
 const parent={...input(directory),activity:async(event:import("../src/scene-types.js").HostedActivityInput)=>{events.push(importedValidate(event));}};
 const result=await executor.execute(parent);assert.equal(result.success,true);assert.ok(events.some(e=>e.scene==="settlement"&&e.evidence?.taskId==="42"));assert.ok(events.some(e=>e.scene==="decision"&&e.state==="selected"));
 const saved=JSON.parse(await readFile(join(directory,"autonomy-host/session.json"),"utf8"));assert.equal(saved.input.activity,undefined);assert.ok(Object.values(saved.children).every((child:any)=>child.activity===undefined));
 assert.deepEqual(await executor.execute({...parent,recover:true}),result);assert.equal(plans,1);
}));


test("runtime pause is distinct from a model stop in public decisions",async()=>fixture(async directory=>{
 const events:import("../src/scene-types.js").HostedActivityInput[]=[];
 const executor=new HostedAutonomyExecutor(task(async()=>{throw Error("must not execute");},async()=>({...finance,block:{...finance.block,hash:`0x${"ab".repeat(32)}`}})),config,{shouldContinue:async()=>false});
 const result=await executor.execute({...input(directory),activity:async event=>{events.push(importedValidate(event));}});assert.equal(result.reason,"HOSTED_AGENT_PAUSED");assert.ok(events.some(e=>e.reason==="HOSTED_AGENT_PAUSED"));assert.equal(events.some(e=>e.reason==="AUTONOMY_MODEL_STOPPED"),false);
}));
