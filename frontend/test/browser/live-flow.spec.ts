import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Wallet } from "ethers";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../../services/underwriter/test/fixture.js";
import { createHttpServer as underwriterServer } from "../../../services/underwriter/src/http.js";
import { Relay } from "../../../services/provider-relay/src/relay.js";
import { Refunder } from "../../../services/provider-relay/src/refunder.js";
import { createHttpServer as relayServer } from "../../../services/provider-relay/src/http.js";
import { createArenaHttpServer } from "../../../services/arena/src/http.js";
import { validateDeployment } from "../../lib/config";
import { readDashboard } from "../../lib/read";

const origin = "http://127.0.0.1:3010";
async function listen(server: Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
const close = (server?: Server) => !server?.listening ? Promise.resolve() : new Promise<void>(resolve => server.close(() => resolve()));

test("browser wallet → real task/SDK payment → signed Python Arena submission → atomic settlement", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Wallet integration runs once; the separate mobile test verifies layout and interactions.");
  test.setTimeout(120_000);
  const directory = await mkdtemp("/tmp/ifu-"); const local = await startAnvil();
  const f = await fixture(local.rpc, join(directory, "evidence"), 18);
  let relay: Relay | undefined, relayHttp: Server | undefined, creditHttp: Server | undefined, upstream: Server | undefined;
  let arena: ReturnType<typeof createArenaHttpServer> | undefined, settler: ChildProcess | undefined;
  const logicalRequests: Record<string, unknown>[] = [], walletRequests: string[] = [];
  try {
    for (const id of [2n, 3n]) { await tx(f.identity, f.admin, "registerFor", [f.agentAddress, f.agentAddress]); await tx(f.manager, f.admin, "enrollAgent", [id]); }
    creditHttp = underwriterServer(f.underwriter, origin); const underwriterUrl = await listen(creditHttp);
    const python = "import json,sys\nprint(json.dumps(sum(json.loads(sys.stdin.readline()))))\n";
    // Only inference text is controlled. Money, authorization, receipt, Docker tests and settlement are real local execution.
    upstream = createServer(async (req, res) => {
      let content = ""; for await (const chunk of req) content += chunk;
      const input = JSON.parse(content);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: python } }], model: input.model, usage: { total_tokens: 20 } }));
    });
    const upstreamUrl = await listen(upstream);
    relay = new Relay({ rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
      assetDecimals: 18, payTo: f.payee, service: { id: "infercredit/coder", model: "coder", price: 12n * f.unit / 100n,
        upstreams: [{ name: "controlled-local-upstream", baseUrl: upstreamUrl, model: "physical-local-model", key: "local-test-placeholder" }] },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 2000, host: "127.0.0.1", port: 8788, frontendOrigin: origin });
    await relay.initialize(); const refunder = new Refunder(relay); await refunder.initialize(); relayHttp = relayServer(relay, refunder); const relayUrl = await listen(relayHttp);
    const arenaConfig = { rpcUrl: local.rpc, chainId: "31337", escrowAddress: await f.escrow.getAddress(),
      tasks: { "1": { agentId: "1", problemId: "sum-integers" as const } }, ipcDirectory: join(directory, "ipc") };
    const configFile = join(directory, "arena.json"); await writeFile(configFile, JSON.stringify(arenaConfig), { mode: 0o600 });
    // The verifier key exists exclusively in this independent local settler process.
    settler = spawn(process.execPath, ["--import", "tsx", new URL("../../../services/arena/src/settler-main.ts", import.meta.url).pathname],
      { cwd: new URL("../../..", import.meta.url).pathname, env: { ...process.env, FORCE_COLOR: undefined, ARENA_CONFIG: configFile, ARENA_VERIFIER_PRIVATE_KEY: key(1) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Settler startup timed out")), 10_000);
      settler!.stdout!.on("data", chunk => { if (String(chunk).includes('"ready":true')) { clearTimeout(timer); resolve(); } });
      settler!.stderr!.on("data", chunk => { if (/^[A-Z_]+$/m.test(String(chunk))) { clearTimeout(timer); reject(new Error("Independent settler startup failed")); } });
      settler!.on("error", reject);
    });
    arena = createArenaHttpServer(arenaConfig, [origin]); const arenaUrl = await listen(arena.server);
    const config = validateDeployment({ chainId: "31337", network: "Local Anvil browser integration", rpcUrl: local.rpc, explorerUrl: "", deploymentBlock: 0, underwriterUrl,
      asset: { address: f.config.settlementAsset, symbol: "MON", decimals: 18 },
      contracts: { manager: await f.manager.getAddress(), adapter: await f.adapter.getAddress(), account: await f.account.getAddress(), escrow: await f.escrow.getAddress() },
      agents: [1, 2, 3].map(id => ({ id: String(id), name: `Agent ${id}` })),
      providers: [{ name: "Local compute", address: f.payee, relayUrl, service: "infercredit/coder", model: "coder" }], arenaUrl });
    await f.provider.send("anvil_impersonateAccount", [f.agentAddress]);
    // Test EIP-1193 wallet bridge: synthetic signing stays in Node, no private key enters the page.
    await page.exposeFunction("testWalletRpc", async ({ method, params }: { method: string; params?: unknown[] }) => {
      walletRequests.push(method);
      try {
        let result: unknown;
        if (method === "eth_requestAccounts" || method === "eth_accounts") result = [f.agentAddress];
        else if (method === "eth_signTypedData_v4") {
          const payload = JSON.parse(String(params![1])); const types = { ...payload.types }; delete types.EIP712Domain;
          result = await new Wallet(key(2)).signTypedData(payload.domain, types, payload.message);
        } else result = await f.provider.send(method, params || []);
        return { result };
      } catch (error) {
        // Preserve structured EIP-1193 error data across Playwright's Node/browser boundary.
        const e = error as { data?: unknown; info?: { error?: { data?: unknown } } };
        return { error: { code: -32000, message: "Local test RPC rejected the call", data: e.data || e.info?.error?.data } };
      }
    });
    await page.addInitScript(() => {
      const target = window as unknown as { ethereum: { request: (request: unknown) => Promise<unknown> }; testWalletRpc: (request: unknown) => Promise<unknown> };
      target.ethereum = { request: async request => {
        const response = await target.testWalletRpc(request) as { result?: unknown; error?: unknown };
        if (response.error) throw response.error;
        return response.result;
      } };
    });
    await page.route("**/api/dashboard", async route => { await route.fulfill({ json: await readDashboard(config) }); });
    page.on("request", request => { if (request.url() === `${relayUrl}/v1/chat` && request.method() === "POST") logicalRequests.push(JSON.parse(request.postData()!)); });
    await page.goto("/advanced"); await page.getByRole("button", { name: "刷新链上数据" }).click();
    await expect(page.getByText("Local Anvil browser integration", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "连接钱包" }).click();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /演示面板/ }).click();
    await page.getByRole("button", { name: "创建并托管任务" }).click();
    await expect(page.getByText("createTask 已确认。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "接受任务" }).click();
    await expect(page.getByText("acceptTask 已确认。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Logical model")).toHaveValue("coder");
    await page.getByRole("button", { name: "获取报价并付款" }).click();
    await expect(page.getByText("推理已交付，receipt 与链上付款相对应。", { exact: true })).toBeVisible({ timeout: 25_000 });
    expect(logicalRequests[0].service).toBe("infercredit/coder"); expect(logicalRequests[0].model).toBe("coder");
    expect(logicalRequests[0].taskId).toBe("1");
    expect((await read(f.manager, "getLoan", [1])).principal).toBe(8n * f.unit / 100n);
    expect(await f.providerBalance()).toBe(12n * f.unit / 100n);
    await page.getByRole("button", { name: "使用推理返回代码" }).click();
    await expect(page.getByLabel("提交代码 · Python 3 stdin / stdout")).toHaveValue(python.trim());
    await page.getByRole("button", { name: "签名并提交验收" }).click();
    await expect(page.getByText("可信 controller 已验收，链上结算回执已核验。", { exact: true })).toBeVisible({ timeout: 45_000 });
    expect(walletRequests).toContain("eth_signTypedData_v4");
    expect((await read(f.manager, "getLoan", [1])).status).toBe(2n);
    expect(await read(f.manager, "repaymentCount", [1])).toBe(1n);
    expect((await read(f.escrow, "getTask", [1])).status).toBe(3n);
    await page.getByRole("button", { name: "验证白名单拒绝" }).click();
    await expect(page.getByText("SpendRejected", { exact: true })).toBeVisible();
    await expect(page.getByText("目标 Provider 未加入白名单，资金无法转出。")).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await arena?.close(); if (settler) await stopAnvil(settler);
    await close(relayHttp); relay?.close(); await close(creditHttp); await close(upstream);
    await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true });
  }
});
