import "server-only";
import { hostedAgentsRequest } from "../../../../lib/hosted-agents-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function handle(request: Request) {
  return hostedAgentsRequest(request, { upstreamUrl: process.env.HOSTED_AGENTS_URL, origin: process.env.HOSTED_FRONTEND_ORIGIN,
    trustProxy: process.env.HOSTED_FRONTEND_TRUST_PROXY === "1" });
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
