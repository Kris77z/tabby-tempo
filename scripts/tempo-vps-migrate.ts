import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { taskPrivateFile } from "../packages/pi-loop/src/task-runner/config.js";
import { validateGatewayCatalog } from "../services/hosted-agents/src/inference-gateway.js";
import { loadTestSponsorship } from "../services/hosted-agents/src/test-sponsorship.js";
import { tempoPublicOrigin, tempoRuntimeBinding } from "./tempo-hosted-runtime.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => digest(JSON.stringify(value));
const fail = (code: string): never => { throw new Error(code); };
interface Change { path: string; before: string; after: string; beforeHash: string; afterHash: string }
interface Migration {
  version: 1; id: string; status: "Prepared" | "Applied"; preparedAt: string; appliedAt?: string;
  directory: string; bootstrapFile: string; origin: string; previousOrigin: string; ports: number[];
  previousBinding: string; publicBinding: string; retiredSponsorship?: { file: string; digest: string; expiresAtMs: number; admissions: number };
  changes: Change[];
}
function absolute(path: string) { if (!isAbsolute(path) || resolve(path) !== path) fail("TEMPO_MIGRATION_ABSOLUTE_PATH_REQUIRED"); return path; }
const auditFile = (directory: string) => join(directory, "vps-origin-migration", "session.json");
async function optionalMigration(directory: string): Promise<Migration | undefined> {
  try { return JSON.parse(await taskPrivateFile(auditFile(directory))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function boundRequest(record: Migration, directory: string, bootstrapFile: string, origin: string) {
  if (record.version !== 1 || record.directory !== directory || record.bootstrapFile !== bootstrapFile || record.origin !== origin
    || !["Prepared", "Applied"].includes(record.status) || record.changes.length !== 4) fail("TEMPO_ORIGINAL_ORIGIN_MIGRATION_REQUIRED");
  const expected = new Set([bootstrapFile, join(directory, "hosted.json"), join(directory, "hosted", "database", "session.json"), join(directory, "runtime-journal", "session.json")]);
  for (const change of record.changes) {
    if (!expected.delete(change.path) || digest(change.before) !== change.beforeHash || digest(change.after) !== change.afterHash) fail("TEMPO_ORIGIN_MIGRATION_AUDIT_INVALID");
  }
  if (expected.size) fail("TEMPO_ORIGIN_MIGRATION_AUDIT_INVALID");
}
async function inactive(ports: number[]) {
  for (const port of ports) {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("TEMPO_MIGRATION_PORT_INVALID");
    const listening = await new Promise<boolean>(done => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (result: boolean) => { socket.destroy(); done(result); };
      socket.setTimeout(250, () => finish(false)); socket.once("error", () => finish(false)); socket.once("connect", () => finish(true));
    });
    if (listening) fail("TEMPO_ORIGIN_MIGRATION_STOP_REQUIRED");
  }
}
function safeView(record: Migration) {
  return { version: 1, migrationId: record.id, status: record.status, previousOrigin: record.previousOrigin, origin: record.origin,
    auditFile: auditFile(record.directory), changedFiles: record.changes.map(change => ({ path: change.path, beforeHash: change.beforeHash, afterHash: change.afterHash })),
    clearedAuthentication: true, historicalRunsChanged: false, retiredSponsorship: !!record.retiredSponsorship,
    chainWrites: 0, modelRequests: 0, next: "set TEMPO_PUBLIC_ORIGIN to the exact origin and start the same runtime with --recover" };
}

/** Patch only three authentication values, preserving every byte of historical agents/runs and other fields. */
export function migratedHostedAuthentication(raw: string, configBinding: string) {
  const replacements = new Map<string, string>([["configBinding", JSON.stringify(configBinding)], ["challenges", "[]"], ["sessions", "[]"]]);
  const patches: { start: number; end: number; value: string }[] = [];
  let position = raw.indexOf("{") + 1;
  const whitespace = () => { while (/\s/.test(raw[position] ?? "") && position < raw.length) position++; };
  const stringEnd = (start: number) => { let end = start + 1; for (; end < raw.length; end++) { if (raw[end] === "\\") end++; else if (raw[end] === '"') return end + 1; } return fail("TEMPO_MIGRATION_JSON_INVALID"); };
  while (position < raw.length) {
    whitespace(); if (raw[position] === "}") break;
    if (raw[position] === ",") { position++; continue; }
    if (raw[position] !== '"') fail("TEMPO_MIGRATION_JSON_INVALID");
    const keyStart = position; position = stringEnd(position); const key = JSON.parse(raw.slice(keyStart, position));
    whitespace(); if (raw[position++] !== ":") fail("TEMPO_MIGRATION_JSON_INVALID"); whitespace();
    const start = position; let depth = 0;
    for (; position < raw.length; position++) {
      if (raw[position] === '"') { position = stringEnd(position) - 1; continue; }
      if (raw[position] === "[" || raw[position] === "{") depth++;
      else if (raw[position] === "]" || raw[position] === "}") { if (depth === 0) break; depth--; }
      else if (raw[position] === "," && depth === 0) break;
    }
    let end = position; while (end > start && /\s/.test(raw[end - 1])) end--;
    if (replacements.has(key)) { patches.push({ start, end, value: replacements.get(key)! }); replacements.delete(key); }
  }
  if (replacements.size) fail("TEMPO_MIGRATION_AUTHENTICATION_FIELDS_REQUIRED");
  for (const patch of patches.reverse()) raw = raw.slice(0, patch.start) + patch.value + raw.slice(patch.end);
  return raw;
}
async function atomicRaw(path: string, raw: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

/** Read-only planning. No RPC, private keys, paid model calls, local lock recovery or source state writes. */
export async function planTempoVpsMigration(directory: string, bootstrapFile: string, origin: string): Promise<Migration> {
  directory = absolute(directory); bootstrapFile = absolute(bootstrapFile); origin = tempoPublicOrigin(origin);
  const previous = await optionalMigration(directory);
  if (previous) { boundRequest(previous, directory, bootstrapFile, origin); return previous; }
  const paths = [bootstrapFile, join(directory, "hosted.json"), join(directory, "hosted", "database", "session.json"), join(directory, "runtime-journal", "session.json")];
  const raw = await Promise.all(paths.map(path => taskPrivateFile(path)));
  const [bootstrap, hosted, database, runtime] = raw.map(value => JSON.parse(value));
  if (bootstrap.chainId !== "42431" || !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(bootstrap.frontendOrigin)
    || hosted.hosted?.chainId !== "42431" || hosted.hosted.origin !== bootstrap.frontendOrigin || hosted.hosted.directory !== join(directory, "hosted")
    || database.version !== 1 || database.configBinding !== hash({ origin: bootstrap.frontendOrigin, chainId: "42431" })
    || !Array.isArray(database.runs) || database.runs.some((run: any) => !["Succeeded", "Failed"].includes(run.status))
    || runtime.version !== 1 || runtime.publicOriginMigration || runtime.migrations?.some((migration: any) => migration.status !== "Applied")) fail("TEMPO_ORIGIN_MIGRATION_STATE_INVALID");
  const gateway = JSON.parse(await taskPrivateFile(bootstrap.gatewayReadyFile));
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/v1$/.test(gateway.url) || gateway.endpoint !== `${gateway.url}/chat/completions` || gateway.models?.length !== 2) fail("TEMPO_MIGRATION_GATEWAY_INVALID");
  const catalog = validateGatewayCatalog(gateway.models.map((model: any, index: number) => ({ ...model, route: gateway.endpoint,
    inputMicroCreditsPerToken: index ? "3" : "1", outputMicroCreditsPerToken: index ? "6" : "2", maxCompletionTokens: 1024 })));
  const previousBinding = tempoRuntimeBinding(bootstrap, gateway, catalog);
  if ((runtime.effectiveBinding ?? runtime.binding) !== previousBinding
    || runtime.originalBootstrap && tempoRuntimeBinding(runtime.originalBootstrap, gateway, catalog) !== runtime.binding) fail("TEMPO_ORIGIN_MIGRATION_BINDING_CHANGED");
  const id = hash({ directory, bootstrapFile, origin, previousBinding });
  const preparedAt = new Date().toISOString(), afterBootstrap = { ...bootstrap, frontendOrigin: origin };
  const publicBinding = tempoRuntimeBinding(afterBootstrap, gateway, catalog);
  const afterRuntime = { ...runtime, effectiveBinding: publicBinding, publicOriginMigration: {
    version: 1, id, fromOrigin: bootstrap.frontendOrigin, toOrigin: origin, previousBinding, publicBinding, auditFile: auditFile(directory) } };
  let retiredSponsorship: Migration["retiredSponsorship"];
  if (hosted.hosted.testSponsorshipFile || runtime.testSponsorship) {
    const file = hosted.hosted.testSponsorshipFile ?? runtime.testSponsorship.file;
    if (runtime.testSponsorship && runtime.testSponsorship.file !== file) fail("TEMPO_ORIGIN_SPONSORSHIP_CHANGED");
    const loaded = await loadTestSponsorship(file, { chainId: "42431", origin: bootstrap.frontendOrigin });
    if (loaded.grant.expiresAtMs > Date.now() || database.testSponsorship?.digest !== loaded.digest
      || JSON.stringify(database.testSponsorship.grant) !== JSON.stringify(loaded.grant)
      || runtime.testSponsorship && runtime.testSponsorship.digest !== loaded.digest) fail("TEMPO_EXPIRED_ORIGIN_SPONSORSHIP_REQUIRED");
    retiredSponsorship = { file, digest: loaded.digest, expiresAtMs: loaded.grant.expiresAtMs, admissions: database.testSponsorship.admissions.length };
    delete afterRuntime.testSponsorship;
  }
  const afterHosted = structuredClone(hosted); afterHosted.hosted.origin = origin; delete afterHosted.hosted.testSponsorshipFile;
  // Authentication changes alone: historical agents/runs/limits/grants and admission bytes remain semantically identical.
  const afterDatabase = migratedHostedAuthentication(raw[2], hash({ origin, chainId: "42431" }));
  const after = [JSON.stringify(afterBootstrap) + "\n", JSON.stringify(afterHosted) + "\n", afterDatabase, JSON.stringify(afterRuntime) + "\n"];
  return { version: 1, id, status: "Prepared", preparedAt, directory, bootstrapFile, origin, previousOrigin: bootstrap.frontendOrigin,
    ports: [...new Set<number>([bootstrap.hostedPort, ...Object.values(runtime.ports ?? {}) as number[]])], previousBinding, publicBinding,
    ...(retiredSponsorship ? { retiredSponsorship } : {}),
    changes: paths.map((path, index) => ({ path, before: raw[index], after: after[index], beforeHash: digest(raw[index]), afterHash: digest(after[index]) })) };
}

/** Executes only the recorded four-file offline domain migration, recovering partial writes from the same immutable intent. */
export async function applyTempoVpsMigration(directory: string, bootstrapFile: string, origin: string) {
  const planned = await planTempoVpsMigration(directory, bootstrapFile, origin); await inactive(planned.ports);
  const transaction = new SessionStore<Migration>(join(directory, "vps-origin-migration")); await transaction.start(true);
  const runtime = new SessionStore<unknown>(join(directory, "runtime-journal")), hosted = new SessionStore<unknown>(join(directory, "hosted", "database"));
  let runtimeHeld = false, hostedHeld = false;
  try {
    await runtime.start(true); runtimeHeld = true; await hosted.start(true); hostedHeld = true;
    const record = await transaction.read() ?? planned; boundRequest(record, directory, bootstrapFile, origin);
    for (const change of record.changes) {
      const current = await taskPrivateFile(change.path), currentHash = digest(current);
      if (currentHash !== change.beforeHash && currentHash !== change.afterHash) fail("TEMPO_ORIGIN_MIGRATION_SOURCE_CHANGED");
    }
    if (record.retiredSponsorship && digest(await taskPrivateFile(record.retiredSponsorship.file)) !== record.retiredSponsorship.digest) fail("TEMPO_ORIGIN_SPONSORSHIP_CHANGED");
    if (record.status === "Applied") {
      if ((await Promise.all(record.changes.map(change => taskPrivateFile(change.path)))).some((value, index) => digest(value) !== record.changes[index].afterHash)) fail("TEMPO_ORIGIN_MIGRATION_SOURCE_CHANGED");
      return { ...safeView(record), cached: true };
    }
    await transaction.write(record); // Full original bytes and target bytes precede the first changed file.
    for (const change of record.changes) await atomicRaw(change.path, change.after);
    record.status = "Applied"; record.appliedAt = new Date().toISOString(); await transaction.write(record);
    return { ...safeView(record), cached: false };
  } finally { if (hostedHeld) await hosted.close(); if (runtimeHeld) await runtime.close(); await transaction.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory, bootstrapFile, origin, ...rest] = process.argv.slice(2);
  if (!["--check", "--execute"].includes(mode) || !directory || !bootstrapFile || !origin || rest.length) {
    console.error("Usage: tempo-vps-migrate.ts --check|--execute RUNTIME_DIRECTORY BOOTSTRAP_FILE EXACT_HTTPS_ORIGIN"); process.exitCode = 1;
  } else if (mode === "--execute" && process.platform !== "linux") { console.error("TEMPO_VPS_MIGRATION_LINUX_REQUIRED"); process.exitCode = 1; }
  else (mode === "--execute" ? applyTempoVpsMigration(resolve(directory), resolve(bootstrapFile), origin)
    : planTempoVpsMigration(resolve(directory), resolve(bootstrapFile), origin).then(safeView))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "TEMPO_ORIGIN_MIGRATION_FAILED"); process.exitCode = 1; });
}
