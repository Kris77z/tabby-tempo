import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? "/tmp", HOME: process.env.HOME,
  ...(process.env.npm_config_cache ? { npm_config_cache: process.env.npm_config_cache } : {}) };
const command = promisify(execFile), args = process.argv.slice(2), image = "python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111";
const run = async (binary, argv, timeout = 10000) => (await command(binary, argv, { cwd: root, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
let child, directory, ipc, reportFile, interrupted = false;
let report = { version: 1, suite: "local-publisher-worker", status: "failed", error: "NOT_STARTED" };
const signalGroup = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } } };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; signalGroup("SIGTERM"); });
try {
  let online = false, reportPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--online-install" && !online) online = true;
    else if (["--report", "--out-file"].includes(args[i]) && !reportPath && args[i + 1] && isAbsolute(args[i + 1])) reportPath = args[++i];
    else throw new Error("USAGE_EXPECTS_OPTIONAL_ONLINE_INSTALL_AND_ABSOLUTE_REPORT_PATH");
  }
  if (reportPath) reportFile = await open(reportPath, "wx", 0o600);
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("NODE_22_REQUIRED");
  const dockerEndpoint = await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!dockerEndpoint.startsWith("unix:///")) throw new Error("LOCAL_UNIX_DOCKER_DAEMON_REQUIRED");
  const tools = { forge: (await run("forge", ["--version"])).split("\n")[0], anvil: (await run("anvil", ["--version"])).split("\n")[0],
    docker: await run("docker", ["info", "--format", "{{.ServerVersion}}"]), imageId: await run("docker", ["image", "inspect", "--format", "{{.Id}}", image]), dockerTransport: "local-unix-socket" };
  directory = await mkdtemp("/tmp/af-publisher-worker-"); ipc = await mkdtemp("/tmp/af-pw-ipc-");
  const realDocker = await run("which", ["docker"]), containerLog = join(directory, "containers.jsonl"), privateReport = join(directory, "report.json");
  const proxy = `import { appendFileSync } from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst args=process.argv.slice(2);\nif(args[0]==='create'){const i=args.indexOf('--name');if(i>=0&&/^agentfuel-arena-[0-9a-f-]{36}$/.test(args[i+1]))appendFileSync(process.env.AF_PW_CONTAINER_LOG,JSON.stringify(args[i+1])+'\\n',{mode:0o600});}\nconst child=spawn(process.env.AF_PW_DOCKER_BIN,args,{stdio:'inherit'});\nchild.on('error',()=>process.exit(127));\nchild.on('exit',code=>process.exit(code??1));\n`;
  await writeFile(join(directory, "docker.mjs"), proxy, { mode: 0o700 });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(directory, "docker"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(directory, "docker.mjs"))} "$@"\n`, { mode: 0o700 });
  if (interrupted) throw new Error("LOCAL_SUITE_INTERRUPTED");
  child = spawn(process.execPath, ["--import", "tsx", join(root, "scripts/publisher-worker-local.ts"), ...(online ? ["--online-install"] : [])], { cwd: root, detached: true,
    env: { ...env, PATH: `${directory}:${env.PATH}`, AF_PW_DIRECTORY: directory, AF_PW_IPC: ipc, AF_PW_PRIVATE_REPORT: privateReport,
      AF_PW_DOCKER_BIN: realDocker, AF_PW_CONTAINER_LOG: containerLog }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", bytes => { for (const line of String(bytes).split("\n")) if (/^publisher-worker: [a-z0-9 -]+$/.test(line)) process.stderr.write(line + "\n"); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; signalGroup("SIGTERM"); }, 300000), hardTimeout = setTimeout(() => signalGroup("SIGKILL"), 320000);
  let code;
  try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); }); }
  finally { clearTimeout(timeout); clearTimeout(hardTimeout); }
  if (interrupted) throw new Error("LOCAL_SUITE_INTERRUPTED");
  if (timedOut) throw new Error("LOCAL_SUITE_TIMEOUT");
  try { report = JSON.parse(await readFile(privateReport, "utf8")); } catch { throw new Error("LOCAL_WORKER_REPORT_MISSING"); }
  report.provenance = { ...report.provenance, node: process.version, tools, launcherSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex") };
  if (code !== 0 || report.status !== "passed") process.exitCode = 1;
} catch (error) {
  report = { version: 1, suite: "local-publisher-worker", status: "failed", error: error?.code === "EEXIST" ? "REPORT_ALREADY_EXISTS" : /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : "LOCAL_SUITE_FAILED" };
  process.exitCode = 1;
} finally {
  signalGroup("SIGKILL");
  const failures = [];
  if (child?.pid) {
    let remains = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(-child.pid, 0); remains = true; } catch { remains = false; break; }
      await delay(50);
    }
    if (remains) failures.push("OWNED_PROCESS_GROUP_REMAINS");
  }
  if (directory) {
    let names = [];
    try { names = (await readFile(join(directory, "containers.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { /* No owned container recorded. */ }
    for (const name of new Set(names)) {
      if (!/^agentfuel-arena-[0-9a-f-]{36}$/.test(name)) continue;
      try { await run("docker", ["rm", "--force", name]); }
      catch { try { await run("docker", ["inspect", name]); failures.push("OWNED_CONTAINER_REMAINS"); } catch { /* Already removed. */ } }
    }
    try { await rm(directory, { recursive: true, force: true }); } catch { failures.push("PRIVATE_TEMP_DIRECTORY_REMAINS"); }
  }
  if (ipc) try { await rm(ipc, { recursive: true, force: true }); } catch { failures.push("OWNED_IPC_DIRECTORY_REMAINS"); }
  report.cleanup = { ownedProcessesStopped: !failures.includes("OWNED_PROCESS_GROUP_REMAINS"), ownedContainersRemoved: !failures.includes("OWNED_CONTAINER_REMAINS"),
    privateTempDirectoryRemoved: Boolean(directory) && !failures.includes("PRIVATE_TEMP_DIRECTORY_REMAINS"), ownedIpcDirectoryRemoved: Boolean(ipc) && !failures.includes("OWNED_IPC_DIRECTORY_REMAINS"), failures };
  if (failures.length) { report.status = "failed"; process.exitCode = 1; }
  const bytes = JSON.stringify(report, null, 2) + "\n";
  if (reportFile) { try { await reportFile.writeFile(bytes); } finally { await reportFile.close(); } }
  process.stdout.write(bytes);
}
