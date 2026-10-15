import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import type { JsonRpcProvider } from "ethers";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { Refunder, type RefunderOptions } from "../services/provider-relay/src/refunder.js";
import { missionSpecialists } from "../services/hosted-agents/src/specialists/catalog.js";
import { ExternalSpecialistRelay, createExternalServiceServer } from "../services/hosted-agents/src/external/service.js";
import { externalAdvertisement, validateExternalHiringConfig, type ExternalHiringConfig, type ExternalServiceTrust } from "../services/hosted-agents/src/external/registry.js";

/** Real HTTP service pool for the owned fixture or separately approved operator stack. Each specialist
 * has an isolated quote/payment journal and two independently priced services.
 * Production enablement requires a separately reviewed provider and guard migration. */
export async function startExternalSpecialistStack(options: {
  base: RelayConfig; provider: JsonRpcProvider; directory: string;
  providerIdentity: {chainId:string;registry:string;agentId:string;wallet:string};
  models: { id: string; model: string; responseModel?: string; baseUrl: string; key: string; priceRaw: string }[];
  ports?: Record<string, number>; savePort?(name: string, port: number): Promise<void>;
  upstreamFetch?: typeof fetch;
  refundLimits?: RefunderOptions;
}) {
  if (options.base.chainId === 42431n && (!options.refundLimits?.maxFeePerGas || options.refundLimits.gasLimit !== 10_000_000n || !options.refundLimits.serialize)) throw Error("EXTERNAL_TEMPO_REFUND_LIMITS_REQUIRED");
  const ports = options.ports ?? {}, services: ExternalServiceTrust[] = [], servers: Server[] = [], relays: ExternalSpecialistRelay[] = [];
  const close = async () => {
    for (const server of servers) if (server.listening) await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); });
    for (const relay of relays) relay.close();
  };
  const listen = async (server: Server, name: string) => {
    servers.push(server); server.listen(ports[name] ?? 0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port; ports[name] = port; await options.savePort?.(name, port); return port;
  };
  try {
    for (const specialist of missionSpecialists) for (const [index, model] of options.models.entries()) {
      const id = `external-${specialist.id}-${model.id}`, name = `external-${specialist.id}-${index}`;
      const trust: ExternalServiceTrust = { id, name: `${specialist.name} · ${model.id}`, taskType: specialist.id,
        endpoint: `http://127.0.0.1:${ports[name] ?? 1}/v1/chat`, serviceId: `tabby/external/${specialist.id}`,
        modelId: model.id, physicalModel: model.model, ...(model.responseModel?{responseModel:model.responseModel}:{}),
        priceRaw: model.priceRaw, provider: options.providerIdentity.wallet, identity: {...options.providerIdentity} };
      const relay = new ExternalSpecialistRelay({ ...options.base, payTo:options.providerIdentity.wallet, dataDir: join(options.directory, id),
        service: {id:trust.serviceId,model:trust.modelId,price:BigInt(trust.priceRaw),upstreams:[{name:model.id,model:model.model,baseUrl:model.baseUrl,key:model.key}]} }, trust,
        {provider:options.provider,upstreamFetch:options.upstreamFetch});
      relays.push(relay); await relay.initialize(); const refunder = new Refunder(relay, options.refundLimits); await refunder.initialize();
      const port = await listen(createExternalServiceServer(relay, refunder), name);
      trust.endpoint = `http://127.0.0.1:${port}/v1/chat`; services.push(trust);
    }
    const registry = createServer((req,res) => {
      if(req.method !== "GET" || req.url !== "/services") {res.writeHead(404);res.end();return;}
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      // No invented ratings: an operator may add canonical reputation readers
      // in a separately configured deployment; this directory starts unrated.
      res.end(JSON.stringify({services:services.map(s=>externalAdvertisement(s))}));
    });
    const port = await listen(registry,"external-registry");
    const config:ExternalHiringConfig=validateExternalHiringConfig({version:1,registryUrl:`http://127.0.0.1:${port}/services`,services,minReputation:0,timeoutMs:10000});
    return {config,close};
  } catch(error) {await close();throw error;}
}
