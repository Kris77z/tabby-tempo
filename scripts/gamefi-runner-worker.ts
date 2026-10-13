import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { parseGameFiStageDiagnostic } from "../services/arena/src/gamefi-runner/diagnostic.js";

/** Private IPC worker. Waiting for the journaled PID closes the parent-crash spawn window. */
if (!process.send) throw new Error("GAMEFI_WORKER_IPC_REQUIRED");
let started = false, child: ChildProcess | undefined;
process.on("disconnect", () => { if (!started) process.exit(1); });
process.once("message", (input: unknown) => {
  const value = input as { version?: unknown; script?: unknown; args?: unknown };
  if (!value || value.version !== 1 || !["holdem-live.ts", "holdem-monad.ts", "holdem-monad-purchase.ts"].includes(String(value.script))
    || !Array.isArray(value.args) || value.args.length > 14 || value.args.some(arg => typeof arg !== "string")
    || value.args[0] !== "--import" || value.args[1] !== join(process.cwd(), "node_modules/tsx/dist/loader.mjs")
    || value.args[2] !== join(process.cwd(), "scripts", String(value.script))) process.exit(1);
  started = true;
  child = spawn(process.execPath, value.args as string[], { cwd: process.cwd(), shell: false, stdio: ["ignore", "ignore", "pipe"], env: process.env });
  let stderr = "";
  child.stderr!.on("data", chunk => { if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length); });
  child.once("error", () => { process.exitCode = 1; if (process.connected) process.disconnect(); });
  child.once("close", (status, signal) => {
    process.exitCode = signal ? 1 : status ?? 1;
    const diagnostic = parseGameFiStageDiagnostic(stderr);
    if (process.connected && diagnostic) process.send!({ version: 1, type: "diagnostic", ...diagnostic }, () => { if (process.connected) process.disconnect(); });
    else if (process.connected) process.disconnect();
  });
});
process.on("SIGTERM", () => {
  if (!started || !child) process.exit(1);
  child.kill("SIGTERM");
});
