import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Interface, keccak256, toUtf8Bytes } from "ethers";
import { fixture, read, startAnvil, stopAnvil, tx } from "../../services/underwriter/test/fixture.js";
import { readDashboard } from "../lib/read";
import { createServerRpc } from "../lib/server-transport";
import { publicConfig, validateDeployment } from "../lib/config";
import { acceptTask, connectWallet, createTask, depositCash, probeSpendRejection } from "../lib/wallet";
import { explainError } from "../lib/errors";
import { ESCROW_ABI, MANAGER_ABI } from "../lib/abi";

test("live Underwriter + real four-contract views + EIP-1193 wallet actions, both assets", { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "infercredit-frontend-"));
  const local = await startAnvil();
  try {
    for (const decimals of [6, 18] as const) await t.test(`${decimals} decimals`, async () => {
      const f = await fixture(local.rpc, join(dir, String(decimals)), decimals);
      let browser: Awaited<ReturnType<typeof connectWallet>> | undefined;
      try {
        for (const id of [2n, 3n]) {
          await tx(f.identity, f.admin, "registerFor", [f.agentAddress, f.agentAddress]);
          await tx(f.manager, f.admin, "enrollAgent", [id]);
        }
        const deployment = validateDeployment({ chainId: "31337", network: "local Anvil test", rpcUrl: local.rpc,
          explorerUrl: "", deploymentBlock: 0, underwriterUrl: f.http,
          asset: { address: f.config.settlementAsset, symbol: decimals === 6 ? "USDC" : "MON", decimals },
          contracts: { manager: await f.manager.getAddress(), adapter: await f.adapter.getAddress(), account: await f.account.getAddress(), escrow: await f.escrow.getAddress() },
          agents: [1, 2, 3].map(id => ({ id: String(id), name: `Agent ${id}` })), providers: [{ name: "test provider", address: f.payee }] });
        const task = await f.task(); const authorization = await f.authorize(task, 900n);
        await tx(f.account, f.agent, "payProvider", [f.agentId, f.payee, 12n * f.unit / 100n, keccak256(toUtf8Bytes(`frontend-${decimals}`)), authorization.body.authorization, authorization.body.signature]);
        const logRanges: [number, number][] = [];
        const taskCalls: { method: string; id?: string; block: number }[] = [];
        const creditBlocks = new Map<string, number>();
        const managerInterface = new Interface(MANAGER_ABI), escrowInterface = new Interface(ESCROW_ABI);
        const taskMethods = new Set(["nextTaskId", "getTask", "getLoan", "payableEscrow", "feedbackSent", "pendingFeedback"]);
        let activeRpc = 0, activeDetection = 0, activeCredits = 0;
        let peakRpc = 0, peakDetection = 0, peakTotal = 0, peakCredits = 0;
        const boundedRpc: typeof createServerRpc = async rpcUrl => {
          const connection = await createServerRpc(rpcUrl);
          const send = connection.provider._send.bind(connection.provider);
          connection.provider._send = async payload => {
            const batch = Array.isArray(payload) ? payload : [payload];
            for (const p of batch) {
              if (p.method !== "eth_call" || !Array.isArray(p.params)) continue;
              const [transaction, blockTag] = p.params;
              const address = String(transaction.to).toLowerCase();
              const abi = address === deployment.contracts.manager.toLowerCase() ? managerInterface :
                address === deployment.contracts.escrow.toLowerCase() ? escrowInterface : undefined;
              const parsed = abi?.parseTransaction({ data: transaction.data });
              if (!parsed || !taskMethods.has(parsed.name)) continue;
              assert.match(String(blockTag), /^0x[\da-f]+$/i, "task calls must use a fixed snapshot block");
              taskCalls.push({ method: parsed.name, id: parsed.name === "nextTaskId" ? undefined : String(parsed.args[0]), block: Number(BigInt(blockTag)) });
            }
            const detection = batch.filter(p => p.method === "eth_chainId").length, business = batch.length - detection;
            activeRpc += business; activeDetection += detection;
            peakRpc = Math.max(peakRpc, activeRpc); peakDetection = Math.max(peakDetection, activeDetection);
            peakTotal = Math.max(peakTotal, activeRpc + activeDetection);
            try { return await send(payload); }
            finally { activeRpc -= business; activeDetection -= detection; }
          };
          const getLogs = connection.provider.getLogs.bind(connection.provider);
          connection.provider.getLogs = async filter => {
            assert.ok("fromBlock" in filter && "toBlock" in filter);
            const from = Number(filter.fromBlock), to = Number(filter.toBlock);
            assert.ok(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from);
            assert.ok(to - from + 1 <= 100, "RPC rejects log requests exceeding 100 blocks");
            logRanges.push([from, to]);
            return getLogs(filter);
          };
          return connection;
        };
        const readBounded = async (advanceBlocks = false) => {
          taskCalls.length = 0; creditBlocks.clear();
          const originalFetch = globalThis.fetch;
          globalThis.fetch = async (input, init) => {
            const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!endpoint.startsWith(`${f.http}/agents/`)) return originalFetch(input, init);
            activeCredits++; peakCredits = Math.max(peakCredits, activeCredits);
            try {
              const response = await originalFetch(input, init);
              const snapshot = await response.clone().json() as { agentId: string; block: { number: number } };
              creditBlocks.set(snapshot.agentId, snapshot.block.number);
              // Real Underwriter snapshots differ while all frontend calls remain pinned to each returned block.
              if (advanceBlocks) await f.provider.send("anvil_mine", ["0x1"]);
              return response;
            } finally { activeCredits--; }
          };
          try { return await readDashboard(deployment, boundedRpc); }
          finally { globalThis.fetch = originalFetch; }
        };
        const data = await readBounded();
        assert.equal(data.mode, "chain"); assert.equal(data.profiles.length, 3);
        assert.equal(data.profiles[0].cash, "0"); assert.equal(data.profiles[0].debt, String(92n * f.unit / 1000n));
        assert.equal(data.profiles[0].evidence[0].kind, "payment");
        assert.equal(data.profiles[0].evidence[0].evidenceHash, authorization.body.evidenceHash);
        assert.ok(data.profiles[0].evidence[0].events.some(e => e.name === "LoanOpened"));
        // Native EIP-1193 -> ethers BrowserProvider -> an actual local transaction.
        await f.provider.send("anvil_impersonateAccount", [f.agentAddress]);
        browser = await connectWallet(publicConfig(deployment), { request: async ({ method, params }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [f.agentAddress];
          return f.provider.send(method, Array.isArray(params) ? params : []);
        } });
        const created = await createTask(browser, publicConfig(deployment), "0.15", (await f.provider.getBlock("latest"))!.timestamp + 3600, () => {});
        await acceptTask(browser, publicConfig(deployment), created.taskId, "1", f.agentAddress, () => {});
        await depositCash(browser, publicConfig(deployment), "1", "0.02", () => {});
        assert.equal(await read(f.account, "cash", [1n]), 2n * f.unit / 100n);
        await assert.rejects(probeSpendRejection(browser, publicConfig(deployment), "1", f.agentAddress, "0x000000000000000000000000000000000000dEaD"), error => {
          assert.equal(explainError(error).code, "SpendRejected"); assert.match(explainError(error).message, /白名单/); return true;
        });
        // Time can pass beyond the visible event window without removing an old loan from debt.
        await f.provider.send("anvil_mine", ["0x7d1"]);
        logRanges.length = 0;
        const older = await readBounded();
        assert.ok(older.history!.fromBlock > 0); assert.equal(older.profiles[0].counts.payments, 0);
        assert.equal(older.history!.toBlock - older.history!.fromBlock + 1, 2_000);
        assert.equal(logRanges.length, 20);
        assert.equal(logRanges[0][0], older.history!.fromBlock);
        assert.equal(logRanges.at(-1)![1], older.history!.toBlock);
        assert.ok(logRanges.every((range, index) => index === 0 || range[0] === logRanges[index - 1][1] + 1));
        assert.equal(older.profiles[0].cash, String(2n * f.unit / 100n));
        assert.equal(older.profiles[0].debt, String(92n * f.unit / 1000n));
        assert.equal(older.profiles[0].tasks.length, 2);
        // BrowserProvider sent transactions for this same local wallet after NonceManager's last use.
        f.agent.reset();
        const createTaskFor = async (agentId?: bigint) => {
          const id = BigInt(await read(f.escrow, "nextTaskId"));
          const reward = 15n * f.unit / 100n, now = (await f.provider.getBlock("latest"))!.timestamp;
          await tx(f.escrow, f.admin, "createTask", [reward, now + 7200], f.token ? {} : { value: reward });
          if (agentId !== undefined) await tx(f.escrow, f.agent, "acceptTask", [id, agentId]);
          return String(id);
        };
        for (const id of [1n, 2n, 2n, 3n, 3n]) await createTaskFor(id);
        const owned = new Map([["1", ["1", "2", "3"]], ["2", ["4", "5"]], ["3", ["6", "7"]]]);
        const split = await readBounded(true);
        assert.equal(new Set(creditBlocks.values()).size, 3);
        assert.equal(split.openTasks.length, 0);
        for (const profile of split.profiles) {
          assert.deepEqual(profile.tasks.map(task => task.id), [...owned.get(profile.agent.id)!].reverse());
          assert.equal(profile.credit.block.number, creditBlocks.get(profile.agent.id));
          const atBlock = taskCalls.filter(call => call.block === profile.credit.block.number);
          assert.equal(atBlock.filter(call => call.method === "nextTaskId").length, 1);
          assert.deepEqual(atBlock.filter(call => call.method === "getTask").map(call => call.id).sort(), ["1", "2", "3", "4", "5", "6", "7"]);
          assert.ok(atBlock.filter(call => !["nextTaskId", "getTask"].includes(call.method)).every(call => owned.get(profile.agent.id)!.includes(call.id!)));
          assert.equal(atBlock.filter(call => !["nextTaskId", "getTask"].includes(call.method)).length, owned.get(profile.agent.id)!.length * 7);
        }
        assert.equal(taskCalls.filter(call => call.method !== "nextTaskId").length, 70, "three blocks and seven owned tasks require 21 headers + 49 details, down from 168");
        assert.equal(split.profiles[0].debt, String(92n * f.unit / 1000n), "old loans remain outside the recent log window");
        const openId = await createTaskFor();
        await tx(f.identity, f.admin, "registerFor", [f.agentAddress, f.agentAddress]);
        await tx(f.manager, f.admin, "enrollAgent", [4n]);
        const unlistedId = await createTaskFor(4n);
        const shared = await readBounded();
        assert.equal(new Set(creditBlocks.values()).size, 1);
        assert.ok(taskCalls.every(call => call.block === shared.history!.toBlock), "Open details and all shared headers use the final snapshot block");
        assert.equal(taskCalls.filter(call => call.method === "nextTaskId").length, 1, "same-block profiles and Open tasks share one header enumeration");
        assert.equal(taskCalls.filter(call => call.method === "getTask").length, 9);
        assert.equal(taskCalls.filter(call => call.method !== "nextTaskId").length, 9 + 8 * 7);
        assert.deepEqual(taskCalls.filter(call => call.id === unlistedId).map(call => call.method), ["getTask"], "assigned tasks outside the manifest need only a header");
        assert.equal(shared.openTasks.length, 1);
        assert.equal(shared.openTasks[0].id, openId); assert.equal(shared.openTasks[0].agentId, "0");
        assert.equal(shared.openTasks[0].status, 1); assert.equal(shared.openTasks[0].netEscrow, String(15n * f.unit / 100n));
        assert.deepEqual(shared.openTasks[0].loan, { principal: "0", fee: "0", dueAt: "0", status: 0 });
        assert.deepEqual(shared.openTasks[0].feedback, { successSent: false, repaymentSent: false, successPending: false, repaymentPending: false, defaultPending: false });
        assert.ok(shared.profiles.every(profile => !profile.tasks.some(task => [openId, unlistedId].includes(task.id))));
        assert.equal(shared.profiles[0].debt, String(92n * f.unit / 1000n));
        await tx(f.identity, f.admin, "cheatSetWalletOnly", [1n, f.payee]);
        const changed = await readBounded();
        assert.equal(changed.profiles[0].credit.identity.changed, true);
        assert.equal(changed.profiles[0].credit.eligible, false);
        assert.equal(peakCredits, 1, "Underwriter credit requests must not overlap");
        assert.ok(peakRpc > 1 && peakRpc <= 8, `observed business RPC concurrency ${peakRpc}`);
        assert.equal(activeRpc, 0); assert.equal(activeDetection, 0); assert.equal(activeCredits, 0);
        t.diagnostic(`${decimals} decimals: peak credit=${peakCredits}, business RPC=${peakRpc}, chain detection=${peakDetection}, total=${peakTotal}`);
        // Exercise the real HTTP rejection and a later task RPC failure without exposing their payloads.
        const reports: unknown[][] = [], originalError = console.error;
        console.error = (...args: unknown[]) => { reports.push(args); };
        try {
          await assert.rejects(readDashboard({ ...deployment, agents: [{ id: "999999", name: "Missing Agent" }, ...deployment.agents.slice(1)] }), error => {
            assert.equal((error as { code: string }).code, "UNDERWRITER_HTTP_ERROR");
            assert.equal((error as { httpStatus: number }).httpStatus, 409); return true;
          });
          assert.equal(reports.length, 1); assert.equal(reports[0][0], "FRONTEND_READ_FAILED");
          assert.deepEqual(JSON.parse(String(reports[0][1])), { stage: "credit", errorClass: "Error", code: "UNDERWRITER_HTTP_ERROR", httpStatus: 409 });
          reports.length = 0;
          const canary = "DO_NOT_LOG_PRIVATE_RPC_PAYLOAD";
          const rpcFailure = Object.assign(new Error(canary), { code: "SERVER_ERROR", request: { url: canary, body: canary },
            cause: { message: canary }, info: { responseStatus: "429 Too Many Requests", error: { code: -32005, message: canary } } });
          const managerInterface = new Interface(MANAGER_ABI), managerAddress = deployment.contracts.manager.toLowerCase();
          const failingRpc: typeof createServerRpc = async rpcUrl => {
            const connection = await createServerRpc(rpcUrl), call = connection.provider.call.bind(connection.provider);
            connection.provider.call = async transaction => {
              if (String(transaction.to).toLowerCase() === managerAddress && transaction.data && managerInterface.parseTransaction({ data: transaction.data })?.name === "getLoan") throw rpcFailure;
              return call(transaction);
            };
            return connection;
          };
          await assert.rejects(readDashboard(deployment, failingRpc), error => error === rpcFailure);
          assert.equal(reports.length, 1); assert.equal(reports[0][0], "FRONTEND_READ_FAILED");
          assert.deepEqual(JSON.parse(String(reports[0][1])), { stage: "profile.tasks", method: "getLoan", errorClass: "Error", code: "SERVER_ERROR", httpStatus: 429, rpcCode: -32005 });
          assert.equal(JSON.stringify(reports).includes(canary), false);
        } finally { console.error = originalError; }
      } finally { browser?.provider.destroy(); await f.close(); }
    });
  } finally { await stopAnvil(local.child); await rm(dir, { recursive: true, force: true }); }
});
