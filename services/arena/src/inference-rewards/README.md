# GameFi inference rewards

`InferenceRewardLedger` is an operator-issued allowance for `kimi-k2.6`. One trusted terminal hand awards 4096 inference tokens: a sole winner receives all, a tie receives 2048 each. Chips, USDC, and loans are unrelated records. A token is one supplier-reported input or output token, including cached input and reasoning output within those supplier totals; this is not a vendor currency price.

Only the trusted server runner calls `grantTerminal`. It must replay its own private terminal hand, compute `winners` and `replayDigest`, and bind both configured players. The public HTTP API has no grant or winner operation. Grant and match IDs are each unique; rebinding either fails. Browser identity selection does not establish ownership: HTTP callers must authenticate the fixed configured identity first.

```ts
const ledger = await InferenceRewardLedger.open(privateDirectory, {
  accounts: configuredPlayers,
  dispatch: createKimiRewardDispatch({ baseUrl: operatorKimiBase, key: operatorKimiKey }),
  recover: true,
});
try {
  await ledger.grantTerminal({ grantId, matchId, replayDigest, players: configuredPlayers, winners });
  await ledger.balance(authenticatedPlayer);
  await ledger.redeem(authenticatedPlayer, { redemptionId, prompt, maxCompletionTokens: 128 });
  await ledger.redemption(authenticatedPlayer, redemptionId);
} finally { await ledger.close(); }
```

Accounts and policy bind the durable directory. The store uses 0700 directories, 0600 JSON, atomic replacement and file/directory fsync. A single writer lock protects multiple processes; operations in one ledger serialize state mutations. `recover: true` takes over a dead writer only, never a live writer. Intent and conservative allowance reservation are persisted before dispatch. Restart converts an intent without a saved response to `OutcomeUnknown`, retaining its reservation. A durable response is settled during reopen without another request. Successful requests charge supplier `prompt_tokens + completion_tokens` once; both original input counts and output counts must be present, nonnegative safe integers, and match `total_tokens`. No substitute usage is estimated.

The plain-text, single-message request accepts at most 8192 UTF-8 bytes and at most 512 completion tokens. Admission reserves UTF-8 byte count plus 256 tokens for fixed chat framing plus the requested completion bound. UTF-8 bytes are used rather than a chars/4 estimate. Larger reservations than available balance are rejected before dispatch. A supplier exceeding a bound is charged at its actual reported usage, records any deficit, and blocks further requests for that account. The operational exception remains visible as `UsageOverrun`.

`OutcomeUnknown` keeps its reservation after network errors, missing usage, mismatched model, malformed receipt, or oversized response. Reusing the same redemption ID returns the saved state and never retries; changing its owner or request fails. Deliverable text is returned only for a valid assistant response with `stop` or `length`; an invalid result with valid usage is still charged and recorded as `Failed`. There is no automatic release of unknown reservations or an HTTP retry action. Operator recovery of ambiguous provider charges requires separate evidence and is outside this minimal ledger.

`createKimiRewardDispatch` accepts only operator-configured official Moonshot HTTPS `/v1` bases. It fixes the model and performs one request, disables redirects and thinking, and has no provider fallback. The optional fetch transport is a trusted server injection for the existing system HTTPS proxy or controlled tests; it is not passed from a browser.

The local browser endpoint is `/api/arena/credits`. It reuses `GAMEFI_RUNNER_CONFIG` and the runner's `dataDirectory/credits`, and requires `GAMEFI_CREDIT_ACCOUNT_AGENT_ID` to pin one of the configured players. It accepts loopback hosts and the same browser Origin; there is no remote login or reverse proxy authorization in this first local operator workflow. The browser cannot supply `wallet`, `agentId`, `seat`, a provider, key, URL, model, or grant. `GET` returns the pinned identity, policy and balance. `GET ?redemptionId=ID` or `POST {"action":"query","redemptionId":"ID"}` also returns that owner's saved redemption. `POST {"action":"redeem","redemptionId":"ID","prompt":"...","maxCompletionTokens":128}` exchanges the allowance; omitting the completion limit defaults to 128. A saved `Completed` result returns its cached text. A saved unknown result returns its unknown state, retaining its reservation.

Run controlled tests with Node 22:

```sh
node --import tsx --test services/arena/test/inference-rewards.test.ts
```


Hosted task consumption uses the server-only `redeemChat` / `taskResponse` interface. It admits bounded Pi messages and public-sample tool schemas, fixes Kimi K2.6, and reserves the serialized messages/tools byte length plus framing and completion bounds. Completed tool responses share the same game balance and actual-usage ledger; they never execute inside the ledger. The Pi solver runs public tests, while the separate Arena owns hidden tests and settlement. Browser credit endpoints still accept only their existing plain prompt schema.

`HostedGameExecutor.rewardTask` binds every round to the original hosted request ID and opens the same private ledger as game awards. Admission before a Pi dispatch can pause with `INFERENCE_FUNDING_REQUIRED`; a new award can resume that round without replaying earlier model calls. Unknown dispatches remain non-retryable. This is reward-funded inference, not a loan or USDC-denominated token purchase.
