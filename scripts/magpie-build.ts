import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const magpieLock = JSON.parse(await readFile(new URL("./magpie.lock.json", import.meta.url), "utf8")) as {
  repository: string; tag: string; commit: string; sourceUrl: string; sourceSha256: string; goVersion: string;
  patchSha256: string; patchedVersion: string; patchedSourceSha256: Record<string, string>; officialDarwinArm64BinarySha256: string;
};
export const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function command(program: string, args: string[], cwd: string, input?: string) {
  const result = spawnSync(program, args, { cwd, input, encoding: "utf8", env: { ...process.env, CGO_ENABLED: "0" }, stdio: input === undefined ? "inherit" : "pipe" });
  if (result.error || result.status !== 0) throw new Error(`${program} failed (${result.status}): ${result.error?.message || result.stderr || "see command output"}`);
  return result.stdout;
}

export async function buildMagpie(outputDirectory: string) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(tmpdir(), "agentfuel-magpie-build-"));
  try {
    const archive = join(temporary, "source.tar.gz");
    const source = join(temporary, "source");
    await mkdir(source);
    // Downloads only the locked official source; neither a floating tag nor an install shell is run.
    if (process.env.MAGPIE_SOURCE_ARCHIVE) await copyFile(resolve(process.env.MAGPIE_SOURCE_ARCHIVE), archive);
    else command("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "180", magpieLock.sourceUrl, "--output", archive], temporary);
    if (sha256(await readFile(archive)) !== magpieLock.sourceSha256) throw new Error("Official source archive checksum differs from magpie.lock.json");
    command("tar", ["-xzf", archive, "-C", source, "--strip-components=1"], temporary);
    const patch = await readFile(new URL("./magpie-no-retry.patch", import.meta.url), "utf8");
    if (sha256(patch) !== magpieLock.patchSha256) throw new Error("Magpie patch checksum differs from lock");
    command("patch", ["-p1", "--dry-run"], source, patch);
    command("patch", ["-p1"], source, patch);
    for (const [path, expected] of Object.entries(magpieLock.patchedSourceSha256)) {
      if (sha256(await readFile(join(source, path))) !== expected) throw new Error(`Patched source checksum mismatch: ${path}`);
    }
    const go = process.env.MAGPIE_GO_BIN || "go";
    const version = spawnSync(go, ["version"], { cwd: source, encoding: "utf8" });
    if (version.status !== 0 || !version.stdout.includes(` ${magpieLock.goVersion} `)) throw new Error(`Build requires ${magpieLock.goVersion}: ${version.stderr || version.stdout}`);
    const binary = join(output, "magpie");
    command(go, ["build", "-tags", "nogui", "-trimpath", "-ldflags", `-s -w -X main.version=${magpieLock.patchedVersion}`, "-o", binary, "."], source);
    const manifest = { ...magpieLock, platform: process.platform, arch: process.arch, binarySha256: sha256(await readFile(binary)), goVersionOutput: version.stdout.trim() };
    await writeFile(join(output, "build.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await writeFile(join(output, "UPSTREAM-LICENSE"), await readFile(join(source, "LICENSE")), { mode: 0o600 });
    return { binary, manifest };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: tsx scripts/magpie-build.ts --output /absolute/build-directory");
  const built = await buildMagpie(args[1]);
  console.log(JSON.stringify({ binary: built.binary, version: built.manifest.patchedVersion, binarySha256: built.manifest.binarySha256 }));
}
