import { validateGoalView } from "../../services/hosted-agents/src/goal-types.js";
const COOKIE = "agentfuel_hosted_session";
const responseHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const settings = ["name", "modelId", "strategy", "perRunBudgetRaw", "totalBudgetRaw", "allowCredit"];
class BridgeError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
function fail(code: string, status = 400): never { throw new BridgeError(code, status); }
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function select(value: unknown, fields: string[]) {
  if (!object(value)) fail("HOSTED_UNAVAILABLE", 503);
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
/** Public fields only: never forward an upstream token, key path or arbitrary adapter state. */
function agent(value: unknown) {
  const result = select(value, [...settings, "id", "owner", "wallet", "createdAt", "updatedAt", "status", "spentRaw", "reservedRaw", "activeRequestId", "configurationRequired"]);
  if (object(value) && value.binding !== undefined) result.binding = select(value.binding, ["chainId", "agentId", "wallet"]);
  return result;
}
function run(value: unknown) {
  const result = select(value, ["requestId", "agentId", "action", "fundingFor", "rewardKind", "amountRaw", "status", "createdAt", "updatedAt", "reservedRaw", "chargedRaw", "recoverable", "reason", "goal", "stopRequested"]);
  if (object(value) && value.mission !== undefined) result.mission = validateGoalView(value.mission);
  if (object(value) && value.testSponsorship !== undefined) result.testSponsorship = select(value.testSponsorship, ["grantId", "digest", "ordinal"]);
  if (object(value) && value.result !== undefined) {
    result.result = select(value.result, ["phase", "terminal", "success", "chargedRaw", "reason", "taskId", "paymentId", "txHash", "matchId", "cashRaw", "principalRaw", "feeRaw", "rewardRaw", "creditsGranted", "creditsUsed", "chainId", "acceptTxHash", "paymentTxHash", "fromCashRaw", "fromCreditRaw", "refundedRaw", "autonomousTasks"]);
    if (object(value.result) && value.result.mission !== undefined) result.result.mission = validateGoalView(value.result.mission);
    if (object(value.result) && value.result.binding !== undefined) result.result.binding = select(value.result.binding, ["chainId", "agentId", "wallet"]);
    if (object(value.result) && value.result.settlement !== undefined) {
      result.result.settlement = select(value.result.settlement, ["txHash", "passed", "loanStatus", "repaidRaw", "slashedRaw", "residualRaw"]);
      result.result.settlement.block = select(value.result.settlement.block, ["number", "hash", "timestamp"]);
    }
  }
  return result;
}
function finance(value: unknown) {
  const result = select(value, ["status", "observedAt", "reason", "chainId", "agentId", "wallet", "cashRaw", "debtRaw", "scannedTaskCount", "ownedTaskCount"]);
  if (object(value) && value.status === "confirmed") {
    result.block = select(value.block, ["number", "hash", "timestamp"]);
    result.credit = select(value.credit, ["score", "tier", "tierCapRaw", "feeBps", "eligible", "rejection"]);
    result.policy = select(value.policy, ["maxCashPerTxRaw", "maxDebtPerTxRaw", "maxDebtPerDayRaw", "ownerFrozen"]);
    result.counts = select(value.counts, ["repayments", "defaults", "mirrorRepayments", "successes", "mirrorDefaults"]);
  }
  return result;
}
async function readJson(input: Request | Response, limit: number) {
  const reader = input.body?.getReader(); if (!reader) fail("HOSTED_JSON_REQUIRED");
  let bytes = 0; const parts: Uint8Array[] = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); fail("HOSTED_BODY_TOO_LARGE", 413); } parts.push(part.value); }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); } catch { fail("HOSTED_JSON_INVALID"); }
}
function configuredOrigin(value: string | undefined) {
  if (!value) fail("HOSTED_NOT_CONFIGURED", 503);
  let url: URL; try { url = new URL(value); } catch { fail("HOSTED_CONFIG_INVALID", 503); }
  if (url.origin !== value || url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) fail("HOSTED_CONFIG_INVALID", 503);
  return url;
}
function authorize(request: Request, expected: URL) {
  const url = new URL(request.url), host = request.headers.get("host") ?? url.host, origin = request.headers.get("origin");
  // NextURL normalizes loopback IPs to localhost; Host and Origin retain the browser's exact authority.
  const normalizedLoopback = request.headers.get("host") === expected.host && ["127.0.0.1", "[::1]"].includes(expected.hostname)
    && url.hostname === "localhost" && url.port === expected.port && url.protocol === expected.protocol;
  if (host !== expected.host || (url.host !== expected.host && !normalizedLoopback) || !["http:", "https:"].includes(url.protocol) || origin !== null && origin !== expected.origin || request.method !== "GET" && origin !== expected.origin || ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) fail("HOSTED_INVALID_ORIGIN", 403);
  if (["authorization", "x-owner", "x-wallet", "x-agent-owner"].some(key => request.headers.has(key))) fail("HOSTED_BROWSER_CREDENTIAL_REJECTED", 403);
}
function session(request: Request) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) fail("HOSTED_AUTH_REQUIRED", 401);
  const token = matches[0].slice(COOKIE.length + 1); if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) fail("HOSTED_AUTH_REQUIRED", 401); return token;
}
function cookie(token: string, expected: URL, seconds: number) {
  return `${COOKIE}=${token}; Path=/api/hosted; HttpOnly; SameSite=Strict; Max-Age=${seconds}${expected.protocol === "https:" ? "; Secure" : ""}`;
}
/** Only the Node route calls this bridge. Browser input cannot choose an upstream or owner. */
export async function hostedAgentsRequest(request: Request, config: { upstreamUrl?: string; origin?: string; fetcher?: typeof fetch }) {
  let expected: URL | undefined, path = "";
  try {
    expected = configuredOrigin(config.origin); authorize(request, expected);
    if (!config.upstreamUrl) fail("HOSTED_NOT_CONFIGURED", 503);
    let base: URL; try { base = new URL(config.upstreamUrl); } catch { fail("HOSTED_CONFIG_INVALID", 503); }
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) fail("HOSTED_CONFIG_INVALID", 503);
    const url = new URL(request.url); if (url.search) fail("HOSTED_QUERY_INVALID");
    path = url.pathname.slice("/api/hosted".length);
    if (!url.pathname.startsWith("/api/hosted/")) fail("HOSTED_ROUTE_NOT_FOUND", 404);
    const match = /^\/agents\/([a-zA-Z0-9_-]{1,80})(?:\/(pause|runs|finance|cancel))?$/.exec(path);
    let allowed: string[] | undefined;
    if (["/auth/challenge", "/auth/login", "/auth/logout"].includes(path)) {
      if (request.method !== "POST") fail("HOSTED_METHOD_NOT_ALLOWED", 405);
      allowed = path === "/auth/challenge" ? ["wallet"] : path === "/auth/login" ? ["challengeId", "signature"] : [];
    } else if (path === "/agents") {
      if (!["GET", "POST"].includes(request.method)) fail("HOSTED_METHOD_NOT_ALLOWED", 405);
      if (request.method === "POST") allowed = ["requestId", ...settings];
    } else if (match) {
      if (request.method !== (match[2] === "finance" ? "GET" : match[2] ? "POST" : "PATCH")) fail("HOSTED_METHOD_NOT_ALLOWED", 405);
      allowed = match[2] === "finance" ? undefined : match[2] === "pause" ? ["paused"] : match[2] === "cancel" ? ["requestId"] : match[2] === "runs" ? ["action", "requestId", "rewardKind", "amountRaw", "goal"] : settings;
    } else fail("HOSTED_ROUTE_NOT_FOUND", 404);
    const publicAuth = ["/auth/challenge", "/auth/login"].includes(path), token = publicAuth ? undefined : session(request);
    let input;
    if (allowed) {
      if (request.headers.get("content-type")?.toLowerCase().split(";")[0].trim() !== "application/json") fail("HOSTED_JSON_REQUIRED", 415);
      input = await readJson(request, allowed?.includes("goal") ? 65536 : 8192);
      if (!object(input) || Object.keys(input).some(key => !allowed!.includes(key))) fail("HOSTED_BODY_INVALID");
    }
    const upstream = await (config.fetcher ?? fetch)(new URL(path, base), { method: request.method, redirect: "error", cache: "no-store",
      headers: { "content-type": "application/json", origin: base.origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      // The shared bridge cannot know the chain before the finance response.
      // Give Tempo's bounded 120s backend read time to finish; backend budgets
      // for local/Monad reads remain unchanged, as do all business POST budgets.
      body: input ? JSON.stringify(input) : undefined, signal: AbortSignal.any([request.signal, AbortSignal.timeout(match?.[2] === "finance" ? 130000 : 10000)]) });
    const payload = await readJson(upstream, path === "/agents" ? 64 * 1024 * 1024 : 1048576);
    if (!upstream.ok) {
      const error = object(payload) && typeof payload.error === "string" && /^HOSTED_[A-Z_0-9]{1,80}$/.test(payload.error) ? payload.error : "HOSTED_UNAVAILABLE";
      const status = [400, 401, 403, 404, 409, 413, 415, 429, 503].includes(upstream.status) ? upstream.status : 503;
      const headers = { ...responseHeaders, ...(path === "/auth/logout" || status === 401 ? { "set-cookie": cookie("", expected, 0) } : {}) };
      return Response.json({ error }, { status, headers });
    }
    if (path === "/auth/login") {
      if (!object(payload) || typeof payload.token !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(payload.token)) fail("HOSTED_UNAVAILABLE", 503);
      const expiry = payload.expiresAt, seconds = Math.floor((expiry - Date.now()) / 1000);
      if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || seconds <= 0 || seconds > 86400) fail("HOSTED_UNAVAILABLE", 503);
      return Response.json({ authenticated: true, expiresAt: payload.expiresAt }, { headers: { ...responseHeaders, "set-cookie": cookie(payload.token, expected, seconds) } });
    }
    if (path === "/auth/logout") return Response.json({ authenticated: false }, { headers: { ...responseHeaders, "set-cookie": cookie("", expected, 0) } });
    let value;
    if (path === "/auth/challenge") value = select(payload, ["id", "message", "expiresAt"]);
    else if (path === "/agents" && request.method === "GET") {
      if (!object(payload) || !Array.isArray(payload.agents) || !Array.isArray(payload.runs) || !Array.isArray(payload.models)) fail("HOSTED_UNAVAILABLE", 503);
      value = { agents: payload.agents.map(agent), runs: payload.runs.map(run), models: payload.models.map((model: unknown) => select(model, ["id", "label"])) };
      if (object(payload.sponsorship)) {
        const sponsorship = select(payload.sponsorship, ["used", "limit", "remaining", "globalLimit"]);
        if (object(payload.sponsorship.testAuthorization)) {
          sponsorship.testAuthorization = select(payload.sponsorship.testAuthorization, ["id", "maxTotalGames", "expiresAt", "active", "additionalUsed"]);
          if (Array.isArray(payload.sponsorship.testAuthorization.actorRewards)) sponsorship.testAuthorization.actorRewards = payload.sponsorship.testAuthorization.actorRewards.map((actor: unknown) => select(actor, ["hostedAgentId", "rewardKind"]));
        }
        value = { ...value, sponsorship } as typeof value;
      }
      if (object(payload.capabilities)) {
        const capabilities: Record<string, unknown> = {};
        if (object(payload.capabilities.inference) && Array.isArray(payload.capabilities.inference.models)) capabilities.inference = {
          ...select(payload.capabilities.inference, ["priceRaw", "creditsRaw"]), models: payload.capabilities.inference.models.map((model: unknown) => select(model, ["id", "inputMicroCreditsPerToken", "outputMicroCreditsPerToken"])) };
        if (object(payload.capabilities.goals) && Array.isArray(payload.capabilities.goals.models)) capabilities.goals = { ...select(payload.capabilities.goals,["maxPhases"]), ...(object(payload.capabilities.goals.chainLookup)?{chainLookup:select(payload.capabilities.goals.chainLookup,["chainId","maxTargets"])}:{}), ...(Array.isArray(payload.capabilities.goals.specialists)?{specialists:payload.capabilities.goals.specialists.map((s:unknown)=>select(s,["id","serviceId","name","output"]))}:{}), models: payload.capabilities.goals.models.map((m:unknown)=>select(m,["id","pricePerCallRaw"])) };
        if (object(payload.capabilities.autonomy)) capabilities.autonomy = select(payload.capabilities.autonomy, ["maxTasks", "durationMs", "plannerPriceRaw"]);
        value = { ...value, capabilities } as typeof value;
      }
    } else value = match?.[2] === "finance" ? finance(payload) : ["runs", "cancel"].includes(match?.[2] ?? "") ? run(payload) : agent(payload);
    return Response.json(value, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof BridgeError ? error.code : "HOSTED_UNAVAILABLE" }, { status: error instanceof BridgeError ? error.status : 503,
      headers: { ...responseHeaders, ...(expected && path === "/auth/logout" ? { "set-cookie": cookie("", expected, 0) } : {}) } });
  }
}
