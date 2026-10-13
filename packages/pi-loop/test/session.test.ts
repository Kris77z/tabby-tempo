import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session.js";

test("atomic persistence cleans failed writes and preserves private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-pi-store-")); const store = new SessionStore<unknown>(directory);
  try {
    await store.start(); const circular: any = {}; circular.self = circular;
    await assert.rejects(store.write(circular)); await store.write({ reserved: "30000" });
    assert.deepEqual(await store.read(), { reserved: "30000" });
    assert.deepEqual((await readdir(directory)).sort(), [".writer", "session.json"]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(join(directory, "session.json"))).mode & 0o777, 0o600);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cross-process writer exclusion and explicit stale-lock recovery after a crash", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-pi-lock-")); const store = new SessionStore(directory);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {SessionStore} from ${JSON.stringify(new URL("../src/session.ts", import.meta.url).href)}; const s=new SessionStore(${JSON.stringify(directory)}); await s.start(); console.log('ready'); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.on("data", data => { if (String(data).includes("ready")) resolve(); }); child.once("error", reject); child.once("exit", () => reject(new Error("LOCK_CHILD_EXITED"))); });
    await assert.rejects(store.start(), /SESSION_BUSY/); await assert.rejects(store.start(true), /SESSION_BUSY/);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    await assert.rejects(store.start(), /SESSION_RECOVERY_REQUIRED/); await store.start(true); await store.write({ recovered: true });
    assert.deepEqual(await store.read(), { recovered: true });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
