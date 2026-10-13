import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredHttpsProxy, defaultUpstreamTransport } from "../demo-rpc.js";
import { linuxMagpieScript, startLinuxMagpie } from "../linux-magpie.js";
import { stopMagpie } from "../magpie-gateway.js";

test("Linux defaults to direct upstream, while explicit HTTP proxy rejects URL credentials and redirects", () => {
  assert.equal(defaultUpstreamTransport("linux"), "direct");
  assert.equal(defaultUpstreamTransport("darwin"), "system-https-proxy");
  assert.equal(configuredHttpsProxy({}), undefined);
  assert.equal(configuredHttpsProxy({ AGENTFUEL_HTTPS_PROXY: "http://127.0.0.1:8080" }), "http://127.0.0.1:8080");
  for (const value of ["", "https://proxy.example", "http://proxy.example:0", "http://user:password@proxy.example:8080", "http://proxy.example/path", "http://proxy.example?credential=x", "http://proxy.example#fragment"]) {
    assert.throws(() => configuredHttpsProxy({ AGENTFUEL_HTTPS_PROXY: value }), /CONFIGURED_HTTPS_PROXY_INVALID/);
  }
});

test("Linux isolated Magpie rejects invalid or colliding TCP ports before launch", () => {
  for (const [port, peers] of [[0, [3427]], [3426, [3426]], [3426, [65536]], [3426, [NaN]]] as [number, number[]][]) {
    assert.throws(() => linuxMagpieScript(port, peers), /MAGPIE_LINUX_PORT_INVALID/);
  }
});

async function freePort() {
  const server = tcpServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}

test("Linux sandbox hides host files, denies unconfigured loopback peers and routes configured peers", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-linux-runtime-test-"));
  const state = join(directory, "state"); await mkdir(state);
  const secret = join(directory, "host-secret"); await writeFile(secret, "host-only-fixture", { mode: 0o600 });
  let requests = 0, deniedRequests = 0;
  const allowed = createServer((_request, response) => { requests++; response.end("controlled-peer"); });
  const denied = createServer((_request, response) => { deniedRequests++; response.end("must-stay-unreachable"); });
  allowed.listen(0, "127.0.0.1"); denied.listen(0, "127.0.0.1"); await Promise.all([once(allowed, "listening"), once(denied, "listening")]);
  const allowedPort = (allowed.address() as { port: number }).port, deniedPort = (denied.address() as { port: number }).port, port = await freePort();
  const binary = join(directory, "fixture-magpie");
  await writeFile(binary, `#!/bin/sh
set -eu
test ! -e ${secret}
if printf 'GET / HTTP/1.0\\r\\n\\r\\n' | /usr/bin/socat - TCP4:127.0.0.1:${deniedPort},connect-timeout=1 2>/dev/null; then exit 42; fi
exec /usr/bin/socat TCP4-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork TCP4:127.0.0.1:${allowedPort}
`, { mode: 0o755 });
  let sandbox: Awaited<ReturnType<typeof startLinuxMagpie>> | undefined;
  try {
    sandbox = await startLinuxMagpie({ binary, state, port, peers: [allowedPort, allowedPort], env: { PATH: "/usr/bin:/bin", HOME: directory } });
    let diagnostic = ""; sandbox.child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    sandbox.child.on("error", error => { diagnostic += error.message; });
    let response: string | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (sandbox.child.exitCode !== null) assert.fail(`Linux namespace launch failed: ${diagnostic}`);
      try { response = await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(200) })).text(); break; } catch {}
      await new Promise<void>(done => setTimeout(done, 50));
    }
    assert.equal(response, "controlled-peer", diagnostic);
    assert.equal(requests, 1); assert.equal(deniedRequests, 0);
  } finally {
    if (sandbox) { await stopMagpie(sandbox.child); await sandbox.close(); }
    await Promise.all([allowed, denied].map(server => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); })));
    await rm(directory, { recursive: true, force: true });
  }
});
