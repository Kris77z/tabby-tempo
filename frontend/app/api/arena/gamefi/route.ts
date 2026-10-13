import "server-only";
import { GameFiError, parseGameFiCommand } from "@agentfuel/arena/gamefi-runner";
import { getGameFiServerContext } from "../../../../lib/gamefi-server";
import { hasAllowedGameFiOrigin } from "../../../../lib/gamefi-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  const known = error instanceof GameFiError;
  return Response.json({ error: known ? error.code : "GAMEFI_UNAVAILABLE" }, { status: known ? error.status : 503, headers });
}
async function body(request: Request): Promise<unknown> {
  if ((request.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim() !== "application/json") throw new GameFiError("GAMEFI_JSON_REQUIRED", 415);
  const reader = request.body?.getReader(); if (!reader) throw new GameFiError("GAMEFI_COMMAND_INVALID");
  let bytes = 0, raw = ""; const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > 2048) { await reader.cancel(); throw new GameFiError("GAMEFI_COMMAND_TOO_LARGE", 413); }
    raw += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(raw + decoder.decode()); } catch { throw new GameFiError("GAMEFI_COMMAND_INVALID"); }
}
export async function GET(request: Request) {
  try {
    if (!hasAllowedGameFiOrigin(request)) throw new GameFiError("GAMEFI_INVALID_ORIGIN", 403);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => key !== "requestId") || url.searchParams.getAll("requestId").length > 1) throw new GameFiError("GAMEFI_QUERY_INVALID");
    const context = await getGameFiServerContext();
    if (!context) return Response.json({ enabled: false, rewardKinds: [], runs: [] }, { headers });
    return Response.json(await context.runner.snapshot(url.searchParams.get("requestId") ?? undefined), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    if (!hasAllowedGameFiOrigin(request)) throw new GameFiError("GAMEFI_INVALID_ORIGIN", 403);
    const command = parseGameFiCommand(await body(request)), context = await getGameFiServerContext();
    if (!context) throw new GameFiError("GAMEFI_NOT_CONFIGURED", 503);
    return Response.json(await context.runner.command(command), { status: 202, headers });
  } catch (error) { return failure(error); }
}
