import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { digest, PROBLEM, publicationData, validateManifest, assertEconomics, configValue } from "../protocol.mjs";
import { sendOnce, withJournal, writeJson } from "../durable.mjs";
import { paymentAdmission,dispatchAdmission,resumeSubmission } from "../worker.mjs";

const key = n => `0x${n.toString(16).padStart(64, "0")}`;
const address = n => new Wallet(key(n)).address;
const config = { version: 1, rpcUrl: "http://127.0.0.1:8545", chainId: "31337", escrow: address(1), asset: address(2),
  account: address(3), verifier: address(4), poster: address(5), maxPrice: "120000", maxBorrowFeeBps: "1500", minimumProfit: "10000" };
async function manifest() {
  const value = { version: 1, chainId: "31337", escrow: config.escrow, spec: PROBLEM, publication: { requestId: key(6), taskId: "1", poster: config.poster,
    asset: config.asset, account: config.account, verifier: config.verifier, reward: "150000", deadline: "2000000000", protocolFeeBps: "0",
    specHash: digest(PROBLEM), creationTxHash: key(7) } };
  const typed = publicationData(value);
  return { ...value, signature: await new Wallet(key(5)).signTypedData(typed.domain, typed.types, typed.message) };
}
test("publisher signature binds the existing fixed problem, task, funding and trusted settlement domain", async () => {
  const original = await manifest();
  assert.equal(validateManifest(config, original), original);
  for (const [field, value] of [["taskId", "2"], ["reward", "1"], ["deadline", "2000000001"], ["creationTxHash", key(8)]]) {
    assert.throws(() => validateManifest(config, { ...original, publication: { ...original.publication, [field]: value } }), /PUBLICATION_SIGNER_MISMATCH/);
  }
  assert.throws(() => validateManifest(config, { ...original, spec: { ...PROBLEM, prompt: "different task" } }), /MANIFEST_DOMAIN_MISMATCH/);
  assert.throws(() => validateManifest(config, { ...original, publication: { ...original.publication, verifier: address(8) } }), /MANIFEST_BINDING_MISMATCH/);
});
test("economic admission uses the task fee snapshot and conservative borrowing cost before accepting", async () => {
  const p = (await manifest()).publication;
  assert.equal(assertEconomics(config, p).minimumNet, "12000");
  assert.throws(() => assertEconomics(config, { ...p, reward: "130000" }), /UNPROFITABLE_TASK/);
  assert.throws(() => assertEconomics(config, { ...p, protocolFeeBps: "1000" }), /UNPROFITABLE_TASK/);
  assert.throws(() => configValue({ ...config, chainId: "10143" }), /LOCAL_CHAIN_ONLY/);
  assert.throws(() => configValue({ ...config, rpcUrl: "https://monad.tabbyai.xyz" }), /LOCAL_ENDPOINT_REQUIRED/);
});
test("an unpaid saved quote cannot buy work after its business deadline; an original paid handle can reconcile", async () => {
  const publication = await manifest(), handle = { quote: { paymentId: key(6), quoteExpiry: String(Math.floor(Date.now() / 1000) + 300) } };
  const provider = { getBlock: async () => ({ timestamp: Math.floor(Date.now() / 1000) }) };
  const escrow = { getTask: async () => ({ status: 2n, agentId: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 1800) }) };
  const account = { getPayment: async () => ({ fromCash: 0n, fromCredit: 0n }) };
  const expired = { ...config, agentId: "1", solveDeadlineMs: Date.now() - 1 };
  await assert.rejects(paymentAdmission(expired, publication, provider, escrow, account, handle), /No new payment after/);
  account.getPayment = async () => ({ fromCash: 40000n, fromCredit: 80000n });
  await paymentAdmission(expired, publication, provider, escrow, account, handle);
});
test("mined-but-unacknowledged publication resumes the durable transaction without signing or broadcasting again", async () => {
  const wallet = new Wallet(key(5));
  let receipt, signs = 0, broadcasts = 0, saves = 0;
  const provider = { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: key(8) }),
    getTransaction: async () => undefined, getTransactionCount: async () => 0,
    broadcastTransaction: async () => { broadcasts++; receipt = { hash: state.transactions.create.txHash, status: 1, blockNumber: 1, blockHash: key(8) }; throw new Error("LOST_REPLY"); } };
  const signer = { provider, getAddress: () => wallet.getAddress(), populateTransaction: async request => ({ ...request, chainId: 31337, nonce: 0, gasLimit: 21000, gasPrice: 1 }),
    signTransaction: async request => { signs++; return wallet.signTransaction(request); } };
  const state = { transactions: {} }, save = async () => { saves++; };
  await assert.rejects(sendOnce(state, save, "create", signer, { to: address(1), value: 0 }), /LOST_REPLY/);
  assert.equal((await sendOnce(state, save, "create", signer, {})).status, 1);
  assert.deepEqual({ signs, broadcasts, saves }, { signs: 1, broadcasts: 1, saves: 2 });
  provider.getBlock = async () => ({ hash: key(9) });
  await assert.rejects(sendOnce(state, save, "create", signer, {}), /NONCANONICAL_RECEIPT/);
  assert.equal(signs, 1);
});
test("changed deployment or request leaves the original private journal and lock namespace untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-publication-journal-")), path = join(directory, "journal.json");
  try {
    await writeJson(path, { version: 1, binding: "original", transactions: {} });
    const bytes = await readFile(path, "utf8");
    await assert.rejects(withJournal(path, "changed", () => assert.fail()), /JOURNAL_BINDING_MISMATCH/);
    assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dispatch and submission reservations fail closed across stop, malformed history and cold invocation",async()=>{
 const m=await manifest(),c={...config,agentId:"1",solveDeadlineMs:Date.now()+100000};
 const provider={getBlock:async()=>({timestamp:Math.floor(Date.now()/1000)})},escrow={getTask:async()=>({status:2n,agentId:1n,deadline:BigInt(Math.floor(Date.now()/1000)+200)})};
 const h={quote:{paymentId:key(6)}};
 for(const old of [null,false,{}, {paymentId:key(9),attempts:1}])await assert.rejects(dispatchAdmission(c,m,provider,escrow,{dispatchAdmission:old},async()=>{},h),/Original dispatch/);
 await assert.rejects(dispatchAdmission(c,m,provider,escrow,{},async()=>{throw Error("SAVE_FAILED")},h),/SAVE_FAILED/);
 const stopped={};await assert.rejects(dispatchAdmission(c,m,provider,escrow,stopped,async()=>{stopped.sealed=true},h),/Original dispatch/);
 await assert.rejects(dispatchAdmission({...c,solveDeadlineMs:0},m,provider,escrow,{},async()=>{},h),/deadline/);
 let posts=0; const state={runId:"original",submission:{taskId:"1",code:"original"}}, post=async()=>{posts++;return{runId:"original",taskId:"1"}};
 await assert.rejects(resumeSubmission(state,async()=>{},false,"1",post,c.solveDeadlineMs),/NOT_AUTHORIZED/);
 for(const prior of [null,false,{}])await assert.rejects(resumeSubmission({...state,submissionRecovery:prior},async()=>{},true,"1",post,c.solveDeadlineMs),/NOT_AUTHORIZED/);
 const revoked=structuredClone(state);await assert.rejects(resumeSubmission(revoked,async()=>{revoked.sealed=true},true,"1",post,c.solveDeadlineMs),/NOT_AUTHORIZED/);
 await resumeSubmission(state,async()=>{},true,"1",post,c.solveDeadlineMs);
 await assert.rejects(resumeSubmission(structuredClone(state),async()=>{},true,"1",post,c.solveDeadlineMs),/NOT_AUTHORIZED/);assert.equal(posts,1);
});
