import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { magpieLock, sha256 } from "../magpie-build.js";
import { linuxMagpieScript, startLinuxMagpie } from "../linux-magpie.js";
import { stopMagpie, verifyMagpieBinary } from "../magpie-gateway.js";

test("Linux isolated Magpie rejects invalid or colliding TCP ports before launch", () => {
  for (const [port, peers] of [[0, [3427]], [3426, [3426]], [3426, [65536]], [3426, [NaN]], [3426, [1.5]]] as [number, number[]][]) {
    assert.throws(() => linuxMagpieScript(port, peers), /MAGPIE_LINUX_PORT_INVALID/);
  }
});

test("Linux bridge deduplicates explicit peers and waits for Magpie with signal cleanup", () => {
  const script = linuxMagpieScript(3426, [3427, 3427, 3428]);
  assert.equal(script.match(/TCP4-LISTEN:3427,/g)?.length, 1);
  assert.equal(script.match(/TCP4-LISTEN:3428,/g)?.length, 1);
  assert.ok(script.includes("UNIX-LISTEN:/run/agentfuel-magpie/gateway.sock,fork,mode=0600 TCP4:127.0.0.1:3426"));
  assert.ok(script.includes("trap cleanup EXIT"));
  assert.ok(script.endsWith('wait "$!"\n'));
});

test("Magpie cleanup returns when its child has already exited by signal", { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: {}, stdio: "ignore" });
  await once(child, "spawn");
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(await Promise.race([stopMagpie(child).then(() => true), delay(100).then(() => false)]), true);
});

test("Magpie provenance rejects changed binary, build platform, lock and patched source before launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-magpie-provenance-test-"));
  const binary = join(directory, "magpie");
  const contents = "synthetic-offline-binary";
  const manifest = { ...magpieLock, binarySha256: sha256(contents), platform: process.platform, arch: process.arch };
  const save = async (value: unknown) => writeFile(join(directory, "build.json"), JSON.stringify(value));
  try {
    await writeFile(binary, contents); await save(manifest);
    assert.equal((await verifyMagpieBinary(binary)).binarySha256, manifest.binarySha256);
    for (const change of [
      { binarySha256: "wrong" }, { platform: "unsupported" }, { arch: "wrong" }, { commit: "wrong" },
      { patchSha256: "wrong" }, { patchedVersion: "wrong" }, { patchedSourceSha256: {} },
    ]) {
      await save({ ...manifest, ...change });
      await assert.rejects(verifyMagpieBinary(binary), /provenance\/checksum mismatch/);
    }
    await save(manifest); await writeFile(binary, "changed-binary");
    await assert.rejects(verifyMagpieBinary(binary), /provenance\/checksum mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function freePort() {
  const server = tcpServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}

test("Linux sandbox hides host files, denies unconfigured loopback peers and routes configured peers", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-linux-magpie-test-"));
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
