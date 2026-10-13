import { ArenaController } from "./controller.js";
import { loadArenaConfig } from "./protocol.js";

if (process.env.ARENA_VERIFIER_PRIVATE_KEY) throw new Error("VERIFIER_KEY_MUST_ONLY_EXIST_IN_SETTLER_PROCESS");
const [taskId, verdict, ...reason] = process.argv.slice(2);
if (!process.env.ARENA_CONFIG || !taskId || !["pass", "fail"].includes(verdict ?? "")) throw new Error("Usage: ARENA_CONFIG=config.json npm run manual -- <taskId> <pass|fail> <human acceptance reason>");
const controller = new ArenaController(await loadArenaConfig(process.env.ARENA_CONFIG));
try { process.stdout.write(JSON.stringify(await controller.manual({ taskId, passed: verdict === "pass", reason: reason.join(" ") })) + "\n"); }
finally { controller.close(); }
