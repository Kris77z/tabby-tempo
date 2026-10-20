import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function readHandle(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

// Persist before returning to onHandle: an uncertain send must retain its original identity.
export async function writePrivateJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}
