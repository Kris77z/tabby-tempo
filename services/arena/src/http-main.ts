import { createArenaHttpServer } from "./http.js";
import { loadArenaConfig } from "./protocol.js";

if (process.env.ARENA_VERIFIER_PRIVATE_KEY) throw new Error("VERIFIER_KEY_MUST_ONLY_EXIST_IN_SETTLER_PROCESS");
if (!process.env.ARENA_CONFIG) throw new Error("ARENA_CONFIG is required");
const port = Number(process.env.ARENA_PORT ?? "8789");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_ARENA_PORT");
const service = createArenaHttpServer(await loadArenaConfig(process.env.ARENA_CONFIG), process.env.ARENA_UI_ORIGIN ? [process.env.ARENA_UI_ORIGIN] : undefined);
service.server.listen(port, "127.0.0.1", () => process.stdout.write(JSON.stringify({ ready: true, host: "127.0.0.1", port }) + "\n"));
let closing = false;
const close = async () => { if (closing) return; closing = true; await service.close(); };
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
