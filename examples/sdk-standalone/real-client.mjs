import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import { PaymentError, uint } from "@agentfuel/sdk";
import { fetchOrResume } from "./client.mjs";
import { writePrivateJson } from "./journal.mjs";

async function run() {
  const [execute, configPath, journalPath, ...extra] = process.argv.slice(2);
  if (execute !== "--execute" || !configPath || !journalPath || extra.length) {
    console.error("Usage: node real-client.mjs --execute TRUSTED_CONFIG.json PRIVATE_JOURNAL.json");
    process.exitCode = 1; return;
  }
  if (!process.env.AGENTFUEL_SESSION_KEY) throw new PaymentError("SESSION_KEY_REQUIRED", "Provide your own current agent wallet key");
  // This file is a caller-trusted deployment configuration, never a relay-supplied quote or model output.
  const config = JSON.parse(await readFile(configPath, "utf8"));
  for (const name of ["rpcUrl", "relayUrl", ...(config.underwriterUrl ? ["underwriterUrl"] : [])]) {
    if (!["http:", "https:"].includes(new URL(config[name]).protocol)) throw new Error("Invalid URL protocol");
  }
  for (const name of ["account", "asset", "provider"]) getAddress(config[name]);
  for (const name of ["agentId", "chainId", "maxPrice"]) uint(config[name], name);
  if (config.taskId !== undefined) uint(config.taskId, "taskId");
  if (!config.request || typeof config.request.service !== "string" || typeof config.request.model !== "string" ||
    !Array.isArray(config.request.messages)) throw new Error("Invalid request");
  const handlePath = resolve(journalPath);
  const paid = await fetchOrResume({ options: { agentId: config.agentId, rpcUrl: config.rpcUrl,
    sessionKey: process.env.AGENTFUEL_SESSION_KEY, chainId: BigInt(config.chainId), account: config.account,
    asset: config.asset, provider: config.provider, maxPrice: BigInt(config.maxPrice), underwriterUrl: config.underwriterUrl },
    relayUrl: config.relayUrl, body: config.request, taskId: config.taskId, handlePath });
  await writePrivateJson(`${handlePath}.delivery.json`, { result: paid.result, receipt: paid.receipt });
  console.log(JSON.stringify({ state: "Delivered", paymentId: paid.handle.quote.paymentId }));
}

try { await run(); }
catch (error) {
  // Error objects can contain RPC URLs or transaction bytes; print only a bounded diagnostic code.
  const code = error instanceof PaymentError && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : "CLIENT_FAILED";
  console.error(code); process.exitCode = 1;
}
