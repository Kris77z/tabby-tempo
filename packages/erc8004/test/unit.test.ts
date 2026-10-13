import assert from "node:assert/strict";
import test from "node:test";
import { Interface, JsonRpcProvider, TypedDataEncoder, verifyTypedData, Wallet, ZeroAddress,
  type TransactionReceipt } from "ethers";
import { IDENTITY_ABI, IdentityRegistry, registrationFromReceipt, uint, walletSetTypedData } from "../src/identity.js";
import { clientFilter, REPUTATION_ABI, ReputationRegistry } from "../src/reputation.js";

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const registry = new Wallet(key(10)).address;
const owner = new Wallet(key(11)).address;
const newWallet = new Wallet(key(12));

test("canonical EIP712 binds owner, chain, registry and agentId zero", async () => {
  const consent = { agentId: 0n, newWallet: newWallet.address, owner, deadline: 1790864000n, chainId: 10143n, registryAddress: registry };
  const typed = walletSetTypedData(consent);
  assert.equal(TypedDataEncoder.from(typed.types).encodeType("AgentWalletSet"), "AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
  assert.deepEqual(typed.domain, { name: "ERC8004IdentityRegistry", version: "1", chainId: 10143n, verifyingContract: registry });
  const signature = await newWallet.signTypedData(typed.domain, typed.types, typed.message);
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, signature), newWallet.address);
  for (const patch of [{ owner: registry }, { chainId: 31337n }, { registryAddress: owner }]) {
    const changed = walletSetTypedData({ ...consent, ...patch });
    assert.notEqual(verifyTypedData(changed.domain, changed.types, changed.message, signature), newWallet.address);
  }
  assert.throws(() => walletSetTypedData({ ...consent, newWallet: ZeroAddress }), /INVALID_WALLET_CONSENT/);
});

test("registration is derived exclusively from a matching successful receipt event", () => {
  const iface = new Interface(IDENTITY_ABI);
  const event = iface.encodeEventLog(iface.getEvent("Registered")!, [0n, "ipfs://agent", owner]);
  const receipt = { status: 1, logs: [{ address: registry, ...event }] } as unknown as TransactionReceipt;
  assert.equal(registrationFromReceipt(receipt, registry, owner, "ipfs://agent").agentId, 0n);
  assert.throws(() => registrationFromReceipt({ ...receipt, status: 0 } as TransactionReceipt, registry, owner, "ipfs://agent"), /TRANSACTION_FAILED/);
  for (const [address, expectedOwner, uri] of [[owner, owner, "ipfs://agent"], [registry, registry, "ipfs://agent"], [registry, owner, "wrong-uri"]]) {
    assert.throws(() => registrationFromReceipt(receipt, address, expectedOwner, uri), /EVENT_MISMATCH/);
  }
  assert.throws(() => registrationFromReceipt({ ...receipt, logs: [...receipt.logs, ...receipt.logs] } as unknown as TransactionReceipt, registry, owner, "ipfs://agent"), /EVENT_MISMATCH/);
});

test("signed feedback ABI decodes all canonical fields without aggregation assumptions", () => {
  const iface = new Interface(REPUTATION_ABI);
  const summary = iface.decodeFunctionResult("getSummary", iface.encodeFunctionResult("getSummary", [7n, -1234n, 2]));
  assert.equal(summary.count, 7n); assert.equal(summary.summaryValue, -1234n); assert.equal(summary.summaryValueDecimals, 2n);
  const feedback = iface.decodeFunctionResult("readFeedback", iface.encodeFunctionResult("readFeedback", [-18n, 1, "infercredit", "default", true]));
  assert.equal(feedback.value, -18n); assert.equal(feedback.isRevoked, true);
  assert.equal(iface.getFunction("giveFeedback")!.format("sighash"), "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)");
  assert.equal(iface.getEvent("NewFeedback")!.format("sighash"), "NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)");
});

test("bad identifiers, empty/duplicate clients and registry config fail before RPC", async () => {
  assert.equal(uint(0n, "AGENT_ID"), 0n);
  for (const invalid of [-1n, 2n ** 256n, 0 as unknown as bigint]) assert.throws(() => uint(invalid, "AGENT_ID"), /INVALID_AGENT_ID/);
  assert.throws(() => clientFilter([]), /NONEMPTY_CLIENT_FILTER_REQUIRED/);
  assert.throws(() => clientFilter([owner, owner]), /DUPLICATE_CLIENT_FILTER/);
  assert.deepEqual(clientFilter([owner]), [owner]);
  const provider = new JsonRpcProvider("http://127.0.0.1:1"); // No test below reaches RPC.
  try {
    assert.throws(() => new IdentityRegistry({ provider, address: ZeroAddress, expectedChainId: 10143n }), /REGISTRY_ADDRESS_REQUIRED/);
    assert.throws(() => new IdentityRegistry({ provider, address: registry, expectedChainId: 0n }), /INVALID_CHAIN_ID/);
    const reputation = new ReputationRegistry({ provider, address: registry, expectedChainId: 10143n });
    await assert.rejects(reputation.readSummary(0n, [], "", ""), /NONEMPTY_CLIENT_FILTER_REQUIRED/);
    await assert.rejects(reputation.readFeedback(0n, owner, 0n), /FEEDBACK_INDEX_MUST_BE_POSITIVE/);
    await assert.rejects(reputation.giveFeedback(newWallet, { agentId: 0n, value: -(10n ** 38n) - 1n, valueDecimals: 0, tag1: "", tag2: "" }), /INVALID_FEEDBACK_VALUE/);
  } finally { provider.destroy(); }
});
