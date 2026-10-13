import { createServer, type IncomingMessage } from "node:http";
import { uint256 } from "./config.js";
import { json, Rejection, type Underwriter } from "./underwriter.js";
import { journalDiagnostic } from "../../../scripts/demo-common.js";

const BODY_LIMIT = 4096;
async function requestBody(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new Rejection("INVALID_CONTENT_TYPE", "Use application/json", 415);
  }
  if (Number(req.headers["content-length"] || 0) > BODY_LIMIT) throw new Rejection("BODY_TOO_LARGE", "JSON body exceeds 4096 bytes", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > BODY_LIMIT) throw new Rejection("BODY_TOO_LARGE", "JSON body exceeds 4096 bytes", 413);
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Rejection("INVALID_JSON", "Body must be valid JSON", 400); }
}

export function createHttpServer(underwriter: Underwriter, frontendOrigin?: string) {
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (origin !== frontendOrigin) throw new Rejection("ORIGIN_REJECTED", "Origin is not configured", 403);
        res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "Origin");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      }
      let result: unknown;
      if (req.method === "POST" && req.url === "/authorize") {
        const body = await requestBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "agentId,nonce,taskId") {
          throw new Rejection("INVALID_REQUEST", "Body requires only agentId, taskId, nonce", 400);
        }
        const input = body as Record<string, unknown>;
        let values: bigint[];
        try { values = [uint256(input.agentId, "agentId"), uint256(input.taskId, "taskId"), uint256(input.nonce, "nonce")]; }
        catch (error) { throw new Rejection("INVALID_REQUEST", (error as Error).message, 400); }
        result = await underwriter.authorize(values[0], values[1], values[2]);
      } else if (req.method === "GET" && /^\/agents\/[^/]+\/credit$/.test(req.url || "")) {
        let agentId: bigint;
        try { agentId = uint256(req.url!.split("/")[2], "agentId"); }
        catch (error) { throw new Rejection("INVALID_REQUEST", (error as Error).message, 400); }
        result = await underwriter.credit(agentId);
      } else {
        throw new Rejection("NOT_FOUND", "Endpoint not found", 404);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(json(result));
    } catch (error) {
      const known = error instanceof Rejection;
      if (!known) {
        // Restrict diagnostics to codes/status; RPC errors may embed private
        // URLs, request bodies or signed material in their message/stack.
        console.error("UNDERWRITER_READ_FAILED", JSON.stringify(journalDiagnostic(error)));
      }
      res.writeHead(known ? error.status : 503, { "content-type": "application/json" });
      res.end(json({ error: known ? error.code : "SERVICE_UNAVAILABLE", message: known ? error.message : "RPC or evidence storage unavailable" }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
