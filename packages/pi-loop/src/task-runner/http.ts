import { createServer, type IncomingMessage } from "node:http";
import { TaskRunner } from "./runner.js";
import { TaskRunnerError, parseTaskRunnerCommand, parseTaskRunnerSnapshot } from "./types.js";

const PATH = "/api/tasks/runs";
/** No proxy trust or CORS. A Next server bridge can call the same fixed loopback URL. */
function authorize(request: IncomingMessage) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) throw new TaskRunnerError("TASK_LOOPBACK_ONLY", 403);
  const port = request.socket.localPort, host = request.headers.host;
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) throw new TaskRunnerError("TASK_INVALID_HOST", 403);
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}` || request.headers["sec-fetch-site"] === "cross-site" || request.headers["sec-fetch-site"] === "same-site") throw new TaskRunnerError("TASK_INVALID_ORIGIN", 403);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if ((request.headers["content-type"] ?? "").toLowerCase().split(";")[0].trim() !== "application/json") throw new TaskRunnerError("TASK_JSON_REQUIRED", 415);
  let bytes = 0; const parts: Buffer[] = [];
  for await (const part of request.iterator({ destroyOnReturn: false })) { const buffer = Buffer.from(part); bytes += buffer.length; if (bytes > 2048) { request.resume(); throw new TaskRunnerError("TASK_COMMAND_TOO_LARGE", 413); } parts.push(buffer); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new TaskRunnerError("TASK_COMMAND_INVALID"); }
}
export function createTaskRunnerHttpServer(runner: TaskRunner) {
  return createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (request, response) => {
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); };
    try {
      authorize(request); const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.origin !== `http://${request.headers.host}`) throw new TaskRunnerError("TASK_INVALID_HOST", 403);
      if (url.pathname !== PATH) throw new TaskRunnerError("TASK_ROUTE_NOT_FOUND", 404);
      if (request.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "requestId") || url.searchParams.getAll("requestId").length > 1) throw new TaskRunnerError("TASK_QUERY_INVALID");
        send(200, parseTaskRunnerSnapshot(await runner.snapshot(url.searchParams.get("requestId") ?? undefined)));
      } else if (request.method === "POST") {
        if ([...url.searchParams].length) throw new TaskRunnerError("TASK_QUERY_INVALID");
        const command = parseTaskRunnerCommand(await body(request)); send(202, parseTaskRunnerSnapshot(await runner.command(command)));
      } else throw new TaskRunnerError("TASK_METHOD_NOT_ALLOWED", 405);
    } catch (error) { send(error instanceof TaskRunnerError ? error.status : 503, { error: error instanceof TaskRunnerError ? error.code : "TASK_RUNNER_UNAVAILABLE" }); }
  });
}
