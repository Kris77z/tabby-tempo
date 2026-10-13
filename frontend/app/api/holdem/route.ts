import "server-only";
import { loadHoldemSnapshot } from "../../../lib/holdem-report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// No request path, URL, RPC, or model input is accepted. Only server configuration selects the public report.
export async function GET() {
  const snapshot = await loadHoldemSnapshot();
  return Response.json(snapshot, { status: snapshot.error ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
