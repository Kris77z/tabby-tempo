import { readFile } from "node:fs/promises";
import { ArenaController } from "./controller.js";
import { loadArenaConfig } from "./protocol.js";

if (process.env.ARENA_VERIFIER_PRIVATE_KEY) throw new Error("VERIFIER_KEY_MUST_ONLY_EXIST_IN_SETTLER_PROCESS");
const [taskId, path] = process.argv.slice(2);
if (!process.env.ARENA_CONFIG || !taskId || !path) throw new Error("Usage: ARENA_CONFIG=config.json npm run submit -- <taskId> <submission.py>");
const controller = new ArenaController(await loadArenaConfig(process.env.ARENA_CONFIG), { image: process.env.ARENA_DOCKER_IMAGE });
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
try {
  const result = await controller.submit({ taskId, code: await readFile(path, "utf8"), signal: abort.signal });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally { controller.close(); }
