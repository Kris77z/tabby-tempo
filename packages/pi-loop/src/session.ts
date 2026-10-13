import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("SESSION_LOCK_INVALID");
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw new Error("SESSION_BUSY"); }
}
async function exists(path: string) { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

/** Single local writer. Stale locks require an explicit recovery, never automatic takeover. */
export class SessionStore<T> {
  readonly directory: string;
  private readonly token = randomUUID();
  private held = false;
  constructor(directory: string) { this.directory = resolve(directory); }
  private get lock() { return join(this.directory, ".writer"); }
  private get recovery() { return join(this.directory, ".recover"); }
  private async acquire(recovering = false) {
    if (!recovering && await exists(this.recovery)) throw new Error("SESSION_RECOVERY_IN_PROGRESS");
    try { await mkdir(this.lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid: number };
      try { owner = JSON.parse(await readFile(join(this.lock, "owner.json"), "utf8")); } catch { throw new Error("SESSION_LOCK_INVALID"); }
      throw new Error(alive(owner.pid) ? "SESSION_BUSY" : "SESSION_RECOVERY_REQUIRED");
    }
    this.held = true;
    try { await this.atomic(join(this.lock, "owner.json"), { pid: process.pid, token: this.token }); }
    catch (error) { await rm(this.lock, { recursive: true, force: true }); this.held = false; throw error; }
    if (!recovering && await exists(this.recovery)) { await this.close(); throw new Error("SESSION_RECOVERY_IN_PROGRESS"); }
  }
  async start(recover = false) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    if (!recover) { await this.acquire(); return; }
    try { await mkdir(this.recovery, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("SESSION_RECOVERY_IN_PROGRESS"); throw error; }
    try {
      if (await exists(this.lock)) {
        let owner: { pid: number };
        try { owner = JSON.parse(await readFile(join(this.lock, "owner.json"), "utf8")); } catch { throw new Error("SESSION_LOCK_INVALID"); }
        if (alive(owner.pid)) throw new Error("SESSION_BUSY");
        await rm(this.lock, { recursive: true });
      }
      await this.acquire(true);
    } finally { await rm(this.recovery, { recursive: true, force: true }); }
  }
  private async atomic(path: string, value: unknown) {
    const temporary = `${path}.${this.token}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path); const directory = await open(resolve(path, ".."), "r"); try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await rm(temporary, { force: true }); }
  }
  async read(): Promise<T | undefined> {
    if (!this.held) throw new Error("SESSION_NOT_LOCKED");
    try { return JSON.parse(await readFile(join(this.directory, "session.json"), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async write(value: T) { if (!this.held) throw new Error("SESSION_NOT_LOCKED"); await this.atomic(join(this.directory, "session.json"), value); }
  async close() {
    if (!this.held) return;
    const owner = JSON.parse(await readFile(join(this.lock, "owner.json"), "utf8")) as { token: string };
    if (owner.token !== this.token) throw new Error("SESSION_LOCK_CHANGED");
    await rm(this.lock, { recursive: true }); this.held = false;
  }
}
