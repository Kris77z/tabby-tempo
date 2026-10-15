import { type IncomingMessage, type ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import type { ChatInput, Json } from "@agentfuel/sdk";
import { Relay, RelayError, type RelayOptions } from "../../../provider-relay/src/relay.js";
import { createHttpServer } from "../../../provider-relay/src/http.js";
import { Refunder } from "../../../provider-relay/src/refunder.js";
import type { RelayConfig } from "../../../provider-relay/src/config.js";
import { externalAdvertisement, type ExternalServiceTrust } from "./registry.js";
import { externalResultBinding } from "./hiring.js";

/** An independently running paid specialist, not a cosmetic internal role.
 * It reuses monad-rebel specialist prompts and Tabby's canonical 402/payment
 * journal, cash Account and original-handle reconciliation protocol. */
export class ExternalSpecialistRelay extends Relay {
  constructor(config: RelayConfig, readonly identity: ExternalServiceTrust,
    options: RelayOptions = {}) {
    const upstreamFetch: typeof fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      const binding = externalResultBinding(identity, request.messages, String(config.chainId));
      const response = await (options.upstreamFetch ?? fetch)(url, { ...init, redirect: "error" });
      if (!response.ok) return response;
      const result = await response.json() as Record<string, Json>;
      // The provider adds task/service provenance before Relay durably stores
      // the delivered result. A reconnect/status read sees exactly that result.
      return Response.json({ ...result, externalService: binding });
    };
    super(config, { ...options, upstreamFetch });
    if (config.service.id !== identity.serviceId || config.service.model !== identity.modelId || config.service.price.toString() !== identity.priceRaw ||
      config.payTo.toLowerCase() !== identity.provider.toLowerCase() || config.service.tiers || config.service.upstreams.length !== 1 ||
      config.service.upstreams[0].model !== identity.physicalModel) { this.close(); throw new Error("HOSTED_EXTERNAL_SERVICE_BINDING_CHANGED"); }
  }
  override validate(value: unknown, forQuote = true): ChatInput {
    const input = super.validate(value, forQuote);
    try {
      if (Object.keys(input).sort().join(",") !== "agentId,max_completion_tokens,messages,model,service,taskId,thinking" || input.taskId !== "0" ||
        input.max_completion_tokens !== 2048 || !isDeepStrictEqual(input.thinking, { type: "disabled" })) throw new Error();
      externalResultBinding(this.identity, input.messages as unknown as { role: string; content: string }[], String(this.config.chainId));
    } catch { throw new RelayError("EXTERNAL_ASSIGNMENT_INVALID", "Use the configured specialist and the original bounded task assignment", 400); }
    return input;
  }
}

/** Registry and identity endpoints are public metadata. Existing paid/status
 * and protected operator endpoints remain the audited Relay HTTP handlers. */
export function createExternalServiceServer(relay: ExternalSpecialistRelay, refunder: Refunder,
  reputation?: { score: number | null; samples: number }) {
  const server = createHttpServer(relay, refunder);
  const handler = server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); }
    catch {
      res.writeHead(400, { "content-type": "application/json", "connection": "close" });
      res.end(JSON.stringify({ error: "INVALID_URL", message: "Invalid request URL" }));
      return;
    }
    if (req.method === "GET" && ["/identity", "/services"].includes(url.pathname)) {
      const service = externalAdvertisement(relay.identity, reputation);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(url.pathname === "/identity" ? { service } : { services: [service] }));
      return;
    }
    handler(req, res);
  });
  return server;
}
