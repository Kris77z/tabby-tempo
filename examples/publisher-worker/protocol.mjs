import { Contract, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { canonical, uint } from "@agentfuel/sdk/protocol";

export const PROBLEM = Object.freeze({ version: 1, problemId: "sum-integers", language: "python3",
  prompt: "Write Python 3.12 code that reads a JSON array of integers from stdin and prints its sum as JSON. Public sample: [4,8,-3] -> 9. Call test_public_sample with your complete code. Fix failures. Do not claim task success: only the independent Arena can accept it." });
export const ESCROW_ABI = [
  "function settlementAsset() view returns(address)", "function agentAccount() view returns(address)",
  "function adapter() view returns(address)", "function verifier() view returns(address)",
  "function createTask(uint256 reward,uint256 deadline) returns(uint256)", "function acceptTask(uint256 taskId,uint256 agentId)",
  "function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))",
  "event TaskCreated(uint256 indexed taskId,address indexed poster,uint256 reward,uint256 deadline)",
  "event TaskAccepted(uint256 indexed taskId,uint256 indexed agentId,address wallet)",
  "event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)",
];
export const TOKEN_ABI = ["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"];
export const MANIFEST_TYPES = { Publication: [
  { name: "requestId", type: "bytes32" }, { name: "taskId", type: "uint256" },
  { name: "poster", type: "address" }, { name: "asset", type: "address" },
  { name: "account", type: "address" }, { name: "verifier", type: "address" },
  { name: "reward", type: "uint256" }, { name: "deadline", type: "uint256" },
  { name: "protocolFeeBps", type: "uint16" }, { name: "specHash", type: "bytes32" },
  { name: "creationTxHash", type: "bytes32" },
] };
export const SUBMISSION_TYPES = { Submission: [
  { name: "taskId", type: "uint256" }, { name: "agentId", type: "uint256" },
  { name: "codeHash", type: "bytes32" }, { name: "deadline", type: "uint256" },
] };
export const digest = value => keccak256(toUtf8Bytes(canonical(value)));
export const same = (left, right) => getAddress(left) === getAddress(right);
export function configValue(value) {
  if (!value || value.version !== 1) throw new Error("CONFIG_VERSION_MISMATCH");
  uint(value.chainId, "chainId");
  if (value.chainId !== "31337") throw new Error("LOCAL_CHAIN_ONLY");
  for (const name of ["escrow", "asset", "account", "verifier", "poster"]) getAddress(value[name]);
  if (value.asset === "0x0000000000000000000000000000000000000000") throw new Error("ERC20_ONLY_SAMPLE");
  for (const name of ["rpcUrl", ...(value.relayUrl ? ["relayUrl", "arenaUrl", "underwriterUrl"] : [])]) {
    const url = new URL(value[name]);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.hash) throw new Error("LOCAL_ENDPOINT_REQUIRED");
  }
  return value;
}
export function assertEconomics(config, publication) {
  for (const name of ["maxPrice", "maxBorrowFeeBps", "minimumProfit"]) uint(config[name], name);
  if (BigInt(config.maxPrice) === 0n || BigInt(config.maxBorrowFeeBps) > 10000n) throw new Error("INVALID_COST_BOUND");
  const reward = BigInt(publication.reward), price = BigInt(config.maxPrice);
  const protocolFee = reward * BigInt(publication.protocolFeeBps) / 10000n;
  // Conservatively charge the borrowing-fee bound on the entire provider price,
  // even when existing cash reduces the principal. Gas is a separate native asset.
  const maximumBorrowFee = (price * BigInt(config.maxBorrowFeeBps) + 9999n) / 10000n;
  const minimumNet = reward - protocolFee - price - maximumBorrowFee;
  if (minimumNet < BigInt(config.minimumProfit)) throw new Error("UNPROFITABLE_TASK");
  return { reward: String(reward), providerCostBound: String(price), protocolFee: String(protocolFee),
    borrowFeeBound: String(maximumBorrowFee), minimumNet: String(minimumNet), gasIncluded: false };
}
export function publicationData(manifest) {
  return { domain: { name: "AgentfuelPublication", version: "1", chainId: manifest.chainId, verifyingContract: manifest.escrow },
    types: MANIFEST_TYPES, message: manifest.publication };
}
export function validateManifest(config, manifest) {
  configValue(config);
  if (!manifest || manifest.version !== 1 || manifest.chainId !== config.chainId || !same(manifest.escrow, config.escrow)
    || digest(manifest.spec) !== digest(PROBLEM)) throw new Error("MANIFEST_DOMAIN_MISMATCH");
  const p = manifest.publication;
  if (!p || !same(p.poster, config.poster) || !same(p.asset, config.asset) || !same(p.account, config.account)
    || !same(p.verifier, config.verifier) || p.specHash !== digest(PROBLEM)) throw new Error("MANIFEST_BINDING_MISMATCH");
  for (const name of ["taskId", "reward", "deadline", "protocolFeeBps"]) uint(p[name], name);
  if (p.taskId === "0" || p.reward === "0" || BigInt(p.protocolFeeBps) > 10000n
    || !/^0x[0-9a-f]{64}$/.test(p.requestId) || !/^0x[0-9a-f]{64}$/.test(p.creationTxHash)) throw new Error("INVALID_PUBLICATION");
  const typed = publicationData(manifest);
  let signer;
  try { signer = verifyTypedData(typed.domain, typed.types, typed.message, manifest.signature); }
  catch { throw new Error("PUBLICATION_SIGNATURE_INVALID"); }
  if (!same(signer, config.poster)) throw new Error("PUBLICATION_SIGNER_MISMATCH");
  return manifest;
}
export async function verifyDeployment(config, provider) {
  if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(config.chainId)) throw new Error("NETWORK_MISMATCH");
  const escrow = new Contract(config.escrow, ESCROW_ABI, provider);
  const [asset, account, verifier] = await Promise.all([escrow.settlementAsset(), escrow.agentAccount(), escrow.verifier()]);
  if (!same(asset, config.asset) || !same(account, config.account) || !same(verifier, config.verifier)) throw new Error("DEPLOYMENT_MISMATCH");
  return escrow;
}
export async function verifyPublication(config, manifest, provider) {
  validateManifest(config, manifest);
  const escrow = await verifyDeployment(config, provider), p = manifest.publication;
  const receipt = await provider.getTransactionReceipt(p.creationTxHash);
  const transaction = await provider.getTransaction(p.creationTxHash);
  if (!receipt || receipt.status !== 1 || (await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash
    || !transaction || !same(transaction.from, p.poster) || !same(transaction.to, config.escrow)) throw new Error("PUBLICATION_RECEIPT_INVALID");
  const events = receipt.logs.filter(log => same(log.address, config.escrow)).map(log => {
    try { return escrow.interface.parseLog(log); } catch { return null; }
  }).filter(event => event?.name === "TaskCreated" && String(event.args.taskId) === p.taskId);
  const task = await escrow.getTask(p.taskId);
  if (events.length !== 1 || !same(events[0].args.poster, p.poster) || String(events[0].args.reward) !== p.reward
    || String(events[0].args.deadline) !== p.deadline || !same(task.poster, p.poster) || String(task.reward) !== p.reward
    || String(task.deadline) !== p.deadline || String(task.protocolFeeBps) !== p.protocolFeeBps) throw new Error("PUBLICATION_CHAIN_MISMATCH");
  return { escrow, task, receipt };
}
