import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Relay, RelayError } from "./relay.js";
import { Refunder } from "./refunder.js";

export function createHttpServer(relay: Relay, refunder: Refunder) {
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (origin !== relay.config.frontendOrigin) throw new RelayError("ORIGIN_REJECTED", "Origin is not configured", 403);
        res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "Origin");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, x-payment-id, x-payment-tx");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      }
      const url = new URL(req.url || "/", "http://localhost");
      let result;
      if (req.method === "GET" && /^\/payments\/0x[0-9a-f]{64}$/.test(url.pathname)) {
        result = await relay.status(url.pathname.split("/")[2], url.searchParams.get("agentId") || "", url.searchParams.get("requestDigest") || "");
      } else if (req.method === "POST" && ["/v1/chat", "/ops/refund", "/ops/resolve-undelivered", "/ops/compensate-allowance"].includes(url.pathname)) {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new RelayError("INVALID_CONTENT_TYPE", "Use application/json", 415);
        if (Number(req.headers["content-length"] || 0) > 131072) throw new RelayError("BODY_TOO_LARGE", "Request exceeds 128KiB", 413);
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 131072) throw new RelayError("BODY_TOO_LARGE", "Request exceeds 128KiB", 413); chunks.push(Buffer.from(chunk)); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RelayError("INVALID_JSON", "Invalid JSON", 400); }
        if (url.pathname.startsWith("/ops/")) {
          const token = Buffer.from(relay.config.operatorToken || ""); const supplied = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, ""));
          if (origin || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "") || !token.length || token.length !== supplied.length || !timingSafeEqual(token, supplied)) {
            throw new RelayError("OPERATOR_REQUIRED", "Loopback and operator token required", 403);
          }
          result = url.pathname === "/ops/resolve-undelivered" ? await relay.resolveUndelivered(body)
            : url.pathname === "/ops/compensate-allowance" ? await relay.compensateAllowance(body) : await refunder.refund(body.paymentId, body.refundId, body.amount);
        } else {
          const id = req.headers["x-payment-id"];
          const input = relay.validate(body, !id); // Existing payments use their persisted request/route, even after a config change.
          if (!id) { const quote = await relay.quote(input); res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ quote })); return; }
          if (typeof id !== "string" || typeof req.headers["x-payment-tx"] === "object") throw new RelayError("INVALID_PAYMENT", "Use one paymentId/txHash", 400);
          result = await relay.chat(input, id, req.headers["x-payment-tx"]);
        }
      } else throw new RelayError("NOT_FOUND", "Endpoint not found", 404);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof RelayError;
      res.writeHead(known ? error.status : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: known ? error.code : "SERVICE_UNAVAILABLE", message: known ? error.message : "RPC or relay storage unavailable" }));
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  return server;
}
