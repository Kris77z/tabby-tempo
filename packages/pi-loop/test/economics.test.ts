import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { accountInterface, EMPTY_AUTH, type PaymentHandle } from "@agentfuel/sdk";
import { assessTaskEconomics, assertEconomicPayment, hostedTaskEconomics, validateTaskEconomicsPolicy } from "../src/economics.js";
import { selectInference, type SelectionConfig, type SelectionSnapshot } from "../src/selector.js";

const revenue = (rewardRaw: string, protocolFeeBps = "0") => ({ rewardRaw, escrowBalanceRaw: rewardRaw, protocolFeeBps });
test("successful completion margin charges the selected execution price once and floors both contract fees", () => {
  const policy = hostedTaskEconomics("10", "100");
  const cash = assessTaskEconomics(policy, revenue("200", "250"), "999", "1000");
  assert.deepEqual([cash.protocolFeeRaw, cash.netRevenueRaw, cash.borrowerFeeRaw, cash.netRewardRaw], ["5", "195", "0", "85"]);
  const credit = assessTaskEconomics(policy, revenue("200", "250"), "999", "40");
  assert.deepEqual([credit.fromCashRaw, credit.fromCreditRaw, credit.borrowerFeeRaw, credit.netRewardRaw], ["40", "60", "9", "76"]);
  assert.equal(credit.reason, undefined); assert.equal(credit.scope, "settlement-asset-only");
  const tiny = assessTaskEconomics(hostedTaskEconomics("0", "1"), revenue("2", "1"), "999", "0");
  assert.deepEqual([tiny.protocolFeeRaw, tiny.borrowerFeeRaw, tiny.netRewardRaw], ["0", "0", "1"]);
  assert.equal(assessTaskEconomics(policy, revenue("110"), "0", "1000").reason, "ECONOMICS_NOT_WORTHWHILE");
  assert.equal(assessTaskEconomics(policy, revenue("109"), "0", "1000").netRewardRaw, "-1");
});
test("subsidized tokens have zero direct settlement-asset purchase price while unknown/unfunded revenue is rejected", () => {
  const policy = hostedTaskEconomics("0", "0");
  const result = assessTaskEconomics(policy, revenue("1"), "999999", "0");
  assert.equal(result.netRewardRaw, "1"); assert.equal(result.executionCostRaw, "0"); assert.equal(result.reason, undefined);
  assert.equal(assessTaskEconomics(policy, undefined, "100", "0").reason, "ECONOMICS_REVENUE_UNKNOWN");
  assert.equal(assessTaskEconomics(policy, { ...revenue("100"), escrowBalanceRaw: "99" }, "100", "0").reason, "ECONOMICS_ESCROW_UNFUNDED");
  assert.equal(assessTaskEconomics(policy, revenue("0"), "100", "0").reason, "ECONOMICS_NOT_WORTHWHILE");
  assert.equal(assessTaskEconomics(hostedTaskEconomics("2", "9007199254740993"), revenue("9007199254741000"), "1", "9007199254741000").netRewardRaw, "5");
});
function fixture(economics = true) {
  const config: SelectionConfig = { agentId: "1", chainId: "31337", account: "0x1111111111111111111111111111111111111111", asset: "0x2222222222222222222222222222222222222222", escrowAddress: "0x3333333333333333333333333333333333333333",
    tasks: ["1", "2"].map(taskId => ({ taskId, problemId: "sum-integers", deadlineMs: 50000, creditLimit: "100" })),
    providers: [{ id: "fixed", payTo: "0x4444444444444444444444444444444444444444", relayUrl: "http://127.0.0.1:3000/v1/chat", service: "fixed", model: "fixed", routes: [{ tier: "cheap", price: "100", capabilities: ["python3-json-stdio", "sum-integers"] }] }],
    allowCredit: true, maxPrice: "100", deadlineMs: 50000, minRemainingMs: 100, maxCompletionTokens: 128,
    ...(economics ? { economics: hostedTaskEconomics("10") } : {}) };
  const snapshot: SelectionSnapshot = { atMs: 1000, cash: "100", creditEnabled: true, tasks: config.tasks.map((task, index) => ({ ...task, assigned: true, ...(economics ? { revenue: revenue(index === 0 ? "100" : "200") } : {}) })) };
  return { config, snapshot };
}
test("the actual selector rejects the earlier losing task and chooses only an economically viable provider/task", () => {
  const { config, snapshot } = fixture();
  let decision = selectInference(config, snapshot);
  assert.equal(decision.selected?.taskId, "2"); assert.deepEqual(decision.candidates[0].rejected, ["ECONOMICS_NOT_WORTHWHILE"]);
  config.providers.unshift({ ...structuredClone(config.providers[0]), id: "expensive", routes: [{ ...config.providers[0].routes[0], price: "190" }] });
  decision = selectInference(config, snapshot);
  assert.equal(decision.selected?.providerId, "fixed"); assert.equal(decision.selected?.taskId, "2");
  config.maxPrice = "99"; assert.equal(selectInference(config, snapshot).selected, undefined);
  config.maxPrice = "100"; snapshot.cash = "0"; config.allowCredit = false;
  assert.equal(selectInference(config, snapshot).selected, undefined);
  config.allowCredit = true;
  assert.equal(selectInference(config, snapshot).selected?.economics?.borrowerFeeRaw, "15");
  delete snapshot.tasks[1].revenue;
  assert.equal(selectInference(config, snapshot).selected, undefined);
});
test("strict economics validation rejects arbitrary revenue fields, unsafe amounts and model-provided policy extensions", () => {
  for (const patch of [{ minNetRewardRaw: "-1" }, { planningCostRaw: 1 }, { borrowerFeeBps: "65536" }, { executionCostRaw: "01" }, { probability: "1" }, { rewardRaw: "99999" }]) {
    assert.throws(() => validateTaskEconomicsPolicy({ ...hostedTaskEconomics(), ...patch } as any), /INVALID_TASK_ECONOMICS/);
  }
  assert.throws(() => assessTaskEconomics(hostedTaskEconomics(), revenue("2", "10001"), "1", "1"));
  assert.throws(() => assessTaskEconomics(hostedTaskEconomics(), { ...revenue("2"), modelClaimedReward: "9999" } as any, "1", "1"));
  const { config, snapshot } = fixture(); (config.tasks[0] as any).rewardRaw = "999999";
  assert.throws(() => selectInference(config, snapshot));
});
test("legacy selection remains price ordered without adding a policy or requiring revenue", () => {
  const { config, snapshot } = fixture(false), decision = selectInference(config, snapshot);
  assert.equal(decision.selected?.taskId, "1"); assert.equal(Object.hasOwn(decision.selected!, "economics"), false);
});
test("a signed credit authorization above the saved fee bound is rejected before broadcast", async () => {
  const signer = Wallet.createRandom();
  const make = async (feeBps: number, price = "100") => ({ quote: { price }, submission: { rawTransaction: await signer.signTransaction({ chainId: 31337, nonce: 0, gasLimit: 500000, gasPrice: 1,
    to: "0x1111111111111111111111111111111111111111", data: accountInterface.encodeFunctionData("payProvider", ["1", "0x2222222222222222222222222222222222222222", price, `0x${"01".repeat(32)}`, { ...EMPTY_AUTH, feeBps }, "0x"]) }) } } as PaymentHandle);
  assert.doesNotThrow(() => assertEconomicPayment(hostedTaskEconomics("0", "100"), { quote: { price: "100" } } as PaymentHandle));
  assert.throws(() => assertEconomicPayment(hostedTaskEconomics("0", "100"), { quote: { price: "100" }, submission: { from: signer.address, nonce: 0 } } as PaymentHandle), /inspectable signed payment bytes/);
  const accepted = await make(1500); assertEconomicPayment(hostedTaskEconomics("0", "100"), accepted);
  const changed = await make(1501); assert.throws(() => assertEconomicPayment(hostedTaskEconomics("0", "100"), changed), /saved economic bound/);
  assert.throws(() => assertEconomicPayment(hostedTaskEconomics("0", "99"), accepted), /saved economic price/);
});

test("Tempo type0x76 is explicitly unsupported before broadcast, while type2 keeps signed economic checks", async () => {
  const policy = hostedTaskEconomics("0", "100");
  assert.throws(() => assertEconomicPayment(policy, {quote:{price:"100"},submission:{rawTransaction:"0x76c0"}} as PaymentHandle), (error:any) => error.code === "ECONOMICS_SIGNED_TRANSACTION_UNSUPPORTED");
  const signer=Wallet.createRandom();
  const rawTransaction=await signer.signTransaction({type:2,chainId:42431,nonce:0,gasLimit:500000,maxFeePerGas:1,maxPriorityFeePerGas:1,to:"0x1111111111111111111111111111111111111111",data:accountInterface.encodeFunctionData("payProvider",["1","0x2222222222222222222222222222222222222222","100",`0x${"01".repeat(32)}`,{...EMPTY_AUTH,feeBps:1500},"0x"])});
  assert.doesNotThrow(() => assertEconomicPayment(policy,{quote:{price:"100"},submission:{rawTransaction}} as PaymentHandle));
});

test("a cash-funded decision rejects any signed credit cap or fee before broadcast", async () => {
  const signer = Wallet.createRandom(), policy = hostedTaskEconomics("0", "100");
  for (const [principalCap, feeBps] of [[0, 0], [1, 0], [0, 1]]) {
    const rawTransaction = await signer.signTransaction({ type: 2, chainId: 42431, nonce: 0, gasLimit: 500000, maxFeePerGas: 1, maxPriorityFeePerGas: 1,
      to: "0x1111111111111111111111111111111111111111", data: accountInterface.encodeFunctionData("payProvider", ["1", "0x2222222222222222222222222222222222222222", "100", `0x${"01".repeat(32)}`, { ...EMPTY_AUTH, principalCap, feeBps }, "0x"]) });
    const handle = { quote: { price: "100" }, submission: { rawTransaction } } as PaymentHandle;
    if (principalCap || feeBps) assert.throws(() => assertEconomicPayment(policy, handle, true), (error: any) => error.code === "ECONOMICS_CASH_ONLY");
    else assert.doesNotThrow(() => assertEconomicPayment(policy, handle, true));
  }
});
