import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { proxyUpstreamFetch, systemHttpsProxy } from "./demo-rpc.js";
import { loadProbeUpstream } from "./verify-live-tiers.js";
import { startMagpie } from "./magpie-gateway.js";
import { journalDiagnostic } from "./demo-common.js";

/** Loopback-only bridge owns the real credentials; sandboxed Magpie sees local routing keys only. */
export function savedGatewayCounters(raw: string) {
  const entries = raw.trim() ? raw.trim().split("\n").map(line => JSON.parse(line)) : [];
  const dispatches = entries.filter(entry => entry.phase === "DispatchIntent");
  if (dispatches.some((entry, index) => !Number.isSafeInteger(entry.attempt) || entry.attempt !== index + 1)
    || entries.some(entry => !dispatches.some(dispatch => dispatch.attempt === entry.attempt))) throw new Error("GATEWAY_ATTEMPT_JOURNAL_INVALID");
  return { nextId: dispatches.length, accepted: dispatches.length };
}
export async function startLocalModelGateway(options: { config: string; binary: string; directory: string; port?: number; bridgePort?: number; transport?: "direct" | "system-https-proxy" }) {
  const upstream = await loadProbeUpstream(resolve(options.config));
  const transportKind = options.transport ?? "system-https-proxy";
  if (!["direct", "system-https-proxy"].includes(transportKind)) throw new Error("INVALID_GATEWAY_TRANSPORT");
  const transport = transportKind === "direct" ? { fetch: ((input: any, init: any) => fetch(input, { ...init, redirect: "error",
    signal: AbortSignal.any([init.signal, AbortSignal.timeout(120000)]) })) as typeof fetch, close() {} } : proxyUpstreamFetch(await systemHttpsProxy(), 120000);
  await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 });
  const directory = await realpath(resolve(options.directory)); await chmod(directory, 0o700);
  const keyFile = join(directory, "magpie.key"), bridgeKey = randomBytes(32).toString("hex");
  try { await writeFile(keyFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if ((await stat(keyFile)).mode % 512 !== 0o600 || !(await readFile(keyFile, "utf8")).trim()) throw new Error("PRIVATE_GATEWAY_KEY_REQUIRED");
  const journal = join(directory, "attempts.jsonl");
  const append = async (entry: Record<string, unknown>) => {
    const file = await open(journal, "a", 0o600); try { await file.writeFile(JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); await file.sync(); } finally { await file.close(); }
  };
  let { nextId, accepted } = savedGatewayCounters(await readFile(journal, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }));
  await mkdir(join(directory, "responses"), { recursive: true, mode: 0o700 });
  const authorized = (value?: string) => {
    const expected = Buffer.from(`Bearer ${bridgeKey}`), supplied = Buffer.from(value ?? "");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  };
  const bridge = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ready: true, models: ["kimi-k2.6", "kimi-k3"], acceptedRequests: accepted })); return; }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
    if (!authorized(request.headers.authorization)) { response.writeHead(401); response.end(); return; }
    const controller = new AbortController(); response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    let attempt: number | undefined;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { const part = Buffer.from(chunk); bytes += part.length; if (bytes > 128 * 1024) { response.writeHead(413); response.end(); return; } chunks.push(part); }
      const raw = Buffer.concat(chunks).toString("utf8"), body = JSON.parse(raw);
      if (!["kimi-k2.6", "kimi-k3"].includes(body.model) || body.stream === true || !Array.isArray(body.messages)
        || !Number.isSafeInteger(body.max_completion_tokens) || body.max_completion_tokens < 1 || body.max_completion_tokens > 8192) {
        response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":{"code":"LOCAL_MODEL_REQUEST_INVALID"}}'); return;
      }
      attempt = ++nextId;
      await append({ attempt, phase: "DispatchIntent", model: body.model, requestDigest: createHash("sha256").update(raw).digest("hex"), maxCompletionTokens: body.max_completion_tokens });
      accepted++;
      const upstreamResponse = await transport.fetch(`${upstream.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${upstream.key}`, "content-type": "application/json" }, body: raw, signal: controller.signal });
      const rawResponse = await upstreamResponse.text();
      // Retain private response evidence for future reconciliation. Public logs
      // contain only its digest and a restricted provider request identifier.
      await writeFile(join(directory, "responses", `attempt-${attempt}.json`), rawResponse, { mode: 0o600, flag: "wx" });
      let usage: unknown; try { const value = JSON.parse(rawResponse); usage = value.usage; } catch { /* Unknown response remains visible to the calling durable ledger. */ }
      const responseDigest = createHash("sha256").update(rawResponse).digest("hex");
      const providerRequestId = upstreamResponse.headers.get("x-request-id") ?? upstreamResponse.headers.get("x-moonshot-request-id");
      await append({ attempt, phase: "Response", model: body.model, httpStatus: upstreamResponse.status, transport: transportKind, responseDigest,
        ...(providerRequestId && /^[A-Za-z0-9._:-]{1,160}$/.test(providerRequestId) ? { providerRequestId } : {}), ...(usage ? { usage } : {}) });
      response.writeHead(upstreamResponse.status, { "content-type": "application/json" }); response.end(rawResponse);
    } catch (error) {
      const value = error as { code?: unknown; cause?: { code?: unknown } };
      const transportCode = [value?.code, value?.cause?.code].find(code => typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code));
      if (attempt !== undefined) await append({ attempt, phase: "OutcomeUnknown", diagnostic: journalDiagnostic(error), ...(transportCode ? { transportCode } : {}) }).catch(() => {});
      if (!response.headersSent) response.writeHead(attempt === undefined ? 400 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: attempt === undefined ? "LOCAL_REQUEST_INVALID" : "LOCAL_UPSTREAM_UNKNOWN" } }));
    }
  });
  bridge.requestTimeout = 130000; bridge.headersTimeout = 10000;
  let magpie: Awaited<ReturnType<typeof startMagpie>> | undefined;
  try {
    bridge.listen(options.bridgePort ?? 3427, "127.0.0.1"); await once(bridge, "listening");
    const bridgeUrl = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
    magpie = await startMagpie({ binary: resolve(options.binary), stateDirectory: join(directory, "magpie"), port: options.port ?? 3426,
      providers: [{ id: "cheap", model: "kimi-k2.6", baseUrl: `${bridgeUrl}/v1`, key: bridgeKey }, { id: "strong", model: "kimi-k3", baseUrl: `${bridgeUrl}/v1`, key: bridgeKey }] });
    const metadata = { version: 1, pid: process.pid, magpiePid: magpie.child.pid, startedAt: new Date().toISOString(), url: `${magpie.url}/v1`,
      endpoint: `${magpie.url}/v1/chat/completions`, bridgeHealthUrl: `${bridgeUrl}/health`, keyFile,
      models: [{ id: "cheap", model: "cheap/kimi-k2.6", responseModel: "kimi-k2.6" }, { id: "strong", model: "strong/kimi-k3", responseModel: "kimi-k3" }],
      binarySha256: magpie.provenance.binarySha256, inferenceRetries: 0, transport: transportKind };
    await writeFile(join(directory, "ready.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
    return { ...metadata, child: magpie.child, close: async () => {
      await magpie!.close(); transport.close(); await new Promise<void>(done => { bridge.close(() => done()); bridge.closeAllConnections(); });
    } };
  } catch (error) { await magpie?.close(); transport.close(); bridge.closeAllConnections(); bridge.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  if (!value("--config") || !value("--binary") || !value("--directory")) throw new Error("Usage: local-model-gateway --config PRIVATE_CONFIG --binary LOCKED_MAGPIE --directory PRIVATE_RUNTIME [--port 3426 --bridge-port 3427]");
  try {
    const gateway = await startLocalModelGateway({ config: value("--config")!, binary: value("--binary")!, directory: value("--directory")!,
      port: value("--port") ? Number(value("--port")) : undefined, bridgePort: value("--bridge-port") ? Number(value("--bridge-port")) : undefined,
      transport: value("--transport") as "direct" | "system-https-proxy" | undefined });
    const { child: _child, close: _close, ...metadata } = gateway; console.log(JSON.stringify(metadata));
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    await once(gateway.child, "exit"); if (!stopping) { await gateway.close(); process.exitCode = 1; }
  } catch { console.error("LOCAL_MODEL_GATEWAY_START_FAILED"); process.exitCode = 1; }
}
