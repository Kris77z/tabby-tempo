import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startMagpie } from "../magpie-gateway.js";
import { InferenceGateway, createMagpieDispatch, type GatewayModel, type GatewayRequest } from "../../services/hosted-agents/src/inference-gateway.js";

async function close(server: Server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); }
async function freePort() {
  const server = createTcpServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

test("actual locked Magpie routes two metered tool-call models, preserves physical usage and caches without extra upstream calls", { timeout: 60000 }, async () => {
  assert.ok(process.env.MAGPIE_BIN, "Set MAGPIE_BIN to the locked local build; this integration does not silently skip");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-metered-magpie-")));
  const upstreams: Server[] = [], observed: { provider: string; body: any; auth: string | undefined }[] = [];
  let magpie: Awaited<ReturnType<typeof startMagpie>> | undefined, ledger: InferenceGateway | undefined;
  try {
    const providers = [];
    for (const name of ["cheap", "strong"] as const) {
      const model = `${name}-physical`, key = `synthetic-${name}-key`;
      const server = createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
        let text = ""; for await (const chunk of req) text += String(chunk);
        const body = JSON.parse(text); observed.push({ provider: name, body, auth: req.headers.authorization });
        if (body.model !== model || req.headers.authorization !== `Bearer ${key}`) { res.writeHead(400); res.end('{"error":"routing mismatch"}'); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `controlled-${name}`, object: "chat.completion", created: 1700000000, model,
          choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
            tool_calls: [{ id: `sample-${name}`, type: "function", function: { name: "test_public_sample", arguments: '{"code":"print(9)"}' } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
      });
      upstreams.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
      providers.push({ id: name, model, key, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
    }
    magpie = await startMagpie({ binary: process.env.MAGPIE_BIN, stateDirectory: join(directory, "magpie"), port: await freePort(), providers });
    const endpoint = `${magpie.url}/v1/chat/completions`;
    const catalog: [GatewayModel, GatewayModel] = [
      { id: "cheap", model: "cheap/cheap-physical", responseModel: "cheap-physical", route: endpoint, inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 256 },
      { id: "strong", model: "strong/strong-physical", responseModel: "strong-physical", route: endpoint, inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens: 256 },
    ];
    const binding = { agentId: "1", taskId: "1", wallet: `0x${"11".repeat(20)}` }, dispatch = createMagpieDispatch({ baseUrl: `${magpie.url}/v1`, apiKey: "magpie" });
    ledger = await InferenceGateway.open(join(directory, "ledger"), binding, catalog, dispatch);
    await ledger.grant("controlled-game-reward", "100000", { kind: "game", rewardId: "controlled-game-reward" });
    const request = (model: "cheap" | "strong"): GatewayRequest => ({ model, max_completion_tokens: 100, messages: [{ role: "user", content: "Solve the controlled public sample." }],
      ...(model === "cheap" ? { thinking: { type: "disabled" } } : { reasoning_effort: "low" }),
      tools: [{ type: "function", function: { name: "test_public_sample", description: "Test the public sample", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } } }] });
    const cheap = await ledger.invoke("round:0", request("cheap")), strong = await ledger.invoke("round:1", request("strong"));
    assert.equal(cheap.chargedCredits, "50"); assert.equal(strong.chargedCredits, "150");
    assert.equal((cheap.response as any).model, "cheap-physical"); assert.equal((strong.response as any).model, "strong-physical");
    for (const result of [cheap, strong]) {
      assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 20 });
      assert.equal((result.response as any).choices[0].message.tool_calls[0].function.name, "test_public_sample");
    }
    assert.deepEqual(observed.map(call => [call.provider, call.body.model, call.auth]), [
      ["cheap", "cheap-physical", "Bearer synthetic-cheap-key"], ["strong", "strong-physical", "Bearer synthetic-strong-key"],
    ]);
    assert.ok(observed.every(call => call.body.tools[0].function.name === "test_public_sample"));
    assert.equal(ledger.balance().spentCredits, "200"); assert.equal(ledger.balance().availableCredits, "99800");
    assert.deepEqual(await ledger.invoke("round:0", request("cheap")), cheap); assert.equal(observed.length, 2);
    await ledger.close(); ledger = await InferenceGateway.open(join(directory, "ledger"), binding, catalog, dispatch);
    assert.deepEqual(await ledger.invoke("round:1", request("strong")), strong); assert.equal(observed.length, 2);
    assert.equal(ledger.balance().spentCredits, "200"); assert.equal(ledger.balance().reservedCredits, "0");
    const persisted = await readFile(join(directory, "ledger/session.json"), "utf8");
    assert.ok(!persisted.includes("synthetic-cheap-key") && !persisted.includes("synthetic-strong-key"));
  } finally {
    await ledger?.close(); await magpie?.close(); await Promise.all(upstreams.map(close)); await rm(directory, { recursive: true, force: true });
  }
});
