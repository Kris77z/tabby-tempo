import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

export async function recoverStaleSettler(directory: string): Promise<void> {
  const info = await stat(directory);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("INSECURE_IPC_PERMISSIONS");
  const recovery = join(directory, "recover.lock");
  await writeFile(recovery, String(process.pid), { mode: 0o600, flag: "wx" });
  try {
    const owner = join(directory, "settler.owner");
    const pid = Number((await readFile(owner, "utf8")).trim());
    if (!Number.isInteger(pid) || pid < 1) throw new Error("INVALID_SETTLER_OWNER");
    try { process.kill(pid, 0); throw new Error("SETTLER_IS_RUNNING"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await new Promise<void>((resolve, reject) => {
      const socket = connect(join(directory, "settler.sock"));
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("CANNOT_VERIFY_STALE_SOCKET")); });
      socket.once("connect", () => { socket.destroy(); reject(new Error("SETTLER_IS_RUNNING")); });
      socket.once("error", error => {
        if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) resolve(); else reject(error);
      });
    });
    // Owner remains present until socket/token removal has finished. New signer
    // startup also respects recover.lock, avoiding an unlink of a live socket.
    await rm(join(directory, "settler.sock"), { force: true });
    await rm(join(directory, "controller.token"), { force: true });
    await rm(owner);
  } finally { await rm(recovery, { force: true }); }
}
