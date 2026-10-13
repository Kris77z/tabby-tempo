import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, JsonRpcProvider, keccak256, Wallet } from "ethers";
import { atomicJson, digest, ESCROW_ABI, privateDirectory, settlementTimeout, validateVerdict, type ArenaConfig, type Settlement, type Verdict } from "./protocol.js";

interface RecordEntry { verdict: Verdict; verdictHash: string; rawTx: string; txHash: string; settlement?: Settlement }
type Journal = Record<string, RecordEntry>;

// Only this module/process has a Wallet and receives the verifier key.
export class ArenaSettler {
  private readonly provider: JsonRpcProvider;
  private readonly ownsProvider: boolean;
  private readonly wallet: Wallet;
  private readonly escrow: Contract;
  private readonly token = randomBytes(32).toString("hex");
  private readonly journalPath: string;
  private journal: Journal = {};
  private queue: Promise<unknown> = Promise.resolve();
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private ownsIpc = false;
  constructor(private readonly config: ArenaConfig, privateKey: string, provider?: JsonRpcProvider, private readonly maxFeePerGas?: bigint) {
    if (maxFeePerGas !== undefined && maxFeePerGas <= 0n) throw new Error("INVALID_GAS_CEILING");
    this.ownsProvider = provider === undefined;
    this.provider = provider ?? new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100 });
    this.wallet = new Wallet(privateKey, this.provider);
    this.escrow = new Contract(config.escrowAddress, ESCROW_ABI, this.wallet);
    this.journalPath = join(config.ipcDirectory, "settlements.json");
  }
  private async domain(): Promise<void> {
    if (BigInt(await this.provider.send("eth_chainId", [])) !== BigInt(this.config.chainId)) throw new Error("NETWORK_MISMATCH");
    if (await this.provider.getCode(this.config.escrowAddress) === "0x") throw new Error("ESCROW_HAS_NO_CODE");
    if ((await this.escrow.getFunction("verifier").staticCall()).toLowerCase() !== this.wallet.address.toLowerCase()) throw new Error("VERIFIER_MISMATCH");
  }
  async start(): Promise<void> {
    await this.domain();
    await privateDirectory(this.config.ipcDirectory);
    const recovery = join(this.config.ipcDirectory, "recover.lock");
    const noRecovery = async () => {
      try { await access(recovery); throw new Error("IPC_RECOVERY_IN_PROGRESS"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    await noRecovery();
    // Exclusive PID file prevents a second signer from replacing a live socket.
    await writeFile(join(this.config.ipcDirectory, "settler.owner"), String(process.pid), { flag: "wx", mode: 0o600 });
    this.ownsIpc = true;
    await noRecovery();
    try {
      this.journal = JSON.parse(await readFile(this.journalPath, "utf8")) as Journal;
      for (const [taskId, entry] of Object.entries(this.journal)) {
        validateVerdict(entry.verdict, this.config);
        if (entry.verdict.taskId !== taskId || entry.verdictHash !== digest(JSON.stringify(entry.verdict)) || keccak256(entry.rawTx) !== entry.txHash) throw new Error("INVALID_SETTLEMENT_JOURNAL");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Do not unlink a live socket from a second process. Binding must fail EADDRINUSE.
    this.server = createServer({ allowHalfOpen: true }, socket => this.connection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(join(this.config.ipcDirectory, "settler.sock"), () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(join(this.config.ipcDirectory, "settler.sock"), 0o600);
    // Rotate the capability at every process startup. Container never sees this directory.
    await writeFile(join(this.config.ipcDirectory, "controller.token"), this.token, { mode: 0o600, flag: "w" });
    await chmod(join(this.config.ipcDirectory, "controller.token"), 0o600);
  }
  private connection(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => { /* Peer disconnects cannot stop signer. */ });
    socket.setTimeout(5000, () => socket.destroy());
    let body = "";
    socket.on("data", data => {
      body += data.toString();
      if (Buffer.byteLength(body) > 16384) socket.destroy();
    });
    socket.on("end", () => {
      // Disconnecting a slow peer never cancels the journal operation below.
      socket.setTimeout(settlementTimeout(this.config.settlementTimeoutMs), () => socket.destroy());
      const operation = this.queue.then(async () => {
        const request = JSON.parse(body) as { token: unknown; verdict: unknown };
        if (typeof request.token !== "string" || !/^[a-f0-9]{64}$/.test(request.token) || !timingSafeEqual(Buffer.from(request.token), Buffer.from(this.token))) throw new Error("UNAUTHORIZED_CONTROLLER");
        return this.settle(validateVerdict(request.verdict, this.config));
      });
      this.queue = operation.catch(() => undefined);
      operation.then(settlement => socket.end(JSON.stringify({ settlement }) + "\n"), error => {
        // Never leak RPC credentials, the private key, or raw transactions.
        const message = (error as Error).message;
        socket.end(JSON.stringify({ error: /^[A-Z_]+$/.test(message) ? message : "SETTLEMENT_UNAVAILABLE" }) + "\n");
      });
    });
  }
  private async settle(verdict: Verdict): Promise<Settlement> {
    await this.domain();
    const hash = digest(JSON.stringify(verdict));
    let entry = this.journal[verdict.taskId];
    if (entry && entry.verdictHash !== hash) throw new Error("TASK_ALREADY_SUBMITTED");
    if (entry?.settlement) return entry.settlement;
    if (!entry) {
      const task = await this.escrow.getFunction("getTask").staticCall(verdict.taskId);
      if (task.status !== 2n) throw new Error("TASK_NOT_ASSIGNED");
      if (task.agentId !== BigInt(verdict.agentId)) throw new Error("TASK_AGENT_MISMATCH");
      // Gas estimation can choose the feedback catch path. Budget for two normal
      // feedback writes so successful acceptance produces the intended mirror.
      // Tempo's storage writes and two bounded ERC-8004 callbacks need a
      // separate ceiling. Estimation alone may select the callback catch path.
      const settlementGasLimit = this.config.chainId === "42431" ? 20_000_000 : 2_000_000;
      const transaction = await this.escrow.getFunction("settle").populateTransaction(verdict.taskId, verdict.passed, { gasLimit: settlementGasLimit });
      const populated = await this.wallet.populateTransaction(transaction);
      if (this.maxFeePerGas !== undefined && BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0n) > this.maxFeePerGas) throw new Error("GAS_CEILING_EXCEEDED");
      const rawTx = await this.wallet.signTransaction(populated);
      entry = { verdict, verdictHash: hash, rawTx, txHash: keccak256(rawTx) };
      this.journal[verdict.taskId] = entry;
      // Persist the exact signed tx before broadcast, so retries after crashes
      // can only resubmit that transaction; they cannot mint another verdict.
      try { await atomicJson(this.journalPath, this.journal); }
      catch (error) { delete this.journal[verdict.taskId]; throw error; }
    }
    let receipt = await this.provider.getTransactionReceipt(entry.txHash);
    if (!receipt) {
      try { await this.provider.broadcastTransaction(entry.rawTx); }
      catch (error) {
        // A previously broadcast tx can already be mined/pending after restart.
        if (!await this.provider.getTransaction(entry.txHash)) throw error;
      }
      // Poll only this persisted hash. A block subscription can miss the first
      // automined block while it bootstraps, leaving a mined tx waiting forever
      // on a quiet chain. Never sign or broadcast again in this read-only wait.
      const until = Date.now() + 25000;
      const timer = new AbortController();
      const expired = delay(25000, undefined, { signal: timer.signal }).then(() => { throw new Error("SETTLEMENT_RECEIPT_PENDING"); });
      const poll = async () => {
        do {
          const found = await this.provider.getTransactionReceipt(entry.txHash);
          if (found) return found;
          const remaining = until - Date.now();
          if (remaining > 0) await delay(Math.min(100, remaining));
        } while (Date.now() < until);
        throw new Error("SETTLEMENT_RECEIPT_PENDING");
      };
      try { receipt = await Promise.race([poll(), expired]); }
      finally { timer.abort(); }
    }
    if (!receipt) throw new Error("SETTLEMENT_RECEIPT_PENDING");
    if (receipt.status !== 1) throw new Error("SETTLEMENT_TRANSACTION_FAILED");
    const canonical = await this.provider.getBlock(receipt.blockNumber);
    if (!canonical || canonical.hash !== receipt.blockHash) throw new Error("SETTLEMENT_NOT_CANONICAL");
    const settled = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== this.config.escrowAddress.toLowerCase()) return false;
      try {
        const event = this.escrow.interface.parseLog(log);
        return event?.name === "TaskSettled" && event.args.taskId === BigInt(verdict.taskId) && event.args.passed === verdict.passed;
      } catch { return false; }
    });
    if (!settled) throw new Error("SETTLEMENT_EVENT_MISMATCH");
    const task = await this.escrow.getFunction("getTask").staticCall(verdict.taskId);
    if (task.status !== (verdict.passed ? 3n : 4n)) throw new Error("SETTLEMENT_STATE_MISMATCH");
    const feedback = await Promise.all([1, 2, 3].map(async type => ({ type,
      sent: Boolean(await this.escrow.getFunction("feedbackSent").staticCall(verdict.taskId, type)),
      pending: Boolean(await this.escrow.getFunction("pendingFeedback").staticCall(verdict.taskId, type)) })));
    entry.settlement = { taskId: verdict.taskId, runId: verdict.runId, passed: verdict.passed, txHash: entry.txHash, blockNumber: receipt.blockNumber, feedback };
    await atomicJson(this.journalPath, this.journal);
    return entry.settlement;
  }
  async close(): Promise<void> {
    await this.queue;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.ownsIpc) {
      await rm(join(this.config.ipcDirectory, "controller.token"), { force: true });
      await rm(join(this.config.ipcDirectory, "settler.owner"), { force: true });
      this.ownsIpc = false;
    }
    if (this.ownsProvider) this.provider.destroy();
  }
}
