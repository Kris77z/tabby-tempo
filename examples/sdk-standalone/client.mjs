import { InferCredit, PaymentError } from "@agentfuel/sdk";
import { requestDigest } from "@agentfuel/sdk/protocol";
import { mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readHandle, writePrivateJson } from "./journal.mjs";

/** A journal belongs to one immutable request. Coordinate wallet nonces across clients separately. */
export async function fetchOrResume(arguments_) {
  const handlePath = resolve(arguments_.handlePath);
  await mkdir(dirname(handlePath), { recursive: true, mode: 0o700 });
  const lockPath = `${handlePath}.lock`;
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new PaymentError("JOURNAL_LOCKED", "Another client or an unresolved previous run owns this journal");
    throw error;
  }
  // Never guess whether an existing lock is stale: only the process that acquired it removes it.
  try { return await run({ ...arguments_, handlePath }); }
  finally { await rmdir(lockPath); }
}

async function run({ options, relayUrl, body, taskId, handlePath }) {
  const saved = await readHandle(handlePath);
  const input = { ...body, agentId: options.agentId, taskId: taskId ?? "0" };
  if (saved && (saved.relayUrl !== relayUrl || requestDigest(input) !== saved.quote.requestDigest)) {
    throw new PaymentError("CONFIG_HANDLE_MISMATCH", "Resume with the original request and deployment configuration");
  }
  const client = new InferCredit({ ...options, onHandle: handle => writePrivateJson(handlePath, handle) });
  try {
    if (saved) return await client.resume(saved);
    if (taskId !== undefined) return await client.forTask(taskId).fetch(relayUrl, { body });
    return await client.fetch(relayUrl, { body });
  } finally { client.close(); }
}
