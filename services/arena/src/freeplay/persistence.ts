import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class PlayStorageError extends Error {
  constructor(public readonly code: "ARENA_STORAGE_BUSY" | "ARENA_STORAGE_UNAVAILABLE") { super(code); }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One atomic snapshot on a local filesystem. No network/shared-filesystem lock contract. */
export class PrivatePlayStateFile {
  readonly path: string;
  #signature: string | undefined;
  constructor(path: string) { this.path = resolve(path); }
  invalidate() { this.#signature = undefined; }
  #stat() {
    try {
      const stat = lstatSync(this.path, { bigint: true });
      if (!stat.isFile()) throw new Error("STATE_NOT_REGULAR_FILE");
      return { stat, signature: `${stat.ino}:${stat.mtimeNs}:${stat.size}` };
    } catch (error) {
      if (missing(error)) return { signature: "missing" };
      throw new PlayStorageError("ARENA_STORAGE_UNAVAILABLE");
    }
  }
  readIfChanged(force = false): { state: unknown | undefined } | undefined {
    try {
      const { stat, signature } = this.#stat();
      if (!force && signature === this.#signature) return undefined;
      if (!stat) { this.#signature = signature; return { state: undefined }; }
      if ((stat.mode & 0o077n) !== 0n) chmodSync(this.path, 0o600);
      const state: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      this.#signature = signature;
      return { state };
    } catch { throw new PlayStorageError("ARENA_STORAGE_UNAVAILABLE"); }
  }
  #reclaim(lock: string, depth = 0): boolean {
    const claim = join(lock, "reclaim");
    let removed = false;
    let agedOut: boolean;
    try { agedOut = Date.now() - Number(lstatSync(lock).mtimeMs) > 30_000; }
    catch { return false; }
    try { mkdirSync(claim, { mode: 0o700 }); }
    catch (error) {
      // A process may also die while recovering another abandoned writer.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || depth >= 8 || !this.#reclaim(claim, depth + 1)) return false;
      try { mkdirSync(claim, { mode: 0o700 }); } catch { return false; }
    }
    try {
      writeFileSync(join(claim, "owner"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      let abandoned = false;
      try {
        const owner = JSON.parse(readFileSync(join(lock, "owner"), "utf8")) as { pid?: number };
        abandoned = Number.isSafeInteger(owner.pid) && owner.pid! > 0 ? !alive(owner.pid!) : agedOut;
      } catch {
        // Allow the very short mkdir→owner-write interval; recover an interrupted setup later.
        abandoned = agedOut;
      }
      if (!abandoned) return false;
      rmSync(lock, { recursive: true });
      removed = true;
      return true;
    } finally { if (!removed) rmSync(claim, { recursive: true, force: true }); }
  }
  withLock<T>(action: () => T): T {
    const directory = dirname(this.path), lock = `${this.path}.lock`;
    let owned = false;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { mkdirSync(lock, { mode: 0o700 }); owned = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!this.#reclaim(lock)) throw new PlayStorageError("ARENA_STORAGE_BUSY");
        try { mkdirSync(lock, { mode: 0o700 }); owned = true; }
        catch (retry) {
          if ((retry as NodeJS.ErrnoException).code === "EEXIST") throw new PlayStorageError("ARENA_STORAGE_BUSY");
          throw retry;
        }
      }
      writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      // The lock proves no writer is using an interrupted temporary snapshot.
      const prefix = `${basename(this.path)}.tmp-`;
      for (const entry of readdirSync(directory)) if (entry.startsWith(prefix)) rmSync(join(directory, entry), { force: true });
      return action();
    } catch (error) {
      if (error instanceof PlayStorageError) throw error;
      // Preserve command/validation errors thrown by the caller.
      if (owned && error instanceof Error && "status" in error) throw error;
      throw new PlayStorageError("ARENA_STORAGE_UNAVAILABLE");
    } finally { if (owned) rmSync(lock, { recursive: true, force: true }); }
  }
  save(state: unknown): void {
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
      const directoryFd = openSync(dirname(this.path), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      this.#signature = this.#stat().signature;
    } catch { throw new PlayStorageError("ARENA_STORAGE_UNAVAILABLE"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}
