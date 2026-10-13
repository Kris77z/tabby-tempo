import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, ContractFactory, Wallet, getAddress, type TransactionRequest } from "ethers";
import { IdentityRegistry, IDENTITY_ABI, registrationFromReceipt } from "../packages/erc8004/src/identity.js";
import { atomicJson } from "../services/arena/src/protocol.js";
import { artifact, json } from "./demo-common.js";
import { DemoJournal } from "./demo-journal.js";
import { chainRpcProvider, readRpcUrlFile } from "./demo-rpc.js";
import { TEMPO_ASSET, TEMPO_CHAIN_ID, TEMPO_EXPLORER_URL, TEMPO_IDENTITY, TEMPO_PATH_USD, TEMPO_REPUTATION, TEMPO_RPC_URL, tempoPreflight } from "./tempo-config.js";
import type { TempoHostedBootstrap } from "./tempo-hosted-runtime.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";

const roles = ["deployer", "guardian", "underwriter", "verifier", "refunder", "poster", "sponsor", "opponent", "dashboardA", "dashboardB"] as const;
type Role = typeof roles[number];
interface Plan { version: 1; chainId: "42431"; directory: string; createdAt: string; rpcUrlFile: string; vendorKeyFile: string; gatewayReadyFile: string; keyFiles: Record<Role, string>; addresses: Record<Role, string>; frontendOrigin: string; hostedPort: number }
interface State { version: 1; binding: string; startedAt: string; deadline: number; faucets: Partial<Record<Role, { intentAt: string; result?: unknown; confirmed?: boolean }>>; contracts?: TempoHostedBootstrap["contracts"]; deploymentBlock?: number; agents: Partial<Record<Role, string>>; tasks: TempoHostedBootstrap["tasks"]; completedAt?: string }
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (code: string): never => { throw new Error(code); };
async function privateText(path: string) {
  if (!isAbsolute(path)) fail("TEMPO_ABSOLUTE_PRIVATE_FILE_REQUIRED");
  const m = await stat(path);
  if (!m.isFile() || (m.mode & 0o777) !== 0o600 || process.getuid && m.uid !== process.getuid()) fail("TEMPO_PRIVATE_FILE_REQUIRED");
  return (await readFile(path, "utf8")).trim();
}

/** Generates isolated role keys; no old deployment, chain journal or wallet is imported. */
export async function initializeTempoBootstrap(directory: string, vendorKeyFile: string, gatewayReadyFile: string) {
  directory = resolve(directory); vendorKeyFile = resolve(vendorKeyFile); gatewayReadyFile = resolve(gatewayReadyFile);
  const vendorKey = await privateText(vendorKeyFile);
  if (!vendorKey || /\s/.test(vendorKey)) fail("TEMPO_VENDOR_KEY_INVALID");
  await mkdir(directory, { mode: 0o700 }); // Existing directories require the original plan and deploy/recover.
  await chmod(directory, 0o700);
  const keyFiles = {} as Record<Role, string>, addresses = {} as Record<Role, string>;
  for (const role of roles) {
    const wallet = Wallet.createRandom(); keyFiles[role] = join(directory, `${role}.key`); addresses[role] = wallet.address;
    await writeFile(keyFiles[role], wallet.privateKey + "\n", { flag: "wx", mode: 0o600 });
  }
  const newVendorKey = join(directory, "vendor.key"); await writeFile(newVendorKey, vendorKey + "\n", { flag: "wx", mode: 0o600 });
  const rpcUrlFile = join(directory, "rpc-url"); await writeFile(rpcUrlFile, TEMPO_RPC_URL + "\n", { flag: "wx", mode: 0o600 });
  const plan: Plan = { version: 1, chainId: "42431", directory, createdAt: new Date().toISOString(), rpcUrlFile, vendorKeyFile: newVendorKey,
    gatewayReadyFile, keyFiles, addresses, frontendOrigin: "http://127.0.0.1:3028", hostedPort: 8794 };
  await atomicJson(join(directory, "plan.json"), plan);
  await atomicJson(join(directory, "model-upstream.json"), { upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6", apiKeyFile: newVendorKey } });
  return { initialized: true, chainId: "42431", directory, addresses, modelRequests: 0, transactions: 0 };
}

/** Explicit testnet-only faucet, deployments and catalog. All signed writes use one durable journal. */
export async function deployTempoBootstrap(directory: string, recover = false) {
  directory = resolve(directory);
  const lock = new SessionStore(join(directory, "bootstrap-writer")); await lock.start(recover);
  try { return await deployLockedTempoBootstrap(directory); }
  finally { await lock.close(); }
}
async function deployLockedTempoBootstrap(directory: string) {
  const plan = JSON.parse(await privateText(join(directory, "plan.json"))) as Plan;
  if (plan.version !== 1 || plan.chainId !== "42431" || plan.directory !== directory || Object.keys(plan.addresses).sort().join() !== [...roles].sort().join()) fail("TEMPO_PLAN_INVALID");
  const connection = await chainRpcProvider(await readRpcUrlFile(plan.rpcUrlFile), TEMPO_CHAIN_ID, "direct");
  const provider = connection.provider;
  try {
    const preflight = await tempoPreflight(provider);
    await atomicJson(join(directory, "preflight.json"), preflight);
    const wallets = {} as Record<Role, Wallet>;
    for (const role of roles) {
      wallets[role] = new Wallet(await privateText(plan.keyFiles[role]), provider);
      if (wallets[role].address !== getAddress(plan.addresses[role])) fail("TEMPO_ROLE_KEY_CHANGED");
    }
    if (new Set(Object.values(plan.addresses).map(getAddress)).size !== roles.length) fail("TEMPO_ROLE_ISOLATION_REQUIRED");
    let state: State;
    try { state = JSON.parse(await privateText(join(directory, "bootstrap-state.json"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; state = { version: 1, binding: hash(plan), startedAt: new Date().toISOString(), deadline: Math.floor(Date.now() / 1000) + 3 * 86400, faucets: {}, agents: {}, tasks: [] }; }
    if (state.version !== 1 || state.binding !== hash(plan)) fail("TEMPO_BOOTSTRAP_BINDING_CHANGED");
    const save = () => atomicJson(join(directory, "bootstrap-state.json"), state);
    await save();
    const token = new Contract(TEMPO_PATH_USD, ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)"], provider);
    const journal = new DemoJournal(provider, join(directory, "transactions.json")); await journal.load();
    const receipts: Record<string, unknown> = {};
    const operation = async (id: string, role: Role, contract: Contract, method: string, args: unknown[]) => {
      if (!journal.has(id)) {
        const request = await contract.getFunction(method).populateTransaction(...args) as TransactionRequest;
        await journal.send(id, wallets[role], request);
      }
      const receipt = await journal.receipt(id); receipts[id] = receipt.toJSON();
      console.log(JSON.stringify({ operation: id, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: String(receipt.gasUsed) }));
      return receipt;
    };
    for (const role of roles) {
      if (state.faucets[role]?.confirmed) continue;
      const balance = await token.balanceOf(wallets[role].address);
      if (balance < 10_000_000n) {
        if (state.faucets[role]?.intentAt && !state.faucets[role]?.result) fail("TEMPO_FAUCET_UNKNOWN_INSPECT_ORIGINAL_ADDRESS");
        if (!state.faucets[role]?.result) {
          state.faucets[role] = { intentAt: new Date().toISOString() }; await save();
          state.faucets[role]!.result = await provider.send("tempo_fundAddress", [wallets[role].address]); await save();
        }
      }
      const fundedBy = Date.now() + 20000;
      while (await token.balanceOf(wallets[role].address) < 10_000_000n && Date.now() < fundedBy) await delay(300);
      if (await token.balanceOf(wallets[role].address) < 10_000_000n) fail("TEMPO_FAUCET_PATH_USD_INSUFFICIENT");
      state.faucets[role] = { intentAt: state.faucets[role]?.intentAt ?? new Date().toISOString(), ...state.faucets[role], confirmed: true }; await save();
    }
    const deploy = async (name: string, args: unknown[]) => {
      const id = `deploy-${name}`;
      if (!journal.has(id)) {
        const a = await artifact(name);
        const request = await new ContractFactory(a.abi, a.bytecode.object).getDeployTransaction(...args);
        await journal.send(id, wallets.deployer, request);
      }
      const receipt = await journal.receipt(id); receipts[id] = receipt.toJSON();
      if (!receipt.contractAddress || await provider.getCode(receipt.contractAddress) === "0x") fail("TEMPO_DEPLOYMENT_CODE_REQUIRED");
      state.deploymentBlock ??= receipt.blockNumber; await save();
      console.log(JSON.stringify({ operation: id, address: receipt.contractAddress, txHash: receipt.hash, gasUsed: String(receipt.gasUsed) }));
      return receipt.contractAddress!;
    };
    if (!state.contracts) {
      const adapter = await deploy("ERC8004Adapter", [TEMPO_IDENTITY, TEMPO_REPUTATION, wallets.deployer.address]);
      const manager = await deploy("CreditManager", [{ settlementAsset: TEMPO_PATH_USD, adapter, underwriter: wallets.underwriter.address, treasury: wallets.deployer.address,
        guardian: wallets.guardian.address, relayRefunder: wallets.refunder.address, owner: wallets.deployer.address, maxLtvBps: 8000, grace: 3600 }]);
      const account = await deploy("AgentAccount", [TEMPO_PATH_USD, adapter, wallets.deployer.address]);
      const escrow = await deploy("TaskEscrow", [TEMPO_PATH_USD, adapter, wallets.verifier.address, wallets.deployer.address, 0, wallets.deployer.address]);
      state.contracts = { manager, adapter, account, escrow }; await save();
    }
    const addresses = state.contracts ?? fail("TEMPO_CONTRACTS_REQUIRED");
    const c = {} as Record<keyof typeof addresses, Contract>;
    for (const [kind, name] of Object.entries({ manager: "CreditManager", adapter: "ERC8004Adapter", account: "AgentAccount", escrow: "TaskEscrow" }))
      c[kind as keyof typeof addresses] = new Contract(addresses[kind as keyof typeof addresses], (await artifact(name)).abi, provider);
    await operation("wire-manager", "deployer", c.manager, "setProtocolContracts", [addresses.account, addresses.escrow]);
    await operation("wire-account", "deployer", c.account, "setProtocolContracts", [addresses.manager, addresses.escrow]);
    await operation("wire-escrow", "deployer", c.escrow, "setProtocolContracts", [addresses.manager, addresses.account]);
    await operation("wire-adapter", "deployer", c.adapter, "setCreditManager", [addresses.manager]);
    await operation("wire-reporter", "deployer", c.adapter, "setReporter", [addresses.escrow, true]);
    await operation("limits", "deployer", c.manager, "setGlobalLimits", [50_000_000n, 20_000_000n]);
    await operation("provider-whitelist", "deployer", c.account, "setProviderWhitelist", [wallets.refunder.address, true]);
    await operation("treasury-approve", "deployer", token, "approve", [addresses.manager, 10_000_000n]);
    await operation("treasury-deposit", "deployer", c.manager, "deposit", [10_000_000n]);
    const identity = new IdentityRegistry({ provider, address: TEMPO_IDENTITY, expectedChainId: TEMPO_CHAIN_ID });
    const identityContract = new Contract(TEMPO_IDENTITY, IDENTITY_ABI, provider);
    for (const role of ["opponent", "dashboardA", "dashboardB"] as const) {
      const uri = `urn:agentfuel-tempo:${hash(plan).slice(0, 16)}:${role}`;
      const receipt = await operation(`register-${role}`, role, identityContract, "register(string)", [uri]);
      state.agents[role] = String(registrationFromReceipt(receipt, TEMPO_IDENTITY, wallets[role].address, uri).agentId); await save();
      const agentId = BigInt(state.agents[role]!);
      const bind = `bind-${role}`;
      if (!journal.has(bind)) {
        const consent = await identity.signWalletConsent(wallets[role], agentId);
        await identity.bindWallet(journal.signer(bind, wallets[role]), consent);
      }
      receipts[bind] = (await journal.receipt(bind)).toJSON();
      await operation(`enroll-${role}`, "guardian", c.manager, "enrollAgent", [agentId]);
    }
    await operation("poster-approve", "poster", token, "approve", [addresses.escrow, 150000n * 8n]);
    const problems = ["sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"] as const;
    for (let i = 0; i < 8; i++) {
      const receipt = await operation(`task-${i}`, "poster", c.escrow, "createTask", [150000n, state.deadline]);
      const event = receipt.logs.filter(log => getAddress(log.address) === addresses.escrow).map(log => { try { return c.escrow.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === "TaskCreated");
      if (!event) fail("TEMPO_TASK_CREATED_EVENT_REQUIRED");
      const task = { taskId: String(event!.args.taskId), problemId: problems[i % 4], deadlineMs: state.deadline * 1000, creditLimit: "80000" };
      if (state.tasks[i] && JSON.stringify(state.tasks[i]) !== JSON.stringify(task)) fail("TEMPO_TASK_BINDING_CHANGED");
      state.tasks[i] = task; await save();
    }
    const fee = await provider.getFeeData(), feeCeiling = (fee.maxFeePerGas ?? fee.gasPrice ?? 1n) * 3n;
    const bootstrap: TempoHostedBootstrap = { version: 1, chainId: "42431", contracts: addresses, deploymentBlock: state.deploymentBlock!, asset: TEMPO_ASSET,
      identity: TEMPO_IDENTITY, reputation: TEMPO_REPUTATION, payTo: wallets.refunder.address, publicRpcUrl: TEMPO_RPC_URL, rpcUrlFile: plan.rpcUrlFile, rpcTransport: "direct",
      roleKeyFiles: { guardian: plan.keyFiles.guardian, underwriter: plan.keyFiles.underwriter, verifier: plan.keyFiles.verifier, refunder: plan.keyFiles.refunder, sponsor: plan.keyFiles.sponsor, opponent: plan.keyFiles.opponent },
      opponentBinding: { chainId: "42431", agentId: state.agents.opponent!, wallet: wallets.opponent.address },
      dashboardAgents: ["opponent", "dashboardA", "dashboardB"].map(role => ({ id: state.agents[role as Role]!, name: `Tempo ${role}` })), gatewayReadyFile: plan.gatewayReadyFile,
      vendorKeyFile: plan.vendorKeyFile, tasks: state.tasks, maxFeePerGas: String(feeCeiling), frontendOrigin: plan.frontendOrigin, hostedPort: plan.hostedPort };
    await atomicJson(join(directory, "bootstrap.json"), bootstrap);
    state.completedAt = new Date().toISOString(); await save();
    const report = { completed: true, chainId: "42431", preflight, addresses, roles: plan.addresses, tasks: state.tasks, dashboardAgents: bootstrap.dashboardAgents,
      receipts, maxFeePerGas: String(feeCeiling), settlementAsset: TEMPO_ASSET, explorerUrl: TEMPO_EXPLORER_URL,
      feedbackGasLimit: String(await c.adapter.feedbackGasLimit()), inferenceRequests: 0, newWalletsOnly: true, gasSponsorship: false };
    await atomicJson(join(directory, "deployment-evidence.json"), report); return report;
  } finally { connection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory, vendorKeyFile, gatewayReadyFile] = process.argv.slice(2);
  const task = mode === "init" && directory && vendorKeyFile && gatewayReadyFile ? initializeTempoBootstrap(directory, vendorKeyFile, gatewayReadyFile)
    : mode === "deploy" && directory && (!vendorKeyFile || vendorKeyFile === "--recover") ? deployTempoBootstrap(directory, vendorKeyFile === "--recover") : Promise.reject(new Error("Usage: tempo-bootstrap.ts init DIRECTORY VENDOR_KEY_FILE GATEWAY_READY_FILE | deploy DIRECTORY [--recover]"));
  task.then(result => console.log(json("receipts" in result ? { completed: result.completed, chainId: result.chainId, contracts: result.addresses,
    taskCount: result.tasks.length, evidenceFile: join(resolve(directory), "deployment-evidence.json") } : result)))
    .catch(e => { console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message) ? e.message : "TEMPO_BOOTSTRAP_FAILED"); console.error(JSON.stringify({ code: e.code, rpcCode: e.info?.error?.code })); process.exitCode = 1; });
}
