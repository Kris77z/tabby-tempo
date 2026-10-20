import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { open, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = promisify(execFile);
const image = "python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111";
const digest = value => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
let reportFile, directory, child;
let report = { version: 1, suite: "local-economic-loop", status: "failed", error: "NOT_STARTED" };
const run = async (binary, argv, timeout = 10000) => (await command(binary, argv, { cwd: root, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const groupSignal = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* Owned process group already exited. */ } } };
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; groupSignal("SIGTERM"); });

try {
  if (args.length && (args.length !== 2 || args[0] !== "--report" || !isAbsolute(args[1]))) throw Error("USAGE_EXPECTS_OPTIONAL_ABSOLUTE_REPORT_PATH");
  if (args.length) reportFile = await open(args[1], "wx", 0o600); // Never replace earlier evidence.
  if (Number(process.versions.node.split(".")[0]) < 22) throw Error("NODE_22_REQUIRED");
  directory = await mkdtemp(join(tmpdir(), "agentfuel-economic-loop-"));
  const tools = {};
  const dockerEndpoint = process.env.DOCKER_HOST || await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!dockerEndpoint.startsWith("unix:///")) throw Error("LOCAL_UNIX_DOCKER_DAEMON_REQUIRED");
  tools.dockerTransport = "local-unix-socket";
  for (const [name, binary, argv] of [["forge", process.env.FORGE_BIN || "forge", ["--version"]], ["anvil", process.env.ANVIL_BIN || "anvil", ["--version"]], ["docker", "docker", ["info", "--format", "{{.ServerVersion}}"]]]) {
    try { tools[name] = (await run(binary, argv)).split("\n")[0]; } catch { throw Error(`${name.toUpperCase()}_UNAVAILABLE`); }
  }
  try { tools.image = await run("docker", ["image", "inspect", "--format", "{{.Id}}", image]); } catch { throw Error("PINNED_DOCKER_IMAGE_MISSING"); }
  const source = { revision: await run("git", ["rev-parse", "HEAD"]), dirty: Boolean(await run("git", ["status", "--porcelain"])),
    trackedDiffSha256: digest(await run("git", ["diff", "--binary", "HEAD"])),
    harnessSha256: digest(await readFile(new URL("./economic-loop-local.ts", import.meta.url))),
    launcherSha256: digest(await readFile(fileURLToPath(import.meta.url))) };
  process.stderr.write("economic-loop: building local contracts\n");
  try { await run(process.env.FORGE_BIN || "forge", ["build", "--root", "contracts", "--skip-lint"], 90000); } catch { throw Error("LOCAL_CONTRACT_BUILD_FAILED"); }
  if (interrupted) throw Error("LOCAL_SUITE_INTERRUPTED");

  // Record only container names created by this child. This lets timeout/signal
  // cleanup remove its own containers without touching concurrent test runs.
  const realDocker = await run("which", ["docker"]), containerLog = join(directory, "containers.jsonl");
  const proxy = `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst args=process.argv.slice(2);\nif(args[0]==='create'){const i=args.indexOf('--name');if(i>=0&&/^agentfuel-arena-[0-9a-f-]{36}$/.test(args[i+1]))appendFileSync(process.env.AF_ECONOMIC_CONTAINER_LOG,JSON.stringify(args[i+1])+'\\n',{mode:0o600});}\nconst child=spawn(process.env.AF_ECONOMIC_DOCKER_BIN,args,{stdio:'inherit'});\nchild.on('error',()=>process.exit(127));\nchild.on('exit',(code)=>process.exit(code??1));\n`;
  // .mjs avoids depending on the package type of a generated temporary directory.
  await writeFile(join(directory, "docker.mjs"), proxy, { mode: 0o700 });
  await writeFile(join(directory, "docker"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(directory, "docker.mjs").replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  const privateReport = join(directory, "report.json");
  const workerEnvironment = { ...process.env };
  for (const name of Object.keys(workerEnvironment)) if (/^(ARENA_|AGENTFUEL_|HOSTED_|MONAD_|RELAY_|UNDERWRITER_|MODEL_|RPC_|PRIVATE_KEY|OPERATOR_TOKEN)/.test(name)) delete workerEnvironment[name];
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) delete workerEnvironment[name];
  workerEnvironment.ARENA_DOCKER_IMAGE = image;
  child = spawn(process.execPath, ["--import", "tsx", join(root, "scripts/economic-loop-local.ts"), directory, privateReport], {
    cwd: root, detached: true, env: { ...workerEnvironment, PATH: `${directory}:${process.env.PATH}`, AF_ECONOMIC_CONTAINER_LOG: containerLog, AF_ECONOMIC_DOCKER_BIN: realDocker },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Worker prints only fixed stage labels; never forward arbitrary subprocess output.
  child.stderr.on("data", bytes => { for (const line of String(bytes).split("\n")) if (/^economic-loop: [a-z0-9 -]+$/.test(line)) process.stderr.write(line + "\n"); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; groupSignal("SIGTERM"); }, 360000);
  const hardTimeout = setTimeout(() => groupSignal("SIGKILL"), 380000);
  let code;
  try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); }); }
  finally { clearTimeout(timeout); clearTimeout(hardTimeout); }
  if (timedOut) throw Error("LOCAL_SUITE_TIMEOUT");
  if (interrupted) throw Error("LOCAL_SUITE_INTERRUPTED");
  try { report = JSON.parse(await readFile(privateReport, "utf8")); } catch { throw Error("LOCAL_WORKER_REPORT_MISSING"); }
  report.provenance = { ...report.provenance, node: process.version, tools, source, dockerImage: image };
  if (code !== 0 || report.status !== "passed") process.exitCode = 1;
} catch (error) {
  const code = error?.code === "EEXIST" ? "REPORT_ALREADY_EXISTS" : /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "LOCAL_SUITE_FAILED";
  report = { version: 1, suite: "local-economic-loop", status: "failed", error: code };
  process.exitCode = 1;
} finally {
  groupSignal("SIGKILL");
  const cleanupFailures = [];
  if (child?.pid) {
    let remains = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(-child.pid, 0); remains = true; } catch { remains = false; break; }
      await delay(50);
    }
    if (remains) cleanupFailures.push("OWNED_PROCESS_GROUP_REMAINS");
  }
  if (directory) {
    let names = [];
    try { names = (await readFile(join(directory, "containers.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { /* No containers created. */ }
    for (const name of new Set(names)) {
      if (!/^agentfuel-arena-[0-9a-f-]{36}$/.test(name)) continue;
      try { await run("docker", ["rm", "--force", name], 10000); }
      catch { try { await run("docker", ["inspect", name]); cleanupFailures.push("OWNED_CONTAINER_REMAINS"); } catch { /* Already removed. */ } }
    }
    // The shared workflow fixture uses a short Unix-socket directory under /tmp.
    // Read its path only from this worker's private arena configuration, including
    // when the worker died before it could return its fixture to a finally block.
    try {
      const config = JSON.parse(await readFile(join(directory, "runtime", "arena.json"), "utf8"));
      if (typeof config.ipcDirectory !== "string" || !/^\/tmp\/af-wf-ipc-[A-Za-z0-9]+$/.test(config.ipcDirectory)) cleanupFailures.push("OWNED_IPC_PATH_INVALID");
      else await rm(config.ipcDirectory, { recursive: true, force: true });
    } catch (error) { if (error?.code !== "ENOENT") cleanupFailures.push("OWNED_IPC_DIRECTORY_REMAINS"); }
    try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailures.push("PRIVATE_TEMP_DIRECTORY_REMAINS"); }
  }
  report.cleanup = { privateTempDirectoryRemoved: Boolean(directory) && !cleanupFailures.includes("PRIVATE_TEMP_DIRECTORY_REMAINS"), ownedContainersRemoved: !cleanupFailures.includes("OWNED_CONTAINER_REMAINS"),
    ownedProcessesStopped: !cleanupFailures.includes("OWNED_PROCESS_GROUP_REMAINS"), ownedIpcDirectoryRemoved: !cleanupFailures.some(code => code.startsWith("OWNED_IPC_")), failures: cleanupFailures };
  if (cleanupFailures.length) { report.status = "failed"; process.exitCode = 1; }
  const output = JSON.stringify(report, null, 2) + "\n";
  if (reportFile) { try { await reportFile.writeFile(output); } finally { await reportFile.close(); } }
  process.stdout.write(output);
}
