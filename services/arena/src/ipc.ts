import { connect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { settlementTimeout, type Settlement, type SettlementIntent, type Verdict } from "./protocol.js";

export async function readControllerToken(directory: string): Promise<string> {
  const path = join(directory, "controller.token");
  const [parent, file] = await Promise.all([stat(directory), stat(path)]);
  if ((parent.mode & 0o077) !== 0 || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) throw new Error("INSECURE_IPC_PERMISSIONS");
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("INVALID_IPC_TOKEN");
  return token;
}
export async function requestSettlement(directory: string, token: string, verdict: Verdict, timeoutMs?: number): Promise<Settlement> {
  return exchange(directory, { token, verdict }, timeoutMs, result => {
    if (result.error || !result.settlement) throw new Error(result.error ?? "INVALID_IPC_RESPONSE");
    return result.settlement;
  });
}
/** Authenticated read of the original verdict; never exposes signed bytes. */
export async function readSettlementIntent(directory: string, token: string, taskId: string, timeoutMs?: number): Promise<SettlementIntent | null> {
  return exchange(directory, { token, action: "inspect", taskId }, timeoutMs, result => {
    if (result.error || !Object.hasOwn(result, "intent")) throw new Error(result.error ?? "INVALID_IPC_RESPONSE");
    return result.intent;
  });
}
async function exchange<T>(directory: string, request: unknown, timeoutMs: number | undefined, decode: (value: any) => T): Promise<T> {
  const timeout = settlementTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const socket = connect(join(directory, "settler.sock"));
    let response = "";
    socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error("SETTLER_TIMEOUT: retry the same runId")); });
    socket.on("error", reject);
    socket.on("connect", () => socket.end(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => {
      response += chunk.toString();
      if (Buffer.byteLength(response) > 32768) { socket.destroy(); reject(new Error("IPC_RESPONSE_TOO_LARGE")); }
    });
    socket.on("end", () => {
      try {
        resolve(decode(JSON.parse(response)));
      } catch (error) { reject(error); }
    });
  });
}
