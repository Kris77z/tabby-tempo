import "server-only";
import { CreditHttpError, parseCreditCommand } from "../../../../../services/arena/src/inference-rewards/http";
import { gameFiCreditSnapshot } from "../../../../lib/gamefi-credits-server";
import { hasAllowedGameFiOrigin } from "../../../../lib/gamefi-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const known = error instanceof CreditHttpError || /^(?:REWARD|SESSION)_[A-Z_]+$/.test(code);
  const status = error instanceof CreditHttpError ? error.status
    : /(?:INSUFFICIENT|BLOCKED|BINDING_MISMATCH|BUSY|RECOVERY)/.test(code) ? 409
      : /(?:INVALID|NOT_AUTHORIZED)/.test(code) ? 400 : 503;
  return Response.json({ error: known ? code : "REWARD_UNAVAILABLE" }, { status, headers });
}
async function body(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new CreditHttpError("REWARD_JSON_REQUIRED", 415);
  const reader = request.body?.getReader(); if (!reader) throw new CreditHttpError("REWARD_COMMAND_INVALID");
  let size = 0, raw = ""; const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new CreditHttpError("REWARD_COMMAND_TOO_LARGE", 413); }
      raw += decoder.decode(next.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(raw + decoder.decode()); } catch { throw new CreditHttpError("REWARD_COMMAND_INVALID"); }
}
export async function GET(request: Request) {
  try {
    if (!hasAllowedGameFiOrigin(request)) throw new CreditHttpError("REWARD_INVALID_ORIGIN", 403);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => key !== "redemptionId") || url.searchParams.getAll("redemptionId").length > 1)
      throw new CreditHttpError("REWARD_QUERY_INVALID");
    const redemptionId = url.searchParams.get("redemptionId");
    return Response.json(await gameFiCreditSnapshot(redemptionId === null ? undefined
      : parseCreditCommand({ action: "query", redemptionId })), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    if (!hasAllowedGameFiOrigin(request)) throw new CreditHttpError("REWARD_INVALID_ORIGIN", 403);
    return Response.json(await gameFiCreditSnapshot(parseCreditCommand(await body(request))), { headers });
  } catch (error) { return failure(error); }
}
