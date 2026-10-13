import { connect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { settlementTimeout, type Settlement, type Verdict } from "./protocol.js";

export async function readControllerToken(directory: string): Promise<string> {
  const path = join(directory, "controller.token");
  const [parent, file] = await Promise.all([stat(directory), stat(path)]);
  if ((parent.mode & 0o077) !== 0 || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) throw new Error("INSECURE_IPC_PERMISSIONS");
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("INVALID_IPC_TOKEN");
  return token;
}
export async function requestSettlement(directory: string, token: string, verdict: Verdict, timeoutMs?: number): Promise<Settlement> {
  const timeout = settlementTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const socket = connect(join(directory, "settler.sock"));
    let response = "";
    socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error("SETTLER_TIMEOUT: retry the same runId")); });
    socket.on("error", reject);
    socket.on("connect", () => socket.end(JSON.stringify({ token, verdict }) + "\n"));
    socket.on("data", chunk => {
      response += chunk.toString();
      if (Buffer.byteLength(response) > 32768) { socket.destroy(); reject(new Error("IPC_RESPONSE_TOO_LARGE")); }
    });
    socket.on("end", () => {
      try {
        const result = JSON.parse(response) as { settlement?: Settlement; error?: string };
        if (result.error || !result.settlement) reject(new Error(result.error ?? "INVALID_IPC_RESPONSE"));
        else resolve(result.settlement);
      } catch (error) { reject(error); }
    });
  });
}
