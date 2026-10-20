import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateOperatorFinancialObservation } from "../services/hosted-agents/src/operating-report.js";

const inputLimit = 1024 * 1024;
class ReportError extends Error {}
const fail = (code: string): never => { throw new ReportError(code); };
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** Only the explicitly named, bounded regular file is read; never discovers or loads operator books. */
export async function evaluateOperatingReportFile(path: string) {
  if (!isAbsolute(path)) fail("OPERATING_INPUT_ABSOLUTE_PATH_REQUIRED");
  let file: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat(); if (!stat.isFile()) fail("OPERATING_INPUT_REGULAR_FILE_REQUIRED"); if (stat.size > inputLimit) fail("OPERATING_INPUT_TOO_LARGE");
    const buffer = Buffer.alloc(inputLimit + 1); let length = 0;
    while (length < buffer.length) { const part = await file.read(buffer, length, buffer.length - length, null); if (part.bytesRead === 0) break; length += part.bytesRead; }
    if (length > inputLimit) fail("OPERATING_INPUT_TOO_LARGE"); bytes = buffer.subarray(0, length);
  } catch (error) { if (error instanceof ReportError) throw error; return fail("OPERATING_INPUT_UNREADABLE"); }
  finally { await file?.close(); }
  let input: unknown; try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail("OPERATING_INPUT_JSON_INVALID"); }
  let evaluation; try { evaluation = evaluateOperatorFinancialObservation(input); } catch { return fail("OPERATING_INPUT_INVALID"); }
  const sources = ["scripts/operating-report.ts", "services/hosted-agents/src/operating-report.ts", "services/hosted-agents/src/operating-types.ts"];
  const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async relative => [relative, sha256(await readFile(fileURLToPath(new URL(`../${relative}`, import.meta.url))))])));
  return { version: 1, mode: "operator-declared-financial-evaluation", currency: "USDC", decimals: 6,
    scope: { explicitInputOnly: true, productionRead: false, productionWrite: false, externalRpcCalls: 0, modelCalls: 0, signedTransactions: 0, profitCalibrated: false,
      evidenceDigest: "reference-only-not-authenticated-invoice", operatorDeclarationVerified: false },
    inputSha256: sha256(bytes), evaluation, sourceSha256 };
}
async function save(path: string, content: string) {
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, "wx", 0o600); } catch (error) { return fail((error as NodeJS.ErrnoException).code === "EEXIST" ? "OPERATING_REPORT_EXISTS" : "OPERATING_REPORT_WRITE_FAILED"); }
  try { await file.writeFile(content); await file.close(); }
  catch { await file.close().catch(() => {}); await rm(path, { force: true }).catch(() => {}); return fail("OPERATING_REPORT_WRITE_FAILED"); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write("Usage: npm run operating:report -- --input /absolute/sanitized-observation.json [--report /absolute/new-report.json]\nReads one operator-declared JSON observation (maximum 1 MiB). No RPC, wallet, model or production discovery. Reports never overwrite.\n"); return; }
  if (![2, 4].includes(args.length) || args[0] !== "--input" || !isAbsolute(args[1]) || args.length === 4 && (args[2] !== "--report" || !isAbsolute(args[3]))) fail("OPERATING_USAGE_INVALID");
  const report = await evaluateOperatingReportFile(args[1]), content = JSON.stringify(report, null, 2) + "\n";
  if (args.length === 4) await save(args[3], content);
  process.stdout.write(JSON.stringify({ ...report, ...(args.length === 4 ? { report: { path: args[3], sha256: sha256(content), sourceHashesIncluded: true } } : {}) }, null, 2) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error instanceof ReportError ? error.message : "OPERATING_REPORT_FAILED"}\n`); process.exitCode = 1; });
