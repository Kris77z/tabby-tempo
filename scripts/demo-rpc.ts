import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FetchRequest, JsonRpcProvider, Network, type GetUrlResponse } from "ethers";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import { HttpsProxyAgent } from "https-proxy-agent";

export type RpcTransport = "direct" | "system-https-proxy";

// Shared by the CLI and Next server. Never return the private URL in public metadata.
export async function readRpcUrlFile(path: string) {
  if (!isAbsolute(path)) throw new Error("ABSOLUTE_RPC_URL_FILE_REQUIRED");
  let value: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || (process.getuid && metadata.uid !== process.getuid())) throw new Error();
    value = (await readFile(path, "utf8")).trim();
  } catch { throw new Error("PRIVATE_RPC_URL_FILE_REQUIRED"); }
  let url: URL; try { url = new URL(value); } catch { throw new Error("INVALID_RPC_URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("INVALID_RPC_URL");
  return url.toString().replace(/\/$/, "");
}

const READ_RPC_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_call",
  "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_estimateGas",
]);
function retryableRead(request: FetchRequest) {
  if (request.method !== "POST" || request.body === null) return false;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body));
    return value !== null && typeof value === "object" && !Array.isArray(value) && value.jsonrpc === "2.0" &&
      Object.hasOwn(value, "id") && READ_RPC_METHODS.has(value.method);
  } catch { return false; }
}

type RpcReadLimiter = (request: FetchRequest, signal: Parameters<FetchRequest["getUrlFunc"]>[1], getUrl: FetchRequest["getUrlFunc"], cancellation?: AbortSignal) => Promise<GetUrlResponse>;
interface TempoRpcOwner { closed: boolean }
interface TempoRpcRead {
  owner: TempoRpcOwner; expires: number; queued: boolean; finished: boolean;
  run(remainingMs: number): Promise<GetUrlResponse>;
  resolve(response: GetUrlResponse): void; reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>; cleanup?(): void;
}
const tempoReadQueues = new Map<string, TempoRpcReadQueue>();
const tempoRpcError = (message: string, code: string) => Object.assign(new Error(message), { code });

/** One process-wide budget per endpoint, shared even by separately owned providers. Writes never enter this queue. */
class TempoRpcReadQueue {
  private references = 0;
  private active = 0;
  private nextAt = 0;
  private pending: TempoRpcRead[] = [];
  private wake?: ReturnType<typeof setTimeout>;
  constructor(private endpoint: string) {}
  retain() { this.references++; }
  release(owner: TempoRpcOwner) {
    owner.closed = true;
    for (const entry of [...this.pending]) if (entry.owner === owner) this.reject(entry, tempoRpcError("RPC_CONNECTION_CLOSED", "CANCELLED"));
    this.references--; this.pump();
  }
  submit(owner: TempoRpcOwner, request: FetchRequest, signal: Parameters<FetchRequest["getUrlFunc"]>[1], getUrl: FetchRequest["getUrlFunc"], cancellation?: AbortSignal): Promise<GetUrlResponse> {
    if (owner.closed) return Promise.reject(tempoRpcError("RPC_CONNECTION_CLOSED", "CANCELLED"));
    if (signal?.cancelled || cancellation?.aborted) return Promise.reject(tempoRpcError("RPC_REQUEST_CANCELLED", "CANCELLED"));
    // At 10 starts/sec this bounds a healthy endpoint's queued work to about 6.4 seconds.
    if (this.pending.length >= 64) return Promise.reject(tempoRpcError("RPC_READ_QUEUE_FULL", "RPC_READ_QUEUE_FULL"));
    return new Promise((resolve, reject) => {
      const entry: TempoRpcRead = { owner, expires: Date.now() + request.timeout, queued: true, finished: false, resolve, reject,
        run: remainingMs => { const current = request.clone(); current.timeout = remainingMs; return getUrl(current, signal); } };
      const cancel = () => this.reject(entry, tempoRpcError("RPC_REQUEST_CANCELLED", "CANCELLED"));
      cancellation?.addEventListener("abort", cancel, { once: true });
      entry.cleanup = () => cancellation?.removeEventListener("abort", cancel);
      entry.timer = setTimeout(() => this.reject(entry, tempoRpcError("RPC_REQUEST_TIMEOUT", "TIMEOUT")), request.timeout);
      signal?.addListener(() => this.reject(entry, tempoRpcError("RPC_REQUEST_CANCELLED", "CANCELLED")));
      this.pending.push(entry); this.pump();
    });
  }
  private reject(entry: TempoRpcRead, error: Error) {
    if (entry.finished) return;
    entry.finished = true; clearTimeout(entry.timer); entry.cleanup?.();
    if (entry.queued) { this.pending = this.pending.filter(queued => queued !== entry); entry.queued = false; }
    entry.reject(error); this.pump();
  }
  private pump() {
    clearTimeout(this.wake); this.wake = undefined;
    if (!this.references && !this.active && !this.pending.length) {
      // Preserve the endpoint's last-start budget across short-lived provider instances.
      const idleWait = this.nextAt - Date.now();
      if (idleWait > 0) this.wake = setTimeout(() => this.pump(), idleWait);
      else tempoReadQueues.delete(this.endpoint);
      return;
    }
    if (this.active >= 4 || !this.pending.length) return;
    const wait = this.nextAt - Date.now();
    if (wait > 0) { this.wake = setTimeout(() => this.pump(), wait); return; }
    const entry = this.pending.shift()!; entry.queued = false;
    const remaining = entry.expires - Date.now();
    if (entry.owner.closed || remaining <= 0) { this.reject(entry, tempoRpcError(entry.owner.closed ? "RPC_CONNECTION_CLOSED" : "RPC_REQUEST_TIMEOUT", entry.owner.closed ? "CANCELLED" : "TIMEOUT")); return; }
    this.active++; this.nextAt = Date.now() + 100;
    Promise.resolve().then(() => entry.run(remaining)).then(response => {
      if (!entry.finished) { entry.finished = true; entry.cleanup?.(); entry.resolve(response); }
    }, error => this.reject(entry, error)).finally(() => {
      clearTimeout(entry.timer); entry.cleanup?.(); this.active--; this.pump();
    });
    this.pump();
  }
}

export function tempoReadTransport(url: string): { send: RpcReadLimiter; close(): void } {
  const endpoint = new URL(url).toString();
  let queue = tempoReadQueues.get(endpoint);
  if (!queue) { queue = new TempoRpcReadQueue(endpoint); tempoReadQueues.set(endpoint, queue); }
  queue.retain(); const owner: TempoRpcOwner = { closed: false };
  const send: RpcReadLimiter = (current, signal, getUrl, cancellation) => {
    if (owner.closed) return Promise.reject(tempoRpcError("RPC_CONNECTION_CLOSED", "CANCELLED"));
    return retryableRead(current) ? queue!.submit(owner, current, signal, getUrl, cancellation) : getUrl(current, signal);
  };
  return { send, close: () => { if (!owner.closed) queue!.release(owner); } };
}

/** Explicit proxy configuration is also available on Linux; credentials never belong in this URL. */
export function configuredHttpsProxy(env: NodeJS.ProcessEnv = process.env) {
  if (env.AGENTFUEL_HTTPS_PROXY === undefined) return undefined;
  let url: URL; try { url = new URL(env.AGENTFUEL_HTTPS_PROXY); } catch { throw new Error("CONFIGURED_HTTPS_PROXY_INVALID"); }
  if (url.protocol !== "http:" || !url.hostname || url.port === "0" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("CONFIGURED_HTTPS_PROXY_INVALID");
  return url.origin;
}
export function defaultUpstreamTransport(platform: NodeJS.Platform = process.platform): RpcTransport {
  return platform === "darwin" ? "system-https-proxy" : "direct";
}
export async function systemHttpsProxy() {
  const configured = configuredHttpsProxy(); if (configured) return configured;
  if (process.platform !== "darwin") throw new Error("SYSTEM_HTTPS_PROXY_UNAVAILABLE");
  const { stdout } = await promisify(execFile)("/usr/sbin/scutil", ["--proxy"], { timeout: 3000, env: { PATH: "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "production" } });
  const setting = (name: string) => stdout.match(new RegExp(`\\b${name}\\s*:\\s*([^\\s}]+)`))?.[1];
  const host = setting("HTTPSProxy"), port = setting("HTTPSPort");
  if (setting("HTTPSEnable") !== "1" || !host || !/^[A-Za-z0-9.:-]+$/.test(host) || !/^\d+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535) throw new Error("SYSTEM_HTTPS_PROXY_UNAVAILABLE");
  return `http://${host}:${port}`;
}

// Unlike ethers' Node adapter, native request.signal destroys just the cancelled
// request/socket. A connection-owned keep-alive pool can therefore remain usable
// by concurrent RPCs without lending one request another request's abort signal.
function pooledRpcGetUrl(req: FetchRequest, agent: HttpAgent | HttpsAgent, signal: AbortSignal): Promise<GetUrlResponse> {
  return new Promise((resolve, reject) => {
    const protocol = new URL(req.url).protocol;
    if (!["http:", "https:"].includes(protocol) || protocol === "http:" && req.credentials && !req.allowInsecureAuthentication) {
      reject(Object.assign(new Error("RPC_REQUEST_UNSUPPORTED_PROTOCOL"), { code: "UNSUPPORTED_OPERATION" })); return;
    }
    const request = (protocol === "https:" ? httpsRequest : httpRequest)(req.url, { method: req.method, headers: req.headers, agent, signal });
    request.on("error", reject);
    request.on("response", response => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value ?? "";
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("aborted", () => reject(Object.assign(new Error("RPC_REQUEST_ECONNRESET"), { code: "ECONNRESET" })));
      response.on("end", () => {
        try {
          let body: Uint8Array | null = chunks.length ? Buffer.concat(chunks) : null;
          if (body && headers["content-encoding"] === "gzip") body = gunzipSync(body);
          resolve({ statusCode: response.statusCode ?? 0, statusMessage: response.statusMessage ?? "", headers, body });
        } catch { reject(Object.assign(new Error("RPC_REQUEST_BAD_RESPONSE"), { code: "SERVER_ERROR" })); }
      });
    });
    request.end(req.body === null ? undefined : Buffer.from(req.body));
  });
}

// Opted-in direct RPCs own a shared pool; proxy requests keep isolated agents.
// Only explicitly opted-in single reads get up to three HTTP 503 or native
// ECONNRESET retries, sharing the original deadline and cancellation.
// A separate read-only 429 opt-in uses bounded Retry-After/backoff with the
// same maximum attempt count and original deadline. Writes never retry.
// Upstream inference and every write remain single-attempt.
export function rpcRequest(url: string, proxyUrl?: string, timeout = 30000, retryRead503 = false, readLimiter?: RpcReadLimiter, retryRead429 = false) {
  const request = new FetchRequest(url);
  request.timeout = timeout;
  request.setThrottleParams({ maxAttempts: 1 });
  request.retryFunc = async () => false;
  const active = new Set<AbortController>();
  const pool = !proxyUrl && (retryRead503 || retryRead429 || readLimiter) ? {
    http: new HttpAgent({ keepAlive: true, maxFreeSockets: 8 }),
    https: new HttpsAgent({ keepAlive: true, maxFreeSockets: 8 }),
  } : undefined;
  let closed = false;
  if (proxyUrl || retryRead503 || retryRead429 || readLimiter) request.getUrlFunc = (req, signal) => new Promise((resolve, reject) => {
    if (pool && closed) { reject(Object.assign(new Error("RPC_CONNECTION_CLOSED"), { code: "CANCELLED" })); return; }
    if (signal?.cancelled) { reject(Object.assign(new Error("RPC_REQUEST_CANCELLED"), { code: "CANCELLED" })); return; }
    const controller = new AbortController(); active.add(controller);
    // ethers' Node getUrl does not destroy sockets on its own timeout/cancel.
    // The standard agent forwards this signal to the underlying proxy socket,
    // including while CONNECT is still pending.
    const agent = pool ? (req.url.startsWith("https:") ? pool.https : pool.http) : proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: false, signal: controller.signal })
      : new (req.url.startsWith("https:") ? HttpsAgent : HttpAgent)({ keepAlive: false });
    let finished = false;
    const cleanup = (abort = true) => { clearTimeout(timer); if (abort || !pool) controller.abort(); if (!pool) agent.destroy(); active.delete(controller); };
    const fail = (code: string) => {
      if (finished) return; finished = true; cleanup(); reject(Object.assign(new Error(`RPC_REQUEST_${code}`), { code }));
    };
    const expires = Date.now() + req.timeout;
    const timer = setTimeout(() => fail("TIMEOUT"), req.timeout);
    signal?.addListener(() => fail("CANCELLED"));
    controller.signal.addEventListener("abort", () => { if (!finished) fail("CANCELLED"); }, { once: true });
    const getUrl = pool ? (current: FetchRequest) => pooledRpcGetUrl(current, agent, controller.signal) : FetchRequest.createGetUrlFunc({ agent });
    const send = async () => {
      const backoffs = [250, 500, 1000], rateBackoffs = [1000, 2000, 4000];
      const read = retryableRead(req), canRetry = retryRead503 && read, canRetryRate = retryRead429 && read;
      for (let attempt = 0; ; attempt++) {
        const remaining = expires - Date.now();
        if (remaining <= 0 || finished) throw Object.assign(new Error("RPC_REQUEST_TIMEOUT"), { code: "TIMEOUT" });
        const current = req.clone(); current.timeout = remaining;
        let backoff = backoffs[attempt];
        try {
          // Gate each actual HTTP attempt, including an already-authorized read retry.
          const response = await (readLimiter ? readLimiter(current, signal, (queued, inheritedSignal) => getUrl(queued, inheritedSignal), controller.signal) : getUrl(current, signal));
          if (attempt === backoffs.length) return response;
          if (response.statusCode === 429 && canRetryRate) {
            const header = response.headers["retry-after"], seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
            const requested = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 0;
            // At most three retries; never let an untrusted header extend the
            // original request deadline or sleep for more than five seconds.
            backoff = Math.max(rateBackoffs[attempt], Math.min(5000, Math.max(0, Number.isFinite(requested) ? requested : 0)));
          } else if (!canRetry || response.statusCode !== 503) return response;
        } catch (error) {
          const reset = (error as { code?: unknown })?.code === "ECONNRESET";
          if (!reset) throw error;
          if (!canRetry || attempt === backoffs.length || finished) throw Object.assign(new Error("RPC_REQUEST_ECONNRESET"), { code: "ECONNRESET" });
        }
        await delay(backoff, undefined, { signal: controller.signal });
      }
    };
    send().then(response => {
      if (finished) return; finished = true; cleanup(false); resolve(response);
    }, error => { if (finished) return; finished = true; cleanup(); reject(error); });
  });
  return { request, close: () => { closed = true; for (const controller of active) controller.abort(); pool?.http.destroy(); pool?.https.destroy(); } };
}

/** Explicit network binding for shared remote RPC transports. Callers still verify eth_chainId before writes. */
export async function chainRpcProvider(url: string, chainId: string | number | bigint, transport: RpcTransport) {
  if (!/^[1-9][0-9]*$/.test(String(chainId)) || typeof chainId === "number" && !Number.isSafeInteger(chainId)) throw new Error("RPC_CHAIN_ID_INVALID");
  if (transport !== "direct" && transport !== "system-https-proxy") throw new Error("UNKNOWN_RPC_TRANSPORT");
  const proxyUrl = transport === "system-https-proxy" ? await systemHttpsProxy() : undefined;
  const interval = Number(process.env.AGENTFUEL_RPC_INTERVAL_MS ?? "0");
  if (!Number.isInteger(interval) || interval < 0 || interval > 5000) throw new Error("RPC_INTERVAL_INVALID");
  const callGasValue = process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT;
  let callGas: string | undefined;
  if (callGasValue !== undefined) {
    const units = Number(callGasValue);
    if (!/^[1-9][0-9]*$/.test(callGasValue) || !Number.isSafeInteger(units) || units < 21000 || units > 1000000) throw new Error("RPC_CALL_GAS_LIMIT_INVALID");
    callGas = `0x${units.toString(16)}`;
  }
  const retryRead503 = transport === "system-https-proxy" || process.env.AGENTFUEL_RPC_RETRY_READ_503 === "1";
  const tempo = BigInt(chainId) === 42431n;
  const tempoTransport = tempo ? tempoReadTransport(url) : undefined;
  const connection = rpcRequest(url, proxyUrl, 30000, retryRead503, tempoTransport?.send);
  const provider = new JsonRpcProvider(connection.request, Network.from(BigInt(chainId)), { staticNetwork: true, cacheTimeout: -1, pollingInterval: 1000, batchMaxCount: 1 });
  let closed = false, nextAt = 0, queue = Promise.resolve();
  const originalSend = provider.send.bind(provider);
  const send: typeof provider.send = (method, params) => {
    // Some RPCs default an omitted eth_call gas to more than their provider cap.
    // This operator opt-in never changes explicit gas, estimates or broadcasts.
    if (callGas !== undefined && method === "eth_call" && Array.isArray(params) && params[0] !== null
      && typeof params[0] === "object" && !Array.isArray(params[0]) && params[0].gas === undefined) {
      return originalSend(method, [{ ...params[0], gas: callGas }, ...params.slice(1)]);
    }
    return originalSend(method, params);
  };
  if (callGas !== undefined) provider.send = send;
  if (!tempo && interval > 0) provider.send = (method, params) => {
    const result = queue.then(async () => {
      if (closed) throw new Error("RPC_CONNECTION_CLOSED");
      const wait = Math.max(0, nextAt - Date.now());
      if (wait) await delay(wait);
      if (closed) throw new Error("RPC_CONNECTION_CLOSED");
      nextAt = Date.now() + interval;
      return send(method, params);
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  void provider.on("error", () => {});
  return { provider, proxyUrl, close() { closed = true; tempoTransport?.close(); provider.destroy(); connection.close(); } };
}

/** Compatibility entry point for existing Monad tools. */
export function monadProvider(url: string, transport: RpcTransport) {
  return chainRpcProvider(url, 10143, transport);
}

// The Relay calls this only with its original non-streaming JSON POST. Keep
// native fetch for direct/local mode; proxy mode owns only these requests.
export function proxyUpstreamFetch(proxyUrl: string, timeout = 120000) {
  const active = new Set<ReturnType<typeof rpcRequest>>();
  let closed = false;
  const upstreamFetch: typeof fetch = async (input, init) => {
    if (closed) throw Object.assign(new Error("UPSTREAM_TRANSPORT_CLOSED"), { code: "CANCELLED" });
    if (!(typeof input === "string" || input instanceof URL) || init?.method !== "POST" || typeof init.body !== "string") throw new Error("INVALID_UPSTREAM_FETCH_REQUEST");
    if (init.signal?.aborted) throw Object.assign(new Error("UPSTREAM_CANCELLED"), { code: "CANCELLED" });
    const connection = rpcRequest(String(input), proxyUrl, timeout), { request } = connection;
    request.method = "POST"; request.body = init.body;
    for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value);
    const getUrl = request.getUrlFunc;
    request.getUrlFunc = async (req, signal) => {
      const response = await getUrl(req, signal);
      // FetchRequest.redirect creates a fresh request. Reject here before it
      // can forward an Authorization header or issue another paid request.
      if (response.statusCode >= 300 && response.statusCode < 400) throw Object.assign(new Error("UPSTREAM_REDIRECT_REJECTED"), { code: "REDIRECT_REJECTED" });
      return response;
    };
    const abort = () => { request.cancel(); connection.close(); };
    active.add(connection);
    try {
      const pending = request.send();
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) abort();
      const result = await pending;
      const headers = new Headers(result.headers);
      // ethers already decompresses gzip. Do not label the decoded body gzip.
      headers.delete("content-encoding"); headers.delete("content-length");
      const body = result.body === null || [204, 205].includes(result.statusCode) ? null : new Uint8Array(result.body).buffer;
      return new Response(body, { status: result.statusCode, statusText: result.statusMessage, headers });
    } catch (error) {
      const value = (error as { code?: unknown }).code;
      const code = typeof value === "string" && /^[A-Z_0-9]+$/.test(value) ? value : "REQUEST_FAILED";
      // Original transport errors may contain the request's Authorization.
      throw Object.assign(new Error(`UPSTREAM_${code}`), { code });
    } finally {
      init.signal?.removeEventListener("abort", abort);
      active.delete(connection); connection.close();
    }
  };
  return { fetch: upstreamFetch, close() {
    closed = true;
    for (const connection of active) { connection.request.cancel(); connection.close(); }
  } };
}
