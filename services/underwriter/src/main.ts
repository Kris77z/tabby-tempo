import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { Rejection, Underwriter } from "./underwriter.js";

const config = loadConfig(process.env);
const underwriter = new Underwriter(config);
try {
  await underwriter.initialize();
  const server = createHttpServer(underwriter, process.env.FRONTEND_ORIGIN);
  server.once("error", () => { underwriter.close(); console.error("Underwriter could not listen on configured host/port"); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Underwriter listening on http://${config.host}:${config.port}`));
  const stop = () => { server.close(() => { underwriter.close(); }); server.closeIdleConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  underwriter.close();
  // Avoid logging RPC credentials or configuration secrets from provider errors.
  console.error(error instanceof Rejection ? `Underwriter startup rejected: ${error.code}` :
    "Underwriter startup failed; check RPC/configuration");
  process.exitCode = 1;
}
