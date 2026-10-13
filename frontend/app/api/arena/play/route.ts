import "server-only";
import { PlayError, playStore } from "@agentfuel/arena/freeplay-store";
import { hasAllowedPlayOrigin } from "../../../../lib/play-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
function bearer(request: Request) {
  const value = request.headers.get("authorization");
  if (!value) return undefined;
  if (!value.startsWith("Bearer ") || value.length > 100) throw new PlayError("UNAUTHORIZED", 401);
  return value.slice(7);
}
function failure(error: unknown) {
  const known = error instanceof PlayError;
  return Response.json({ error: known ? error.code : "ARENA_ERROR", message: known ? error.code : "游戏服务暂时不可用",
    ...(known && error.version !== undefined ? { version: error.version } : {}) }, { status: known ? error.status : 500, headers });
}
async function readCommand(request: Request): Promise<unknown> {
  const size = request.headers.get("content-length");
  if (size && Number(size) > 20_000) throw new PlayError("COMMAND_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PlayError("INVALID_JSON");
  const decoder = new TextDecoder();
  let bytes = 0, raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 20_000) { await reader.cancel(); throw new PlayError("COMMAND_TOO_LARGE", 413); }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  try { return JSON.parse(raw); } catch { throw new PlayError("INVALID_JSON"); }
}
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("matchId");
    return Response.json(id ? playStore.get(id, bearer(request)) : playStore.list(), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    if (!hasAllowedPlayOrigin(request)) throw new PlayError("INVALID_ORIGIN", 403);
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) throw new PlayError("JSON_REQUIRED", 415);
    const command = await readCommand(request);
    return Response.json(playStore.command(command, bearer(request)), { headers });
  } catch (error) { return failure(error); }
}
