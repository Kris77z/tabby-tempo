import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { taskRunsRequest } from "../lib/task-runner-proxy";

const origin = "http://127.0.0.1:3020", upstreamUrl = "http://127.0.0.1:8790";
const request = (method = "GET", body?: unknown, path = "/api/tasks/runs") => new Request(origin + path, { method, headers: { origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = { enabled: true, profiles: [{ profileId: "demo", label: "Local demo", chainId: "31337", agentId: "1", problemIds: ["sum-integers"] }], runs: [] };

test("task bridge forwards only validated commands to fixed loopback path, without browser secrets or retries", async () => {
  let calls = 0; const command = { action: "start", requestId: randomUUID(), profileId: "demo" };
  const fetcher: typeof fetch = async (url, options) => {
    calls++; assert.equal(String(url), upstreamUrl + "/api/tasks/runs"); assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    assert.deepEqual(JSON.parse(String(options?.body)), command); assert.equal((options?.headers as any).origin, upstreamUrl);
    assert.equal((options?.headers as any).authorization, undefined); assert.equal((options?.headers as any).cookie, undefined);
    return Response.json(snapshot);
  };
  const sent = request("POST", command); sent.headers.set("authorization", "do-not-forward"); sent.headers.set("cookie", "do-not-forward");
  const result = await taskRunsRequest(sent, { upstreamUrl, fetcher }); assert.equal(result.status, 202); assert.equal(result.headers.get("cache-control"), "no-store"); assert.deepEqual(await result.json(), snapshot); assert.equal(calls, 1);
  let failures = 0; const failed = await taskRunsRequest(request("POST", { action: "recover", requestId: command.requestId }), { upstreamUrl, fetcher: async () => { failures++; throw new Error("private-rpc-or-key"); } });
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "TASK_RUNNER_UNAVAILABLE" }); assert.equal(failures, 1);
});

test("task bridge rejects foreign origins, commands, targets and oversize data before forwarding", async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; return Response.json(snapshot); };
  const foreign = request("POST", { action: "start", requestId: randomUUID(), profileId: "demo" }); foreign.headers.set("origin", "https://foreign.invalid");
  assert.equal((await taskRunsRequest(foreign, { upstreamUrl, fetcher })).status, 403);
  for (const body of [{ action: "start", requestId: randomUUID(), profileId: "demo", privateKey: "forbidden" }, { action: "recover", requestId: "../path" }, { text: "x".repeat(3000) }]) assert.ok((await taskRunsRequest(request("POST", body), { upstreamUrl, fetcher })).status >= 400);
  for (const url of ["http://remote.invalid", "http://127.0.0.1:8790/other", "http://user:pass@127.0.0.1", "http://127.0.0.1?secret=x"]) assert.equal((await taskRunsRequest(request(), { upstreamUrl: url, fetcher })).status, 503);
  assert.equal((await taskRunsRequest(request("GET", undefined, "/api/tasks/runs?url=http://bad"), { upstreamUrl, fetcher })).status, 400);
  assert.equal(calls, 0);
});

test("task bridge is disabled without configuration and never returns arbitrary upstream evidence", async () => {
  assert.deepEqual(await (await taskRunsRequest(request(), {})).json(), { enabled: false, profiles: [], runs: [] });
  const result = await taskRunsRequest(request(), { upstreamUrl, fetcher: async () => Response.json({ ...snapshot, rawTransaction: "private-signature", config: { key: "private" } }) });
  const text = await result.text(); assert.equal(text.includes("private"), false);
  const failure = await taskRunsRequest(request(), { upstreamUrl, fetcher: async () => Response.json({ error: "private-key-and-rpc" }, { status: 500 }) });
  assert.deepEqual(await failure.json(), { error: "TASK_RUNNER_UNAVAILABLE" }); assert.equal(failure.status, 503);
});
