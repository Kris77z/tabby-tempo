import assert from "node:assert/strict";
import test from "node:test";
import { hasAllowedGameFiOrigin } from "../lib/gamefi-origin.js";

test("paid GameFi mutations require a loopback Host and exactly the browser origin", () => {
  const request = (host: string, origin?: string, method = "POST") => new Request("http://127.0.0.1:3021/api/arena/gamefi", { method,
    headers: { host, ...(origin ? { origin } : {}) } });
  assert.equal(hasAllowedGameFiOrigin(request("127.0.0.1:3021", "http://127.0.0.1:3021")), true);
  assert.equal(hasAllowedGameFiOrigin(request("localhost:3021", "http://localhost:3021")), true);
  assert.equal(hasAllowedGameFiOrigin(request("[::1]:3021", "http://[::1]:3021")), true);
  for (const input of [request("evil.example", "http://evil.example"), request("127.0.0.1:3021", "http://evil.example"),
    request("127.0.0.1:3021"), request("127.0.0.1:3021", "http://127.0.0.1:3020"), request("127.0.0.1:99999", "http://127.0.0.1:99999")])
    assert.equal(hasAllowedGameFiOrigin(input), false);
  assert.equal(hasAllowedGameFiOrigin(request("127.0.0.1:3021", undefined, "GET")), true);
});
