import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { recoverStaleSettler } from "../services/arena/src/recover.js";
import { saveJson } from "./demo-common.js";

// The runner's recorded IPC path remains the authoritative journal location
// throughout restart. Recovery only removes dead socket ownership, never txs.
export async function prepareArenaIpc(directory: string, backupPath: string) {
  try { await access(join(directory, "settler.owner")); await recoverStaleSettler(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(directory, { mode: 0o700, recursive: true });
  try { await access(join(directory, "settlements.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let backup: unknown;
    try { backup = JSON.parse(await readFile(backupPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await saveJson(join(directory, "settlements.json"), backup);
  }
}
export async function backupAndRemoveArenaIpc(directory: string, backupPath: string, writer = saveJson) {
  let journal: unknown;
  try { journal = JSON.parse(await readFile(join(directory, "settlements.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rm(directory, { recursive: true, force: true }); return;
  }
  await writer(backupPath, journal); // A failure keeps the sole source intact.
  await rm(directory, { recursive: true, force: true });
}
