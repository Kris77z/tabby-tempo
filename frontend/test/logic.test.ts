import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress } from "ethers";
import { ACCOUNT_ABI, MANAGER_ABI } from "../lib/abi";
import { amount, ratio, taskCreditCap } from "../lib/format";
import { explainError } from "../lib/errors";
import { validateDeployment, unavailableDashboard } from "../lib/config";
import { fixtureDashboard } from "../lib/fixture";
import { validateCredit } from "../lib/read";

test("asset displays keep 6/18 decimals and uint256 precision; task cap has two integer floors", () => {
  assert.equal(amount("120000", 6), "0.12");
  assert.equal(amount("120000000000000000", 18), "0.12");
  assert.equal(amount("100000000000000000000000000001", 6), "100,000,000,000,000,000,000,000.000001");
  assert.equal(amount("1", 18), "<0.000001");
  assert.equal(taskCreditCap("150000", "8000", "1500", "200000"), 104347n);
  assert.equal(taskCreditCap("1", "8000", "1500", "200000"), 0n);
  assert.equal(ratio("200", "100"), 100);
});
test("wallet nested revert payloads decode SpendRejected and identityChanged without events", () => {
  const account = new Interface(ACCOUNT_ABI), manager = new Interface(MANAGER_ABI);
  const data = account.encodeErrorResult("SpendRejected", [1842, ZeroAddress, 1]);
  const error = explainError({ info: { error: { data: { originalError: { data } } } } });
  assert.equal(error.code, "SpendRejected"); assert.match(error.message, /白名单/); assert.match(error.detail!, /reason 1/);
  assert.equal(explainError({ code: "SpendRejected", reason: 3, message: "SpendRejected reason 3" }).message.includes("冻结"), true);
  assert.equal(explainError({ data: manager.encodeErrorResult("IdentityChanged", [1842]) }).code, "IdentityChanged");
  assert.equal(explainError({ code: 4001 }).code, "ACTION_REJECTED");
});
test("deployment/credit boundaries refuse missing addresses, wrong decimals and a different chain", () => {
  const sample = fixtureDashboard();
  const config = validateDeployment({ ...sample.config, rpcUrl: "http://127.0.0.1:8545", underwriterUrl: "http://127.0.0.1:8787", deploymentBlock: 0 });
  assert.equal(validateCredit(sample.profiles[0].credit, config, "1842").terms.tier, "B");
  assert.throws(() => validateCredit({ ...sample.profiles[0].credit, configuration: { ...sample.profiles[0].credit.configuration, chainId: "10143" } }, config, "1842"), /不一致/);
  assert.throws(() => validateDeployment({ ...config, contracts: { ...config.contracts, manager: "" } }), /部署地址/);
  assert.throws(() => validateDeployment({ ...config, asset: { ...config.asset, address: ZeroAddress, decimals: 6 } }), /18/);
  assert.throws(() => validateDeployment({ ...config, underwriterUrl: "https://service.example/?api_key=private" }), /凭据/);
});

test("configured read failure preserves public deployment metadata and exposes no invented financial values", () => {
  const config = validateDeployment({ ...fixtureDashboard().config, chainId: "42431", network: "Tempo Moderato Testnet", rpcUrl: "https://rpc.example/PRIVATE_SENTINEL", underwriterUrl: "http://127.0.0.1:8787", deploymentBlock: 0 });
  const state = unavailableDashboard(config);
  assert.equal(state.configured, true);
  assert.equal(state.readStatus, "unavailable");
  assert.equal(state.config!.chainId, "42431");
  assert.deepEqual(state.config!.contracts, config.contracts);
  assert.deepEqual(state.profiles, []);
  assert.deepEqual(state.openTasks, []);
  assert.equal(JSON.stringify(state).includes("PRIVATE_SENTINEL"), false);
  assert.equal("cash" in state, false);
  assert.equal("debt" in state, false);
});
