import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Wallet } from "ethers";
import { DockerExecutor } from "@agentfuel/arena/docker";
import type { ProblemId } from "@agentfuel/arena";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../../services/underwriter/test/fixture.js";
import { FixedPriceSolvingRelay, FixedPriceRefunder } from "../../../services/provider-relay/src/fixed-price.js";
import { createHttpServer } from "../../../services/provider-relay/src/http.js";
import type { RelayConfig } from "../../../services/provider-relay/src/config.js";
import { createArenaHttpServer } from "../../../services/arena/src/http.js";
import type { ArenaConfig } from "../../../services/arena/src/protocol.js";
import type { WorkflowConfig, WorkflowOptions } from "../src/workflow.js";

export const GOOD_CODE: Record<ProblemId, string> = {
  "sum-integers": "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n",
  "unique-sorted": "import json,sys\nprint(json.dumps(sorted(set(json.load(sys.stdin)))))\n",
  "balanced-brackets": "import json,sys\ns=json.load(sys.stdin)\nstack=[]\nmatch={')':'(',']':'[','}':'{'}\nok=True\nfor c in s:\n if c in '([{': stack.append(c)\n elif not stack or stack.pop()!=match[c]: ok=False; break\nprint(json.dumps(ok and not stack))\n",
  "word-frequency": "import json,sys\nwords=json.load(sys.stdin)\ncounts={}\nfor w in words: counts[w]=counts.get(w,0)+1\nprint(json.dumps(counts))\n",
};
export function modelToolResponse(code: string, model: string) {
  return { model, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "fixture_call", type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
}
/** Test-only owned Anvil + Docker + separate settler; models are controlled unless explicitly host-injected. */
export async function createWorkflowFixture(directory: string, definitions: Array<{ problemId: ProblemId; open?: boolean; reward?: bigint; remaining?: number; agentId?: string | null }> = [{ problemId: "sum-integers", open: true }],
  trusted: { modelFetch?: typeof fetch; models?: { cheap: string; strong: string }; upstreams?: { cheap: { baseUrl: string; key: string }; strong: { baseUrl: string; key: string } }; upstreamTimeoutMs?: number } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const local = await startAnvil(), f = await fixture(local.rpc, join(directory, "underwriter"), 6, { refunderKey: key(4) });
  const ipc = await mkdtemp("/tmp/af-wf-ipc-");
  let settler: ReturnType<typeof spawn> | undefined, arena: ReturnType<typeof createArenaHttpServer> | undefined;
  let relay: FixedPriceSolvingRelay | undefined, server: ReturnType<typeof createHttpServer> | undefined;
  const queue: Array<string | "unknown"> = [], calls: any[] = [];
  const cleanup = async () => {
    if (server?.listening) await new Promise<void>(done => server!.close(() => done())); await arena?.close(); relay?.close();
    if (settler) await stopAnvil(settler); await f.close(); await stopAnvil(local.child); await rm(ipc, { recursive: true, force: true });
  };
  try {
    await f.provider.send("anvil_setBalance", [f.payee, "0x3635c9adc5dea00000"]); // Provider receives gas only, not refund token mints.
    const tasks: WorkflowConfig["tasks"] = [];
    for (const definition of definitions) {
      f.admin.reset(); const now = (await f.provider.getBlock("latest"))!.timestamp;
      const receipt = await tx(f.escrow, f.admin, "createTask", [definition.reward ?? 150000n, now + (definition.remaining ?? 1800)]);
      const event = receipt.logs.map((log: any) => { try { return f.escrow.interface.parseLog(log); } catch { return null; } }).find((event: any) => event?.name === "TaskCreated");
      const taskId = String(event!.args.taskId);
      if (!definition.open) { f.agent.reset(); await tx(f.escrow, f.agent, "acceptTask", [taskId, "1"]); }
      const task = await read(f.escrow, "getTask", [taskId]);
      tasks.push({ taskId, problemId: definition.problemId, deadlineMs: Number(task.deadline) * 1000, creditLimit: "80000" });
    }
    const arenaConfig: ArenaConfig = { rpcUrl: local.rpc, chainId: "31337", escrowAddress: await f.escrow.getAddress(), ipcDirectory: ipc,
      tasks: Object.fromEntries(tasks.map((task, i) => [task.taskId, { ...(definitions[i].agentId === null ? {} : { agentId: definitions[i].agentId ?? "1" }), problemId: task.problemId }])) };
    const arenaFile = join(directory, "arena.json"); await writeFile(arenaFile, JSON.stringify(arenaConfig), { mode: 0o600 });
    settler = spawn(process.execPath, ["--import", "tsx", new URL("../../../services/arena/src/settler-main.ts", import.meta.url).pathname], {
      cwd: new URL("../../..", import.meta.url).pathname, env: { ...process.env, ARENA_CONFIG: arenaFile, ARENA_VERIFIER_PRIVATE_KEY: key(1) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 10000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : done(); };
      settler!.stdout!.on("data", data => { if (String(data).includes('"ready":true')) finish(); });
      settler!.stderr!.on("data", () => finish(new Error("SETTLER_START_FAILED"))); settler!.once("error", finish); settler!.once("exit", () => finish(new Error("SETTLER_EXITED")));
    });
    arena = createArenaHttpServer(arenaConfig, [], f.provider, { save: journal => writeFile(join(directory, "arena-http-journal.json"), JSON.stringify(journal), { mode: 0o600 }) }); arena.server.listen(0, "127.0.0.1"); await once(arena.server, "listening");
    const relayConfig: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: "infercredit/solve-fixed", model: "pi-fixed-v1", price: 120000n, upstreams: [
        { name: "cheap", model: trusted.models?.cheap ?? "controlled-cheap", baseUrl: trusted.upstreams?.cheap.baseUrl ?? "https://cheap.invalid/v1", key: trusted.upstreams?.cheap.key ?? "synthetic-key" },
        { name: "strong", model: trusted.models?.strong ?? "controlled-strong", baseUrl: trusted.upstreams?.strong.baseUrl ?? "https://strong.invalid/v1", key: trusted.upstreams?.strong.key ?? "synthetic-key" }] }, dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1,
      upstreamTimeout: trusted.upstreamTimeoutMs ?? 3000, host: "127.0.0.1", port: 0, refunderKey: key(4), operatorToken: "controlled-workflow-operator-token-32-characters" };
    relay = new FixedPriceSolvingRelay(relayConfig, { provider: f.provider, runner: new DockerExecutor(), modelFetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      assert.equal(JSON.stringify(body).includes(key(2)), false); assert.equal(JSON.stringify(body).includes(key(4)), false); assert.equal(body.taskId, undefined);
      if (trusted.modelFetch) return trusted.modelFetch(url, init); // Host-only injection; never accepted from HTTP or model output.
      assert.ok(queue.length, "No unplanned controlled model request");
      const next = queue.shift()!; if (next === "unknown") throw new Error("Controlled dispatch unknown"); return Response.json(modelToolResponse(next, body.model));
    } });
    await relay.initialize(); const refunder = new FixedPriceRefunder(relay); await refunder.initialize();
    server = createHttpServer(relay, refunder); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const config: WorkflowConfig = { agentId: "1", chainId: "31337", account: relayConfig.account, asset: relayConfig.asset, escrowAddress: arenaConfig.escrowAddress,
      tasks, allowCredit: true, maxPrice: "120000", deadlineMs: Date.now() + 90000, minRemainingMs: 100, maxCompletionTokens: 256,
      providers: [{ id: "trusted-fixed", payTo: f.payee, relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`, service: "infercredit/solve-fixed", model: "pi-fixed-v1",
        routes: [{ tier: "cheap", price: "120000", capabilities: ["python3-json-stdio", "sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"],
          solve: { version: 1, tiers: ["cheap", "strong"], maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 256 } }] }] };
    const options: WorkflowOptions = { signer: new Wallet(key(2), f.provider), provider: f.provider, rpcUrl: local.rpc,
      arenaUrl: `http://127.0.0.1:${(arena.server.address() as { port: number }).port}`, underwriterUrl: f.http, walletLockDirectory: join(directory, "wallet"), timeoutMs: 5000, pollTimeoutMs: 15000 };
    return { directory, local, f, config, options, relayConfig, relay, refunder, arena, arenaConfig, calls, queue: (...code: string[]) => queue.push(...code), close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}
