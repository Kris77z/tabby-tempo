import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {validateHostedActivity,type HostedActivityInput} from "../src/scene-types.js";
import { Transaction, Wallet } from "ethers";
import { HostedTaskExecutor, loadHostedTaskExecutorConfig, validateHostedTaskExecutorConfig } from "../src/task-executor.js";
import { createHostedTaskFixture } from "./task-fixture.js";
import { key, read, tx } from "../../underwriter/test/fixture.js";

test("unconfigured Agent provisions and deposits with zero spending/debt policy and no model calls", { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-unconfigured-"))), fx = await createHostedTaskFixture(directory);
  try {
    const actor = await fx.actor(20);
    Object.assign(actor.agent, { configurationRequired: true, modelId: "", perRunBudgetRaw: "0", totalBudgetRaw: "0", allowCredit: false });
    const executor = new HostedTaskExecutor({ ...fx.config, initialCashRaw: "0" }, { provider: fx.fx.f.provider });
    const provision = actor.input("provision"), result = await executor.execute(provision);
    assert.equal(result.phase, "Ready", JSON.stringify(result)); assert.ok(result.binding);
    actor.agent.binding = result.binding;
    assert.deepEqual(await executor.execute({ ...provision, recover: true }), result);
    const policy = await read(fx.fx.f.account, "getPolicy", [result.binding!.agentId]);
    assert.equal(policy.maxCashPerTx, 0n); assert.equal(policy.maxDebtPerTx, 0n); assert.equal(policy.maxDebtPerDay, 0n);
    const deposit = actor.input("deposit"); deposit.run.amountRaw = "40000";
    const deposited = await executor.execute(deposit);
    assert.equal(deposited.success, true, JSON.stringify(deposited));
    assert.equal(await read(fx.fx.f.account, "cash", [result.binding!.agentId]), 40000n);
    await assert.rejects(executor.execute(actor.input("task")), /HOSTED_CONFIGURATION_REQUIRED/);
    assert.equal(fx.fx.calls.length, 0);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("two hosted agents register/enroll independent wallets and run the real fixed B workflow under independent budgets/models", { timeout: 120000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-task-"))), fx = await createHostedTaskFixture(directory);
  try {
    const cheap = await fx.actor(20), strong = await fx.actor(21, "strong");
    const firstInput = cheap.input("provision"), secondInput = strong.input("provision");
    const first = await fx.executor.execute(firstInput), second = await fx.executor.execute(secondInput);
    assert.equal(first.phase, "Ready", JSON.stringify(first)); assert.equal(second.phase, "Ready", JSON.stringify(second));
    assert.deepEqual([first.binding?.agentId, second.binding?.agentId], ["2", "3"]);
    assert.notEqual(first.binding?.wallet, second.binding?.wallet);
    assert.equal(await read(fx.fx.f.identity, "ownerOf", ["2"]), cheap.wallet.address); assert.equal(await read(fx.fx.f.identity, "getAgentWallet", ["3"]), strong.wallet.address);
    assert.equal(await read(fx.fx.f.adapter, "snapshotVersion", ["2"]), 1n); assert.equal(await read(fx.fx.f.adapter, "snapshotVersion", ["3"]), 1n);
    assert.deepEqual([await read(fx.fx.f.account, "cash", ["2"]), await read(fx.fx.f.account, "cash", ["3"])], [40000n, 40000n]);
    cheap.agent.binding = first.binding; strong.agent.binding = second.binding;
    // A user's smaller budget cannot buy this 120000 service or consume another Agent's cash.
    const tooSmall = strong.input("task", { perRunBudgetRaw: "119999" });
    const rejected = await fx.executor.execute(tooSmall); assert.equal(rejected.phase, "Stopped"); assert.equal(rejected.reason, "NO_FEASIBLE_CANDIDATE"); assert.equal(rejected.chargedRaw, "0");
    assert.equal(fx.fx.calls.length, 0); assert.equal(await fx.fx.f.providerBalance(), 0n);
    assert.equal((await read(fx.fx.f.account, "getPolicy", ["3"])).maxDebtPerTx, 119999n);
    fx.fx.queue(fx.GOOD_CODE["sum-integers"]);
    const task = cheap.input("task"),activities:HostedActivityInput[]=[];task.activity=async e=>{activities.push(validateHostedActivity(e));};
    const delivered = await fx.executor.execute(task);
    assert.ok(activities.some(e=>e.scene==="task"&&e.state==="selected"));assert.ok(activities.some(e=>e.scene==="task"&&e.state==="waiting"&&e.evidence?.acceptTxHash));assert.ok(activities.some(e=>e.scene==="credit"&&e.state==="confirmed"&&e.evidence?.fromCreditRaw==="80000"));assert.ok(activities.some(e=>e.scene==="review"&&e.state==="waiting"));assert.ok(activities.some(e=>e.scene==="settlement"&&e.state==="confirmed"&&e.evidence?.txHash===delivered.settlement?.txHash));
    assert.equal(delivered.phase, "Succeeded", JSON.stringify(delivered)); assert.equal(delivered.terminal, true); assert.equal(delivered.chargedRaw, "120000"); assert.equal(delivered.principalRaw, "0"); assert.equal(delivered.feeRaw, "0");
    assert.equal(fx.fx.calls.length, 1); assert.equal(fx.fx.calls[0].model, "controlled-cheap");
    assert.equal((await read(fx.fx.f.manager, "getLoan", [delivered.taskId!])).status, 2n);
    assert.equal((await read(fx.fx.f.escrow, "getTask", [delivered.taskId!])).agentId, 2n);
    assert.equal(await read(fx.fx.f.account, "cash", ["3"]), 40000n);
    const before = await fx.fx.f.provider.getTransactionCount(cheap.wallet.address);
    assert.deepEqual(await fx.executor.execute({ ...task, recover: true }), delivered); assert.equal(fx.fx.calls.length, 1); assert.equal(await fx.fx.f.provider.getTransactionCount(cheap.wallet.address), before);
    fx.fx.queue(fx.GOOD_CODE["unique-sorted"]);
    const otherTask = strong.input("task"), otherDelivered = await fx.executor.execute(otherTask);
    assert.equal(otherDelivered.phase, "Succeeded", JSON.stringify(otherDelivered)); assert.equal(otherDelivered.chargedRaw, "120000"); assert.equal(fx.fx.calls.length, 2); assert.equal(fx.fx.calls[1].model, "controlled-strong");
    assert.equal((await read(fx.fx.f.escrow, "getTask", [otherDelivered.taskId!])).agentId, 3n);
    const ledger = JSON.parse(await readFile(join(task.directory, "task-executor", "session.json"), "utf8"));
    assert.equal(ledger.snapshot.workflow.agentId, "2"); assert.equal(ledger.snapshot.workflow.maxPrice, "120000"); assert.equal(ledger.snapshot.workflow.allowCredit, true);
    assert.equal((await read(fx.fx.f.account, "getPolicy", ["3"])).maxDebtPerTx, 120000n);
    for (const secret of [key(20), key(1), fx.fx.local.rpc, fx.config.arenaUrl, fx.config.models[0].templates.balanced.providers[0].relayUrl]) assert.equal(JSON.stringify(delivered).includes(secret), false);
    // Catalog/settings changes do not rewrite an existing successful request's snapshot or buy it again.
    const changed = structuredClone(fx.config); changed.models[0].templates.balanced.maxPrice = "1";
    assert.deepEqual(await new HostedTaskExecutor(changed, { provider: fx.fx.f.provider }).execute({ ...task, recover: true }), delivered);
    const noBorrow = cheap.input("task", { allowCredit: false });
    const noFunds = await fx.executor.execute(noBorrow); assert.equal(noFunds.phase, "Stopped"); assert.equal(noFunds.chargedRaw, "0"); assert.equal((await read(fx.fx.f.account, "getPolicy", ["2"])).maxDebtPerTx, 0n);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("provision saves original register/enroll bytes before broadcast, resumes the same ID after response loss and stops guardian nonce races", { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-recover-"))), fx = await createHostedTaskFixture(directory);
  try {
    const actor = await fx.actor(22), request = actor.input("provision"), broadcast = fx.fx.f.provider.broadcastTransaction.bind(fx.fx.f.provider);
    let lost = true;
    fx.fx.f.provider.broadcastTransaction = async raw => {
      const journal = JSON.parse(await readFile(join(request.directory, "task-executor", "session.json"), "utf8"));
      assert.ok(Object.values(journal.transactions).some((entry: any) => entry.raw === raw), "signed bytes must be durable before send");
      const sent = await broadcast(raw); if (lost) { lost = false; throw new Error("Controlled register response loss"); } return sent;
    };
    const paused = await fx.executor.execute(request); assert.equal(paused.phase, "Paused"); assert.equal(paused.reason, "HOSTED_TRANSACTION_UNCERTAIN");
    const original = JSON.parse(await readFile(join(request.directory, "task-executor", "session.json"), "utf8")), nonce = await fx.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.equal(nonce, 1); assert.equal(Transaction.from(original.transactions.register.raw).from, actor.wallet.address);
    fx.fx.f.provider.broadcastTransaction = broadcast;
    const changed = structuredClone(fx.config); changed.initialCashRaw = "0"; changed.models[0].templates.balanced.maxPrice = "1";
    const resumed = await new HostedTaskExecutor(changed, { provider: fx.fx.f.provider }).execute({ ...request, recover: true });
    assert.equal(resumed.phase, "Ready", JSON.stringify(resumed)); assert.equal(resumed.binding?.agentId, "2"); assert.equal(resumed.cashRaw, "40000");
    const restored = JSON.parse(await readFile(join(request.directory, "task-executor", "session.json"), "utf8"));
    assert.equal(restored.transactions.register.raw, original.transactions.register.raw); assert.equal(await read(fx.fx.f.identity, "nextAgentId"), 3n);
    const next = await fx.actor(23), second = next.input("provision"); let loseEnroll = true;
    const guardian = new Wallet(key(1)).address;
    fx.fx.f.provider.broadcastTransaction = async raw => { const signed = Transaction.from(raw), sent = await broadcast(raw); if (loseEnroll && signed.from === guardian) { loseEnroll = false; throw new Error("Controlled enroll loss"); } return sent; };
    const unknown = await fx.executor.execute(second); assert.equal(unknown.phase, "Paused"); assert.equal(unknown.reason, "HOSTED_TRANSACTION_UNCERTAIN");
    const third = await fx.actor(24), competing = third.input("provision"), beforeGuardian = await fx.fx.f.provider.getTransactionCount(guardian);
    const blocked = await fx.executor.execute(competing); assert.equal(blocked.reason, "HOSTED_GUARDIAN_RECOVERY_REQUIRED");
    assert.equal(await fx.fx.f.provider.getTransactionCount(guardian), beforeGuardian);
    fx.fx.f.provider.broadcastTransaction = broadcast;
    assert.equal((await fx.executor.execute({ ...second, recover: true })).phase, "Ready");
    assert.equal((await fx.executor.execute({ ...competing, recover: true })).phase, "Ready"); assert.equal(fx.fx.calls.length, 0);
    const admitted = await fx.actor(26, "cheap", 0n), crashBeforeFirstSave = admitted.input("provision");
    const fundingRequired = await fx.executor.execute({ ...crashBeforeFirstSave, recover: true });
    assert.equal(fundingRequired.phase, "Paused"); assert.equal(fundingRequired.reason, "HOSTED_AGENT_FUNDS_REQUIRED");
    const count = await fx.fx.f.provider.getTransactionCount(admitted.wallet.address);
    fx.fx.f.admin.reset(); await (await fx.fx.f.token!.connect(fx.fx.f.admin).getFunction("mint")(admitted.wallet.address, 40000n)).wait();
    const readyAfterFunding = await fx.executor.execute({ ...crashBeforeFirstSave, recover: true });
    assert.equal(readyAfterFunding.phase, "Ready"); assert.equal(await fx.fx.f.provider.getTransactionCount(admitted.wallet.address), count + 2); // Only approve/deposit after funding.
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("trusted configuration loader is offline, closed, private and rejects injected routes/domains/models/actions", { timeout: 45000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-config-"))), fx = await createHostedTaskFixture(directory);
  try {
    const configFile = join(directory, "executor.json"); await writeFile(configFile, JSON.stringify(fx.config), { mode: 0o600 });
    assert.deepEqual(await loadHostedTaskExecutorConfig(configFile), fx.config);
    for (const mutate of [(c: any) => c.walletKey = key(20), (c: any) => c.rpcTransport = "guess", (c: any) => c.models[0].templates.balanced.providers[0].relayUrl = "https://browser.invalid",
      (c: any) => c.models[1].templates.aggressive.account = c.identity, (c: any) => c.models.push(c.models[0]), (c: any) => c.publicRpcUrl += "?key=forbidden"])
      { const changed = structuredClone(fx.config); mutate(changed); assert.throws(() => validateHostedTaskExecutorConfig(changed)); }
    const actor = await fx.actor(25, "not-allowed");
    await assert.rejects(fx.executor.execute(actor.input("provision")), /HOSTED_TASK_MODEL_NOT_ALLOWED/);
    const input = actor.input("provision"); input.run.action = "credits"; await assert.rejects(fx.executor.execute(input), /HOSTED_ACTION_NOT_SUPPORTED/);
    assert.equal(await fx.fx.f.provider.getTransactionCount(actor.wallet.address), 0); assert.equal(fx.fx.calls.length, 0);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cold hosted wallets receive one bounded real gas grant, unknown grants retain the global budget and shared guardian nonce", { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-gas-"))), fx = await createHostedTaskFixture(directory);
  try {
    const config = { ...structuredClone(fx.config), initialCashRaw: "0", gasGrantWei: "10000000000000000", gasSponsorKeyFile: fx.config.guardianKeyFile, gasSponsorBudgetWei: "20000000000000000" };
    const executor = new HostedTaskExecutor(config, { provider: fx.fx.f.provider });
    const actor = await fx.actor(27, "cheap", 0n); await fx.fx.f.provider.send("anvil_setBalance", [actor.wallet.address, "0x0"]);
    const request = actor.input("provision"), broadcast = fx.fx.f.provider.broadcastTransaction.bind(fx.fx.f.provider); let lose = true;
    fx.fx.f.provider.broadcastTransaction = async raw => {
      const journal = JSON.parse(await readFile(join(request.directory, "task-executor", "session.json"), "utf8"));
      assert.ok(Object.values(journal.transactions).some((entry: any) => entry.raw === raw));
      const signed = Transaction.from(raw), sent = await broadcast(raw);
      if (lose && signed.to === actor.wallet.address && signed.value === BigInt(config.gasGrantWei)) { lose = false; throw new Error("Controlled gas grant response lost"); } return sent;
    };
    const unknown = await executor.execute(request); assert.equal(unknown.reason, "HOSTED_TRANSACTION_UNCERTAIN"); assert.equal(unknown.terminal, false);
    assert.equal(await fx.fx.f.provider.getBalance(actor.wallet.address), BigInt(config.gasGrantWei));
    const next = await fx.actor(28, "cheap", 0n); await fx.fx.f.provider.send("anvil_setBalance", [next.wallet.address, "0x0"]);
    const nextRequest = next.input("provision"), blocked = await executor.execute(nextRequest); assert.equal(blocked.reason, "HOSTED_OPERATOR_RECOVERY_REQUIRED");
    fx.fx.f.provider.broadcastTransaction = broadcast;
    const ready = await executor.execute({ ...request, recover: true }); assert.equal(ready.phase, "Ready", JSON.stringify(ready)); assert.equal(ready.cashRaw, "0");
    const nonce = await fx.fx.f.provider.getTransactionCount(new Wallet(key(1)).address);
    assert.deepEqual(await executor.execute({ ...request, recover: true }), ready); assert.equal(await fx.fx.f.provider.getTransactionCount(new Wallet(key(1)).address), nonce);
    assert.equal((await executor.execute({ ...nextRequest, recover: true })).phase, "Ready");
    const third = await fx.actor(29, "cheap", 0n); await fx.fx.f.provider.send("anvil_setBalance", [third.wallet.address, "0x0"]);
    const exhausted = await executor.execute(third.input("provision")); assert.equal(exhausted.reason, "HOSTED_GAS_BUDGET_EXHAUSTED"); assert.equal(await fx.fx.f.provider.getTransactionCount(third.wallet.address), 0);
    const ledgerFile = join(config.walletDirectory, "gas-grants", `31337-${new Wallet(key(1)).address.toLowerCase()}`, "session.json"), ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.keys(ledger.grants).length, 2); assert.equal(Object.values(ledger.grants).reduce((sum: bigint, grant: any) => sum + BigInt(grant.amount), 0n), BigInt(config.gasSponsorBudgetWei));
    for (const grant of Object.values(ledger.grants) as any[]) { assert.equal(grant.confirmed, true); assert.equal(grant.transaction.receipt.status, 1); assert.equal(Transaction.from(grant.transaction.raw).value, BigInt(config.gasGrantWei)); }
    assert.equal(fx.fx.calls.length, 0);
    const incomplete = structuredClone(config); delete (incomplete as any).gasSponsorBudgetWei; assert.throws(() => validateHostedTaskExecutorConfig(incomplete), /HOSTED_GAS_CONFIG_INVALID/);
    const keyless = await fx.actor(30, "cheap", 0n); await fx.fx.f.provider.send("anvil_setBalance", [keyless.wallet.address, "0x0"]);
    const noGrant = await fx.executor.execute(keyless.input("provision")); assert.equal(noGrant.reason, "HOSTED_WALLET_GAS_REQUIRED"); assert.equal(await fx.fx.f.provider.getTransactionCount(keyless.wallet.address), 0);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a paid unknown hosted request can recover an external task termination even after protocol freeze, without a new policy/payment/model", { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-terminate-"))), fx = await createHostedTaskFixture(directory);
  try {
    const actor = await fx.actor(31), provision = await fx.executor.execute(actor.input("provision")); actor.agent.binding = provision.binding;
    fx.fx.queue("unknown"); const request = actor.input("task"), unknown = await fx.executor.execute(request);
    assert.equal(unknown.phase, "Paused", JSON.stringify(unknown)); assert.equal(unknown.reason, "SOLVE_DISPATCH_UNKNOWN"); assert.equal(unknown.chargedRaw, "120000");
    assert.equal((await read(fx.fx.f.manager, "getLoan", [unknown.taskId!])).status, 1n); assert.equal(fx.fx.calls.length, 1);
    const task = await read(fx.fx.f.escrow, "getTask", [unknown.taskId!]); await fx.fx.f.provider.send("evm_setNextBlockTimestamp", [Number(task.deadline) + 1]);
    fx.fx.f.admin.reset(); await tx(fx.fx.f.escrow, fx.fx.f.admin, "expireTask", [unknown.taskId!]);
    // A guardian freeze also must not prevent read-only closure of the original, already paid request.
    fx.fx.f.admin.reset(); await tx(fx.fx.f.manager, fx.fx.f.admin, "freezeAgent", [provision.binding!.agentId]);
    assert.equal(await read(fx.fx.f.account, "protocolFrozen", [provision.binding!.agentId]), true);
    const nonce = await fx.fx.f.provider.getTransactionCount(actor.wallet.address), recovered = await fx.executor.execute({ ...request, recover: true });
    assert.equal(recovered.phase, "Failed", JSON.stringify(recovered)); assert.equal(recovered.reason, "WORKFLOW_CHAIN_TERMINATED"); assert.equal(recovered.terminal, true); assert.equal(recovered.chargedRaw, "120000");
    assert.equal(recovered.principalRaw, "0"); assert.equal(recovered.feeRaw, "0"); assert.equal(fx.fx.calls.length, 1); assert.equal(await fx.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("hosted deposit uses only the actor's available tokens, freezes the amount and resumes original bytes without credit or duplicate cash", { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-deposit-"))), fx = await createHostedTaskFixture(directory);
  try {
    const config = { ...structuredClone(fx.config), initialCashRaw: "0" }, executor = new HostedTaskExecutor(config, { provider: fx.fx.f.provider });
    const actor = await fx.actor(32, "cheap", 0n), registration = await executor.execute(actor.input("provision")); actor.agent.binding = registration.binding;
    assert.equal(registration.phase, "Ready"); assert.equal(registration.cashRaw, "0");
    const request = actor.input("deposit"); request.run.amountRaw = "60000";
    const nonce = await fx.fx.f.provider.getTransactionCount(actor.wallet.address), insufficient = await executor.execute(request);
    assert.equal(insufficient.phase, "Paused"); assert.equal(insufficient.reason, "HOSTED_AGENT_FUNDS_REQUIRED"); assert.equal(await fx.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
    fx.fx.f.admin.reset(); await tx(fx.fx.f.token!, fx.fx.f.admin, "mint", [actor.wallet.address, 60000n]);
    const broadcast = fx.fx.f.provider.broadcastTransaction.bind(fx.fx.f.provider); let lose = true;
    fx.fx.f.provider.broadcastTransaction = async raw => {
      const signed = Transaction.from(raw), sent = await broadcast(raw);
      if (lose && signed.to?.toLowerCase() === config.models[0].templates.balanced.account.toLowerCase()) { lose = false; throw new Error("Controlled deposit response lost"); } return sent;
    };
    const unknown = await executor.execute({ ...request, recover: true }); assert.equal(unknown.reason, "HOSTED_TRANSACTION_UNCERTAIN");
    assert.equal(await read(fx.fx.f.account, "cash", [registration.binding!.agentId]), 60000n);
    const saved = JSON.parse(await readFile(join(request.directory, "task-executor", "session.json"), "utf8")); assert.ok(saved.transactions.deposit.raw);
    const conflict = { ...request, run: { ...request.run, amountRaw: "60001" }, recover: true };
    await assert.rejects(executor.execute(conflict), /HOSTED_EXECUTION_BINDING_CHANGED/);
    assert.deepEqual(JSON.parse(await readFile(join(request.directory, "task-executor", "session.json"), "utf8")), saved);
    fx.fx.f.provider.broadcastTransaction = broadcast;
    const ready = await executor.execute({ ...request, recover: true }); assert.equal(ready.phase, "Deposited", JSON.stringify(ready)); assert.equal(ready.chargedRaw, "0"); assert.equal(ready.cashRaw, "60000");
    const after = await fx.fx.f.provider.getTransactionCount(actor.wallet.address); assert.equal(after, nonce + 2);
    assert.deepEqual(await executor.execute({ ...request, recover: true }), ready); assert.equal(await fx.fx.f.provider.getTransactionCount(actor.wallet.address), after);
    assert.equal(await read(fx.fx.f.token!, "balanceOf", [actor.wallet.address]), 0n); assert.equal(fx.fx.calls.length, 0);
    const state = JSON.parse(await readFile(join(request.directory, "task-executor", "session.json"), "utf8")); assert.equal(state.transactions.deposit.raw, saved.transactions.deposit.raw);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});
