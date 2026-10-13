import { loadArenaConfig } from "./protocol.js";
import { ArenaSettler } from "./settler.js";

const path = process.env.ARENA_CONFIG;
const key = process.env.ARENA_VERIFIER_PRIVATE_KEY;
if (!path || !key) throw new Error("ARENA_CONFIG and ARENA_VERIFIER_PRIVATE_KEY are required in the settler process");
let settler: ArenaSettler | undefined;
try {
  settler = new ArenaSettler(await loadArenaConfig(path), key);
  await settler.start();
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await settler!.close(); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
} catch (error) {
  await settler?.close();
  const message = (error as Error).message;
  process.stderr.write((/^[A-Z_]+$/.test(message) ? message : "SETTLER_START_FAILED") + "\n");
  process.exitCode = 1;
}
