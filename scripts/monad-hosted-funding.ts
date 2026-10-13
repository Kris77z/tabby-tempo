import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract, Interface, Wallet, getAddress, type TransactionRequest } from "ethers";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { DemoJournal } from "./demo-journal.js";
import { saveJson, artifact, reportDemoFailure } from "./demo-common.js";
import { readSecret } from "./demo-monad-config.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";

const root = resolve("demo-output/monad-hosted-20261012");
const privateRoot = "/Users/jungle/.config/agentfuel/monad-demo-20261002T011344Z-4df31740";
const rpcUrlFile = "/Users/jungle/.config/agentfuel/alchemy-b59e30385b32/rpc-url";
const sourceKeyFile = "/Users/jungle/.config/agentfuel/monad-distributor-20261002T021114Z-7beabf5d/distributor.key";
const sourceAddress = "0x48aEd9c702B97A18A520edA3BB04d959453f0B80";
const managementAddress = "0x752EAb56684458CF5e0F55532B4Bd9BeD090885f";
const maxFee = 250000000000n;
async function context() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const connection = await monadProvider(await readRpcUrlFile(rpcUrlFile), "direct");
  assert.equal(BigInt(await connection.provider.send("eth_chainId", [])), 10143n);
  const source = new Wallet(await readSecret(sourceKeyFile), connection.provider);
  const management = new Wallet(await readSecret(join(privateRoot, "management.key")), connection.provider);
  assert.equal(source.address, sourceAddress); assert.equal(management.address, managementAddress);
  const manifest = JSON.parse(await readFile("demo-output/monad-20261002-deployment-89b14f6d/manifest.json", "utf8"));
  const token = new Contract(manifest.asset.address, ["function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"], connection.provider);
  const journal = new DemoJournal(connection.provider, join(root, "funding-transactions.json")); await journal.load();
  const intentsFile = join(root, "funding-intents.json");
  let intents: Record<string, any> = {};
  try { intents = JSON.parse(await readFile(intentsFile, "utf8")); } catch (e: any) { if(e.code !== "ENOENT") throw e; }
  async function send(id: string, wallet: Wallet, request: TransactionRequest, gasLimit: bigint) {
    const intent = { from: wallet.address, to: request.to, data: request.data ?? "0x", value: String(request.value ?? 0), gasCeiling: String(gasLimit) };
    if (intents[id]) assert.deepEqual(intents[id], intent, "FUNDING_INTENT_CHANGED");
    else { intents[id] = intent; await saveJson(intentsFile, intents); }
    if (!journal.has(id)) {
      assert.equal(await connection.provider.getTransactionCount(wallet.address, "latest"), await connection.provider.getTransactionCount(wallet.address, "pending"), "UNCONFIRMED_ROLE_TRANSACTION");
      const fee = await connection.provider.getFeeData(); assert.ok(fee.maxFeePerGas && fee.maxFeePerGas <= maxFee, "FEE_CEILING_EXCEEDED");
      const estimate = await connection.provider.estimateGas({ ...request, from: wallet.address });
      const requiredGas = estimate === 21000n ? estimate : (estimate * 13n + 9n) / 10n;
      assert.ok(requiredGas <= gasLimit, "GAS_CEILING_EXCEEDED");
      await journal.send(id, wallet, { ...request, gasLimit: requiredGas, maxFeePerGas: maxFee, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 2000000000n });
    }
    const receipt = await journal.receipt(id);
    console.log(JSON.stringify({ operation: id, txHash: receipt.hash, block: receipt.blockNumber, status: receipt.status }));
    return receipt;
  }
  return { connection, source, management, manifest, token, send, hasTransaction: (id: string) => journal.has(id) };
}
export async function setupMonadHosted() {
  const c = await context();
  try {
    const planFile = join(root, "setup-plan.json");
    let plan: any;
    try { plan = JSON.parse(await readFile(planFile, "utf8")); }
    catch (e: any) { if(e.code !== "ENOENT") throw e; plan = { version: 1, deadline: Math.floor(Date.now()/1000)+14400, rewardRaw: "150000", problemIds: ["sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"], tasks: [] }; await saveJson(planFile, plan); }
    // The original 100k-gas transfer is confirmed reverted; preserve its receipt and journal.
    const failed = await c.connection.provider.getTransactionReceipt("0x4526c26922b4d69997919fd53c3a74461653e75d08ec685f1689ae2eaa4fb5ff");
    assert.equal(failed?.status, 0, "ORIGINAL_TRANSFER_REVERT_MUST_BE_CONFIRMED");
    await c.send("fund-management-test-usdc-730000-gas-corrected", c.source, await c.token.transfer.populateTransaction(c.management.address, 730000n), 2000000n);
    await c.send("fund-independent-verifier-mon-0.5", c.source, { to: "0x2481251a15b8Ed31e158aA0C561295f9A05D0CF6", value: 500000000000000000n }, 21000n);
    await c.send("approve-four-rewards-600000", c.management, await c.token.approve.populateTransaction(c.manifest.contracts.escrow, 600000n), 2000000n);
    const escrow = new Contract(c.manifest.contracts.escrow, (await artifact("TaskEscrow")).abi, c.connection.provider);
    for (let i = 0; i < 4; i++) {
      const receipt = await c.send(`create-task-${i}`, c.management, await escrow.createTask.populateTransaction(150000n, plan.deadline), 2000000n);
      const event = receipt.logs.filter(log => getAddress(log.address) === getAddress(c.manifest.contracts.escrow)).map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === "TaskCreated");
      assert.ok(event, "TASK_CREATED_EVENT_REQUIRED");
      const task = { taskId: String(event.args.taskId), problemId: plan.problemIds[i], deadlineMs: plan.deadline * 1000, creditLimit: "80000" };
      if (plan.tasks[i]) assert.deepEqual(plan.tasks[i], task); else { plan.tasks[i] = task; await saveJson(planFile, plan); }
    }
    const bootstrap = { version:1, chainId:"10143", contracts:c.manifest.contracts, deploymentBlock:c.manifest.deploymentBlock,
      asset:c.manifest.asset, identity:"0x8004A818BFB912233c491871b3d84c89A494BD9e", payTo:c.management.address,
      publicRpcUrl:"https://testnet-rpc.monad.xyz", rpcUrlFile, rpcTransport:"direct", dashboardAgents:c.manifest.agents,
      roleKeyFiles:{ guardian:join(privateRoot,"management.key"), underwriter:join(privateRoot,"underwriter.key"), verifier:join(privateRoot,"verifier.key"), refunder:join(privateRoot,"management.key"), sponsor:join(privateRoot,"management.key"), opponent:"/Users/jungle/.config/agentfuel/holdem-20261004/player-1.key" },
      opponentBinding:{chainId:"10143",agentId:"1999",wallet:"0x5C08F50F20609E4CF4ccD2Caf185F03F9BF09ceD"},
      gatewayReadyFile:resolve("demo-output/local-hosted-20261012/gateway/ready.json"), vendorKeyFile:join(privateRoot,"kimi.key"),
      tasks:plan.tasks, maxFeePerGas:String(maxFee), frontendOrigin:"http://127.0.0.1:3024" };
    await saveJson(join(root,"bootstrap.json"),bootstrap);
    console.log(JSON.stringify({setupComplete:true,tasks:plan.tasks}));
  } finally { c.connection.close(); }
}
/** One additional escrow reward for the separately observed game-credit task. */
export async function setupMonadGameTask() {
  const c = await context();
  try {
    const escrow = new Contract(c.manifest.contracts.escrow, (await artifact("TaskEscrow")).abi, c.connection.provider);
    for (const id of [12,13,14,15]) assert.equal((await escrow.getTask(id)).status, 3n, "COMPLETE_PRIMARY_ACCEPTANCE_FIRST");
    const file = join(root,"game-task-plan.json"); let plan: any;
    try { plan=JSON.parse(await readFile(file,"utf8")); }
    catch(e:any){if(e.code!=="ENOENT")throw e; assert.equal(await escrow.nextTaskId(),16n); plan={version:1,deadline:Math.floor(Date.now()/1000)+14400,problemId:"sum-integers"}; await saveJson(file,plan);}
    await c.send("approve-game-task-reward-150000",c.management,await c.token.approve.populateTransaction(c.manifest.contracts.escrow,150000n),2000000n);
    const receipt=await c.send("create-game-task-16",c.management,await escrow.createTask.populateTransaction(150000n,plan.deadline),2000000n);
    const event=receipt.logs.filter(log=>getAddress(log.address)===getAddress(c.manifest.contracts.escrow)).map(log=>{try{return escrow.interface.parseLog(log)}catch{return null}}).find(log=>log?.name==="TaskCreated");
    assert.ok(event); assert.equal(String(event.args.taskId),"16");
    const task={taskId:"16",problemId:plan.problemId,deadlineMs:plan.deadline*1000,creditLimit:"80000"};
    await saveJson(join(root,"game-task-addition.json"),[task]); console.log(JSON.stringify({gameTaskCreated:true,task}));
  }finally{c.connection.close();}
}
/** A failed, fully compensated task must be closed before funding a distinct continuation. */
async function requireCompensatedTask(c: Awaited<ReturnType<typeof context>>) {
  const escrow = new Contract(c.manifest.contracts.escrow, (await artifact("TaskEscrow")).abi, c.connection.provider);
  const manager = new Contract(c.manifest.contracts.manager, (await artifact("CreditManager")).abi, c.connection.provider);
  const [task, loan] = await Promise.all([escrow.getTask(14), manager.getLoan(14)]);
  assert.equal(task.status, 4n, "TASK_14_MUST_BE_FAILED"); assert.equal(task.agentId, 2202n, "TASK_14_AGENT_CHANGED");
  assert.equal(loan.status, 4n, "TASK_14_MUST_BE_CLOSED_BY_REFUND"); assert.equal(loan.agentId, 2202n);
  assert.equal(loan.principal, 0n); assert.equal(loan.fee, 0n); assert.equal(task.escrowBalance, 0n);
  return escrow;
}
/** Adds the explicitly staged task 16 or 17; all prior deadlines and funding intents remain bound. */
export async function setupMonadContinuationTask(stage: "continuation" | "completion" = "continuation") {
  const taskId = stage === "continuation" ? "16" : "17", predecessor = Number(taskId) - 1;
  const problemId = stage === "continuation" ? "sum-integers" : "unique-sorted";
  const lock = new SessionStore<Record<string, unknown>>(join(root, "continuation-funding-lock")); await lock.start(true);
  let c: Awaited<ReturnType<typeof context>> | undefined;
  try {
    c = await context(); const escrow = await requireCompensatedTask(c);
    const file = join(root, `${stage}-task-plan.json`), operation = `create-${stage}-task-${taskId}`;
    let plan: { version: number; taskId: string; problemId: string; deadline: number; rewardRaw: string; creditLimit: string; escrow: string; asset: string; poster: string };
    try { plan = JSON.parse(await readFile(file, "utf8")); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      assert.equal(await escrow.nextTaskId(), BigInt(taskId), "CONTINUATION_TASK_ID_CHANGED");
      plan = { version: 1, taskId, problemId, deadline: Math.floor(Date.now() / 1000) + 14400, rewardRaw: "150000", creditLimit: "80000",
        escrow: getAddress(c.manifest.contracts.escrow), asset: getAddress(c.manifest.asset.address), poster: c.management.address };
      await saveJson(file, plan);
    }
    assert.equal(plan.version, 1); assert.equal(plan.taskId, taskId); assert.equal(plan.problemId, problemId); assert.equal(plan.rewardRaw, "150000"); assert.equal(plan.creditLimit, "80000");
    assert.equal(plan.escrow, getAddress(c.manifest.contracts.escrow)); assert.equal(plan.asset, getAddress(c.manifest.asset.address)); assert.equal(plan.poster, c.management.address);
    assert.ok(Number.isSafeInteger(plan.deadline));
    if (!c.hasTransaction(operation)) {
      for (const id of stage === "completion" ? [12, 13, 15] : [12, 13]) assert.equal((await escrow.getTask(id)).status, 3n, "PRIMARY_TASK_MUST_BE_SETTLED");
      const next = await escrow.getTask(predecessor); assert.equal(next.status, 1n, "NEXT_TASK_MUST_BE_OPEN"); assert.equal(next.agentId, 0n, "NEXT_TASK_ALREADY_ASSIGNED");
      assert.equal(await escrow.nextTaskId(), BigInt(taskId), "CONTINUATION_TASK_ID_CHANGED");
      const block = await c.connection.provider.getBlock("latest"); assert.ok(block);
      assert.ok(plan.deadline > Math.max(block.timestamp, Math.floor(Date.now() / 1000)) + 300, "CONTINUATION_DEADLINE_EXPIRED");
      assert.ok(await c.token.balanceOf(c.management.address) >= 150000n, "MANAGEMENT_TEST_USDC_INSUFFICIENT");
      await c.send(`approve-${stage}-task-reward-150000`, c.management, await c.token.approve.populateTransaction(plan.escrow, 150000n), 2000000n);
    }
    const receipt = await c.send(operation, c.management, await escrow.createTask.populateTransaction(150000n, plan.deadline), 2000000n);
    assert.equal((await c.connection.provider.getBlock(receipt.blockNumber))?.hash, receipt.blockHash, "CONTINUATION_RECEIPT_NOT_CANONICAL");
    const events = receipt.logs.filter(log => getAddress(log.address) === plan.escrow).flatMap(log => { try { const event = escrow.interface.parseLog(log); return event?.name === "TaskCreated" ? [event] : []; } catch { return []; } });
    assert.equal(events.length, 1); assert.equal(events[0].args.taskId, BigInt(taskId));
    const created = await escrow.getTask(taskId); assert.equal(getAddress(created.poster), c.management.address); assert.equal(created.reward, 150000n); assert.equal(created.deadline, BigInt(plan.deadline));
    const task = { taskId, problemId, deadlineMs: plan.deadline * 1000, creditLimit: "80000" };
    await saveJson(join(root, `${stage}-task-addition.json`), [task]);
    console.log(JSON.stringify({ continuationTaskCreated: true, task, txHash: receipt.hash }));
  } finally { c?.connection.close(); await lock.close(); }
}
/** One journaled test top-up per stage (10,000 or 2,000 units); frontend deposit is a separate operation. */
export async function fundMonadContinuationCash(stage: "continuation" | "completion" = "continuation") {
  const raw = stage === "continuation" ? 10000n : 2000n;
  const lock = new SessionStore<Record<string, unknown>>(join(root, "continuation-funding-lock")); await lock.start(true);
  let c: Awaited<ReturnType<typeof context>> | undefined;
  try {
    c = await context(); await requireCompensatedTask(c);
    const acceptance = JSON.parse(await readFile(join(root, "runtime", "acceptance.json"), "utf8"));
    const wallet = getAddress(acceptance.agents.autonomy.agent.wallet), operation = `fund-autonomy-${stage}-usdc-${raw}`;
    const adapter = new Contract(c.manifest.contracts.adapter, ["function resolveAgent(uint256) view returns(address owner,address wallet)"], c.connection.provider);
    assert.equal(getAddress((await adapter.resolveAgent(2202)).wallet), wallet, "CONTINUATION_WALLET_CHANGED");
    if (!c.hasTransaction(operation)) assert.ok(await c.token.balanceOf(c.management.address) >= raw, "MANAGEMENT_TEST_USDC_INSUFFICIENT");
    const receipt = await c.send(operation, c.management, await c.token.transfer.populateTransaction(wallet, raw), 2000000n);
    assert.equal((await c.connection.provider.getBlock(receipt.blockNumber))?.hash, receipt.blockHash, "CONTINUATION_RECEIPT_NOT_CANONICAL");
    const iface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const transfers = receipt.logs.filter(log => getAddress(log.address) === getAddress(c!.manifest.asset.address)).flatMap(log => { try { const event = iface.parseLog(log); return event ? [event] : []; } catch { return []; } });
    assert.ok(transfers.some(event => getAddress(event.args.from) === c!.management.address && getAddress(event.args.to) === wallet && event.args.value === raw), "CONTINUATION_TRANSFER_UNCONFIRMED");
    console.log(JSON.stringify({ continuationCashFunded: true, wallet, amountRaw: String(raw), txHash: receipt.hash }));
  } finally { c?.connection.close(); await lock.close(); }
}
/** Operator-only acceptance funding; never a product faucet or gas sponsorship. */
export async function fundMonadHostedWallet(directory: string, label: string, wallet: string, raw: string) {
  assert.equal(dirname(resolve(directory)), root); assert.equal(resolve(directory),join(root,"runtime"));
  const amounts: Record<string,string> = {cheap:"40000",strong:"40000",autonomy:"50000"};
  assert.equal(raw,amounts[label]); assert.ok(Object.hasOwn(amounts,label)); getAddress(wallet);
  const acceptance = JSON.parse(await readFile(join(directory,"acceptance.json"),"utf8"));
  assert.equal(getAddress(acceptance.agents[label].agent.wallet),getAddress(wallet));
  const c = await context();
  try {
    await c.send(`fund-${label}-mon-0.6`,c.source,{to:wallet,value:600000000000000000n},200000n);
    await c.send(`fund-${label}-usdc-${raw}`,c.management,await c.token.transfer.populateTransaction(wallet,BigInt(raw)),2000000n);
  } finally { c.connection.close(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const modes: Record<string, () => Promise<void>> = { setup: setupMonadHosted, "game-task": setupMonadGameTask, "continuation-task": setupMonadContinuationTask, "continuation-cash": fundMonadContinuationCash, "completion-task": () => setupMonadContinuationTask("completion"), "completion-cash": () => fundMonadContinuationCash("completion") };
  if (!Object.hasOwn(modes, process.argv[2])) throw new Error("Usage: monad-hosted-funding.ts setup|game-task|continuation-task|continuation-cash|completion-task|completion-cash");
  modes[process.argv[2]]().catch(error=>{reportDemoFailure(error);process.exitCode=1;});
}
