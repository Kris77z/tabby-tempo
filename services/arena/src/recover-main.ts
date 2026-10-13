import { loadArenaConfig } from "./protocol.js";
import { recoverStaleSettler } from "./recover.js";

if (!process.env.ARENA_CONFIG) throw new Error("ARENA_CONFIG is required");
const config = await loadArenaConfig(process.env.ARENA_CONFIG);
await recoverStaleSettler(config.ipcDirectory);
process.stdout.write(JSON.stringify({ recovered: true }) + "\n");
