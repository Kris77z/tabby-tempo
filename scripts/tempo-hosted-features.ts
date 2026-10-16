import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { getAddress } from "ethers";
import { taskPrivateFile } from "../packages/pi-loop/src/task-runner/config.js";
import type { WorkflowConfig } from "../packages/pi-loop/src/workflow.js";
import { assertBoundedGameAdmissions, boundedGameOrigin, loadBoundedGameAuthorization } from "../services/hosted-agents/src/bounded-game-authorization.js";
import { missionSpecialists } from "../services/hosted-agents/src/specialists/catalog.js";
import type { HostedAutonomyConfig } from "../services/hosted-agents/src/autonomy-executor.js";
import type { TempoHostedBootstrap } from "./tempo-hosted-runtime.js";
import { validateTempoTransactionBudget } from "./tempo-transaction-budget.js";

export interface TempoHostedFeatures {
  version: 1; id: string; chainId: "42431"; origin: string;
  externalProvider: { chainId: "42431"; registry: string; agentId: string; wallet: string };
  boundedGamesFile: string; transactionBudgetFile: string; taskTemplateDeadlineMs: number; taskIds: string[];
}
export interface TempoHostedFeaturesSeal { version: 1; file: string; digest: string }
export interface TempoFeatureClosure {
  version: 1; id: string; closedAt: string; goalRequestId: string; parentRequestId: string;
  budgetId: string; budgetDigest: string; ledgerSha256: string; boundedAdmissionsSha256: string;
}
export interface TempoHostedFeaturesJournal { version: 1; file: string; digest: string; config: TempoHostedFeatures; seal?: TempoHostedFeaturesSeal }
export const TEMPO_EXTERNAL_PORTS = [...missionSpecialists.flatMap(s => [`external-${s.id}-0`, `external-${s.id}-1`]), "external-registry"];
function fail(): never { throw new Error("TEMPO_FEATURES_BINDING_INVALID"); }
function closed(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail();
}
export function tempoFeaturePaths(directory: string) {
  const operator = join(dirname(directory), "operator");
  return { file: join(operator, "features.json"), boundedGamesFile: join(operator, "bounded-games.json"), transactionBudgetFile: join(operator, "acceptance-20261016/transaction-budget.json"),
    closureFile: join(operator, "acceptance-20261016/closure.json"), externalDirectory: join(directory, "external-services") };
}
/** Pure, closed configuration. Bootstrap identity, asset, old tasks and original
 * runtime journal are never rewritten by validating or selecting features. */
export function validateTempoHostedFeatures(value: unknown, directory: string, bootstrap: TempoHostedBootstrap): TempoHostedFeatures {
  try {
    closed(value, ["version", "id", "chainId", "origin", "externalProvider", "boundedGamesFile", "transactionBudgetFile", "taskTemplateDeadlineMs", "taskIds"]);
    const paths = tempoFeaturePaths(directory);
    if (resolve(directory) !== directory || value.version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
      || value.chainId !== "42431" || value.origin !== bootstrap.frontendOrigin || !boundedGameOrigin(value.origin)
      || value.boundedGamesFile !== paths.boundedGamesFile || value.transactionBudgetFile !== paths.transactionBudgetFile
      || !Number.isSafeInteger(value.taskTemplateDeadlineMs) || value.taskTemplateDeadlineMs <= 0 || !Array.isArray(value.taskIds) || value.taskIds.length !== 1
      || typeof value.taskIds[0] !== "string" || !/^[1-9][0-9]{0,77}$/.test(value.taskIds[0])) fail();
    closed(value.externalProvider, ["chainId", "registry", "agentId", "wallet"]);
    if (value.externalProvider.chainId !== bootstrap.chainId || value.externalProvider.registry !== getAddress(bootstrap.identity)
      || value.externalProvider.agentId !== bootstrap.opponentBinding.agentId || value.externalProvider.wallet !== getAddress(bootstrap.opponentBinding.wallet)) fail();
    const task = bootstrap.tasks.find(task => task.taskId === value.taskIds[0]);
    if (!task || task.deadlineMs !== value.taskTemplateDeadlineMs) fail();
    return structuredClone(value) as TempoHostedFeatures;
  } catch { return fail(); }
}
export async function readTempoHostedFeatures(file: string, directory: string, bootstrap: TempoHostedBootstrap) {
  try {
    const raw = await taskPrivateFile(file), config = validateTempoHostedFeatures(JSON.parse(raw), directory, bootstrap);
    return { config, digest: createHash("sha256").update(raw).digest("hex") };
  } catch { return fail(); }
}
export async function verifyTempoHostedFeatures(record: TempoHostedFeaturesJournal | undefined, directory: string, bootstrap: TempoHostedBootstrap) {
  if (!record) return undefined;
  closed(record, ["version", "file", "digest", "config", ...(Object.hasOwn(record, "seal") ? ["seal"] : [])]);
  if (record.version !== 1 || record.file !== tempoFeaturePaths(directory).file || !/^[0-9a-f]{64}$/.test(record.digest)) fail();
  const observed = await readTempoHostedFeatures(record.file, directory, bootstrap);
  if (observed.digest !== record.digest || !isDeepStrictEqual(observed.config, record.config)) fail();
  await loadBoundedGameAuthorization(record.config.boundedGamesFile, { chainId: bootstrap.chainId, origin: bootstrap.frontendOrigin });
  validateTempoTransactionBudget(JSON.parse(await taskPrivateFile(record.config.transactionBudgetFile)));
  if (record.seal) await verifyTempoFeatureSeal(record, directory);
  return structuredClone(record);
}
/** A seal proves the original terminal requests, frozen model-game admissions
 * and final transaction ledger. It never renews a grant or creates an audit. */
export async function verifyTempoFeatureSeal(record: TempoHostedFeaturesJournal, directory: string, allTerminalTimes = false): Promise<TempoFeatureClosure> {
  try {
    const seal = record.seal; closed(seal, ["version", "file", "digest"]);
    if (seal.version !== 1 || seal.file !== tempoFeaturePaths(directory).closureFile || !/^[0-9a-f]{64}$/.test(seal.digest)) fail();
    const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
    const raw = await taskPrivateFile(seal.file), closure = JSON.parse(raw);
    closed(closure, ["version", "id", "closedAt", "goalRequestId", "parentRequestId", "budgetId", "budgetDigest", "ledgerSha256", "boundedAdmissionsSha256"]);
    const closedAt = Date.parse(closure.closedAt), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (sha(raw) !== seal.digest || closure.version !== 1 || closure.id !== record.config.id || !Number.isSafeInteger(closedAt)
      || new Date(closedAt).toISOString() !== closure.closedAt || closedAt > Date.now() || !uuid.test(closure.goalRequestId) || !uuid.test(closure.parentRequestId)
      || closure.goalRequestId === closure.parentRequestId || ![closure.budgetDigest, closure.ledgerSha256, closure.boundedAdmissionsSha256].every(hash => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) fail();
    const budgetRaw = await taskPrivateFile(record.config.transactionBudgetFile), budget = validateTempoTransactionBudget(JSON.parse(budgetRaw));
    const ledgerRaw = await taskPrivateFile(join(dirname(record.config.transactionBudgetFile), "transaction-budget-ledger.json")), ledger = JSON.parse(ledgerRaw);
    if (closure.budgetId !== budget.id || closure.budgetDigest !== sha(budgetRaw) || closure.ledgerSha256 !== sha(ledgerRaw)
      || ledger.version !== 1 || ledger.budgetId !== budget.id || ledger.digest !== closure.budgetDigest || !Array.isArray(ledger.reservations)
      || ledger.reservations.some((row: any) => !Number.isFinite(Date.parse(row.admittedAt)) || Date.parse(row.admittedAt) > closedAt)) fail();
    const authorization = await loadBoundedGameAuthorization(record.config.boundedGamesFile, { chainId: record.config.chainId, origin: record.config.origin });
    const mirrorRaw = await taskPrivateFile(join(dirname(record.config.boundedGamesFile), "bounded-admissions/session.json"));
    const hosted = JSON.parse(await taskPrivateFile(join(directory, "hosted/database/session.json")));
    if (closure.parentRequestId !== authorization.grant.parentRequestId || sha(mirrorRaw) !== closure.boundedAdmissionsSha256
      || closedAt < Math.max(authorization.grant.issuedAtMs, budget.issuedAtMs)
      || !hosted.boundedGames || hosted.boundedGames.digest !== authorization.digest || !isDeepStrictEqual(hosted.boundedGames.grant, authorization.grant)
      || !isDeepStrictEqual(JSON.parse(mirrorRaw), hosted.boundedGames) || !Array.isArray(hosted.runs)) fail();
    assertBoundedGameAdmissions(hosted.boundedGames);
    const referenced = [hosted.runs.find((run: any) => run.requestId === closure.goalRequestId), hosted.runs.find((run: any) => run.requestId === closure.parentRequestId)];
    for (const [index, run] of referenced.entries()) if (!run || run.action !== (index ? "autonomous" : "goal") || run.agentId !== authorization.grant.actor.hostedAgentId
      || !["Succeeded", "Failed"].includes(run.status) || run.recoverable !== false || run.result?.terminal !== true || !Number.isFinite(Date.parse(run.updatedAt)) || Date.parse(run.updatedAt) > closedAt) fail();
    if (allTerminalTimes && hosted.runs.some((run: any) => !["Succeeded", "Failed"].includes(run.status) || run.recoverable !== false || run.result?.terminal !== true || !Number.isFinite(Date.parse(run.updatedAt)) || Date.parse(run.updatedAt) > closedAt)) fail();
    return closure as TempoFeatureClosure;
  } catch { return fail(); }
}
export function tempoFeatureBudgetFile(record: TempoHostedFeaturesJournal | undefined, ambient: string | undefined): string | undefined {
  if (!record) return ambient;
  if (record.seal) {
    if (ambient !== undefined) throw new Error("TEMPO_FEATURES_BUDGET_ENV_REJECTED");
    return undefined;
  }
  if (ambient !== undefined && ambient !== record.config.transactionBudgetFile) throw new Error("TEMPO_FEATURES_BUDGET_ENV_REJECTED");
  return record.config.transactionBudgetFile;
}
export function tempoFeatureTaskDomain(config: TempoHostedFeatures | undefined, bootstrap: TempoHostedBootstrap, journal: {
  templateDeadlineMs: number; originalCatalog?: WorkflowConfig["tasks"];
  migrations?: { status: string; before: TempoHostedBootstrap; after: TempoHostedBootstrap; appended: WorkflowConfig["tasks"] }[];
}) {
  if (!config) return { tasks: structuredClone(bootstrap.tasks), deadlineMs: journal.templateDeadlineMs };
  const task = bootstrap.tasks.find(task => task.taskId === config.taskIds[0]);
  const migration = journal.migrations?.find(m => m.status === "Applied" && m.appended.length === 1 && m.appended[0].taskId === task?.taskId);
  if (!task || !Array.isArray(journal.originalCatalog) || journal.originalCatalog.some(old => old.taskId === task.taskId) || !migration
    || !isDeepStrictEqual(migration.appended, [task]) || !isDeepStrictEqual(migration.after.tasks, bootstrap.tasks)
    || !isDeepStrictEqual([...migration.before.tasks, ...migration.appended], migration.after.tasks)
    || !isDeepStrictEqual(bootstrap.tasks.slice(0, journal.originalCatalog.length), journal.originalCatalog) || task.deadlineMs !== config.taskTemplateDeadlineMs) fail();
  return { tasks: [structuredClone(task)], deadlineMs: config.taskTemplateDeadlineMs };
}
export function tempoFeatureAutonomy(base: HostedAutonomyConfig, enabled: boolean): HostedAutonomyConfig {
  return !enabled ? structuredClone(base) : { ...structuredClone(base), maxTasks: 1, maxDecisions: 4, durationMs: 1200000,
    games: { maxGames: 2, maxSpendPerGameRaw: "0", rewardKinds: ["llm-credits"], rewardTaskMinTokens: 2048 } };
}
