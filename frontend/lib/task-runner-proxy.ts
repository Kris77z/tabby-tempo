import { TaskRunnerError, parseTaskRunnerCommand, taskRequestId, parseTaskRunnerSnapshot } from "@agentfuel/pi-loop/task-runner-types";
import { hasAllowedGameFiOrigin } from "./gamefi-origin.js";

const headers = { "Cache-Control": "no-store" };
function fail(code: string, status = 400): never { throw new TaskRunnerError(code, status); }
async function readJson(request: Request | Response, limit: number) {
  const reader = request.body?.getReader(); if (!reader) fail("TASK_JSON_REQUIRED");
  const parts: Uint8Array[] = []; let bytes = 0;
  try { while (true) {
    const item = await reader.read(); if (item.done) break;
    bytes += item.value.byteLength; if (bytes > limit) { await reader.cancel(); fail("TASK_BODY_TOO_LARGE", 413); }
    parts.push(item.value);
  } } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); } catch { fail("TASK_JSON_INVALID"); }
}
/** Fixed loopback server bridge; never forwards a browser-selected URL, credential or arbitrary command. */
export async function taskRunsRequest(request: Request, config: { upstreamUrl?: string; fetcher?: typeof fetch }) {
  try {
    if (!hasAllowedGameFiOrigin(request)) fail("TASK_INVALID_ORIGIN", 403);
    if (!["GET", "POST"].includes(request.method)) fail("TASK_METHOD_NOT_ALLOWED", 405);
    const incoming = new URL(request.url);
    if ([...incoming.searchParams.keys()].some(key => key !== "requestId") || incoming.searchParams.getAll("requestId").length > 1 || request.method === "POST" && incoming.search)
      fail("TASK_QUERY_INVALID");
    const requestId = incoming.searchParams.has("requestId") ? taskRequestId(incoming.searchParams.get("requestId")) : undefined;
    let command;
    if (request.method === "POST") {
      if (request.headers.get("content-type")?.toLowerCase().split(";")[0].trim() !== "application/json") fail("TASK_JSON_REQUIRED", 415);
      command = parseTaskRunnerCommand(await readJson(request, 2048));
    }
    if (!config.upstreamUrl) {
      if (request.method === "GET") return Response.json({ enabled: false, profiles: [], runs: [] }, { headers });
      fail("TASK_RUNNER_NOT_CONFIGURED", 503);
    }
    let base: URL; try { base = new URL(config.upstreamUrl); } catch { fail("TASK_RUNNER_CONFIG_INVALID", 503); }
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) fail("TASK_RUNNER_CONFIG_INVALID", 503);
    const target = new URL("/api/tasks/runs", base); if (requestId) target.searchParams.set("requestId", requestId);
    const response = await (config.fetcher ?? fetch)(target, { method: request.method, redirect: "error", cache: "no-store",
      headers: { "content-type": "application/json", origin: base.origin }, body: command ? JSON.stringify(command) : undefined,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
    const payload = await readJson(response, 262144);
    if (!response.ok) {
      const code = typeof payload?.error === "string" && /^(?:TASK|SESSION)_[A-Z_0-9]{1,80}$/.test(payload.error) ? payload.error : "TASK_RUNNER_UNAVAILABLE";
      return Response.json({ error: code }, { status: [400, 403, 404, 409, 413, 415, 503].includes(response.status) ? response.status : 503, headers });
    }
    return Response.json(parseTaskRunnerSnapshot(payload), { status: request.method === "POST" ? 202 : 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof TaskRunnerError ? error.code : "TASK_RUNNER_UNAVAILABLE" }, { status: error instanceof TaskRunnerError ? error.status : 503, headers });
  }
}
