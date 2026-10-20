import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Use Node.js 22 or newer");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--online-install")) throw new Error("Only --online-install is supported");
const onlineInstall = args.includes("--online-install");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "agentfuel-sdk-consumer-"));
const consumer = join(directory, "consumer");
const npmCommand = process.env.npm_execpath ? process.execPath : "npm";
const npmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", npm_config_workspaces: "false" };
function npm(args_, cwd) { execFileSync(npmCommand, [...npmPrefix, ...args_], { cwd, env, stdio: "inherit" }); }
try {
  execFileSync(process.execPath, [join(root, "packages/sdk/scripts/pack.mjs"), "--out-dir", directory], { cwd: root, env, stdio: "inherit" });
  await cp(join(root, "examples/sdk-standalone"), consumer, { recursive: true,
    filter: source => !["node_modules", ".state"].includes(source.split(/[\\/]/).at(-1)) });
  // Preserve the consumer lock: cached package archives from npm ci suffice without registry metadata.
  try {
    npm(["install", ...(onlineInstall ? [] : ["--offline"]), "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact",
      join(directory, "agentfuel-sdk-0.0.0.tgz")], consumer);
  } catch {
    throw new Error(onlineInstall ? "Standalone dependency installation failed" :
      "Offline package archives are missing. Run the root npm ci, or explicitly prepare this example with: node scripts/check-sdk-standalone.mjs --online-install. No network fallback was attempted.");
  }
  const installed = await realpath(join(consumer, "node_modules/@agentfuel/sdk"));
  if (relative(await realpath(consumer), installed).startsWith("..")) throw new Error("SDK escaped the independent consumer directory");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (manifest.exports["."].import !== "./dist/index.js" || manifest.exports["./protocol"].types !== "./dist/protocol.d.ts") {
    throw new Error("Distribution exports must resolve compiled JS and declarations");
  }
  npm(["run", "typecheck"], consumer);
  npm(["test"], consumer);
  npm(["start"], consumer);
  console.log("Standalone SDK accepted outside the repository; temporary consumer removed on exit.");
} finally { await rm(directory, { recursive: true, force: true }); }
