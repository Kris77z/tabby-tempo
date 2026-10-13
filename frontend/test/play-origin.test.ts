import test from "node:test";
import assert from "node:assert/strict";
import { hasAllowedPlayOrigin } from "../lib/play-origin";

const request = (headers: Record<string, string>) => new Request("http://localhost:3020/api/arena/play", { method: "POST", headers });
test("browser origin matches target Host when Next request URL uses an internal hostname", () => {
  assert.equal(hasAllowedPlayOrigin(request({ Host: "127.0.0.1:3020", Origin: "http://127.0.0.1:3020" })), true);
  assert.equal(hasAllowedPlayOrigin(request({ Host: "localhost:3020", Origin: "http://localhost:3020" })), true);
  assert.equal(hasAllowedPlayOrigin(request({ Host: "127.0.0.1:3020" })), true);
});
test("cross origins and untrusted forwarded host cannot authorize a browser mutation", () => {
  for (const origin of ["https://evil.example", "http://127.0.0.1:3021", "https://127.0.0.1:3020", "null", "http://127.0.0.1:3020/path"]) {
    assert.equal(hasAllowedPlayOrigin(request({ Host: "127.0.0.1:3020", Origin: origin, "X-Forwarded-Host": new URL("http://evil.example").host })), false);
  }
  assert.equal(hasAllowedPlayOrigin(request({ Host: "127.0.0.1:3020", Origin: "http://evil.example", "X-Forwarded-Host": "evil.example" })), false);
});
