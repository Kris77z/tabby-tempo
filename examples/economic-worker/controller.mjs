import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes, Transaction } from 'ethers';
import { InferCredit, PaymentError, requestDigest, paymentId, accountInterface } from '@agentfuel/sdk';
import { readJson, writeJson, withJournal, withWalletAuthority, sendOnce, canonicalReceipt, cliFailure } from './durable.mjs';
import { configValue, digest, same, verifyPublication, verifyDeployment, SUBMISSION_TYPES } from './protocol.mjs';
import { hash, freezePolicy, decide } from './policy.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ACCOUNT = ['function cash(uint256) view returns(uint256)', 'function getPayment(bytes32) view returns(tuple(uint256 agentId,uint256 taskId,uint256 fromCash,uint256 fromCredit,uint256 refundedAmount))', 'event ProviderPaid(uint256 indexed agentId,address indexed provider,bytes32 indexed paymentId,uint256 fromCash,uint256 fromCredit)'];
export function bindings(state) {
  const p = state.pending;
  return {
    requestId: p?.requestId ?? null,
    paymentId: p?.handle?.quote.paymentId ?? null,
    quoteSha256: p ? hash(p.handle.quote) : null,
    inputSha256: p ? hash(p.handle.input) : null,
    acceptSignedBytesSha256: p?.transactions.accept ? sha(p.transactions.accept.rawTransaction) : null,
    paymentSignedBytesSha256: p?.handle.submission?.rawTransaction ? sha(p.handle.submission.rawTransaction) : null,
    policySha256: state.policySha256,
    spentRaw: state.spentRaw,
    reservedRaw: state.reservedRaw,
    completedTasks: state.history.length,
    pendingRequestId: p?.requestId ?? null
  };
}
async function gate(name, state) {
  if (process.env.AF_ECON_CHECKPOINT !== name) return;
  await writeJson(process.env.AF_ECON_CHECKPOINT_FILE, {
    checkpoint: name,
    pid: process.pid,
    bindings: bindings(state)
  });
  for (;;) await delay(1000);
}
async function request(url, init) {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.json();
  if (!response.ok) throw Error(/^[A-Z_]+$/.test(body.error) ? body.error : 'REMOTE_UNAVAILABLE');
  return body;
}
async function receipt(provider, txHash, contract, eventName) {
  const r = await canonicalReceipt(provider, txHash);
  if (!r) throw Error('CANONICAL_RECEIPT_REQUIRED');
  const events = r.logs.filter(l => same(l.address, String(contract.target))).map(l => {
    try {
      return contract.interface.parseLog(l);
    } catch {
      return null;
    }
  }).filter(e => e?.name === eventName);
  if (events.length !== 1) throw Error('EVENT_PROOF_REQUIRED');
  return {
    txHash: r.hash,
    blockHash: r.blockHash,
    blockNumber: r.blockNumber,
    status: r.status,
    event: eventName,
    eventCount: events.length,
    values: Object.fromEntries(events[0].fragment.inputs.map((p, i) => [p.name, typeof events[0].args[i] === 'bigint' ? String(events[0].args[i]) : events[0].args[i]]))
  };
}
export async function dispatchAdmission(state,p,provider,escrow,save,h) {
 const check=async(own)=>{
  const task=await escrow.getTask(p.manifest.publication.taskId),block=await provider.getBlock('latest');
  if(state.stopReason||state.sealed||state.terminal||(own?p.dispatchAdmission!==own:p.dispatchAdmission!==undefined)||Date.now()<state.policy.startedAtMs||Date.now()>=state.policy.deadlineMs||Date.now()>=Number(task.deadline)*1000||!block||BigInt(block.timestamp)>=task.deadline||task.status!==2n||String(task.agentId)!==h.input.agentId||hash(h.quote)!==hash(p.handle.quote)||hash(h.input)!==hash(p.handle.input)||BigInt(state.spentRaw)+BigInt(state.reservedRaw)>BigInt(state.policy.totalSpendRaw)) throw new PaymentError('DISPATCH_NOT_AUTHORIZED','No new dispatch after stop, unknown or deadline');
 };
 await check();const reservation={paymentId:h.quote.paymentId,attempts:1};p.dispatchAdmission=reservation;await save();
 if(p.dispatchAdmission!==reservation)throw new PaymentError('DISPATCH_NOT_AUTHORIZED','Admission changed while saving');
 await check(reservation);
}
/** Cold accounting must re-prove the saved settlement before recording income. */
export async function revalidateSettlement(config,p,provider,escrow,account) {
 const taskId=p.manifest.publication.taskId, saved=p.settlement;
 if(!saved || !['succeeded','failed','refunded'].includes(p.outcome))throw Error('SETTLEMENT_PROOF_REQUIRED');
 const fresh=await receipt(provider,saved.txHash,escrow,'TaskSettled');
 const tx=await provider.getTransaction(fresh.txHash),task=await escrow.getTask(taskId);
 const passed=p.outcome==='succeeded';
 if(fresh.blockHash!==saved.blockHash || fresh.blockNumber!==saved.blockNumber || !tx || !same(tx.from,config.verifier) || !same(tx.to,config.escrow) || fresh.values.taskId!==taskId || fresh.values.passed!==passed || String(task.agentId)!==config.agentId || task.status!==(passed?3n:4n) || task.escrowBalance!==0n) throw Error('SETTLEMENT_CHAIN_MISMATCH');
 if(p.outcome==='refunded'){
  const payment=await account.getPayment(p.handle.quote.paymentId);
  if(payment.agentId!==BigInt(config.agentId)||payment.taskId!==0n||payment.fromCredit!==0n||payment.fromCash!==BigInt(p.handle.quote.price)||payment.refundedAmount!==payment.fromCash||p.refundResolution?.kind!=='provider-full-refund-and-authorized-task-failure')throw Error('REFUND_TERMINATION_PROOF_REQUIRED');
 }else if(p.run?.taskId!==taskId || p.run?.result?.settlement?.txHash!==fresh.txHash || p.run?.result?.verdict?.taskId!==taskId || p.run?.result?.verdict?.agentId!==config.agentId || p.run?.result?.verdict?.mode!=='docker' || p.run.result.verdict.passed!==passed)throw Error('ARENA_RESULT_MISMATCH');
 return fresh;
}
export async function control(config, catalog, journalPath, privateKey, mode = 'shadow') {
  configValue(config);
  freezePolicy(config.policy);
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, {
    cacheTimeout: -1,
    pollingInterval: 100
  });
  try {
    const escrow = await verifyDeployment(config, provider),
      account = new Contract(config.account, ACCOUNT, provider),
      signer = privateKey ? new Wallet(privateKey, provider) : undefined;
    if (signer && (same(signer.address, config.poster) || same(signer.address, config.verifier))) throw Error('WORKER_ROLE_MISMATCH');
    const adapter = new Contract(await escrow.adapter(), ['function resolveAgent(uint256) view returns(address owner,address wallet)'], provider),
      identity = await adapter.resolveAgent(config.agentId);
    if (signer && !same(signer.address, identity.wallet)) throw Error('WORKER_WALLET_MISMATCH');
    const observe = async () => {
      const candidates = [];
      for (const manifest of catalog) {
        const {
          task
        } = await verifyPublication(config, manifest, provider);
        if (task.status !== 1n) continue;
        const input = {
          agentId: config.agentId,
          taskId: manifest.publication.taskId,
          service: 'infercredit/solve-fixed',
          model: 'pi-fixed-v1',
          messages: [{
            role: 'user',
            content: manifest.spec.prompt
          }],
          solve: {
            version: 1,
            problemId: manifest.spec.problemId,
            tiers: ['cheap', 'strong'],
            maxRounds: 2,
            maxToolCalls: 4,
            maxCompletionTokens: 256,
            deadlineMs: config.policy.deadlineMs
          }
        };
        const response = await fetch(config.relayUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(input),
          redirect: 'error',
          signal: AbortSignal.timeout(5000)
        });
        if (response.status !== 402) throw Error('QUOTE_REQUIRED');
        const {
          quote
        } = await response.json();
        if (quote.chainId !== config.chainId || quote.agentId !== config.agentId || quote.taskId !== input.taskId || quote.requestDigest !== requestDigest(input) || quote.paymentId !== paymentId(input.taskId, quote.requestDigest, quote.serverNonce) || !same(quote.account, config.account) || !same(quote.asset, config.asset) || !same(quote.payTo, config.provider) || quote.service !== input.service || quote.model !== input.model || quote.price !== config.policy.maxPaymentRaw) throw Error('QUOTE_BINDING_MISMATCH');
        const block = await provider.getBlock('latest');
        candidates.push({
          taskId: input.taskId,
          problemId: manifest.spec.problemId,
          rewardRaw: String(task.reward),
          escrowBalanceRaw: String(task.escrowBalance),
          protocolFeeBps: String(task.protocolFeeBps),
          status: String(task.status),
          deadlineMs: Number(task.deadline) * 1000,
          priceRaw: quote.price,
          expiresAtMs: Number(quote.quoteExpiry) * 1000,
          observedAtMs: Date.now(),
          blockNumber: block.number,
          blockHash: block.hash,
          paymentId: quote.paymentId,
          requestDigest: quote.requestDigest,
          manifest,
          input,
          quote
        });
      }
      return candidates;
    };
    return await withWalletAuthority({
      domain: {
        chainId: config.chainId,
        account: config.account,
        wallet: identity.wallet
      },
      authorizationHash: hash({
        config,
        catalog
      }),
      journalPath
    }, async () => await withJournal(journalPath, hash({
      config,
      catalog
    }), async (state, save) => {
      if (!state.policy) {
        Object.assign(state, {
          policy: config.policy,
          policySha256: hash(config.policy),
          history: [],
          decisions: [],
          spentRaw: '0',
          reservedRaw: '0'
        });
        await save();
      }
      if (state.policySha256 !== hash(config.policy)) throw Error('POLICY_CHANGED');
      // Chain history anchors the wallet to its original journal even if a caller chooses a new path.
      const accepted = await escrow.queryFilter(escrow.filters.TaskAccepted(null, config.agentId), 0, 'latest');
      const knownTasks = new Set([...state.history.map(h => h.taskId), ...(state.pending ? [state.pending.manifest.publication.taskId] : [])]);
      if (accepted.some(e => !knownTasks.has(String(e.args.taskId)))) throw Error('ORIGINAL_WORKER_JOURNAL_REQUIRED');
      const paid = await account.queryFilter(account.filters.ProviderPaid(config.agentId), 0, 'latest');
      const knownPayments = new Set([...state.history.map(h => h.quote.paymentId), ...(state.pending ? [state.pending.handle.quote.paymentId] : [])]);
      if (paid.some(e => !knownPayments.has(e.args.paymentId))) throw Error('ORIGINAL_WORKER_JOURNAL_REQUIRED');
      const chainSpent = paid.reduce((n, e) => n + e.args.fromCash + e.args.fromCredit, 0n),
        pendingPaid = state.pending && !state.pending.charged && paid.some(e => e.args.paymentId === state.pending.handle.quote.paymentId) ? BigInt(state.pending.handle.quote.price) : 0n;
      if (chainSpent !== BigInt(state.spentRaw) + pendingPaid) throw Error('DURABLE_ACCOUNTING_MISMATCH');
      if (process.env.AF_ECON_RECOVERY_FILE) {
        await writeJson(process.env.AF_ECON_RECOVERY_FILE, {
          pid: process.pid,
          bindings: bindings(state)
        });
        while (!(await readJson(process.env.AF_ECON_RECOVERY_FILE + '.release'))) await delay(20);
      }
      const observation = async (unresolved = false) => ({
        candidates: await observe(),
        history: state.history.map(({
          privateRun,
          ...h
        }) => h),
        cashRaw: String(await account.cash(config.agentId)),
        spentRaw: state.spentRaw,
        reservedRaw: state.reservedRaw,
        nowMs: Date.now(),
        unresolved
      });
      if (mode === 'shadow') {
        const input = await observation(Boolean(state.pending));
        return {
          state: 'Shadow',
          observation: publicObservation(input),
          decision: decide(state.policy, input)
        };
      }
      if (!signer) throw Error('WORKER_KEY_REQUIRED');
      for (;;) {
        if (!state.pending) {
          const input = await observation(),
            decision = decide(state.policy, input);
          state.decisions.push({
            observation: publicObservation(input),
            decision,
            counterfactual: {
              rotated: decide(state.policy, {
                ...input,
                candidates: [...input.candidates.slice(2), ...input.candidates.slice(0, 2)]
              }).selectedTaskId,
              reversed: decide(state.policy, {
                ...input,
                candidates: [...input.candidates].reverse()
              }).selectedTaskId,
              withoutFailures: decide(state.policy, {
                ...input,
                history: input.history.filter(h => h.outcome !== 'failed')
              }).selectedTaskId,
              withoutSuccesses: decide(state.policy, {
                ...input,
                history: input.history.filter(h => h.outcome !== 'succeeded')
              }).selectedTaskId
            }
          });
          if (state.history.length) state.history.at(-1).nextChoice = decision.selectedTaskId;
          if (decision.status === 'stopped') {
            state.stopReason = decision.stopReason;
            await save();
            return {
              state: 'Stopped',
              stopReason: decision.stopReason
            };
          }
          const c = input.candidates.find(c => c.taskId === decision.selectedTaskId);
          state.pending = {
            requestId: randomUUID(),
            manifest: c.manifest,
            transactions: {},
            handle: {
              version: 1,
              relayUrl: config.relayUrl,
              input: c.input,
              quote: c.quote,
              creditNonce: BigInt(keccak256(randomBytes(32))).toString()
            },
            decisionIndex: state.decisions.length - 1,
            phase: 'intent',
            intentSha256: hash({
              policySha256: state.policySha256,
              manifest: c.manifest,
              input: c.input,
              quote: c.quote
            })
          };
          state.reservedRaw = c.priceRaw;
          await save();
        }
        const p = state.pending,
          taskId = p.manifest.publication.taskId;
        if (p.intentSha256 !== hash({
          policySha256: state.policySha256,
          manifest: p.manifest,
          input: p.handle.input,
          quote: p.handle.quote
        })) throw Error('DURABLE_INTENT_CHANGED');
        if (p.phase === 'unknown') {
          if (mode !== 'resolve-refund') {
            state.stopReason = 'UNRESOLVED_PAYMENT_OR_HISTORY';
            await save();
            await gate('after-unknown', state);
            return {
              state: 'Blocked',
              reason: state.stopReason,
              bindings: bindings(state)
            };
          }
          const payment = await account.getPayment(p.handle.quote.paymentId),
            url = new URL(p.handle.relayUrl);
          url.pathname = `/payments/${p.handle.quote.paymentId}`;
          url.search = new URLSearchParams({
            agentId: config.agentId,
            requestDigest: p.handle.quote.requestDigest
          });
          const view = await request(url),
            task = await escrow.getTask(taskId);
          if (payment.agentId !== BigInt(config.agentId) || payment.taskId !== 0n || payment.fromCredit !== 0n || payment.fromCash !== BigInt(p.handle.quote.price) || payment.refundedAmount !== payment.fromCash || view.paymentId !== p.handle.quote.paymentId || view.state !== 'Refunded' || task.status !== 4n || task.escrowBalance !== 0n || String(task.agentId) !== config.agentId) throw Error('REFUND_TERMINATION_PROOF_REQUIRED');
          const terminations = await escrow.queryFilter(escrow.filters.TaskSettled(taskId), 0, 'latest');
          if (terminations.length !== 1) throw Error('TASK_TERMINATION_PROOF_REQUIRED');
          p.settlement = await receipt(provider, terminations[0].transactionHash, escrow, 'TaskSettled');
          const terminationTx = await provider.getTransaction(p.settlement.txHash);
          if (!terminationTx || !same(terminationTx.from, config.verifier) || p.settlement.values.taskId !== taskId || p.settlement.values.passed !== false) throw Error('TASK_TERMINATION_PROOF_REQUIRED');
          p.refundResolution = {
            kind: 'provider-full-refund-and-authorized-task-failure',
            amountRaw: String(payment.refundedAmount),
            proofVerified: true,
            taskStatus: '4'
          };
          p.outcome = 'refunded';
          p.phase = 'accounting';
          await save();
        }
        if (p.phase !== 'accounting') {
          if (!p.delivery) {
            const accepted = p.transactions.accept ? await canonicalReceipt(provider, p.transactions.accept.txHash) : undefined;
            if (!accepted) {
              const task = await escrow.getTask(taskId);
              if (Date.now() < state.policy.startedAtMs || Date.now() >= state.policy.deadlineMs || Date.now() >= Number(task.deadline) * 1000 || Date.now() >= Number(p.handle.quote.quoteExpiry) * 1000) throw Error('TIME_LIMIT');
            }
            await sendOnce(p, save, 'accept', signer, await escrow.acceptTask.populateTransaction(taskId, config.agentId));
            const client = new InferCredit({
              agentId: config.agentId,
              rpcUrl: config.rpcUrl,
              sessionKey: privateKey,
              chainId: BigInt(config.chainId),
              account: config.account,
              asset: config.asset,
              provider: config.provider,
              maxPrice: BigInt(state.policy.maxPaymentRaw),
              timeoutMs: 60000,
              onHandle: async h => {
                if (hash(h.quote) !== hash(p.handle.quote) || hash(h.input) !== hash(p.handle.input)) throw Error('ORIGINAL_HANDLE_CHANGED');
                p.handle = h;
                await save();
                if (h.submission?.rawTransaction) await gate('before-payment', state);
              },
              beforeDispatch: h => dispatchAdmission(state,p,provider,escrow,save,h),
              beforePayment: async h => {
                const payment = await account.getPayment(h.quote.paymentId);
                if (payment.fromCash + payment.fromCredit > 0n) return;
                const task = await escrow.getTask(taskId);
                if (task.status !== 2n || String(task.agentId) !== config.agentId) throw Error('TASK_NOT_ASSIGNED');
                if (Date.now() >= state.policy.deadlineMs || Date.now() >= Number(task.deadline) * 1000) throw Error('TIME_LIMIT');
                if (BigInt(state.spentRaw) + BigInt(state.reservedRaw) > BigInt(state.policy.totalSpendRaw) || BigInt(await account.cash(config.agentId)) - BigInt(h.quote.price) < BigInt(state.policy.reserveCashRaw)) throw Error('PAYMENT_BOUNDS');
                if (h.submission?.rawTransaction) {
                  const tx = Transaction.from(h.submission.rawTransaction),
                    args = accountInterface.decodeFunctionData('payProvider', tx.data);
                  if (args[4].principalCap !== 0n) throw Error('CASH_ONLY_REQUIRED');
                }
              }
            });
            try {
              p.delivery = await client.resume(p.handle);
              p.phase = 'delivered';
              await save();
            } catch (error) {
              if (error instanceof PaymentError && error.code === 'SOLVE_DISPATCH_UNKNOWN') {
                p.phase = 'unknown';
                state.spentRaw = String(BigInt(state.spentRaw) + BigInt(p.handle.quote.price));
                state.reservedRaw = p.handle.quote.price;
                p.charged = true;
                await save();
                continue;
              }
              throw error;
            } finally {
              client.close();
            }
          }
          if (!p.charged) {
            state.spentRaw = String(BigInt(state.spentRaw) + BigInt(p.handle.quote.price));
            p.charged = true;
            state.reservedRaw = '0';
            await save();
          }
          const result = p.delivery.result;
          if (result.schema !== 1 || result.taskId !== taskId || sha(result.code) !== result.codeHash) throw Error('PAID_ARTIFACT_MISMATCH');
          if (!p.submission) {
            const deadline = String((await provider.getBlock('latest')).timestamp + 240),
              message = {
                taskId,
                agentId: config.agentId,
                codeHash: keccak256(toUtf8Bytes(result.code)),
                deadline
              };
            p.submission = {
              taskId,
              code: result.code,
              deadline,
              signature: await signer.signTypedData({
                name: 'InferCreditArena',
                version: '1',
                chainId: config.chainId,
                verifyingContract: config.escrow
              }, SUBMISSION_TYPES, message)
            };
            await save();
          }
          if (!p.runId) {
            const admitted = await request(`${config.arenaUrl}/submissions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json'
              },
              body: JSON.stringify(p.submission)
            });
            if (admitted.taskId !== taskId) throw Error('ARENA_ADMISSION_MISMATCH');
            p.runId = admitted.runId;
            await save();
          }
          if (!p.run) {
            const until = Date.now() + 120000;
            while (Date.now() < until) {
              const run = await request(`${config.arenaUrl}/runs/${p.runId}`);
              if (run.status === 'error') throw Error(run.error ?? 'ARENA_ERROR');
              if (run.status === 'settled') {
                p.run = run;
                await save();
                break;
              }
              await delay(100);
            }
            if (!p.run) throw Error('ARENA_PENDING');
          }
          const verdict = p.run.result?.verdict;
          if (verdict.taskId !== taskId || verdict.problemId !== p.manifest.spec.problemId || verdict.agentId !== config.agentId || verdict.mode !== 'docker') throw Error('ARENA_RESULT_MISMATCH');
          p.settlement = await receipt(provider, p.run.result.settlement.txHash, escrow, 'TaskSettled');
          const task = await escrow.getTask(taskId);
          if (p.settlement.values.taskId !== taskId || p.settlement.values.passed !== verdict.passed || task.status !== (verdict.passed ? 3n : 4n) || task.escrowBalance !== 0n) throw Error('SETTLEMENT_CHAIN_MISMATCH');
          p.outcome = verdict.passed ? 'succeeded' : 'failed';
          p.phase = 'accounting';
          await save();
          await gate('after-settlement', state);
        }
        p.settlement = await revalidateSettlement(config,p,provider,escrow,account);
        const paymentProof = await receipt(provider, p.handle.submission.txHash, account, 'ProviderPaid');
        if (paymentProof.values.paymentId !== p.handle.quote.paymentId || paymentProof.values.agentId !== config.agentId || paymentProof.values.fromCash !== p.handle.quote.price || paymentProof.values.fromCredit !== '0' || !same(paymentProof.values.provider, config.provider)) throw Error('PAYMENT_PROOF_MISMATCH');
        const acceptanceProof = await receipt(provider, p.transactions.accept.txHash, escrow, 'TaskAccepted');
        if (acceptanceProof.values.taskId !== taskId || acceptanceProof.values.agentId !== config.agentId || !same(acceptanceProof.values.wallet, signer.address) || acceptanceProof.blockNumber >= paymentProof.blockNumber) throw Error('ACCEPTANCE_PROOF_MISMATCH');
        const row = {
          requestId: p.requestId,
          taskId,
          problemId: p.manifest.spec.problemId,
          decisionIndex: p.decisionIndex,
          quote: {
            paymentId: p.handle.quote.paymentId,
            requestDigest: p.handle.quote.requestDigest,
            priceRaw: p.handle.quote.price
          },
          outcome: p.outcome,
          chargedRaw: p.handle.quote.price,
          refundedRaw: p.outcome === 'refunded' ? p.handle.quote.price : '0',
          revenueRaw: p.outcome === 'succeeded' ? p.settlement.values.agentResidual : '0',
          acceptance: acceptanceProof,
          payment: paymentProof,
          settlement: p.settlement ? {
            ...p.settlement,
            mode: p.outcome === 'refunded' ? 'authorized-failure' : 'docker',
            cases: p.outcome === 'refunded' ? 0 : p.run.result.tests.length
          } : null,
          refundResolution: p.refundResolution ?? null,
          bindings: {
            ...bindings(state),
            intentSha256: p.intentSha256
          }
        };
        state.history.push(row);
        state.reservedRaw = '0';
        delete state.pending;
        delete state.stopReason;
        await save();
        if (process.env.AF_ECON_ROUND_FILE) {
          const marker = process.env.AF_ECON_ROUND_FILE + '.' + state.history.length;
          await writeJson(marker, {
            round: state.history.length,
            pid: process.pid
          });
          while (!(await readJson(marker + '.release'))) await delay(20);
        }
      }
    }));
  } finally {
    provider.destroy();
  }
}
function publicObservation(input) {
  return {
    ...input,
    candidates: input.candidates.map(({
      manifest,
      input,
      quote,
      ...c
    }) => c)
  };
}
async function main() {
  const [catalogConfig, catalogFile, journal, flag, ...extra] = process.argv.slice(2);
  if (!catalogConfig || !catalogFile || !journal || extra.length || flag && !['--execute-local', '--resolve-refund'].includes(flag)) throw Error('CONTROLLER_ARGUMENTS_REQUIRED');
  if (process.env.PUBLISHER_PRIVATE_KEY || process.env.ARENA_VERIFIER_PRIVATE_KEY) throw Error('WORKER_ROLE_KEY_LEAK');
  console.log(JSON.stringify(await control(await readJson(catalogConfig), await readJson(catalogFile), journal, process.env.WORKER_PRIVATE_KEY, flag === '--resolve-refund' ? 'resolve-refund' : flag ? 'execute-local' : 'shadow')));
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main().catch(cliFailure);
