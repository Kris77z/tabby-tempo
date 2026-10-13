import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { magpieLock, sha256 } from "./magpie-build.js";

export interface MagpieProvider { id: string; model: string; baseUrl: string; key: string }
export async function verifyMagpieBinary(binaryPath: string, officialBaseline = false) {
  const binary = resolve(binaryPath);
  const digest = sha256(await readFile(binary));
  if (officialBaseline) {
    if (process.platform !== "darwin" || process.arch !== "arm64" || digest !== magpieLock.officialDarwinArm64BinarySha256) throw new Error("Baseline requires the checksum-locked official darwin-arm64 v0.1.814 binary");
  } else {
    const build = JSON.parse(await readFile(join(dirname(binary), "build.json"), "utf8"));
    if (build.binarySha256 !== digest || build.commit !== magpieLock.commit || build.patchSha256 !== magpieLock.patchSha256 ||
      build.patchedVersion !== magpieLock.patchedVersion || build.platform !== process.platform || build.arch !== process.arch ||
      JSON.stringify(build.patchedSourceSha256) !== JSON.stringify(magpieLock.patchedSourceSha256)) throw new Error("Magpie build provenance/checksum mismatch");
  }
  return { binary, binarySha256: digest, version: officialBaseline ? "0.1.814" : magpieLock.patchedVersion, commit: magpieLock.commit, patchSha256: officialBaseline ? null : magpieLock.patchSha256 };
}

export async function stopMagpie(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) { child.kill("SIGKILL"); await exited; }
}

export async function startMagpie(options: { binary: string; stateDirectory: string; port: number; providers: MagpieProvider[]; officialBaseline?: boolean }) {
  // This local spike uses macOS sandbox-exec so Magpie cannot discover real agent credentials or make external requests.
  if (process.platform !== "darwin") throw new Error("The verified local launcher currently requires macOS sandbox-exec; container/Linux isolation is not verified");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !options.providers.length) throw new Error("Use a local port and at least one explicit provider");
  const provenance = await verifyMagpieBinary(options.binary, options.officialBaseline);
  const state = resolve(options.stateDirectory); const config = join(state, "config", "magpie");
  await mkdir(config, { recursive: true, mode: 0o700 });
  const ids = new Set<string>();
  const providers = options.providers.map(provider => {
    const url = new URL(provider.baseUrl);
    if (!/^[a-z][a-z0-9-]*$/.test(provider.id) || ids.has(provider.id) || !provider.model || provider.model.includes("/") || !provider.key ||
      url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/v1")) throw new Error("Local spike providers require unique ids, physical model ids and loopback HTTP /v1 bases");
    ids.add(provider.id);
    return { id: provider.id, name: provider.id, key: provider.key, chat: provider.baseUrl, models: [provider.model], routing: "order", proxy: "direct", affinity: "off" };
  });
  await writeFile(join(config, "providers.json"), JSON.stringify({ providers, noAutoGroups: true }), { mode: 0o600 });
  await writeFile(join(config, "settings.json"), JSON.stringify({ noAutoUpdate: true, noStats: true, proxy: "direct", lightweight: true }), { mode: 0o600 });
  // Inert discovery commands also keep the macOS Keychain out of this test process.
  const inert = join(state, "bin"); await mkdir(inert, { recursive: true });
  for (const name of ["security", "secret-tool", "claude", "codex", "cursor-agent", "devin", "grok", "kiro-cli"]) {
    await writeFile(join(inert, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  const literal = (value: string) => JSON.stringify(value);
  const profile = `(version 1)(allow default)(deny file-read* file-write* (subpath ${literal(homedir())}))(allow file-read* file-write* (subpath ${literal(state)}))(allow file-read* (literal ${literal(provenance.binary)}))(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`;
  const env: NodeJS.ProcessEnv = { PATH: `${inert}:/usr/bin:/bin`, XDG_CONFIG_HOME: join(state, "config"), XDG_CACHE_HOME: join(state, "cache"),
    XDG_DATA_HOME: join(state, "data"), XDG_STATE_HOME: join(state, "state"), MAGPIE_ADDR: `127.0.0.1:${options.port}`,
    MAGPIE_NO_STATS: "1", DO_NOT_TRACK: "1" };
  // Preserve the system's home meaning; access to it is denied by the sandbox above.
  if (process.env.HOME) env.HOME = process.env.HOME;
  const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, provenance.binary, "serve"], { env, cwd: state, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let failure = "";
  child.stdout!.on("data", chunk => { output = (output + String(chunk)).slice(-16384); });
  child.stderr!.on("data", chunk => { output = (output + String(chunk)).slice(-16384); });
  child.on("error", error => { failure = error.message; });
  const url = `http://127.0.0.1:${options.port}`;
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (failure || child.exitCode !== null) throw new Error(`Magpie failed to start: ${failure || output}`);
      try {
        const response = await fetch(url + "/", { signal: AbortSignal.timeout(200) });
        const health = await response.json() as Record<string, unknown>;
        if (response.ok && health.name === "magpie" && health.version === provenance.version) {
          const catalogResponse = await fetch(url + "/v1/models", { signal: AbortSignal.timeout(500) });
          const catalog = await catalogResponse.json() as { data: { id: string }[] };
          const expected = providers.map(p => `${p.id}/${p.models[0]}`).sort();
          if (!catalogResponse.ok || JSON.stringify(catalog.data.map(m => m.id).sort()) !== JSON.stringify(expected)) throw new Error("Magpie catalog does not contain exactly the explicit local providers");
          return { child, url, health, catalog, provenance, log: () => output, close: () => stopMagpie(child) };
        }
      } catch (error) { if (error instanceof Error && error.message.includes("catalog does not")) throw error; }
      await delay(50);
    }
    throw new Error(`Magpie startup/health probe exceeded 7.5 seconds: ${output}`);
  } catch (error) { await stopMagpie(child); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  if (["--binary", "--state", "--port", "--providers"].some(name => !values.get(name))) throw new Error("Usage: tsx scripts/magpie-gateway.ts --binary /build/magpie --state /private/state --port 3425 --providers /private/providers.json");
  const providers = JSON.parse(await readFile(resolve(values.get("--providers")!), "utf8"));
  const gateway = await startMagpie({ binary: values.get("--binary")!, stateDirectory: values.get("--state")!, port: Number(values.get("--port")), providers });
  console.log(JSON.stringify({ url: gateway.url, provenance: gateway.provenance, catalog: gateway.catalog }));
  const stop = async () => { await gateway.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await once(gateway.child, "exit");
}
