import { createServer, type IncomingMessage } from "node:http";
import type { StrategyAdvicePreview } from "./strategy-types.js";
import type { OperatingReportPreview } from "./operating-types.js";
import { HostedError, type AgentCreation, type AgentSettings, type HostedAction, type HostedAgent, type HostedRun } from "./types.js";

/** Authentication and ownership remain in HostedService; HTTP never accepts an owner. */
export interface HostedHttpService {
  challenge(wallet: string): unknown | Promise<unknown>;
  login(challengeId: string, signature: string): unknown | Promise<unknown>;
  authenticate(token: string): string | Promise<string>;
  logout(token: string): unknown | Promise<unknown>;
  snapshot(owner: string): unknown | Promise<unknown>;
  cancelGoal?(who: string, agentId: string, requestId: string): Promise<HostedRun>;
  finance(owner: string, id: string): unknown | Promise<unknown>;
  accounting?(owner: string, id: string): unknown | Promise<unknown>;
  strategyAdvice?(owner: string, id: string, preview?: StrategyAdvicePreview): unknown | Promise<unknown>;
  operatingReport?(owner: string, id: string, preview?: OperatingReportPreview): unknown | Promise<unknown>;
  create(owner: string, input: AgentCreation & { requestId: string }): HostedAgent | Promise<HostedAgent>;
  update(owner: string, id: string, input: AgentSettings): HostedAgent | Promise<HostedAgent>;
  pause(owner: string, id: string, paused: boolean): HostedAgent | Promise<HostedAgent>;
  command(owner: string, id: string, input: { action: HostedAction; requestId: string; rewardKind?: "usdc" | "llm-credits"; amountRaw?: string; goal?: string }): HostedRun | Promise<HostedRun>;
}
const settings = ["name", "modelId", "strategy", "perRunBudgetRaw", "totalBudgetRaw", "allowCredit"];
function fail(code: string, status = 400): never { throw new HostedError(code, status); }
function authorize(request: IncomingMessage) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) fail("HOSTED_LOOPBACK_ONLY", 403);
  const host = request.headers.host, port = request.socket.localPort;
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) fail("HOSTED_INVALID_HOST", 403);
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}` || ["cross-site", "same-site"].includes(String(request.headers["sec-fetch-site"]))) fail("HOSTED_INVALID_ORIGIN", 403);
  if (request.method !== "GET" && request.headers.origin !== `http://${host}`) fail("HOSTED_INVALID_ORIGIN", 403);
}
async function body(request: IncomingMessage, allowed: string[]): Promise<any> {
  if ((request.headers["content-type"] ?? "").toLowerCase().split(";")[0].trim() !== "application/json") fail("HOSTED_JSON_REQUIRED", 415);
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(part); bytes += buffer.length;
    if (bytes > (allowed.includes("goal") || allowed.includes("candidates") ? 65536 : 8192)) { request.resume(); fail("HOSTED_BODY_TOO_LARGE", 413); } parts.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); } catch { fail("HOSTED_JSON_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("HOSTED_BODY_INVALID");
  return value;
}
function token(request: IncomingMessage) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(request.headers.authorization ?? "");
  if (!match) fail("HOSTED_AUTH_REQUIRED", 401); return match[1];
}
export function createHostedHttpServer(service: HostedHttpService) {
  return createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (request, response) => {
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); };
    try {
      authorize(request); const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.origin !== `http://${request.headers.host}`) fail("HOSTED_INVALID_HOST", 403);
      if (url.search) fail("HOSTED_QUERY_INVALID");
      const path = url.pathname, method = request.method;
      if (method === "POST" && path === "/auth/challenge") {
        const input = await body(request, ["wallet"]); send(200, await service.challenge(input.wallet)); return;
      }
      if (method === "POST" && path === "/auth/login") {
        const input = await body(request, ["challengeId", "signature"]); send(200, await service.login(input.challengeId, input.signature)); return;
      }
      if (["/auth/challenge", "/auth/login"].includes(path)) fail("HOSTED_METHOD_NOT_ALLOWED", 405);
      const match = /^\/agents\/([a-zA-Z0-9_-]{1,80})(?:\/(pause|runs|finance|accounting|strategy-advice|operating-report|cancel))?$/.exec(path);
      if (!["/auth/logout", "/agents"].includes(path) && !match) fail("HOSTED_ROUTE_NOT_FOUND", 404);
      if (!(method === "POST" && path === "/auth/logout" || path === "/agents" && ["GET", "POST"].includes(method ?? "") || match && (["strategy-advice", "operating-report"].includes(match[2]) ? ["GET", "POST"].includes(method ?? "") : ["finance", "accounting"].includes(match[2]) ? method === "GET" : match[2] ? method === "POST" : method === "PATCH"))) fail("HOSTED_METHOD_NOT_ALLOWED", 405);
      const bearer = token(request), owner = await service.authenticate(bearer);
      if (path === "/auth/logout") { await body(request, []); await service.logout(bearer); send(200, { authenticated: false }); }
      else if (path === "/agents") send(method === "GET" ? 200 : 202, method === "GET" ? await service.snapshot(owner) : await service.create(owner, await body(request, ["requestId", ...settings])));
      else if (match![2] === "finance") send(200, await service.finance(owner, match![1]));
      else if (match![2] === "accounting") { if (!service.accounting) fail("HOSTED_ACCOUNTING_NOT_CONFIGURED", 503); send(200, await service.accounting(owner, match![1])); }
      else if (match![2] === "strategy-advice") { if (!service.strategyAdvice) fail("HOSTED_STRATEGY_ADVICE_NOT_CONFIGURED", 503); send(200, await service.strategyAdvice(owner, match![1], method === "POST" ? await body(request, ["policy", "candidates"]) : undefined)); }
      else if (match![2] === "operating-report") { if (!service.operatingReport) fail("HOSTED_OPERATING_REPORT_NOT_CONFIGURED", 503); send(200, await service.operatingReport(owner, match![1], method === "POST" ? await body(request, ["reserveCashRaw", "recurringCostRaw", "burn", "subsidyBudgetRaw", "subsidyBurn"]) : undefined)); }
      else if (match![2] === "pause") { const input = await body(request, ["paused"]); if (typeof input.paused !== "boolean") fail("HOSTED_BODY_INVALID"); send(200, await service.pause(owner, match![1], input.paused)); }
      else if (match![2] === "cancel") { const input = await body(request, ["requestId"]); if (!service.cancelGoal) fail("HOSTED_GOAL_NOT_CONFIGURED",503); send(202, await service.cancelGoal(owner, match![1], input.requestId)); }
      else if (match![2] === "runs") send(202, await service.command(owner, match![1], await body(request, ["action", "requestId", "rewardKind", "amountRaw", "goal"])));
      else send(200, await service.update(owner, match![1], await body(request, settings)));
    } catch (error) {
      const safe = error instanceof HostedError && /^HOSTED_[A-Z_0-9]{1,80}$/.test(error.code);
      send(safe ? error.status : 503, { error: safe ? error.code : "HOSTED_UNAVAILABLE" });
    }
  });
}
