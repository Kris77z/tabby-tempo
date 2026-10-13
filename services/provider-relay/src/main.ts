import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { Relay } from "./relay.js";
import { Refunder } from "./refunder.js";

const config = loadConfig(process.env);
const relay = new Relay(config);
const refunder = new Refunder(relay);
try {
  await relay.initialize(); await refunder.initialize();
  await refunder.recover(); await relay.recover();
  const server = createHttpServer(relay, refunder);
  server.once("error", () => { relay.close(); console.error("Relay listen failed"); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Relay listening on http://${config.host}:${config.port}`));
  const stop = () => { server.close(() => relay.close()); server.closeIdleConnections(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
} catch { relay.close(); console.error("Relay startup failed; check public configuration and recovery state"); process.exitCode = 1; }
