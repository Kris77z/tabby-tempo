import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Interface, JsonRpcProvider, Network, Transaction, Wallet, getAddress, toQuantity,
  type JsonRpcPayload, type JsonRpcResult, type TransactionRequest } from "ethers";
import { DemoJournal } from "./demo-journal.js";
import { saveJson } from "./demo-common.js";
import { readSecret } from "./demo-monad-config.js";

const SOURCE = "0x48aEd9c702B97A18A520edA3BB04d959453f0B80";
const KEY_FILE = "/Users/jungle/.config/agentfuel/monad-distributor-20261002T021114Z-7beabf5d/distributor.key";
const TOKEN = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const RPC = "https://testnet-rpc.monad.xyz";
const ABI = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)",
  "function transfer(address,uint256) returns(bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const TARGETS = [
  ["management", "0x752EAb56684458CF5e0F55532B4Bd9BeD090885f", 23600000n, 11200000n],
  ["verifier", "0x2481251a15b8Ed31e158aA0C561295f9A05D0CF6", 14000000n, 0n],
  ["hero", "0x739e3631540E5bD22540550F45774b2A24643F00", 3000000n, 50000n],
  ["veteran", "0x0B8b639C78f131973D3da24c0D0D0D0b207a8994", 3000000n, 50000n],
  ["defaulted", "0xc2533F2f2fc21eCeb7a49f5f77Abe7C4e238C7Ef", 2000000n, 50000n],
  ["rotatedWallet", "0x68c549D4dD813f1935c81aF8Ce6230635724155C", 1000000n, 0n],
] as const;
interface Transfer {
  id: string; asset: string; to: string; currentRaw: string; targetRaw: string; amountRaw: string;
  estimateGas: string; gasLimit: string; feeCapWei: string;
  request?: { from: string; to: string; value: string; data?: string };
}
interface Plan {
  ready: boolean; chainId: string; source: string; sourceKeyFile: string; asset: { address: string; decimals: number };
  sourceCurrent: { noncePending: string }; sourceExtraBufferMonRaw: string;
  fee: { feeCap: string; maxPriorityFeePerGas: string }; transactions: Transfer[];
}
function integer(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) >= 1n << 256n) throw new Error("INVALID_PLAN_INTEGER");
  return BigInt(value);
}
function request(plan: Plan, item: Transfer, index: number): TransactionRequest {
  return { chainId: 10143n, type: 2, nonce: Number(integer(plan.sourceCurrent.noncePending)) + index,
    to: item.asset === "native MON" ? item.to : TOKEN, value: item.asset === "native MON" ? integer(item.amountRaw) : 0n,
    data: item.asset === "native MON" ? "0x" : ABI.encodeFunctionData("transfer", [item.to, integer(item.amountRaw)]),
    gasLimit: integer(item.gasLimit), maxFeePerGas: integer(plan.fee.feeCap), maxPriorityFeePerGas: integer(plan.fee.maxPriorityFeePerGas) };
}
export function validateDistributionPlan(plan: Plan) {
  if (!plan.ready || plan.chainId !== "10143" || plan.source !== SOURCE || plan.sourceKeyFile !== KEY_FILE ||
      plan.asset.address !== TOKEN || plan.asset.decimals !== 6 || plan.sourceExtraBufferMonRaw !== "50000000000000000") throw new Error("DISTRIBUTION_PLAN_SCOPE_OR_READINESS");
  const cap = integer(plan.fee.feeCap), priority = integer(plan.fee.maxPriorityFeePerGas);
  if (!cap || priority > cap || integer(plan.sourceCurrent.noncePending) > BigInt(Number.MAX_SAFE_INTEGER - 10)) throw new Error("DISTRIBUTION_FEE_OR_NONCE_INVALID");
  const expected = TARGETS.flatMap(([name, to, gas, usdc]) => [
    { id: `MON-${name}`, to, asset: "native MON", target: gas * cap },
    ...(usdc ? [{ id: `USDC-${name}`, to, asset: TOKEN, target: usdc }] : []),
  ]);
  if (plan.transactions.length !== expected.length) throw new Error("DISTRIBUTION_TARGETS_INVALID");
  for (const [index, item] of plan.transactions.entries()) {
    const target = expected[index], current = integer(item.currentRaw);
    const amount = target.target > current ? target.target - current : 0n;
    if (item.id !== target.id || item.to !== target.to || item.asset !== target.asset || integer(item.targetRaw) !== target.target ||
        integer(item.amountRaw) !== amount || integer(item.feeCapWei) !== cap) throw new Error("DISTRIBUTION_AMOUNT_OR_RECIPIENT_INVALID");
    if (!amount) continue;
    const gas = integer(item.estimateGas), limit = integer(item.gasLimit);
    if (!gas || limit !== (gas * 120n + 99n) / 100n) throw new Error("DISTRIBUTION_GAS_INVALID");
    const encoded = item.asset === "native MON" ? undefined : ABI.encodeFunctionData("transfer", [item.to, amount]);
    if (item.request?.from !== SOURCE || item.request.to !== (encoded ? TOKEN : item.to) ||
        item.request.value !== (encoded ? "0x0" : toQuantity(amount)) || item.request.data !== encoded) throw new Error("DISTRIBUTION_CALLDATA_INVALID");
  }
  return plan.transactions.filter(item => integer(item.amountRaw) > 0n);
}

// RPC bodies, including signed transaction bytes, enter curl through stdin only.
function curlRpc(payload: JsonRpcPayload | JsonRpcPayload[], environment: NodeJS.ProcessEnv): Promise<JsonRpcResult[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("/usr/bin/curl", ["-q", "--silent", "--show-error", "--max-time", "30", "--request", "POST",
      "--header", "content-type: application/json", "--data-binary", "@-", RPC], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let body = "", finished = false;
    const fail = () => { if (!finished) { finished = true; clearTimeout(timer); child.kill("SIGKILL"); reject(new Error("DISTRIBUTION_RPC_FAILED")); } };
    const timer = setTimeout(fail, 30500);
    child.stdout.on("data", chunk => { body += String(chunk); if (body.length > 2000000) fail(); });
    child.stderr.on("data", () => {}); child.on("error", fail); child.stdin.on("error", fail);
    child.on("close", code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (code !== 0) { reject(new Error("DISTRIBUTION_RPC_FAILED")); return; }
      try {
        const value = JSON.parse(body), results = Array.isArray(value) ? value : [value];
        if (results.some(result => result.error || !Object.hasOwn(result, "result"))) { reject(new Error("DISTRIBUTION_RPC_RESPONSE_ERROR")); return; }
        resolveResult(results);
      }
      catch { reject(new Error("DISTRIBUTION_RPC_RESPONSE_INVALID")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
class CurlProvider extends JsonRpcProvider {
  constructor(private environment: NodeJS.ProcessEnv) {
    super(RPC, Network.from(10143), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 1000 });
    void this.on("error", () => {});
  }
  override _send(payload: JsonRpcPayload | JsonRpcPayload[]) { return curlRpc(payload, this.environment); }
}
async function jsonOrEmpty(path: string) {
  try { if ((await stat(path)).mode & 0o077) throw new Error("DISTRIBUTION_PRIVATE_STATE_PERMISSIONS"); return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
async function acquireLock(path: string) {
  try { await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(await readFile(path, "utf8"));
    if (!Number.isInteger(owner) || owner <= 0) throw new Error("DISTRIBUTION_LOCK_INVALID");
    try { process.kill(owner, 0); throw new Error("DISTRIBUTION_ALREADY_RUNNING"); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure; }
    await rm(path); await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
  }
}
async function execute(plan: Plan, bytes: string, path: string, items: Transfer[]) {
  const directory = resolve(dirname(path), "private-distribution"), lock = resolve(directory, "lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await stat(directory)).mode & 0o077) throw new Error("DISTRIBUTION_PRIVATE_DIRECTORY_PERMISSIONS");
  await acquireLock(lock);
  let provider: CurlProvider | undefined;
  try {
    const statePath = resolve(directory, "state.json"), state = await jsonOrEmpty(statePath), hash = createHash("sha256").update(bytes).digest("hex");
    if (state.planHash && state.planHash !== hash) throw new Error("DISTRIBUTION_PLAN_CHANGED_USE_ORIGINAL");
    if (!state.planHash) await saveJson(statePath, { planHash: hash, source: SOURCE, chainId: "10143" });
    const { stdout } = await promisify(execFile)("/usr/sbin/scutil", ["--proxy"], { timeout: 3000, env: { PATH: "/usr/bin:/bin" } });
    const setting = (name: string) => stdout.match(new RegExp(`\\b${name}\\s*:\\s*([^\\s}]+)`))?.[1];
    const host = setting("HTTPSProxy"), port = setting("HTTPSPort");
    if (setting("HTTPSEnable") !== "1" || !host || !/^[A-Za-z0-9.:-]+$/.test(host) || !/^\d+$/.test(port ?? "")) throw new Error("DISTRIBUTION_SYSTEM_PROXY_UNAVAILABLE");
    provider = new CurlProvider({ PATH: "/usr/bin:/bin", HTTPS_PROXY: `http://${host}:${port}` });
    if (BigInt(await provider.send("eth_chainId", [])) !== 10143n) throw new Error("DISTRIBUTION_NETWORK_MISMATCH");
    const tokenBalance = async (address: string) => ABI.decodeFunctionResult("balanceOf", await provider!.call({ to: TOKEN, data: ABI.encodeFunctionData("balanceOf", [address]) }))[0] as bigint;
    if (ABI.decodeFunctionResult("decimals", await provider.call({ to: TOKEN, data: ABI.encodeFunctionData("decimals") }))[0] !== 6n) throw new Error("DISTRIBUTION_ASSET_MISMATCH");
    const fee = await provider.getFeeData();
    if (!(fee.maxFeePerGas ?? fee.gasPrice) || (fee.maxFeePerGas ?? fee.gasPrice)! > integer(plan.fee.feeCap)) throw new Error("DISTRIBUTION_FEE_INCREASED_REPLAN");
    const journalPath = resolve(directory, "journal.json"), entries = await jsonOrEmpty(journalPath);
    for (const id of Object.keys(entries)) {
      const index = items.findIndex(item => item.id === id); if (index < 0) throw new Error("DISTRIBUTION_JOURNAL_UNKNOWN_ID");
      const entry = entries[id], decoded = Transaction.from(entry.rawTransaction), expected = request(plan, items[index], index);
      if (entry.from !== SOURCE || decoded.from !== SOURCE || decoded.hash !== entry.txHash || decoded.chainId !== 10143n || decoded.type !== 2 ||
          decoded.to !== expected.to || decoded.value !== expected.value || decoded.data !== expected.data || decoded.nonce !== expected.nonce ||
          decoded.gasLimit !== expected.gasLimit || decoded.maxFeePerGas !== expected.maxFeePerGas || decoded.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas) throw new Error("DISTRIBUTION_JOURNAL_REQUEST_MISMATCH");
    }
    const base = Number(integer(plan.sourceCurrent.noncePending)), pending = await provider.getTransactionCount(SOURCE, "pending");
    if (pending < base || pending > base + items.length) throw new Error("DISTRIBUTION_SOURCE_NONCE_CHANGED");
    for (let index = 0; index < pending - base; index++) if (!entries[items[index].id]) throw new Error("DISTRIBUTION_UNRELATED_SOURCE_TRANSACTION");
    const remaining: Transfer[] = [];
    for (const item of items) {
      const receipt = entries[item.id] ? await provider.getTransactionReceipt(entries[item.id].txHash) : null;
      if (!receipt) remaining.push(item);
      else if (receipt.status !== 1) throw new Error("DISTRIBUTION_RECORDED_TRANSACTION_REVERTED");
      if (!entries[item.id]) {
        const current = item.asset === "native MON" ? await provider.getBalance(item.to) : await tokenBalance(item.to);
        if (current !== integer(item.currentRaw)) throw new Error("DISTRIBUTION_TARGET_BALANCE_CHANGED_REPLAN");
      }
    }
    const requiredMon = remaining.reduce((sum, item) => sum + (item.asset === "native MON" ? integer(item.amountRaw) : 0n) + integer(item.gasLimit) * integer(plan.fee.feeCap), integer(plan.sourceExtraBufferMonRaw));
    const requiredUsdc = remaining.reduce((sum, item) => sum + (item.asset === TOKEN ? integer(item.amountRaw) : 0n), 0n);
    if (await provider.getBalance(SOURCE) < requiredMon || await tokenBalance(SOURCE) < requiredUsdc) throw new Error("DISTRIBUTION_SOURCE_BALANCE_INSUFFICIENT");
    const wallet = new Wallet(await readSecret(KEY_FILE), provider); if (wallet.address !== SOURCE) throw new Error("DISTRIBUTION_KEY_ADDRESS_MISMATCH");
    const journal = new DemoJournal(provider, journalPath); await journal.load();
    const evidence: Record<string, unknown> = {};
    for (const [index, item] of items.entries()) {
      if (BigInt(await provider.send("eth_chainId", [])) !== 10143n) throw new Error("DISTRIBUTION_NETWORK_MISMATCH");
      await journal.send(item.id, wallet, request(plan, item, index));
      const receipt = await journal.receipt(item.id);
      if (item.asset === TOKEN && !receipt.logs.some(log => {
        if (getAddress(log.address) !== TOKEN) return false;
        try { const event = ABI.parseLog(log); return event?.name === "Transfer" && event.args.from === SOURCE && event.args.to === item.to && event.args.value === integer(item.amountRaw); }
        catch { return false; }
      })) throw new Error("DISTRIBUTION_TOKEN_TRANSFER_LOG_MISMATCH");
      const balance = item.asset === "native MON" ? await provider.getBalance(item.to) : await tokenBalance(item.to);
      if (balance < integer(item.targetRaw)) throw new Error("DISTRIBUTION_RECEIPT_CONFIRMED_TARGET_BELOW_GOAL");
      evidence[item.id] = { hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: receipt.gasUsed.toString(), gasPrice: receipt.gasPrice.toString(), targetBalanceRaw: balance.toString() };
      await saveJson(resolve(dirname(path), "distribution-receipts.json"), evidence);
      process.stdout.write(JSON.stringify({ id: item.id, hash: receipt.hash, status: receipt.status }) + "\n");
    }
  } finally { provider?.destroy(); await rm(lock, { force: true }); }
}
async function main() {
  const args = process.argv.slice(2), index = args.indexOf("--plan"), path = index >= 0 && args[index + 1] ? resolve(args[index + 1]) : undefined;
  if (!path || args.some((arg, i) => arg !== "--plan" && arg !== "--execute" && i !== index + 1)) throw new Error("USAGE_DISTRIBUTE_DEMO_PLAN_OPTIONAL_EXECUTE");
  const bytes = await readFile(path, "utf8"), plan = JSON.parse(bytes) as Plan, items = validateDistributionPlan(plan);
  if (!args.includes("--execute")) { console.log(JSON.stringify({ readOnly: true, offlinePlanValidated: true, source: SOURCE, chainId: "10143", transferCount: items.length, privateKeyBytesRead: false })); return; }
  await execute(plan, bytes, path, items);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { const code = typeof error?.message === "string" && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "DISTRIBUTION_FAILED";
    process.stderr.write(code + "\n"); process.exitCode = 1; });
}
