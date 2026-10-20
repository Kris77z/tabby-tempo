import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { Contract, Wallet } from 'ethers';
import { DockerExecutor, DEFAULT_IMAGE } from '../services/arena/src/docker.js';
import { createArenaHttpServer } from '../services/arena/src/http.js';
import { parseConfig } from '../services/arena/src/protocol.js';
import { FixedPriceSolvingRelay, FixedPriceRefunder } from '../services/provider-relay/src/fixed-price.js';
import { createHttpServer } from '../services/provider-relay/src/http.js';
import type { RelayConfig } from '../services/provider-relay/src/config.js';
import { fixture, key, read, startAnvil, stopAnvil, tx } from '../services/underwriter/test/fixture.js';
import { GOOD_CODE, modelToolResponse } from '../packages/pi-loop/test/workflow-fixture.js';
import { publicSampleFor } from '../packages/pi-loop/src/public-sample.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  args = process.argv.slice(2),
  onlineInstall = args.includes('--online-install'),
  mode = args.includes('--execute-local') ? 'execute-local' : 'shadow';
if (args.some(arg => !['--online-install', '--execute-local'].includes(arg))) throw Error('INVALID_PRIVATE_HARNESS_ARGUMENTS');
const directory = process.env.AF_IE_DIRECTORY!,
  ipc = process.env.AF_IE_IPC!,
  privateReport = process.env.AF_IE_PRIVATE_REPORT!;
if (!directory || !ipc || !privateReport) throw Error('USE_CHECK_INDEPENDENT_ECONOMY');
const baseEnv = {
  PATH: process.env.PATH!,
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  HOME: process.env.HOME!,
  npm_config_workspaces: 'false',
  npm_config_cache: process.env.npm_config_cache ?? join(process.env.HOME!, '.npm')
};
const exec = promisify(execFile),
  consumer = join(directory, 'consumer'),
  sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex'),
  json = (v: unknown) => JSON.stringify(v, (_, v) => typeof v === 'bigint' ? String(v) : v);
const files = ['package.json', 'package-lock.json', 'protocol.mjs', 'durable.mjs', 'policy.mjs', 'publisher.mjs', 'controller.mjs'];
const sourcePaths = [...files.map(n => 'examples/economic-worker/' + n), 'scripts/check-independent-economy.mjs', 'scripts/independent-economy-local.ts', 'packages/sdk/src/index.ts', 'packages/sdk/src/protocol.ts', 'services/provider-relay/src/fixed-price.ts', 'services/provider-relay/src/relay.ts', 'services/provider-relay/src/refunder.ts', 'services/arena/src/http.ts', 'services/arena/src/settler-main.ts', 'packages/pi-loop/src/provider.ts', 'packages/pi-loop/test/workflow-fixture.ts'];
let local: any,
  f: any,
  settler: ChildProcess | undefined,
  arena: any,
  relay: any,
  relayServer: any,
  proxy: any,
  controller: ChildProcess | undefined,
  modelCalls = 0;
let report: any = {
    version: 1,
    suite: 'local-independent-economy',
    mode,
    status: 'failed'
  },
  stage = 'consumer';
const children = new Set<ChildProcess>();
async function save(name: string, value: unknown) {
  const p = join(directory, name);
  await writeFile(p, json(value), {
    mode: 0o600
  });
  return p;
}
async function waitFor(fn: () => Promise<any>, code: string, timeout = 180000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await delay(20);
  }
  throw Error(code);
}
async function readMaybe(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as any).code === 'ENOENT') return null;
    throw e;
  }
}
async function role(script: string, argv: string[], secret: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(consumer, script), ...argv], {
    cwd: consumer,
    env: {
      ...baseEnv,
      HOME: join(directory, 'home'),
      ...secret
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let out = '',
    err = '';
  child.stdout!.on('data', b => out += String(b));
  child.stderr!.on('data', b => err += String(b));
  const [code] = await once(child, 'exit');
  children.delete(child);
  if (code !== 0) throw Error(err.trim().split('\n').find(l => /^[A-Z][A-Z0-9_]{0,99}$/.test(l)) ?? 'EXTERNAL_ROLE_FAILED');
  return {
    pid: child.pid!,
    result: JSON.parse(out.trim().split('\n').at(-1)!)
  };
}
function spawnController(configFile: string, catalogFile: string, journal: string, options: Record<string, string> = {}, resolveRefund = false) {
  const child = spawn(process.execPath, [join(consumer, 'controller.mjs'), configFile, catalogFile, journal, resolveRefund ? '--resolve-refund' : '--execute-local'], {
    cwd: consumer,
    env: {
      ...baseEnv,
      HOME: join(directory, 'home'),
      WORKER_PRIVATE_KEY: key(2),
      ...options
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', b => stderr += String(b));
  (child as any).failure = () => stderr.trim().split('\n').find(l => /^[A-Z][A-Z0-9_]{0,99}$/.test(l)) ?? 'CONTROLLER_EXITED';
  child.on('exit', () => children.delete(child));
  controller = child;
  return child;
}
async function kill(child: ChildProcess) {
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  const [code, signal] = await exit;
  assert.equal(signal, 'SIGKILL');
  assert.equal(code, null);
}
async function snapshot() {
  return {
    cashRaw: String(await read(f.account, 'cash', ['1'])),
    walletNonce: await f.provider.getTransactionCount(f.agentAddress),
    paymentEvents: (await f.account.queryFilter(f.account.filters.ProviderPaid(1), 0, 'latest')).length,
    settlementEvents: (await f.escrow.queryFilter(f.escrow.filters.TaskSettled(), 0, 'latest')).length,
    acceptanceEvents: (await f.escrow.queryFilter(f.escrow.filters.TaskAccepted(null, 1), 0, 'latest')).length,
    modelCalls
  };
}
async function receipt(hash: string, contract: Contract, event: string) {
  const r = await f.provider.getTransactionReceipt(hash);
  assert.ok(r);
  assert.equal(r.status, 1);
  assert.equal((await f.provider.getBlock(r.blockNumber)).hash, r.blockHash);
  const events = r.logs.filter((l: any) => l.address.toLowerCase() === String(contract.target).toLowerCase()).map((l: any) => {
    try {
      return contract.interface.parseLog(l);
    } catch {
      return null;
    }
  }).filter((e: any) => e?.name === event);
  assert.equal(events.length, 1);
  return {
    txHash: r.hash,
    blockHash: r.blockHash,
    blockNumber: r.blockNumber,
    status: r.status,
    event,
    eventCount: 1,
    values: Object.fromEntries(events[0].fragment.inputs.map((p: any, i: number) => [p.name, typeof events[0].args[i] === 'bigint' ? String(events[0].args[i]) : events[0].args[i]]))
  };
}
try {
  process.stderr.write('independent-economy: installing external consumer\n');
  execFileSync('forge', ['build', '--root', 'contracts', '--skip-lint'], {
    cwd: root,
    env: baseEnv,
    stdio: 'ignore',
    timeout: 90000
  });
  execFileSync(process.execPath, [join(root, 'packages/sdk/scripts/pack.mjs'), '--out-dir', directory], {
    cwd: root,
    env: baseEnv,
    stdio: 'ignore',
    timeout: 60000
  });
  const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async n => [n, sha(await readFile(join(root, n)))]))),
    consumerSha256: Record<string, string> = {};
  for (const name of files) {
    await mkdir(dirname(join(consumer, name)), {
      recursive: true
    });
    await copyFile(join(root, 'examples/economic-worker', name), join(consumer, name));
    consumerSha256[name] = sha(await readFile(join(consumer, name)));
  }
  try {
    execFileSync('npm', ['install', ...(onlineInstall ? [] : ['--offline']), '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', join(directory, 'agentfuel-sdk-0.0.0.tgz')], {
      cwd: consumer,
      env: baseEnv,
      stdio: 'ignore',
      timeout: 60000
    });
  } catch {
    throw Error('DEPENDENCY_ARCHIVES_MISSING');
  }
  const installed = await realpath(join(consumer, 'node_modules/@agentfuel/sdk'));
  assert.ok(!relative(await realpath(consumer), installed).startsWith('..'));
  assert.ok(!installed.startsWith(root));
  const policyModule = await import(new URL('file://' + join(consumer, 'policy.mjs')).href),
    durableModule = await import(new URL('file://' + join(consumer, 'durable.mjs')).href),
    controllerModule = await import(new URL('file://' + join(consumer, 'controller.mjs')).href);
  stage = 'infrastructure';
  process.stderr.write('independent-economy: starting owned local infrastructure\n');
  local = await startAnvil();
  f = await fixture(local.rpc, join(directory, 'underwriter'), 6, {
    refunderKey: key(4)
  });
  const publisher = new Wallet(key(11), f.provider),
    verifier = new Wallet(key(13), f.provider);
  for (const wallet of [publisher, verifier, new Wallet(key(4))]) await f.provider.send('anvil_setBalance', [wallet.address, '0x3635c9adc5dea00000']);
  await tx(f.token, f.admin, 'mint', [publisher.address, 3000000n]);
  await tx(f.escrow, f.admin, 'setVerifier', [verifier.address]);
  // Explicit startup capital: fixture cash 40000 + deposit 560000, no later top-up.
  await tx(f.account, f.agent, 'depositCash', [1, 560000n]);
  assert.equal(String(await read(f.account, 'cash', [1])), '600000');
  const problemCalls: Record<string, number> = {};
  const relayConfig: RelayConfig = {
    rpcUrl: local.rpc,
    chainId: 31337n,
    account: String(f.account.target),
    asset: f.config.settlementAsset,
    assetDecimals: 6,
    payTo: f.payee,
    service: {
      id: 'infercredit/solve-fixed',
      model: 'pi-fixed-v1',
      price: 120000n,
      upstreams: [{
        name: 'cheap',
        model: 'controlled-cheap',
        baseUrl: 'https://cheap.invalid/v1',
        key: 'synthetic'
      }, {
        name: 'strong',
        model: 'controlled-strong',
        baseUrl: 'https://strong.invalid/v1',
        key: 'synthetic'
      }]
    },
    dataDir: join(directory, 'relay'),
    quoteTtl: 300,
    confirmations: 1,
    upstreamTimeout: 3000,
    host: '127.0.0.1',
    port: 0,
    refunderKey: key(4),
    operatorToken: 'local-independent-economy-operator-token'
  };
  relay = new FixedPriceSolvingRelay(relayConfig, {
    provider: f.provider,
    runner: new DockerExecutor({
      image: DEFAULT_IMAGE
    }),
    modelFetch: async (_url, init) => {
      modelCalls++;
      const body = JSON.parse(String(init?.body)),
        problemId = JSON.stringify(body.messages).includes('JSON array of integers') ? 'sum-integers' : 'balanced-brackets';
      problemCalls[problemId] = (problemCalls[problemId] ?? 0) + 1;
      if (problemId === 'sum-integers' && problemCalls[problemId] === 2) throw Error('CONTROLLED_UNKNOWN_DISPATCH');
      const code = problemId === 'balanced-brackets' && problemCalls[problemId] === 2 ? "print('true')\n" : GOOD_CODE[problemId as keyof typeof GOOD_CODE];
      return Response.json(modelToolResponse(code, body.model));
    }
  });
  await relay.initialize();
  const refunder = new FixedPriceRefunder(relay);
  await refunder.initialize();
  relayServer = createHttpServer(relay, refunder);
  relayServer.listen(0, '127.0.0.1');
  await once(relayServer, 'listening');
  const relayOrigin = `http://127.0.0.1:${relayServer.address().port}`;
  let paidGate: {
      file: string;
      release: () => void;
    } | undefined, paidRelease: Promise<void> | undefined;
  proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.headers['x-payment-id'] && paidGate) {
        const gate = paidGate;
        paidGate = undefined;
        const state = await readMaybe(join(directory, 'controller.json'));
        const pay = await read(f.account, 'getPayment', [req.headers['x-payment-id']]);
        assert.ok(pay.fromCash > 0n);
        await durableModule.writeJson(gate.file, {
          checkpoint: 'after-payment',
          pid: controller!.pid,
          bindings: controllerModule.bindings(state)
        });
        await paidRelease;
      }
      const response = await fetch(relayOrigin + req.url, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          ...(req.headers['x-payment-id'] ? {
            'x-payment-id': String(req.headers['x-payment-id'])
          } : {}),
          ...(req.headers['x-payment-tx'] ? {
            'x-payment-tx': String(req.headers['x-payment-tx'])
          } : {})
        },
        ...(req.method === 'POST' ? {
          body
        } : {}),
        redirect: 'error'
      });
      res.writeHead(response.status, {
        'content-type': 'application/json'
      });
      res.end(await response.text());
    } catch {
      res.writeHead(503, {
        'content-type': 'application/json'
      });
      res.end('{"error":"LOCAL_PROXY_FAILED"}');
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const startedAtMs = Date.now(),
    policy = {
      version: 1,
      id: 'independent-local-cash-v1',
      chainId: '31337',
      maxTasks: 6,
      totalSpendRaw: '720000',
      maxPaymentRaw: '120000',
      reserveCashRaw: '120000',
      minProfitRaw: '20000',
      coldStartCushionRaw: '60000',
      startedAtMs,
      deadlineMs: startedAtMs + 300000
    };
  const config: any = {
    version: 1,
    chainId: '31337',
    rpcUrl: local.rpc,
    escrow: String(f.escrow.target),
    account: String(f.account.target),
    asset: f.config.settlementAsset,
    verifier: verifier.address,
    poster: publisher.address,
    provider: f.payee,
    agentId: '1',
    underwriterUrl: f.http,
    relayUrl: `http://127.0.0.1:${proxy.address().port}/v1/chat`,
    arenaUrl: 'http://127.0.0.1:1',
    policy
  };
  const configFile = await save('config.json', config),
    catalog: any[] = [],
    published: any[] = [];
  const definitions = [['sum-integers', '335000'], ['balanced-brackets', '325000'], ['sum-integers', '330000'], ['balanced-brackets', '340000'], ['balanced-brackets', '330000'], ['sum-integers', '325000'], ['sum-integers', '100000']];
  stage = 'publication';
  for (let i = 0; i < definitions.length; i++) {
    const [problemId, reward] = definitions[i],
      spec = {
        version: 1,
        problemId,
        language: 'python3',
        prompt: publicSampleFor(problemId as any).prompt
      },
      request = {
        version: 1,
        requestId: '0x' + randomBytes(32).toString('hex'),
        spec,
        reward,
        deadline: String((await f.provider.getBlock('latest')).timestamp + 1800)
      };
    const requestFile = await save(`publish-${i}.json`, request),
      manifestFile = join(directory, `manifest-${i}.json`),
      roleResult = await role('publisher.mjs', [configFile, requestFile, join(directory, `publisher-${i}.json`), manifestFile], {
        PUBLISHER_PRIVATE_KEY: key(11)
      });
    const manifest = await readMaybe(manifestFile);
    catalog.push(manifest);
    published.push({
      publisherPid: roleResult.pid,
      taskId: manifest.publication.taskId,
      problemId,
      rewardRaw: reward,
      fundedEscrowRaw: String((await f.escrow.getTask(manifest.publication.taskId)).escrowBalance),
      protocolFeeBps: manifest.publication.protocolFeeBps,
      deadlineMs: Number(request.deadline) * 1000,
      creation: await receipt(manifest.publication.creationTxHash, f.escrow, 'TaskCreated'),
      manifestSha256: policyModule.hash(manifest),
      signatureVerified: true
    });
  }
  const arenaConfig = parseConfig({
      rpcUrl: local.rpc,
      chainId: '31337',
      escrowAddress: config.escrow,
      ipcDirectory: ipc,
      tasks: Object.fromEntries(catalog.map(m => [m.publication.taskId, {
        problemId: m.spec.problemId
      }]))
    }),
    arenaFile = await save('arena.json', arenaConfig);
  settler = spawn(process.execPath, ['--import', 'tsx', join(root, 'services/arena/src/settler-main.ts')], {
    cwd: root,
    env: {
      ...baseEnv,
      ARENA_CONFIG: arenaFile,
      ARENA_VERIFIER_PRIVATE_KEY: key(13)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(Error('SETTLER_START_TIMEOUT')), 10000);
    settler!.stdout!.on('data', b => {
      if (String(b).includes('"ready":true')) {
        clearTimeout(timer);
        done();
      }
    });
    settler!.once('exit', () => reject(Error('SETTLER_EXITED')));
  });
  arena = createArenaHttpServer(arenaConfig, [], f.provider, {
    save: async (journal: any) => {
      await save('arena-http.json', journal);
    }
  });
  arena.server.listen(0, '127.0.0.1');
  await once(arena.server, 'listening');
  config.arenaUrl = `http://127.0.0.1:${arena.server.address().port}`;
  await save('config.json', config);
  const catalogFile = await save('catalog.json', catalog),
    journal = join(directory, 'controller.json');
  report = {
    version: 1,
    suite: 'local-independent-economy',
    mode,
    status: 'failed',
    startedAt: new Date(startedAtMs).toISOString(),
    provenance: {
      chainId: '31337',
      environment: 'owned-local-anvil',
      consumer: 'external-directory-installed-sdk',
      model: 'controlled-response-injection',
      evaluation: 'real-pinned-Docker-public-and-hidden-tests',
      settlement: 'independent-Arena-settler-process',
      source: {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8'
        }).trim(),
        dirty: Boolean(execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8'
        }).trim()),
        trackedDiffSha256: sha(execFileSync('git', ['diff', '--binary', 'HEAD'], {
          cwd: root
        }))
      },
      sourceSha256,
      consumerSha256,
      sdkArchiveSha256: sha(await readFile(join(directory, 'agentfuel-sdk-0.0.0.tgz')))
    },
    policy,
    policySha256: policyModule.hash(policy),
    publication: {
      tasks: published
    },
    initialFunding: {
      agentId: '1',
      startupCapitalRaw: '600000',
      ownerTopupsAfterProvisionRaw: '0',
      gameSubsidyRaw: '0',
      taskPublisherFundedRewardsRaw: String(definitions.reduce((n, d) => n + BigInt(d[1]), 0n))
    },
    scope: {
      productionNetworkUsed: false,
      publicVendorCalls: false,
      autonomousPlannerExercised: false,
      creditOptionsExercised: false,
      nativeGasValuedInUSDC: false,
      limitations: ['Owned local Anvil and a trusted signed catalog; controlled model responses.', 'Cash-only deterministic policy, no commercial demand or real provider profit claim.', 'Uncertain task continuation requires an explicit full refund and independent verifier failure closure.', 'An orphaned lock claim fails closed; manual reconciliation is required.']
    },
    interruptions: [],
    rounds: []
  };
  stage = 'shadow';
  const shadowBefore = await snapshot(),
    shadow = await role('controller.mjs', [configFile, catalogFile, journal]);
  const shadowAfter = await snapshot();
  assert.deepEqual(shadowAfter, shadowBefore);
  report.shadow = {
    before: shadowBefore,
    after: shadowAfter,
    observation: shadow.result.observation,
    decision: shadow.result.decision
  };
  if (mode === 'execute-local') {
    stage = 'interruptions';
    process.stderr.write('independent-economy: interrupting and recovering actual worker processes\n');
    const roundFile = join(directory, 'round'),
      common = {
        AF_ECON_ROUND_FILE: roundFile
      };
    let child = spawnController(configFile, catalogFile, journal, {
      ...common,
      AF_ECON_CHECKPOINT: 'before-payment',
      AF_ECON_CHECKPOINT_FILE: join(directory, 'checkpoint-1.json')
    });
    const checkpoints = ['before-payment', 'after-payment', 'after-settlement'];
    for (let i = 0; i < checkpoints.length; i++) {
      const markerFile = join(directory, `checkpoint-${i + 1}.json`),
        marker = await waitFor(async () => {
          const m = await readMaybe(markerFile);
          if (child.exitCode !== null) throw Error((child as any).failure());
          return m;
        }, 'CHECKPOINT_TIMEOUT');
      let before = await snapshot();
      const killedAt = before;
      await kill(child);
      const recoveryFile = join(directory, `recovery-${i + 1}.json`),
        nextOptions: any = {
          ...common,
          AF_ECON_RECOVERY_FILE: recoveryFile
        };
      if (i === 0) {
        let release!: () => void;
        paidRelease = new Promise<void>(done => release = done);
        paidGate = {
          file: join(directory, 'checkpoint-2.json'),
          release
        };
      }
      if (i === 1) {
        paidGate?.release(); /* gate consumed by proxy, release saved below */
      }
      if (i === 1) {
        (globalThis as any).releasePaid?.();
        await waitFor(async () => modelCalls === 1 && (await relay.status(marker.bindings.paymentId, '1', (await readMaybe(journal)).pending.handle.quote.requestDigest)).state === 'Delivered', 'ORIGINAL_DELIVERY_TIMEOUT');
        before = await snapshot();
      }
      if (i === 0) (globalThis as any).releasePaid = paidGate!.release;
      if (i === 1) {
        nextOptions.AF_ECON_CHECKPOINT = 'after-settlement';
        nextOptions.AF_ECON_CHECKPOINT_FILE = join(directory, 'checkpoint-3.json');
      }
      child = spawnController(configFile, catalogFile, journal, nextOptions);
      const recovered = await waitFor(async () => {
        const r = await readMaybe(recoveryFile);
        if (child.exitCode !== null) throw Error((child as any).failure());
        return r;
      }, 'RECOVERY_TIMEOUT');
      const after = await snapshot();
      assert.deepEqual(recovered.bindings, marker.bindings);
      assert.notEqual(child.pid, marker.pid);
      assert.deepEqual(after, before);
      report.interruptions.push({
        checkpoint: checkpoints[i],
        beforePid: marker.pid,
        afterPid: child.pid,
        signal: 'SIGKILL',
        originalProcessExited: true,
        original: marker.bindings,
        recovered: recovered.bindings,
        killedAt,
        before,
        after,
        extraPayments: 0,
        extraModelCalls: 0,
        extraSettlements: 0,
        extraAcceptances: 0
      });
      await durableModule.writeJson(recoveryFile + '.release', {
        release: true
      });
    }
    let lastSnapshot = shadowAfter,
      handled = 0,
      unknownBefore: any,
      unknownMarker: any;
    // This process accounts the recovered first task and continues the same policy.
    // Persisted round barriers let the host record effects without racing another selection.
    for (;;) {
      const state = await waitFor(async () => {
        const s = await readMaybe(journal);
        if (s?.history.length > handled) return s;
        if (s?.pending?.phase === 'unknown') return s;
        if (child.exitCode !== null) {
          if (s?.stopReason) return s;
          throw Error((child as any).failure());
        }
        return null;
      }, 'CONTROLLER_PROGRESS_TIMEOUT');
      if (state.history.length > handled) {
        const row = state.history[handled],
          after = await snapshot(),
          decision = state.decisions[row.decisionIndex];
        report.rounds.push({
          ...row,
          observation: decision.observation,
          decision: decision.decision,
          counterfactual: {
            reversedSelectedTaskId: decision.counterfactual.reversed,
            rotatedSelectedTaskId: decision.counterfactual.rotated,
            withoutFailuresSelectedTaskId: decision.counterfactual.withoutFailures,
            withoutSuccessesSelectedTaskId: decision.counterfactual.withoutSuccesses
          },
          before: lastSnapshot,
          after
        });
        lastSnapshot = after;
        handled++;
        await durableModule.writeJson(roundFile + '.' + handled + '.release', {
          release: true
        });
        continue;
      }
      if (state.pending?.phase === 'unknown') {
        if (child.exitCode === null) await once(child, 'exit');
        if (child.exitCode !== 0) throw Error((child as any).failure());
        unknownBefore = await snapshot();
        const original = controllerModule.bindings(state),
          recoveryFile = join(directory, 'unknown-recovery.json');
        child = spawnController(configFile, catalogFile, journal, {
          ...common,
          AF_ECON_RECOVERY_FILE: recoveryFile,
          AF_ECON_CHECKPOINT: 'after-unknown',
          AF_ECON_CHECKPOINT_FILE: join(directory, 'checkpoint-unknown.json')
        });
        const recovered = await waitFor(() => readMaybe(recoveryFile), 'UNKNOWN_RECOVERY_TIMEOUT');
        assert.deepEqual(recovered.bindings, original);
        assert.deepEqual(await snapshot(), unknownBefore);
        await durableModule.writeJson(recoveryFile + '.release', {
          release: true
        });
        unknownMarker = await waitFor(() => readMaybe(join(directory, 'checkpoint-unknown.json')), 'UNKNOWN_GATE_TIMEOUT');
        await kill(child);
        const noBypass = await exec(process.execPath, [join(consumer, 'controller.mjs'), configFile, catalogFile, join(directory, 'new-journal.json'), '--execute-local'], {
          cwd: consumer,
          env: {
            ...baseEnv,
            HOME: join(directory, 'home'),
            WORKER_PRIVATE_KEY: key(2)
          }
        }).then(() => false, error => String(error.stderr).includes('ORIGINAL_WORKER_JOURNAL_REQUIRED'));
        assert.equal(noBypass, true);
        const blockedAfter = await snapshot();
        assert.deepEqual(blockedAfter, unknownBefore);
        const p = state.pending,
          refundId = '0x' + randomBytes(32).toString('hex');
        const refunded = await refunder.refund(p.handle.quote.paymentId, refundId, p.handle.quote.price);
        assert.equal(refunded.state, 'Refunded');
        assert.ok(refunded.txHash);
        const terminal = await tx(f.escrow, verifier, 'settle', [p.manifest.publication.taskId, false]);
        report.unknown = {
          requestId: p.requestId,
          paymentId: p.handle.quote.paymentId,
          blockedReason: 'UNRESOLVED_PAYMENT_OR_HISTORY',
          before: unknownBefore,
          after: blockedAfter,
          extraPayments: 0,
          extraModelCalls: 0,
          newJournalBypassRejected: true,
          interruption: {
            checkpoint: 'after-unknown',
            beforePid: unknownMarker.pid,
            signal: 'SIGKILL',
            originalProcessExited: true,
            original: unknownMarker.bindings,
            recovered: recovered.bindings
          },
          resolution: {
            kind: 'provider-full-refund-and-authorized-task-failure',
            paymentId: p.handle.quote.paymentId,
            amountRaw: p.handle.quote.price,
            proofVerified: true,
            cashPaymentTaskId: '0',
            receipt: await receipt(refunded.txHash, f.manager, 'RefundProcessed'),
            taskTermination: await receipt(terminal.hash, f.escrow, 'TaskSettled'),
            terminalTaskStatus: '4',
            terminalEscrowBalanceRaw: '0'
          }
        };
        const resolvedBefore = await snapshot(),
          resolvedRecoveryFile = join(directory, 'unknown-resolved-recovery.json');
        child = spawnController(configFile, catalogFile, journal, {
          ...common,
          AF_ECON_RECOVERY_FILE: resolvedRecoveryFile
        }, true);
        const resolvedRecovered = await waitFor(() => readMaybe(resolvedRecoveryFile), 'UNKNOWN_RESOLVED_RECOVERY_TIMEOUT');
        assert.deepEqual(resolvedRecovered.bindings, unknownMarker.bindings);
        assert.deepEqual(await snapshot(), resolvedBefore);
        Object.assign(report.unknown.interruption, {
          afterPid: child.pid,
          recovered: resolvedRecovered.bindings,
          before: resolvedBefore,
          after: await snapshot(),
          extraPayments: 0,
          extraModelCalls: 0,
          extraSettlements: 0,
          extraAcceptances: 0
        });
        report.interruptions.push(report.unknown.interruption);
        await durableModule.writeJson(resolvedRecoveryFile + '.release', {
          release: true
        });
        await waitFor(async () => (await readMaybe(journal))?.pending?.phase !== 'unknown', 'UNKNOWN_RESOLUTION_PROGRESS_TIMEOUT');
        continue;
      }
      if (state.stopReason) {
        if (child.exitCode === null) await once(child, 'exit');
        assert.equal(child.exitCode, 0);
        break;
      }
    }
    const final = await readMaybe(journal);
    report.final = {
      ...(await snapshot()),
      spentRaw: final.spentRaw,
      reservedRaw: final.reservedRaw,
      taskRevenueRaw: String(final.history.reduce((n: bigint, h: any) => n + BigInt(h.revenueRaw), 0n)),
      refundRaw: String(final.history.reduce((n: bigint, h: any) => n + BigInt(h.refundedRaw), 0n)),
      netOperatingRaw: String(final.history.reduce((n: bigint, h: any) => n + BigInt(h.revenueRaw) + BigInt(h.refundedRaw) - BigInt(h.chargedRaw), 0n)),
      stopReason: final.stopReason,
      completedTasks: final.history.length
    };
    report.final.observation = final.decisions.at(-1).observation;
    report.final.decision = final.decisions.at(-1).decision;
    report.decisions = final.decisions;
    for (const row of report.rounds) row.nextChoice = final.history.find((h: any) => h.requestId === row.requestId).nextChoice ?? null;
    report.unknown.continuedRequestId = report.rounds[report.rounds.findIndex((r: any) => r.requestId === report.unknown.requestId) + 1]?.requestId;
    assert.ok(report.unknown.continuedRequestId);
    assert.equal(report.rounds.length, 6);
    assert.equal(report.final.spentRaw, '720000');
    assert.equal(report.final.reservedRaw, '0');
    assert.equal(report.final.stopReason, 'TASK_LIMIT');
    assert.ok(report.decisions.some((d: any) => d.decision.selectedTaskId !== d.counterfactual.withoutFailures));
    assert.ok(report.decisions.some((d: any) => d.decision.selectedTaskId !== d.counterfactual.withoutSuccesses));
    const replayBefore = await snapshot();
    await role('controller.mjs', [configFile, catalogFile, journal, '--execute-local'], {
      WORKER_PRIVATE_KEY: key(2)
    });
    assert.deepEqual(await snapshot(), replayBefore);
    report.replay = {
      before: replayBefore,
      after: await snapshot()
    };
  }
  for (const path of sourcePaths) assert.equal(sha(await readFile(join(root, path))), report.provenance.sourceSha256[path]);
  const publicText = json(report);
  for (const secret of [key(1), key(2), key(3), key(4), key(11), key(13), local.rpc, config.relayUrl, config.arenaUrl, f.http]) assert.equal(publicText.includes(secret), false);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.stage = stage;
  report.error = /^[A-Z][A-Z0-9_]{0,99}$/.test((error as Error).message) ? (error as Error).message : 'LOCAL_INDEPENDENT_ECONOMY_FAILED';
  report.location = (error as Error).stack?.match(/independent-economy-local\.ts:[0-9]+:[0-9]+/)?.[0];
  if (error instanceof assert.AssertionError) report.assertion = {
    operator: error.operator
  };
  process.exitCode = 1;
} finally {
  for (const child of children) await stopAnvil(child);
  if (proxy?.listening) {
    proxy.closeAllConnections();
    await new Promise<void>(done => proxy.close(() => done()));
  }
  if (relayServer?.listening) await new Promise<void>(done => relayServer.close(() => done()));
  await arena?.close();
  relay?.close();
  if (settler) await stopAnvil(settler);
  await f?.close();
  if (local) await stopAnvil(local.child);
  report.completedAt = new Date().toISOString();
  report.durationMs = report.startedAt ? Date.parse(report.completedAt) - Date.parse(report.startedAt) : 0;
}
await writeFile(privateReport, json(report) + '\n', {
  mode: 0o600,
  flag: 'wx'
});
