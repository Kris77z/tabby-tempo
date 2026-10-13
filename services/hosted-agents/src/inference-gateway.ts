import { createHash } from "node:crypto";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import type { Json } from "../../../packages/sdk/src/protocol.js";
import { unsealedLedgerDigest, validGatewayClosure, type GatewayClosure } from "./inference-closure.js";

export interface GatewayBinding { agentId: string; taskId: string; wallet: string }
/** Rates are integer microcredits per token, chosen by the host, never by a caller. */
export interface GatewayModel {
  id: string; model: string; responseModel?: string; route: string;
  inputMicroCreditsPerToken: string; outputMicroCreditsPerToken: string; maxCompletionTokens: number;
}
export type GatewayRequest = Record<string, Json> & { model: string; messages: Json[]; max_completion_tokens: number };
export type GatewayGrantSource = { kind: "game"; rewardId: string } | { kind: "chain-payment"; paymentId: string; txHash: string };
export interface GatewayQuote { modelId: string; reservedCredits: string; maxPromptTokens: number; maxCompletionTokens: number }
export interface GatewayResult { response: Json; usage: { promptTokens: number; completionTokens: number }; chargedCredits: string }
export type GatewayDispatch = (model: GatewayModel, request: GatewayRequest) => Promise<{ status: number; body: Json }>;
export interface GatewayInvocation extends GatewayQuote {
  id: string; requestDigest: string; state: "DispatchIntent" | "ResponseRecorded" | "Completed" | "Rejected" | "Unknown" | "UsageOverrun";
  result?: GatewayResult; error?: string;
}
interface RecordEntry extends GatewayInvocation { request: GatewayRequest; response?: { status: number; body: Json } }
interface GatewayState {
  version: 1; binding: GatewayBinding; catalog: GatewayModel[];
  grants: { id: string; credits: string; source: GatewayGrantSource }[]; invocations: RecordEntry[];
  closure?: GatewayClosure;
}
export interface GatewayBalance { grantedCredits: string; spentCredits: string; reservedCredits: string; availableCredits: string; frozen: boolean }
const clone = <T>(v: T): T => structuredClone(v);
function canonical(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  throw new Error("GATEWAY_INVALID_JSON");
}
function id(v: string) { if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v)) throw new Error("GATEWAY_INVALID_ID"); return v; }
function amount(v: string) { if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new Error("GATEWAY_INVALID_CREDITS"); return BigInt(v); }
function physicalModel(v: string) { if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(v)) throw new Error("GATEWAY_INVALID_MODEL"); return v; }
function count(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function route(v: string) {
  const url = new URL(v);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)
    || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.pathname.endsWith("/v1/chat/completions")) throw new Error("GATEWAY_INVALID_ROUTE");
  return url.toString();
}
function binding(v: GatewayBinding): GatewayBinding {
  if (!v || !/^[1-9][0-9]{0,77}$/.test(v.agentId) || !/^[1-9][0-9]{0,77}$/.test(v.taskId)
    || !/^0x[0-9a-fA-F]{40}$/.test(v.wallet) || /^0x0{40}$/.test(v.wallet)) throw new Error("GATEWAY_INVALID_BINDING");
  return { agentId: v.agentId, taskId: v.taskId, wallet: v.wallet.toLowerCase() };
}
export function validateGatewayCatalog(v: GatewayModel[]): GatewayModel[] {
  if (!Array.isArray(v) || v.length !== 2) throw new Error("GATEWAY_TWO_MODELS_REQUIRED");
  const models = v.map(m => {
    id(m.id); physicalModel(m.model); if (m.responseModel !== undefined) physicalModel(m.responseModel); if (amount(m.inputMicroCreditsPerToken) <= 0n || amount(m.outputMicroCreditsPerToken) <= 0n
      || !count(m.maxCompletionTokens) || m.maxCompletionTokens < 1 || m.maxCompletionTokens > 8192) throw new Error("GATEWAY_INVALID_MODEL");
    return { id: m.id, model: m.model, ...(m.responseModel !== undefined ? { responseModel: m.responseModel } : {}), route: route(m.route), inputMicroCreditsPerToken: m.inputMicroCreditsPerToken,
      outputMicroCreditsPerToken: m.outputMicroCreditsPerToken, maxCompletionTokens: m.maxCompletionTokens };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (models[0].id === models[1].id || models[0].model === models[1].model || models[0].route !== models[1].route) throw new Error("GATEWAY_INVALID_CATALOG");
  return models;
}
function source(v: GatewayGrantSource): GatewayGrantSource {
  if (v?.kind === "game") return { kind: "game", rewardId: id(v.rewardId) };
  if (v?.kind === "chain-payment" && /^0x[0-9a-fA-F]{64}$/.test(v.paymentId) && /^0x[0-9a-fA-F]{64}$/.test(v.txHash))
    return { kind: "chain-payment", paymentId: v.paymentId.toLowerCase(), txHash: v.txHash.toLowerCase() };
  throw new Error("GATEWAY_INVALID_GRANT_SOURCE");
}

/** Trusted-host ledger: the host must verify every game/payment grant before admission. */
export class InferenceGateway {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, { digest: string; promise: Promise<GatewayResult> }>();
  private closed = false;
  private constructor(private store: SessionStore<GatewayState>, private data: GatewayState, private dispatch: GatewayDispatch) {}
  static async open(directory: string, identity: GatewayBinding, models: GatewayModel[], dispatch: GatewayDispatch, recover = false) {
    const identitySnapshot = binding(identity), modelSnapshot = validateGatewayCatalog(models), store = new SessionStore<GatewayState>(directory);
    await store.start(recover);
    try {
      const saved = await store.read();
      if (saved && (saved.version !== 1 || canonical(saved.binding) !== canonical(identitySnapshot) || canonical(saved.catalog) !== canonical(modelSnapshot)))
        throw new Error("GATEWAY_BINDING_OR_CATALOG_CHANGED");
      const data: GatewayState = saved ?? { version: 1, binding: identitySnapshot, catalog: modelSnapshot, grants: [], invocations: [] };
      const gateway = new InferenceGateway(store, data, dispatch);
      if (data.closure && !validGatewayClosure(data)) throw new Error("GATEWAY_CLOSURE_INVALID");
      for (const r of data.invocations) {
        if (r.state === "DispatchIntent") { r.state = "Unknown"; r.error = "GATEWAY_OUTCOME_UNKNOWN"; }
        if (r.state === "ResponseRecorded") gateway.settle(r);
      }
      await store.write(data); return gateway;
    } catch (e) { await store.close(); throw e; }
  }
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next;
  }
  private active() { if (this.closed) throw new Error("GATEWAY_CLOSED"); }
  private prepare(input: Record<string, Json>) {
    this.active(); canonical(input);
    if (this.data.closure) throw new Error("GATEWAY_PERMANENTLY_SEALED");
    if (!input || Object.keys(input).some(k => !["model", "messages", "tools", "max_completion_tokens", "stream", "thinking", "reasoning_effort"].includes(k))
      || !Array.isArray(input.messages) || !input.messages.length || input.tools !== undefined && !Array.isArray(input.tools)
      || input.reasoning_effort !== undefined && input.reasoning_effort !== "low"
      || input.stream !== undefined && input.stream !== false || input.thinking !== undefined && canonical(input.thinking) !== canonical({ type: "disabled" }))
      throw new Error("GATEWAY_INVALID_REQUEST");
    const model = this.data.catalog.find(m => m.id === input.model);
    if (!model) throw new Error("GATEWAY_MODEL_UNAVAILABLE");
    if (!count(input.max_completion_tokens) || input.max_completion_tokens < 1 || input.max_completion_tokens > model.maxCompletionTokens)
      throw new Error("GATEWAY_INVALID_COMPLETION_LIMIT");
    const request: GatewayRequest = { model: model.model, messages: clone(input.messages), max_completion_tokens: input.max_completion_tokens,
      stream: false, ...(input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {}), ...(input.thinking ? { thinking: clone(input.thinking) } : {}), ...(input.tools ? { tools: clone(input.tools) } : {}) };
    const bytes = Buffer.byteLength(canonical({ messages: request.messages, tools: request.tools ?? [] }));
    if (bytes > 65536) throw new Error("GATEWAY_PROMPT_TOO_LARGE");
    // Conservative tokenizer-independent admission bound; actual provider usage settles below.
    const maxPromptTokens = bytes + 256 + input.messages.length * 32;
    const reservedCredits = (BigInt(maxPromptTokens) * amount(model.inputMicroCreditsPerToken)
      + BigInt(input.max_completion_tokens) * amount(model.outputMicroCreditsPerToken)).toString();
    return { model, request, quote: { modelId: model.id, reservedCredits, maxPromptTokens, maxCompletionTokens: input.max_completion_tokens },
      digest: createHash("sha256").update(canonical(request)).digest("hex") };
  }
  quote(request: Record<string, Json>): GatewayQuote { return this.prepare(request).quote; }
  balance(): GatewayBalance {
    this.active(); let granted = 0n, spent = 0n, reserved = 0n;
    for (const g of this.data.grants) granted += amount(g.credits);
    for (const r of this.data.invocations) {
      if (r.state === "Completed") spent += amount(r.result!.chargedCredits);
      else if (r.state !== "Rejected") reserved += amount(r.reservedCredits);
    }
    const available = granted - spent - reserved;
    return { grantedCredits: String(granted), spentCredits: String(spent), reservedCredits: String(reserved), availableCredits: String(this.data.closure || available < 0n ? 0n : available),
      frozen: Boolean(this.data.closure) || this.data.invocations.some(r => r.state === "Unknown" || r.state === "UsageOverrun") };
  }
  status(invocationId?: string): GatewayInvocation[] {
    this.active(); return this.data.invocations.filter(r => invocationId === undefined || r.id === invocationId).map(r => {
      const { request: _request, response: _response, ...publicRecord } = r; return clone(publicRecord);
    });
  }
  /** Recover only a durably completed matching call. This method never admits or dispatches work. */
  readResult(invocationId: string, request: Record<string, Json>): GatewayResult | undefined {
    id(invocationId); const prepared = this.prepare(request), record = this.data.invocations.find(r => r.id === invocationId);
    if (!record) return undefined;
    if (record.requestDigest !== prepared.digest) throw new Error("GATEWAY_REQUEST_CONFLICT");
    return record.state === "Completed" ? clone(record.result!) : undefined;
  }
  async grant(grantId: string, credits: string, grantSource: GatewayGrantSource): Promise<GatewayBalance> {
    id(grantId); if (amount(credits) <= 0n) throw new Error("GATEWAY_INVALID_CREDITS");
    const verifiedSource = source(grantSource);
    return this.lock(async () => {
      this.active(); if (this.data.closure) throw new Error("GATEWAY_PERMANENTLY_SEALED");
      const existing = this.data.grants.find(g => g.id === grantId);
      if (existing) { if (existing.credits !== credits || canonical(existing.source) !== canonical(verifiedSource)) throw new Error("GATEWAY_GRANT_CONFLICT"); return this.balance(); }
      if (this.data.grants.some(g => g.source.kind === verifiedSource.kind && (g.source.kind === "game" && verifiedSource.kind === "game" ? g.source.rewardId === verifiedSource.rewardId : g.source.kind === "chain-payment" && verifiedSource.kind === "chain-payment" && g.source.paymentId === verifiedSource.paymentId))) throw new Error("GATEWAY_GRANT_SOURCE_REUSED");
      this.data.grants.push({ id: grantId, credits, source: verifiedSource }); await this.store.write(this.data); return this.balance();
    });
  }
  /** Trusted operator entry only; hold the original SessionStore lock throughout. */
  async sealUnknown(input: Pick<GatewayClosure, "resolutionId" | "evidenceDigest" | "paymentId" | "expectedLedgerDigest">): Promise<GatewayClosure> {
    return this.lock(async () => {
      this.active();
      if (this.pending.size) throw new Error("GATEWAY_DISPATCH_IN_PROGRESS");
      if (this.data.closure) {
        const saved = this.data.closure;
        if (!validGatewayClosure(this.data) || Object.entries(input).some(([key, value]) => saved[key as keyof GatewayClosure] !== value)) throw new Error("GATEWAY_CLOSURE_CONFLICT");
        return clone(saved);
      }
      if (unsealedLedgerDigest(this.data) !== input.expectedLedgerDigest) throw new Error("GATEWAY_LEDGER_CHANGED");
      const closure: GatewayClosure = { version: 1, ...input, reason: "operator-accepted-unknown-cost", binding: clone(this.data.binding), sealedAt: Date.now() };
      if (!validGatewayClosure({ ...this.data, closure })) throw new Error("GATEWAY_NOT_SEALABLE");
      this.data.closure = closure; await this.store.write(this.data); return clone(closure);
    });
  }
  invoke(invocationId: string, input: Record<string, Json>): Promise<GatewayResult> {
    id(invocationId); const prepared = this.prepare(input);
    const running = this.pending.get(invocationId);
    if (running) {
      if (running.digest !== prepared.digest) return Promise.reject(new Error("GATEWAY_REQUEST_CONFLICT"));
      return running.promise;
    }
    const promise = this.run(invocationId, prepared);
    this.pending.set(invocationId, { digest: prepared.digest, promise });
    void promise.finally(() => { if (this.pending.get(invocationId)?.promise === promise) this.pending.delete(invocationId); }).catch(() => {});
    return promise;
  }
  private async run(invocationId: string, p: ReturnType<InferenceGateway["prepare"]>): Promise<GatewayResult> {
    const admitted = await this.lock(async () => {
      this.active(); const existing = this.data.invocations.find(r => r.id === invocationId);
      if (existing) {
        if (existing.requestDigest !== p.digest) throw new Error("GATEWAY_REQUEST_CONFLICT");
        if (existing.state === "Completed") return { cached: clone(existing.result!) };
        throw new Error(existing.error ?? "GATEWAY_OUTCOME_UNKNOWN");
      }
      const balance = this.balance(); if (balance.frozen) throw new Error("GATEWAY_FROZEN");
      if (amount(balance.availableCredits) < amount(p.quote.reservedCredits)) throw new Error("INFERENCE_FUNDING_REQUIRED");
      const record: RecordEntry = { id: invocationId, ...p.quote, requestDigest: p.digest, request: p.request, state: "DispatchIntent" };
      this.data.invocations.push(record); await this.store.write(this.data); return { record };
    });
    if (admitted.cached) return admitted.cached;
    const record = admitted.record!;
    let response: { status: number; body: Json };
    try { response = await this.dispatch(clone(p.model), clone(p.request)); canonical(response.body); }
    catch {
      await this.lock(async () => { record.state = "Unknown"; record.error = "GATEWAY_OUTCOME_UNKNOWN"; await this.store.write(this.data); });
      throw new Error("GATEWAY_OUTCOME_UNKNOWN");
    }
    return this.lock(async () => {
      record.response = clone(response); record.state = "ResponseRecorded"; await this.store.write(this.data);
      this.settle(record); await this.store.write(this.data);
      if (record.result && (record.state as string) === "Completed") return clone(record.result);
      throw new Error(record.error ?? "GATEWAY_OUTCOME_UNKNOWN");
    });
  }
  private settle(record: RecordEntry) {
    delete record.error; const response = record.response!;
    if (response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) {
      record.state = "Rejected"; record.error = "GATEWAY_REQUEST_REJECTED"; return;
    }
    const body = response.body as Record<string, any>, usage = body?.usage;
    const model = this.data.catalog.find(m => m.id === record.modelId)!;
    if (response.status !== 200 || body?.model !== (model.responseModel ?? model.model) || !Array.isArray(body?.choices) || !body.choices.length
      || !count(usage?.prompt_tokens) || !count(usage?.completion_tokens) || !count(usage?.total_tokens)
      || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens || usage.total_tokens === 0) {
      record.state = "Unknown"; record.error = "GATEWAY_UNVERIFIABLE_USAGE"; return;
    }
    const chargedCredits = (BigInt(usage.prompt_tokens) * amount(model.inputMicroCreditsPerToken)
      + BigInt(usage.completion_tokens) * amount(model.outputMicroCreditsPerToken)).toString();
    if (usage.prompt_tokens > record.maxPromptTokens || usage.completion_tokens > record.maxCompletionTokens || amount(chargedCredits) > amount(record.reservedCredits)) {
      record.state = "UsageOverrun"; record.error = "GATEWAY_USAGE_OVERRUN"; return;
    }
    record.result = { response: clone(response.body), usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }, chargedCredits };
    record.state = "Completed";
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(entry => entry.promise)); await this.queue; this.closed = true; await this.store.close(); }
}

/** Same authenticated Magpie endpoint for both physical models; secrets live only in this closure. */
export function createMagpieDispatch(config: { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): GatewayDispatch {
  const endpoint = route(`${config.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions`);
  if (!config.apiKey.trim()) throw new Error("GATEWAY_KEY_REQUIRED");
  return async (model, request) => {
    if (model.route !== endpoint || request.model !== model.model) throw new Error("GATEWAY_ROUTE_CHANGED");
    const response = await (config.fetch ?? fetch)(endpoint, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(config.timeoutMs ?? 30000) });
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("GATEWAY_RESPONSE_TOO_LARGE");
    let body: Json; try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body };
  };
}
