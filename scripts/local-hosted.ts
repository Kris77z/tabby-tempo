import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract, JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { createWorkflowFixture } from "../packages/pi-loop/test/workflow-fixture.js";
import { key, tx } from "../services/underwriter/test/fixture.js";
import { DockerExecutor } from "../services/arena/src/docker.js";
import { InferenceAllowanceRelay, ALLOWANCE_MODEL, ALLOWANCE_SERVICE } from "../services/provider-relay/src/allowance.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import { validateGatewayCatalog } from "../services/hosted-agents/src/inference-gateway.js";
import { modelCatalogDigest } from "../services/hosted-agents/src/metered-task.js";
import { loadHostedDaemonConfig } from "./hosted-agents.js";

async function launchDaemon(configFile: string, recover: boolean) {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/hosted-agents.ts"), "--start", ...(recover ? ["--recover"] : [])], {
    env: { ...process.env, HOSTED_AGENTS_CONFIG: configFile }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("LOCAL_HOSTED_START_TIMEOUT")); }, 30000);
    let output = "";
    child.stdout!.on("data", chunk => { output += chunk.toString(); if (output.includes('"ready":true')) { clearTimeout(timer); done(); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`LOCAL_HOSTED_EXIT:${code}`)); });
  });
  return child;
}
async function stopDaemon(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}

/** Development-only live stack. Real production adapters/models; mock registries and USDC on owned Anvil. */
export async function startLocalHosted(directory: string, gatewayFile: string, vendorKeyFile: string) {
  await new DockerExecutor().ready();
  const gateway = JSON.parse(await readFile(gatewayFile, "utf8"));
  if (gateway.url !== "http://127.0.0.1:3426/v1" || gateway.models?.length !== 2) throw new Error("LOCAL_GATEWAY_CONFIG_INVALID");
  const gatewayKey = (await readFile(gateway.keyFile, "utf8")).trim();
  await mkdir(directory, { mode: 0o700 }); // Never silently replace an existing chain or paid task journal.
  const put = async (name: string, value: unknown) => {
    const file = join(directory, name); await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 }); return file;
  };
  const problems = ["sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"] as const;
  const fx = await createWorkflowFixture(join(directory, "chain"), Array.from({ length: 16 }, (_, i) => ({ problemId: problems[i % 4], open: true, agentId: null, remaining: 86400 })), {
    models: { cheap: "cheap/kimi-k2.6", strong: "strong/kimi-k3" },
    upstreams: { cheap: { baseUrl: gateway.url, key: gatewayKey }, strong: { baseUrl: gateway.url, key: gatewayKey } },
    upstreamTimeoutMs: 120000, modelFetch: fetch,
  });
  const relays: Relay[] = [], servers: ReturnType<typeof createHttpServer>[] = [];
  let hosted: ChildProcess | undefined;
  let reload: (() => void) | undefined;
  const close = async () => {
    if (reload) process.off("SIGUSR2", reload);
    await stopDaemon(hosted);
    for (const server of servers) await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); });
    for (const relay of relays) relay.close();
    await fx.close();
  };
  try {
    for (const index of [5, 6]) {
      fx.f.admin.reset(); const wallet = new Wallet(key(index)).address;
      await tx(fx.f.identity, fx.f.admin, "registerFor", [wallet, wallet]);
      await tx(fx.f.manager, fx.f.admin, "enrollAgent", [String(index - 3)]);
    }
    const catalog = validateGatewayCatalog(gateway.models.map((model: any, i: number) => ({ ...model, route: gateway.endpoint,
      inputMicroCreditsPerToken: i ? "3" : "1", outputMicroCreditsPerToken: i ? "6" : "2", maxCompletionTokens: 1024 })));
    if (!["kimi-k2.6", "cheap"].includes(catalog[0].id) || !["kimi-k3", "strong"].includes(catalog[1].id) || catalog[0].model !== "cheap/kimi-k2.6" || catalog[1].model !== "strong/kimi-k3"
      || catalog[0].responseModel !== "kimi-k2.6" || catalog[1].responseModel !== "kimi-k3") throw new Error("LOCAL_GATEWAY_MODELS_INVALID");
    const allowance = new InferenceAllowanceRelay({ ...fx.relayConfig, dataDir: join(directory, "allowance"), service: {
      id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
      upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }],
    } }, { provider: fx.f.provider, creditsRaw: "200000", modelCatalogDigest: modelCatalogDigest(catalog) });
    const planner = new Relay({ ...fx.relayConfig, dataDir: join(directory, "planner"), upstreamTimeout: 120000, service: {
      id: "infercredit/plan", model: "logical-planner", price: 10000n,
      upstreams: [{ name: "magpie-cheap", model: "cheap/kimi-k2.6", baseUrl: gateway.url, key: gatewayKey }],
    } }, { provider: fx.f.provider });
    // Personal goals use cash-only task 0 payments. Each model has an isolated
    // quote journal and fixed per-call price, distinct from task allowances.
    const goalRelays = catalog.map((model, index) => new Relay({ ...fx.relayConfig, dataDir: join(directory, `goal-${model.id}`), upstreamTimeout: 120000, service: {
      id: "tabby/mission", model: model.id, price: index ? 20000n : 10000n,
      upstreams: [{ name: `magpie-${model.id}`, model: model.model, baseUrl: gateway.url, key: gatewayKey }],
    } }, { provider: fx.f.provider }));
    for (const relay of [allowance, planner, ...goalRelays]) {
      relays.push(relay); await relay.initialize();
      const refunder = new Refunder(relay); await refunder.initialize();
      const server = createHttpServer(relay, refunder); servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    }
    const relayUrl = (i: number) => `http://127.0.0.1:${(servers[i].address() as { port: number }).port}/v1/chat`;
    const rpcUrlFile = await put("rpc.txt", fx.local.rpc), guardianKeyFile = await put("guardian.key", key(1));
    const sponsorKeyFile = await put("sponsor.key", key(4)), opponentKeyFile = await put("opponent.key", key(2));
    await put("owner.key", Wallet.createRandom().privateKey);
    fx.f.admin.reset(); await tx(fx.f.token!, fx.f.admin, "mint", [fx.f.payee, 1000000n]);
    const walletDirectory = join(directory, "wallets"), models = ["kimi-k2.6", "kimi-k3"];
    const taskModels = models.map((id, i) => {
      const base = structuredClone(fx.config); base.deadlineMs = Date.now() + 86400000; base.maxCompletionTokens = 1024;
      base.providers[0].routes[0].tier = i ? "strong" : "cheap";
      base.providers[0].routes[0].solve = { version: 1, tiers: i ? ["strong", "strong"] : ["cheap", "strong"], maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 1024 };
      return { id, physicalModels: { cheap: "cheap/kimi-k2.6", strong: "strong/kimi-k3" }, templates: Object.fromEntries(["conservative", "balanced", "aggressive"].map(s => [s, structuredClone(base)])) };
    });
    const taskConfigFile = await put("task.json", { version: 1, identity: await fx.f.identity.getAddress(), guardianKeyFile, initialCashRaw: "0", rpcUrlFile,
      rpcTransport: "direct", publicRpcUrl: fx.local.rpc, walletDirectory, arenaUrl: fx.options.arenaUrl, underwriterUrl: fx.options.underwriterUrl,
      models: taskModels, timeoutMs: 120000, pollTimeoutMs: 120000,
      metered: { relayUrl: relayUrl(0), payTo: fx.f.payee, priceRaw: "120000", creditsRaw: "200000", catalog, keyFile: gateway.keyFile } });
    const gameConfigFile = await put("game.json", { version: 1, chainId: "31337", identity: await fx.f.identity.getAddress(), account: fx.config.account, token: fx.config.asset,
      publicRpcUrl: fx.local.rpc, rpcTransport: "direct", upstreamTransport: "system-https-proxy", walletDirectory, sponsorKeyFile,
      opponent: { binding: { chainId: "31337", agentId: "1", wallet: new Wallet(key(2)).address }, keyFile: opponentKeyFile, modelId: "kimi-k2.6", strategy: "balanced" },
      models: models.map(id => ({ id, baseUrl: "https://api.moonshot.cn/v1", keyFile: vendorKeyFile })), creditsDirectory: join(directory, "credits") });
    const hostedConfigFile = await put("hosted.json", { version: 1, port: 8791,
      hosted: { directory: join(directory, "hosted"), origin: "http://127.0.0.1:3024", chainId: "31337", models: models.map(id => ({ id, label: id === "kimi-k2.6" ? "Kimi K2.6" : "Kimi K3" })),
        maxAgentsPerOwner: 6, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" }, executor: { taskConfigFile, gameConfigFile },
      goals: { chainLookup: true, durationMs: 600000, models: catalog.map((model, index) => ({ id: models[index], relayUrl: relayUrl(index + 2), provider: fx.f.payee,
        priceRaw: goalRelays[index].config.service.price.toString(), service: "tabby/mission", model: model.id, physicalModel: model.model, responseModel: model.responseModel })) },
      autonomy: { maxTasks: 2, maxDecisions: 3, durationMs: 600000, plannerRelayUrl: relayUrl(1), plannerProvider: fx.f.payee, plannerPriceRaw: "10000",
        plannerService: "infercredit/plan", plannerModel: "logical-planner", plannerPhysicalModel: "cheap/kimi-k2.6", plannerResponseModel: "kimi-k2.6" } });
    await loadHostedDaemonConfig(hostedConfigFile);
    hosted = await launchDaemon(hostedConfigFile, false);
    let reloading = false;
    reload = () => { if (reloading) return; reloading = true;
      void (async () => { await stopDaemon(hosted); hosted = await launchDaemon(hostedConfigFile, true); console.log("LOCAL_HOSTED_RELOADED"); })()
        .catch(() => console.error("LOCAL_HOSTED_RELOAD_FAILED" )).finally(() => { reloading = false; });
    };
    process.on("SIGUSR2", reload);
    const manifestFile = await put("deployment.json", { chainId: "31337", network: "Local Anvil · real Kimi models", deploymentBlock: 0, rpcUrl: fx.local.rpc,
      underwriterUrl: fx.options.underwriterUrl, explorerUrl: "", asset: { address: fx.config.asset, symbol: "USDC", decimals: 6 },
      contracts: { manager: await fx.f.manager.getAddress(), adapter: await fx.f.adapter.getAddress(), account: fx.config.account, escrow: fx.config.escrowAddress },
      agents: [{ id: "1", name: "Local game opponent" }, { id: "2", name: "Local test identity A" }, { id: "3", name: "Local test identity B" }],
      providers: [{ name: "Local allowance", address: fx.f.payee, relayUrl: relayUrl(0), service: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL }], arenaUrl: fx.options.arenaUrl });
    const ready = { version: 1, pid: process.pid, startedAt: new Date().toISOString(), chainId: "31337", rpcUrl: fx.local.rpc,
      token: fx.config.asset, identity: await fx.f.identity.getAddress(), account: fx.config.account, hostedUrl: "http://127.0.0.1:8791",
      frontendOrigin: "http://127.0.0.1:3024", manifestFile, hostedConfigFile, gateway: gateway.url, models, taskCount: 16,
      registryMode: "local mocks", assetMode: "local test USDC", inference: "real Kimi K2.6/K3 via Magpie", gasSponsorship: false };
    await put("ready.json", ready); return { ready, close };
  } catch (error) { await close(); throw error; }
}

/** Explicit terminal faucet; never exposed as a production HTTP endpoint or automatic sponsorship. */
export async function fundLocalWallet(directory: string, wallet: string, raw: string) {
  const ready = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
  if (ready.chainId !== "31337" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.rpcUrl) || !/^[0-9]+$/.test(raw) || BigInt(raw) > 1000000n) throw new Error("LOCAL_FAUCET_ONLY");
  const provider = new JsonRpcProvider(ready.rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("LOCAL_FAUCET_ONLY");
    await provider.send("anvil_setBalance", [wallet, "0xde0b6b3a7640000"]);
    if (BigInt(raw)) await tx(new Contract(ready.token, ["function mint(address,uint256)"], provider), new NonceManager(new Wallet(key(1), provider)), "mint", [wallet, raw]);
    console.log(JSON.stringify({ funded: wallet, testUsdcRaw: raw, chainId: "31337" }));
  } finally { provider.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory, arg, extra] = process.argv.slice(2);
  if (mode === "fund" && directory && arg && extra) fundLocalWallet(resolve(directory), arg, extra).catch(error => { console.error(error.message); process.exitCode = 1; });
  else if (mode === "start" && directory && arg && extra) startLocalHosted(resolve(directory), resolve(arg), resolve(extra)).then(runtime => {
    console.log(JSON.stringify(runtime.ready));
    const stop = () => { void runtime.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
  else { console.error("Usage: local-hosted.ts start DIRECTORY GATEWAY_READY VENDOR_KEY_FILE | fund DIRECTORY WALLET TEST_USDC_RAW"); process.exitCode = 1; }
}
