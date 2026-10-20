import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname, homedir } from "node:os";
import { keccak256 } from "ethers";
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, {
      force: true
    });
  }
}
export function processIdentity(pid = process.pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8"
    }).trim() || null;
  } catch {
    return null;
  }
}
function alive(owner) {
  if (owner.hostname !== hostname()) throw Error("LOCK_HOST_MISMATCH");
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw Error("LOCK_OWNER_UNCERTAIN");
  }
  const identity = processIdentity(owner.pid);
  if (!identity) throw Error("LOCK_OWNER_UNCERTAIN");
  return identity === owner.startIdentity;
}
/** All creation/reaping is serialized by a short-lived claim. Malformed locks fail closed. */
export async function withJournal(path, binding, work) {
  path = resolve(path);
  const prior = await readJson(path);
  if (prior !== undefined && (!prior || typeof prior !== "object" || Array.isArray(prior) || prior.binding !== binding || prior.version !== 1 || !prior.transactions || typeof prior.transactions !== "object")) throw Error("JOURNAL_BINDING_MISMATCH");
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700
  });
  const lock = `${path}.lock`,
    claim = `${path}.claim`,
    owner = {
      version: 1,
      pid: process.pid,
      startIdentity: processIdentity(),
      hostname: hostname(),
      token: randomUUID()
    };
  let claimFile;
  try {
    claimFile = await open(claim, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw Error("JOURNAL_LOCKED");
    throw error;
  }
  try {
    const existing = await readJson(lock);
    if (existing) {
      if (existing.version !== 1 || !Number.isInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== "string" || typeof existing.startIdentity !== "string") throw Error("LOCK_OWNER_INVALID");
      if (alive(existing)) throw Error("JOURNAL_LOCKED");
      await rm(lock); // Claim excludes every participating lock creator or reaper.
    }
    const file = await open(lock, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(owner));
      await file.sync();
    } finally {
      await file.close();
    }
  } finally {
    await claimFile.close();
    await rm(claim);
  }
  try {
    const loaded=await readJson(path);
    const state = loaded === undefined ? {
      version: 1,
      binding,
      transactions: {}
    } : loaded;
    if (state.version !== 1 || state.binding !== binding) throw Error("JOURNAL_BINDING_MISMATCH");
    return await work(state, () => writeJson(path, state));
  } finally {
    const saved = await readJson(lock);
    if (saved?.token === owner.token) await rm(lock);
  }
}
export async function canonicalReceipt(provider, hash) {
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return undefined;
  if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error("NONCANONICAL_RECEIPT");
  if (receipt.status !== 1) throw new Error("TRANSACTION_REVERTED");
  return receipt;
}
/** The signed transaction is durable before broadcast. Recovery only reuses those bytes. */
export async function sendOnce(state, save, stage, signer, request) {
  const provider = signer.provider;
  let submitted = state.transactions[stage];
  const recovering = Boolean(submitted);
  if (!submitted) {
    const populated = await signer.populateTransaction(request);
    const rawTransaction = await signer.signTransaction(populated);
    submitted = {
      rawTransaction,
      txHash: keccak256(rawTransaction),
      from: await signer.getAddress(),
      nonce: populated.nonce
    };
    state.transactions[stage] = submitted;
    await save();
  }
  await save(); // Even a same-state retry cannot broadcast after a failed durable save.
  let receipt = await canonicalReceipt(provider, submitted.txHash);
  if (receipt) return receipt;
  const known = await provider.getTransaction(submitted.txHash);
  if (!known) {
    if ((await provider.getTransactionCount(submitted.from, "latest")) > submitted.nonce) throw new Error("TRANSACTION_UNCERTAIN");
    if (recovering || submitted.broadcastIntent) throw new Error("TRANSACTION_UNCERTAIN");
    submitted.broadcastIntent = true; await save();
    await provider.broadcastTransaction(submitted.rawTransaction);
  }
  const mined = await provider.waitForTransaction(submitted.txHash, 1, 30000);
  if (!mined) throw new Error("TRANSACTION_PENDING");
  receipt = await canonicalReceipt(provider, submitted.txHash);
  if (!receipt) throw new Error("TRANSACTION_UNCERTAIN");
  return receipt;
}
export function cliFailure(error) {
  const message = error?.code ?? error?.message;
  console.error(typeof message === "string" && /^[A-Z_]{1,100}$/.test(message) ? message : "EXAMPLE_FAILED");
  process.exitCode = 1;
}

/** One durable authorization and one live writer for each wallet/domain, before the first quote. */
export async function withWalletAuthority({
  domain,
  authorizationHash,
  journalPath
}, work) {
  const {
    createHash
  } = await import('node:crypto');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const domainHash = digest({
    chainId: domain.chainId,
    account: domain.account.toLowerCase(),
    wallet: domain.wallet.toLowerCase()
  });
  const authorityPath = join(homedir(), '.local', 'state', 'agentfuel', 'economic-worker', domainHash, 'authority.json');
  return await withJournal(authorityPath, domainHash, async (authority, save) => {
    const canonicalPath = resolve(journalPath);
    if (authority.journalPath && authority.journalPath !== canonicalPath) throw Error('ORIGINAL_WORKER_JOURNAL_REQUIRED');
    if (authority.authorizationHash && authority.authorizationHash !== authorizationHash) throw Error('WALLET_AUTHORIZATION_CHANGED');
    if (!authority.journalPath) {
      authority.journalPath = canonicalPath;
      authority.authorizationHash = authorizationHash;
      await save();
    }
    return await work();
  });
}
