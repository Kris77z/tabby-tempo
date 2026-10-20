import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out-dir") {
  throw new Error("Usage: npm run pack:standalone --workspace @agentfuel/sdk -- --out-dir DIRECTORY");
}
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(args[1]);
const stage = await mkdtemp(join(tmpdir(), "agentfuel-sdk-pack-"));
const require = createRequire(import.meta.url);
try {
  const source = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(sdkRoot, "tsconfig.build.json"),
    "--outDir", join(stage, "dist")], { cwd: sdkRoot, stdio: "inherit" });
  // Only the distribution gets JS exports; existing workspace TS consumers keep their original exports.
  const manifest = {
    name: source.name, version: "0.0.0", private: true, type: "module", license: "MIT",
    description: "Tabby provider-payment SDK; local standalone distribution",
    engines: { node: ">=22" },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
      "./protocol": { types: "./dist/protocol.d.ts", import: "./dist/protocol.js", default: "./dist/protocol.js" },
    },
    files: ["dist", "README.md", "LICENSE"], dependencies: source.dependencies,
  };
  await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await copyFile(join(sdkRoot, "DISTRIBUTION.md"), join(stage, "README.md"));
  await copyFile(join(sdkRoot, "../../LICENSE"), join(stage, "LICENSE"));
  await mkdir(outDir, { recursive: true });
  const packed = JSON.parse(execFileSync(process.env.npm_execpath ? process.execPath : "npm",
    [...(process.env.npm_execpath ? [process.env.npm_execpath] : []), "pack", "--ignore-scripts", "--json", "--pack-destination", outDir],
    { cwd: stage, encoding: "utf8" }));
  console.log(join(outDir, packed[0].filename));
} finally {
  await rm(stage, { recursive: true, force: true });
}
