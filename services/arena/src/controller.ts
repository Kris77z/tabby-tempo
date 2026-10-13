import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { Contract, JsonRpcProvider } from "ethers";
import { DockerExecutor, type DockerOptions } from "./docker.js";
import { hiddenTests } from "./problems.js";
import { readControllerToken, requestSettlement } from "./ipc.js";
import { digest, ESCROW_ABI, uintString, type ArenaConfig, type Settlement, type Verdict } from "./protocol.js";

export interface TestResult { case: number; passed: boolean; failure?: string }
export interface Acceptance { verdict: Verdict; tests: TestResult[]; settlement: Settlement }

// This process never loads verifier keys or imports the settler implementation.
export class ArenaController {
  private readonly provider: JsonRpcProvider;
  private readonly ownsProvider: boolean;
  private readonly escrow: Contract;
  private readonly runner: DockerExecutor;
  constructor(private readonly config: ArenaConfig, options: DockerOptions = {}, provider?: JsonRpcProvider) {
    if (process.env.ARENA_VERIFIER_PRIVATE_KEY) throw new Error("VERIFIER_KEY_MUST_ONLY_EXIST_IN_SETTLER_PROCESS");
    this.ownsProvider = provider === undefined;
    this.provider = provider ?? new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
    this.escrow = new Contract(config.escrowAddress, ESCROW_ABI, this.provider);
    this.runner = new DockerExecutor(options);
  }
  private async binding(taskId: string) {
    uintString(taskId, "TASK_ID");
    const binding = Object.hasOwn(this.config.tasks, taskId) ? this.config.tasks[taskId] : undefined;
    if (!binding) throw new Error("TASK_NOT_AUTHORIZED");
    if (BigInt(await this.provider.send("eth_chainId", [])) !== BigInt(this.config.chainId)) throw new Error("NETWORK_MISMATCH");
    const task = await this.escrow.getFunction("getTask").staticCall(taskId);
    if (task.status !== 2n) throw new Error("TASK_NOT_ASSIGNED");
    if (task.agentId === 0n || binding.agentId !== undefined && task.agentId !== BigInt(binding.agentId)) throw new Error("TASK_AGENT_MISMATCH");
    return { ...binding, agentId: String(task.agentId) };
  }
  async submit(input: { taskId: string; code: string; runId?: string; signal?: AbortSignal }): Promise<Acceptance> {
    if (typeof input.code !== "string" || Buffer.byteLength(input.code) > 65536) throw new Error("INVALID_SUBMISSION");
    const binding = await this.binding(input.taskId);
    const token = await readControllerToken(this.config.ipcDirectory);
    await this.runner.ready(); // No silent fallback to a host child process.
    const results: TestResult[] = [];
    for (const [i, test] of hiddenTests(binding.problemId).entries()) {
      const output = await this.runner.execute(input.code, test.input, input.signal);
      let passed = false;
      let failure: string | undefined = output.failure;
      if (!failure) {
        try { passed = isDeepStrictEqual(JSON.parse(output.stdout.trim()), test.expected); }
        catch { failure = "invalid-json"; }
        if (!passed) failure ??= "wrong-answer";
      }
      results.push({ case: i + 1, passed, ...(failure ? { failure } : {}) });
      // Any failed case fails the task, including timeout/output limit/nonzero exit.
      if (!passed) break;
    }
    if (input.signal?.aborted) throw new Error("SUBMISSION_CANCELLED");
    const passed = results.length === hiddenTests(binding.problemId).length && results.every(result => result.passed);
    const verdict: Verdict = { version: 1, runId: input.runId ?? randomUUID(), chainId: this.config.chainId,
      escrowAddress: this.config.escrowAddress, taskId: input.taskId, agentId: binding.agentId,
      problemId: binding.problemId, passed, mode: "docker", evidenceHash: digest(JSON.stringify({ codeHash: digest(input.code), results })) };
    return { verdict, tests: results, settlement: await requestSettlement(this.config.ipcDirectory, token, verdict, this.config.settlementTimeoutMs) };
  }
  async manual(input: { taskId: string; passed: boolean; reason: string; runId?: string }): Promise<Acceptance> {
    if (!this.config.allowManual) throw new Error("MANUAL_DISABLED");
    if (typeof input.passed !== "boolean" || typeof input.reason !== "string" || input.reason.trim().length < 8) throw new Error("EXPLICIT_MANUAL_REASON_REQUIRED");
    const binding = await this.binding(input.taskId);
    const token = await readControllerToken(this.config.ipcDirectory);
    const verdict: Verdict = { version: 1, runId: input.runId ?? randomUUID(), chainId: this.config.chainId,
      escrowAddress: this.config.escrowAddress, taskId: input.taskId, agentId: binding.agentId,
      problemId: binding.problemId, passed: input.passed, mode: "manual", evidenceHash: digest(input.reason) };
    return { verdict, tests: [], settlement: await requestSettlement(this.config.ipcDirectory, token, verdict, this.config.settlementTimeoutMs) };
  }
  close(): void { if (this.ownsProvider) this.provider.destroy(); }
}
