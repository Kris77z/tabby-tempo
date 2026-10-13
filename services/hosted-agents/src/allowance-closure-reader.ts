import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { canonical, requestDigest } from "../../../packages/sdk/src/protocol.js";
import { validGatewayClosure, type GatewayClosure } from "./inference-closure.js";

/** Local custody boundary. Never trust a client-supplied filesystem path or seal alone. */
export async function findHostedAllowanceLedger(hostedRoot: string, paymentId: string): Promise<string> {
  const root = await realpath(hostedRoot), matches: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name === "inference-ledger") {
        const file = join(path, "session.json");
        const ledger = JSON.parse(await readFile(file, "utf8"));
        if (ledger.grants?.some((g: any) => g.source?.paymentId === paymentId)) matches.push(file);
      } else await visit(path);
    }
  }
  await visit(join(root, "agents"));
  if (matches.length !== 1) throw new Error("ALLOWANCE_LEDGER_NOT_UNIQUE");
  const file = await realpath(matches[0]);
  if (!file.startsWith(root + sep)) throw new Error("ALLOWANCE_LEDGER_OUTSIDE_CUSTODY");
  return file;
}

export async function verifyHostedAllowanceClosure(hostedRoot: string, closure: GatewayClosure): Promise<boolean> {
  try {
    const file = await findHostedAllowanceLedger(hostedRoot, closure.paymentId);
    const ledger = JSON.parse(await readFile(file, "utf8"));
    if (!validGatewayClosure(ledger, closure)) return false;
    const purchase = JSON.parse(await readFile(join(dirname(dirname(file)), "allowance-purchase", "session.json"), "utf8"));
    const handle = purchase.handle, receipt = purchase.inference?.receipt, result = purchase.inference?.result, quote = handle?.quote;
    const grant = ledger.grants[0];
    return quote?.paymentId === closure.paymentId && quote.agentId === closure.binding.agentId && quote.taskId === closure.binding.taskId
      && handle.submission?.from.toLowerCase() === closure.binding.wallet && handle.submission.txHash === grant.source.txHash
      && requestDigest(handle.input) === quote.requestDigest && quote.service === "infercredit/allowance"
      && receipt?.paymentId === closure.paymentId && receipt.txHash === grant.source.txHash && receipt.agentId === quote.agentId && receipt.taskId === quote.taskId
      && result?.kind === "inference-allowance" && result.paymentId === closure.paymentId && result.creditsRaw === grant.credits
      && canonical(purchase.config.catalog) === canonical(ledger.catalog);
  } catch { return false; }
}
