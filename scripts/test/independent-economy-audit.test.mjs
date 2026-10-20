import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Wallet, keccak256 } from "ethers";
import { canonicalReceipt, processIdentity, readJson, sendOnce, withJournal, writeJson } from "../../examples/economic-worker/durable.mjs";
import { decide, freezePolicy } from "../../examples/economic-worker/policy.mjs";

// These tests exercise the independent consumer's storage and transaction
// boundaries. They do not claim a chain execution; the local acceptance suite
// separately kills and restarts the installed controller against Anvil/Docker.
const moduleUrl = new URL("../../examples/economic-worker/durable.mjs", import.meta.url).href;
const launcher = new URL("../check-independent-economy.mjs", import.meta.url);
const key = n => `0x${n.toString(16).padStart(64, "0")}`;
const wallet = new Wallet(key(53));
const blockHash = key(101);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const temporary = async work => {
  const directory = await mkdtemp(join(tmpdir(), "af-independent-audit-"));
  try { return await work(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
};

function transactionHarness() {
  let receipt, known, nonce = 0, signs = 0;
  const broadcasts = [];
  const provider = {
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ hash: blockHash }),
    getTransaction: async () => known,
    getTransactionCount: async () => nonce,
    broadcastTransaction: async bytes => {
      broadcasts.push(bytes);
      receipt = { hash: keccak256(bytes), status: 1, blockNumber: 1, blockHash };
      return { hash: receipt.hash };
    },
    waitForTransaction: async () => receipt,
  };
  const signer = { provider, getAddress: () => wallet.getAddress(),
    populateTransaction: async request => ({ ...request, chainId: 31337, nonce: 0, gasLimit: 21000, gasPrice: 1 }),
    signTransaction: async request => { signs++; return wallet.signTransaction(request); } };
  return { provider, signer, broadcasts, get signs() { return signs; },
    get receipt() { return receipt; }, set receipt(value) { receipt = value; },
    set known(value) { known = value; }, set nonce(value) { nonce = value; } };
}
const transaction = { to: new Wallet(key(54)).address, value: 0 };

async function launcherFixture(directory) {
  // The fake forge always fails. A regression in early rejection therefore
  // still cannot start Anvil, Docker containers, install dependencies or pay.
  await writeFile(join(directory, "docker"), "#!/bin/sh\nprintf '%s\\n' 'unix:///audit-synthetic.sock'\n", { mode: 0o700 });
  await writeFile(join(directory, "forge"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  const legacyNode = join(directory, "legacy-node.cjs");
  await writeFile(legacyNode, "Object.defineProperty(process.versions, 'node', { value: '20.0.0' });\n", { mode: 0o600 });
  return (args, { endpoint = "tcp://audit.invalid:65535", node20 = false } = {}) => {
    const child = spawnSync(process.execPath, [...(node20 ? ["--require", legacyNode] : []), launcher.pathname, ...args], {
      cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DOCKER_HOST: endpoint,
        MODEL_API_KEY: "AUDIT_LAUNCHER_SECRET_CANARY" },
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 1);
    assert.equal(`${child.stdout}${child.stderr}`.includes("AUDIT_LAUNCHER_SECRET_CANARY"), false);
    const report = JSON.parse(child.stdout); assert.equal(report.status, "failed"); assert.deepEqual(report.cleanup.failures, []);
    return report;
  };
}

test("audit: independent launcher rejects remote Docker overrides and unsupported Node before any owned services start", async () => temporary(async directory => {
  const run = await launcherFixture(directory);
  for (const endpoint of ["tcp://127.0.0.1:65535", "ssh://audit.invalid", "http://audit.invalid"]) {
    for (const args of [[], ["--execute-local"]]) assert.equal(run(args, { endpoint }).error, "LOCAL_UNIX_DOCKER_DAEMON_REQUIRED");
  }
  assert.equal(run([], { node20: true }).error, "NODE_22_REQUIRED");
}));

test("audit: independent launcher never overwrites prior reports and rejects ambiguous execution flags", async () => temporary(async directory => {
  const run = await launcherFixture(directory), original = "ORIGINAL_RECORDED_EVIDENCE\n", target = join(directory, "existing.json"), link = join(directory, "evidence-symlink.json");
  await writeFile(target, original, { mode: 0o600 }); await symlink(target, link);
  for (const path of [target, link]) {
    assert.equal(run(["--report", path]).error, "REPORT_ALREADY_EXISTS");
    assert.equal(await readFile(target, "utf8"), original);
  }
  for (const args of [["--execute"], ["--yes"], ["--report", "relative.json"], ["--execute-local", "--execute-local"],
    ["--online-install", "--online-install"], ["--report", target, "--out-file", join(directory, "other.json")]])
    assert.equal(run(args).error, "USAGE_EXPECTS_OPTIONAL_ONLINE_INSTALL_AND_ABSOLUTE_REPORT_PATH");
}));

async function runOwnedWalletProgram(directory, source) {
  const program = `import assert from "node:assert/strict";
    import { readdir, readFile, stat } from "node:fs/promises";
    import { join } from "node:path";
    import { withWalletAuthority } from ${JSON.stringify(moduleUrl)};
    const directory = process.argv[1];
    const domain = ${JSON.stringify({ chainId: "31337", account: new Wallet(key(55)).address, wallet: wallet.address })};
    const original = { domain, authorizationHash: ${JSON.stringify("a".repeat(64))}, journalPath: join(directory, "original.json") };
    ${source}`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program, directory], {
    env: { ...process.env, HOME: join(directory, "owned-home") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", bytes => { output += bytes; });
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null, output);
  assert.equal(code, 0, output);
}

test("audit: wallet authorization binds the first journal and policy before any chain transaction exists", async () => temporary(async directory => {
  await runOwnedWalletProgram(directory, `
    let entered = 0;
    await withWalletAuthority(original, async () => { entered++; });
    await withWalletAuthority({ ...original, domain: { ...domain, account: domain.account.toUpperCase(), wallet: domain.wallet.toUpperCase() } }, async () => { entered++; });
    assert.equal(entered, 2);
    await assert.rejects(withWalletAuthority({ ...original, journalPath: join(directory, "replacement.json") }, () => assert.fail("new journal bypassed original wallet authority")), /ORIGINAL_WORKER_JOURNAL_REQUIRED/);
    await assert.rejects(withWalletAuthority({ ...original, authorizationHash: "b".repeat(64) }, () => assert.fail("new policy bypassed original wallet authority")), /WALLET_AUTHORIZATION_CHANGED/);
    const root = join(process.env.HOME, ".local", "state", "agentfuel", "economic-worker");
    const [domainDirectory] = await readdir(root);
    const path = join(root, domainDirectory, "authority.json"), authority = JSON.parse(await readFile(path, "utf8"));
    assert.equal(authority.journalPath, original.journalPath);
    assert.equal(authority.authorizationHash, original.authorizationHash);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readdir(root)).length, 1);
  `);
}));

test("audit: concurrent fresh journals cannot share one wallet writer, while independent wallets can run", async () => temporary(async directory => {
  await runOwnedWalletProgram(directory, `
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    const first = withWalletAuthority(original, async () => { entered(); await held; });
    await ready;
    try {
      await assert.rejects(withWalletAuthority({ ...original, journalPath: join(directory, "concurrent.json") }, () => assert.fail("concurrent fresh journal entered")), /JOURNAL_LOCKED/);
      await withWalletAuthority({ ...original, domain: { ...domain, wallet: ${JSON.stringify(new Wallet(key(56)).address)} }, journalPath: join(directory, "independent-wallet.json") }, async () => {});
    } finally { release(); await first; }
    await assert.rejects(withWalletAuthority({ ...original, journalPath: join(directory, "concurrent.json") }, () => assert.fail("new journal replaced the first one after its writer exited")), /ORIGINAL_WORKER_JOURNAL_REQUIRED/);
  `);
}));

const nowMs = 1_800_000_000_000;
const policy = patch => freezePolicy({ version: 1, id: "independent-audit", chainId: "31337", maxTasks: 3, totalSpendRaw: "1000", maxPaymentRaw: "500",
  reserveCashRaw: "100", minProfitRaw: "1", coldStartCushionRaw: "100", startedAtMs: nowMs - 1000, deadlineMs: nowMs + 60_000, ...patch });
const candidate = patch => ({ taskId: "1", problemId: "sum-integers", rewardRaw: "500", escrowBalanceRaw: "500", priceRaw: "100",
  protocolFeeBps: "0", status: "1", deadlineMs: nowMs + 30_000, expiresAtMs: nowMs + 10_000, observedAtMs: nowMs,
  blockNumber: 1, blockHash, paymentId: key(104), requestDigest: key(105), ...patch });
const observation = patch => ({ cashRaw: "1000", spentRaw: "0", reservedRaw: "0", candidates: [candidate()], history: [], nowMs, unresolved: false, ...patch });
function notSelected(bound, input, label) {
  try { assert.equal(decide(bound, input).status, "stopped", label); }
  catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(error.message, /^[A-Z][A-Z_]+$/, `${label}: invalid observations need a fixed public diagnostic`);
  }
}

test("audit: one original authorization enforces start, deadline, reserve, pending commitments and total spend", () => {
  const bound = policy();
  assert.equal(decide(bound, observation()).status, "selected");
  for (const [label, patch] of [
    ["not yet authorized", { nowMs: nowMs - 1001 }],
    ["authorization expired", { nowMs: bound.deadlineMs }],
    ["reserve cannot be spent", { cashRaw: "199" }],
    ["pending reservation is still a liability", { cashRaw: "250", reservedRaw: "51" }],
    ["spent plus reservations consumes total budget", { spentRaw: "850", reservedRaw: "51" }],
    ["unknown original work blocks every new candidate", { unresolved: true }],
  ]) notSelected(bound, observation(patch), label);
  assert.equal(decide(bound, observation({ cashRaw: "200" })).status, "selected");
  assert.equal(decide(bound, observation({ spentRaw: "850", reservedRaw: "50" })).status, "selected");
});

test("audit: malformed task clocks, raw units and unfunded or expired candidates cannot be admitted", () => {
  for (const field of ["deadlineMs", "expiresAtMs", "observedAtMs"]) {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, nowMs + 0.5])
      notSelected(policy(), observation({ candidates: [candidate({ [field]: value })] }), `${field}=${value}`);
  }
  for (const patch of [
    { deadlineMs: nowMs }, { expiresAtMs: nowMs }, { observedAtMs: nowMs + 1 }, { observedAtMs: nowMs - 10001 },
    { priceRaw: "0" }, { priceRaw: "0100" }, { protocolFeeBps: "10001" }, { rewardRaw: "0" },
    { escrowBalanceRaw: "499" }, { status: "2" }, { priceRaw: (1n << 256n).toString() },
  ]) notSelected(policy(), observation({ candidates: [candidate(patch)] }), JSON.stringify(patch));
});

test("audit: authorization rejects unbounded values and execution options outside cash-only local scope", () => {
  for (const patch of [
    { chainId: "10143" }, { allowCredit: true }, { rpcUrl: "https://example.invalid" }, { privateKey: "AUDIT_PRIVATE_KEY" },
    { totalSpendRaw: (1n << 256n).toString() }, { reserveCashRaw: "-1" }, { maxTasks: 1.5 },
  ]) assert.throws(() => policy(patch), /^[A-Z_]+$|INVALID_POLICY/);
});

test("audit: atomic journals are private, survive a fresh read, and leave no transient files", async () => temporary(async directory => {
  const path = join(directory, "nested", "state.json");
  await writeJson(path, { version: 1, original: { budgetRaw: "100", reservedRaw: "40" } });
  assert.deepEqual(await readJson(path), { version: 1, original: { budgetRaw: "100", reservedRaw: "40" } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(directory, "nested")), ["state.json"]);
  await writeJson(path, { version: 1, original: { budgetRaw: "100", reservedRaw: "0" } });
  assert.equal((await readJson(path)).original.budgetRaw, "100");
  assert.deepEqual(await readdir(join(directory, "nested")), ["state.json"]);
}));

test("audit: a failed durable write cannot authorize a broadcast on the same in-memory retry", async () => {
  const h = transactionHarness(), state = { transactions: {} };
  let canPersist = false, durable;
  const save = async () => {
    if (!canPersist) throw new Error("AUDIT_DISK_UNAVAILABLE");
    durable = structuredClone(state);
  };
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(sendOnce(state, save, "accept", h.signer, transaction), /AUDIT_DISK_UNAVAILABLE/);
    assert.equal(h.broadcasts.length, 0, "a caught save failure must not leave an unsaved broadcastable transaction");
  }
  canPersist = true;
  await assert.rejects(sendOnce(state, save, "accept", h.signer, transaction), /TRANSACTION_UNCERTAIN/);
  assert.equal(h.broadcasts.length, 0, "later persistence cannot silently reopen a failed transaction admission");
  assert.equal(durable.transactions.accept.rawTransaction, state.transactions.accept.rawTransaction);
  assert.equal(durable.transactions.accept.txHash, keccak256(state.transactions.accept.rawTransaction));
});

test("audit: broadcast acknowledgement loss resumes original bytes from disk without signing again", async () => temporary(async directory => {
  const h = transactionHarness(), path = join(directory, "transaction.json"), state = { transactions: {} };
  const originalBroadcast = h.provider.broadcastTransaction;
  h.provider.broadcastTransaction = async bytes => {
    assert.ok((await readJson(path)).transactions.accept.rawTransaction === bytes, "the complete signed intent must precede broadcast");
    await originalBroadcast(bytes);
    throw new Error("AUDIT_ACK_LOST");
  };
  await assert.rejects(sendOnce(state, () => writeJson(path, state), "accept", h.signer, transaction), /AUDIT_ACK_LOST/);
  const reloaded = await readJson(path), before = await readFile(path, "utf8");
  const resumedSigner = { ...h.signer, populateTransaction: () => assert.fail("recovery must not populate a replacement transaction"),
    signTransaction: () => assert.fail("recovery must not sign a replacement transaction") };
  const result = await sendOnce(reloaded, () => writeJson(path, reloaded), "accept", resumedSigner, { to: new Wallet(key(55)).address });
  assert.equal(result.hash, reloaded.transactions.accept.txHash);
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.signs, 1);
  assert.equal(sha(await readFile(path)), sha(before), "recovery preserves the private signed intent bytes");
}));

test("audit: a saved transaction with a consumed nonce or noncanonical receipt never signs or broadcasts again", async () => {
  for (const mode of ["nonce-consumed", "noncanonical", "reverted"]) {
    const h = transactionHarness(), state = { transactions: {} };
    h.provider.broadcastTransaction = async () => { throw new Error("AUDIT_BROADCAST_DEFERRED"); };
    await assert.rejects(sendOnce(state, async () => {}, "accept", h.signer, transaction), /AUDIT_BROADCAST_DEFERRED/);
    if (mode === "nonce-consumed") h.nonce = 1;
    else h.receipt = { hash: state.transactions.accept.txHash, status: mode === "reverted" ? 0 : 1, blockNumber: 1,
      blockHash: mode === "noncanonical" ? key(102) : blockHash };
    h.provider.broadcastTransaction = () => assert.fail("uncertain or invalid original payment cannot be replaced");
    const priorSigns = h.signs;
    await assert.rejects(sendOnce(state, async () => {}, "accept", h.signer, transaction),
      mode === "nonce-consumed" ? /TRANSACTION_UNCERTAIN/ : mode === "noncanonical" ? /NONCANONICAL_RECEIPT/ : /TRANSACTION_REVERTED/);
    assert.equal(h.signs, priorSigns);
  }
  await assert.rejects(canonicalReceipt({ getTransactionReceipt: async () => ({ blockNumber: 1, blockHash, status: 1 }),
    getBlock: async () => null }, key(103)), /NONCANONICAL_RECEIPT/);
});

test("audit: an active writer excludes a second writer and changed authorization does not touch its journal", async () => temporary(async directory => {
  const path = join(directory, "controller.json");
  await writeJson(path, { version: 1, binding: "original-authorization", transactions: {}, spentRaw: "40", reservedRaw: "20" });
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const first = withJournal(path, "original-authorization", async state => { entered(); await blocked; return state; });
  await ready;
  const before = await readFile(path, "utf8"), names = (await readdir(directory)).sort();
  try {
    await assert.rejects(withJournal(path, "original-authorization", () => assert.fail("a second live writer entered")), /JOURNAL_LOCKED/);
    await assert.rejects(withJournal(path, "changed-authorization", () => assert.fail("changed authorization entered")), /JOURNAL_BINDING_MISMATCH/);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual((await readdir(directory)).sort(), names);
  } finally { release(); await first; }
  assert.deepEqual((await readJson(path)), JSON.parse(before));
  assert.deepEqual(await readdir(directory), ["controller.json"]);
}));

test("audit: recycled process identifiers are distinguished from live owners, and stale-lock reapers remain exclusive", async () => temporary(async directory => {
  const path = join(directory, "controller.json"), lock = `${path}.lock`;
  await writeJson(path, { version: 1, binding: "original", transactions: {} });
  await writeJson(lock, { version: 1, pid: process.pid, hostname: hostname(), startIdentity: `${processIdentity()}-different-birth`, token: "original-stale-token" });
  let active = 0, entered = 0;
  const races = await Promise.allSettled(Array.from({ length: 8 }, () => withJournal(path, "original", async () => {
    active++; entered++; assert.equal(active, 1, "two stale-lock reapers entered the same wallet journal");
    await delay(40); active--;
  })));
  assert.equal(entered, 1);
  assert.equal(races.filter(result => result.status === "fulfilled").length, 1);
  for (const result of races.filter(result => result.status === "rejected")) assert.match(result.reason.message, /JOURNAL_LOCKED/);
  assert.equal(process.kill(process.pid, 0), true, "recovering a recycled PID must not terminate that process");
  assert.deepEqual(await readdir(directory), ["controller.json"]);
}));

test("audit: malformed, foreign-host and orphan-claim locks fail closed without changing the original bytes", async () => temporary(async directory => {
  const path = join(directory, "controller.json"), lock = `${path}.lock`;
  await writeJson(path, { version: 1, binding: "original", transactions: {}, reservedRaw: "100" });
  const original = await readFile(path, "utf8");
  for (const bytes of ["not-json", JSON.stringify({ pid: process.pid }), JSON.stringify({ version: 1, pid: process.pid,
    hostname: "unrelated-audit-host", startIdentity: processIdentity(), token: "foreign-owner" })]) {
    await writeFile(lock, bytes, { mode: 0o600 });
    await assert.rejects(withJournal(path, "original", () => assert.fail("uncertain lock owner was treated as absent")));
    assert.equal(await readFile(lock, "utf8"), bytes);
    assert.equal(await readFile(path, "utf8"), original);
  }
  await rm(lock);
  await writeFile(`${path}.claim`, "orphan-claim", { mode: 0o600 });
  await assert.rejects(withJournal(path, "original", () => assert.fail("orphan reaper claim was stolen")), /JOURNAL_LOCKED/);
  assert.equal(await readFile(`${path}.claim`, "utf8"), "orphan-claim");
  assert.equal(await readFile(path, "utf8"), original);
}));

test("audit: killing an actual lock holder permits recovery while preserving original budget and reservation", { timeout: 15000 }, async () => temporary(async directory => {
  const path = join(directory, "controller.json"), saved = { version: 1, binding: "persisted-authorization", transactions: {}, spentRaw: "40", reservedRaw: "20", pending: { requestId: "original-request" } };
  await writeJson(path, saved);
  const source = `import { withJournal } from ${JSON.stringify(moduleUrl)};
    await withJournal(process.argv[1], "persisted-authorization", async () => {
      process.stdout.write("AUDIT_LOCK_READY\\n");
      await new Promise(() => { setInterval(() => {}, 1000); });
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, path], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes; });
  const exit = once(child, "exit");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`AUDIT_LOCK_START_TIMEOUT: ${stderr}`)), 5000);
      child.stdout.on("data", bytes => { output += bytes; if (output.includes("AUDIT_LOCK_READY")) { clearTimeout(timer); resolve(); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); if (!output.includes("AUDIT_LOCK_READY")) reject(new Error(`AUDIT_LOCK_EARLY_EXIT: ${stderr}`)); });
    });
    await assert.rejects(withJournal(path, saved.binding, () => assert.fail("live child lock was stolen")), /JOURNAL_LOCKED/);
    child.kill("SIGKILL");
    const [, signal] = await exit;
    assert.equal(signal, "SIGKILL");
    // Yield to the OS reaper; this is a new writer with a fresh journal read.
    await delay(10);
    await withJournal(path, saved.binding, async (state, save) => { assert.deepEqual(state, saved); state.recoveryObserved = true; await save(); });
    assert.deepEqual(await readJson(path), { ...saved, recoveryObserved: true });
    assert.deepEqual(await readdir(directory), ["controller.json"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
  }
}));
