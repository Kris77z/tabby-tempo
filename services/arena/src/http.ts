import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { JsonRpcProvider } from "ethers";
import { ArenaController, type Acceptance } from "./controller.js";
import { problemCatalog } from "./problems.js";
import { digest, uintString, type ArenaConfig } from "./protocol.js";
import { authorizeSubmission, type Submission } from "./submission-auth.js";

export type RunStatus = { runId: string; taskId: string; status: "running" | "settled" | "error"; result?: Acceptance; error?: string };
export interface ArenaHttpJournal {
  runs: RunStatus[]; submissions: [string, { runId: string; requestHash: string }][];
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 70000) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  const data = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const parsed = JSON.parse(data);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_REQUEST");
  return parsed;
}
export function createArenaHttpServer(config: ArenaConfig, origins: string[] = ["http://localhost:3000", "http://127.0.0.1:3000"], injectedProvider?: JsonRpcProvider,
  persistence?: { initial?: ArenaHttpJournal; save: (journal: ArenaHttpJournal) => Promise<void> }) {
  const controller = new ArenaController(config, { image: process.env.ARENA_DOCKER_IMAGE }, injectedProvider);
  const runs = new Map<string, RunStatus>((persistence?.initial?.runs ?? []).map(run => {
    if (!Object.hasOwn(config.tasks, run.taskId) || !/^[a-f0-9-]{36}$/.test(run.runId)) throw new Error("INVALID_ARENA_HTTP_JOURNAL");
    // A restart cannot claim that an interrupted controller is still running.
    return [run.runId, run.status === "running" ? { ...run, status: "error", error: "ARENA_RECOVERY_REQUIRED" } : run];
  }));
  const submissions = new Map<string, { runId: string; requestHash: string }>(persistence?.initial?.submissions ?? []);
  for (const [taskId, entry] of submissions) if (runs.get(entry.runId)?.taskId !== taskId || !/^[a-f0-9]{64}$/.test(entry.requestHash)) throw new Error("INVALID_ARENA_HTTP_JOURNAL");
  let saves: Promise<void> = Promise.resolve();
  const save = (completed?: RunStatus) => {
    const journal = structuredClone({ runs: [...runs.values()].map(run => completed?.runId === run.runId ? completed : run), submissions: [...submissions.entries()] });
    return saves = saves.then(() => persistence?.save(journal));
  };
  const provider = injectedProvider ?? new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  const abort = new AbortController();
  const work = new Set<Promise<void>>();
  const server = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const origin = request.headers.origin;
    if (origin && !origins.includes(origin)) { reply(403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
    if (origin) { response.setHeader("access-control-allow-origin", origin); response.setHeader("vary", "Origin"); }
    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.writeHead(204); response.end(); return;
    }
    try {
      const path = request.url?.split("?")[0];
      if (request.method === "GET" && path === "/problems") {
        reply(200, { problems: problemCatalog(), tasks: config.tasks }); return;
      }
      if (request.method === "GET" && path?.startsWith("/runs/")) {
        const run = runs.get(path.slice("/runs/".length));
        reply(run ? 200 : 404, run ?? { error: "RUN_NOT_FOUND" }); return;
      }
      if (request.method === "POST" && path === "/submissions") {
        if (request.headers["content-type"]?.split(";")[0] !== "application/json") { reply(415, { error: "JSON_REQUIRED" }); return; }
        const input = await body(request);
        if (Object.keys(input).some(key => !["taskId", "code", "deadline", "signature"].includes(key)) || typeof input.code !== "string" || Buffer.byteLength(input.code) > 65536 || typeof input.signature !== "string" || !/^0x[a-fA-F0-9]{130}$/.test(input.signature)) throw new Error("INVALID_SUBMISSION");
        const taskId = uintString(input.taskId, "TASK_ID");
        const deadline = uintString(input.deadline, "DEADLINE");
        if (!Object.hasOwn(config.tasks, taskId)) { reply(403, { error: "TASK_NOT_AUTHORIZED" }); return; }
        const submission: Submission = { taskId, code: input.code, deadline, signature: input.signature };
        const requestHash = digest(JSON.stringify(submission));
        const previous = submissions.get(taskId);
        if (previous) {
          if (previous.requestHash === requestHash) reply(200, { runId: previous.runId, taskId, status: runs.get(previous.runId)!.status });
          else reply(409, { error: "TASK_ALREADY_SUBMITTED", runId: previous.runId });
          return;
        }
        if (runs.size >= 100) { reply(503, { error: "RUN_LIMIT_REACHED" }); return; }
        await authorizeSubmission(provider, config, submission);
        // Another authorized request can finish while RPC reads are in flight.
        const concurrent = submissions.get(taskId);
        if (concurrent) {
          reply(concurrent.requestHash === requestHash ? 200 : 409, { runId: concurrent.runId, taskId, status: runs.get(concurrent.runId)!.status }); return;
        }
        const runId = randomUUID();
        submissions.set(taskId, { runId, requestHash });
        runs.set(runId, { runId, taskId, status: "running" });
        try { await save(); } // Admission must survive before the controller can settle.
        catch { runs.set(runId, { runId, taskId, status: "error", error: "ARENA_DURABILITY_UNCONFIRMED" }); throw new Error("ARENA_DURABILITY_UNCONFIRMED"); }
        const operation = controller.submit({ taskId, code: input.code, runId, signal: abort.signal }).then(async result => {
          const completed: RunStatus = { runId, taskId, status: "settled", result };
          try { await save(completed); runs.set(runId, completed); }
          catch { runs.set(runId, { runId, taskId, status: "error", error: "ARENA_DURABILITY_UNCONFIRMED" }); }
        }, async error => {
          const message = (error as Error).message;
          runs.set(runId, { runId, taskId, status: "error", error: /^[A-Z_]+$/.test(message) ? message : "SUBMISSION_UNAVAILABLE" });
          try { await save(); } catch { runs.set(runId, { runId, taskId, status: "error", error: "ARENA_DURABILITY_UNCONFIRMED" }); }
        });
        work.add(operation);
        void operation.finally(() => work.delete(operation)).catch(() => {});
        reply(202, { runId, taskId, status: "running" }); return;
      }
      reply(404, { error: "NOT_FOUND" });
    } catch (error) {
      const message = (error as Error).message;
      reply(message === "REQUEST_TOO_LARGE" ? 413 : message === "ARENA_DURABILITY_UNCONFIRMED" ? 503 : message.startsWith("SUBMISSION_SIGN") ? 403 : 400, { error: /^[A-Z_]+$/.test(message) ? message : "INVALID_REQUEST" });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return { server, close: async () => {
    abort.abort();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all(work); controller.close();
    if (injectedProvider === undefined) provider.destroy();
  } };
}
