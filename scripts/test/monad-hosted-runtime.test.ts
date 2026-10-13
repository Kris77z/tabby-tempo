import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMonadHostedBootstrap, type MonadHostedBootstrap } from "../monad-hosted-runtime.js";
import { MONAD_IDENTITY, MONAD_USDC } from "../demo-monad-config.js";
import { modelCatalogDigest } from "../../services/hosted-agents/src/metered-task.js";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-monad-runtime-catalog-")));
  const put = async (name: string, value: unknown) => { const file = join(directory, name); await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); return file; };
  const rpcUrlFile = await put("rpc.txt", "https://rpc.example.test"), vendorKeyFile = await put("vendor.key", "synthetic-vendor"), keyFile = await put("gateway.key", "synthetic-gateway");
  const gateway = { url: "http://127.0.0.1:3426/v1", endpoint: "http://127.0.0.1:3426/v1/chat/completions", keyFile,
    models: [{ id: "cheap", model: "cheap/kimi-k2.6", responseModel: "kimi-k2.6" }, { id: "strong", model: "strong/kimi-k3", responseModel: "kimi-k3" }] };
  const gatewayReadyFile = await put("gateway-ready.json", gateway), address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const bootstrap: MonadHostedBootstrap = {
    version: 1, chainId: "10143", contracts: { account: address(1), adapter: address(2), escrow: address(3), manager: address(4) }, deploymentBlock: 5,
    asset: { address: MONAD_USDC, symbol: "USDC", decimals: 6 }, identity: MONAD_IDENTITY, payTo: address(6), publicRpcUrl: "https://rpc.example.test", rpcUrlFile, rpcTransport: "direct",
    roleKeyFiles: Object.fromEntries(["guardian", "underwriter", "verifier", "refunder", "sponsor", "opponent"].map(role => [role, join(directory, `${role}.key`)])) as MonadHostedBootstrap["roleKeyFiles"],
    opponentBinding: { chainId: "10143", agentId: "1", wallet: address(7) }, dashboardAgents: [1, 2, 3].map(id => ({ id: String(id), name: `Agent ${id}` })),
    gatewayReadyFile, vendorKeyFile, tasks: [1, 2, 3, 4].map(id => ({ taskId: String(id), problemId: "sum-integers", deadlineMs: Date.now() + 60000, creditLimit: "80000" })), maxFeePerGas: "100000000000", frontendOrigin: "http://127.0.0.1:3024",
  };
  const path = await put("bootstrap.json", bootstrap);
  return { directory, put, gateway, bootstrap, path, close: () => rm(directory, { recursive: true, force: true }) };
}

for (const ids of [["cheap", "strong"], ["kimi-k2.6", "kimi-k3"], ["cheap", "kimi-k3"], ["kimi-k2.6", "strong"]]) {
  test(`bootstrap preserves ${ids.join("/")} logical IDs and the original paid catalog/domain digest`, async () => {
    const f = await fixture();
    try {
      const gateway = { ...f.gateway, models: f.gateway.models.map((model, index) => ({ ...model, id: ids[index] })) };
      await f.put("gateway-ready.json", gateway);
      const filesBefore = await Promise.all([f.path, f.bootstrap.gatewayReadyFile].map(file => readFile(file, "utf8")));
      // This is the persisted pre-goal catalog shape and ordering, including the original logical IDs.
      const expectedCatalog = gateway.models.map((model, index) => ({ id: model.id, model: model.model, responseModel: model.responseModel, route: gateway.endpoint,
        inputMicroCreditsPerToken: index ? "3" : "1", outputMicroCreditsPerToken: index ? "6" : "2", maxCompletionTokens: 1024 }));
      const loaded = await loadMonadHostedBootstrap(f.path);
      assert.deepEqual(loaded.catalog, expectedCatalog); assert.equal(modelCatalogDigest(loaded.catalog), modelCatalogDigest(expectedCatalog));
      assert.deepEqual(loaded.bootstrap, f.bootstrap); assert.deepEqual(loaded.gateway, gateway);
      const binding = (bootstrap: MonadHostedBootstrap, catalog: unknown) => {
        const { dashboardAgents: _ignored, ...executionBootstrap } = bootstrap;
        return createHash("sha256").update(JSON.stringify({ bootstrap: executionBootstrap, gateway: { url: gateway.url, endpoint: gateway.endpoint, keyFile: gateway.keyFile }, catalog })).digest("hex");
      };
      assert.equal(binding(loaded.bootstrap, loaded.catalog), binding(f.bootstrap, expectedCatalog));
      assert.deepEqual(await Promise.all([f.path, f.bootstrap.gatewayReadyFile].map(file => readFile(file, "utf8"))), filesBefore);
      if (ids[0] === "cheap") assert.notEqual(modelCatalogDigest(loaded.catalog), modelCatalogDigest(loaded.catalog.map((model, index) => ({ ...model, id: ["kimi-k2.6", "kimi-k3"][index] }))));
    } finally { await f.close(); }
  });
}

test("aliases do not permit a different physical/response model, unknown ID or swapped tier binding", async () => {
  const f = await fixture();
  try {
    for (const models of [
      [{ ...f.gateway.models[0], id: "unknown" }, f.gateway.models[1]],
      [{ ...f.gateway.models[0], model: "cheap/other" }, f.gateway.models[1]],
      [f.gateway.models[0], { ...f.gateway.models[1], responseModel: "other" }],
      [{ ...f.gateway.models[0], id: "strong" }, { ...f.gateway.models[1], id: "cheap" }],
    ]) {
      await f.put("gateway-ready.json", { ...f.gateway, models });
      await assert.rejects(loadMonadHostedBootstrap(f.path), /MONAD_GATEWAY_MODELS_INVALID/);
    }
  } finally { await f.close(); }
});
