import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "state_guard.py"
SPEC = importlib.util.spec_from_file_location("tempo_state_guard", MODULE)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)

HASH = "0x" + "1" * 64
ADDRESS = "0x" + "2" * 40
UUID = "11111111-1111-1111-1111-111111111111"


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.root = self.project / ".data/tempo-20261012"
        self.ipc = Path(tempfile.mkdtemp(prefix="af-tempo-hosted-", dir="/tmp"))
        os.chown(self.ipc, -1, os.getgid())
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(lambda: shutil.rmtree(self.ipc, ignore_errors=True))
        for role in ("guardian", "underwriter", "verifier", "refunder", "sponsor", "opponent"):
            self.write("operator/" + role + ".key", "PRIVATE_SENTINEL_" + role)
        self.write("operator/vendor.key", "PRIVATE_SENTINEL_VENDOR")
        self.write("operator/rpc.txt", "https://rpc.example.invalid/private-sentinel")
        self.write("gateway/magpie.key", "PRIVATE_SENTINEL_GATEWAY")
        self.write("gateway/attempts.jsonl", "")
        self.put("operator/bootstrap.json", {
            "version": 1, "chainId": "42431", "frontendOrigin": guard._ORIGIN, "hostedPort": 8794,
            "contracts": {name: "0x" + str(i) * 40 for i, name in enumerate(("manager", "adapter", "account", "escrow"), 1)},
            "deploymentBlock": 1, "asset": {"address": "0x20c0000000000000000000000000000000000000", "symbol": "PathUSD", "decimals": 6},
            "identity": ADDRESS, "reputation": ADDRESS, "payTo": ADDRESS, "publicRpcUrl": "https://rpc.example.invalid",
            "rpcTransport": "direct", "opponentBinding": {"chainId": "42431", "agentId": "1", "wallet": ADDRESS},
            "dashboardAgents": [{"id": str(i), "name": "agent" + str(i)} for i in range(1, 4)],
            "tasks": [{"taskId": str(i), "problemId": "sum-integers", "deadlineMs": 1234567890000, "creditLimit": "80000"} for i in range(1, 5)], "maxFeePerGas": "10000",
            "roleKeyFiles": {role: str(self.root / ("operator/" + role + ".key")) for role in
                             ("guardian", "underwriter", "verifier", "refunder", "sponsor", "opponent")},
            "rpcUrlFile": str(self.root / "operator/rpc.txt"), "vendorKeyFile": str(self.root / "operator/vendor.key"),
            "gatewayReadyFile": str(self.root / "gateway/ready.json")})
        self.put("operator/model-upstream.json", {"upstream": {
            "name": "kimi", "baseUrl": "https://api.moonshot.cn/v1", "apiKeyFile": str(self.root / "operator/vendor.key")}})
        self.put("gateway/ready.json", {
            "version": 1, "pid": 10, "magpiePid": 11, "startedAt": "2026-10-14T00:00:00Z",
            "url": "http://127.0.0.1:3436/v1", "endpoint": "http://127.0.0.1:3436/v1/chat/completions",
            "bridgeHealthUrl": "http://127.0.0.1:3437/health", "keyFile": str(self.root / "gateway/magpie.key"),
            "models": [{"id": "cheap", "model": "cheap/kimi-k2.6", "responseModel": "kimi-k2.6"},
                       {"id": "strong", "model": "strong/kimi-k3", "responseModel": "kimi-k3"}],
            "binarySha256": "a" * 64, "inferenceRetries": 0, "transport": "direct"})
        ports = {"underwriter": 4001, "arena": 4002, "fixed": 4003, "allowance": 4004,
                 "planner": 4005, "goalCheap": 4006, "goalStrong": 4007}
        self.put("runtime/runtime-journal/session.json", {"version": 1, "binding": "b" * 64,
                 "startedAt": "2026-10-13T00:00:00Z", "ipcDirectory": str(self.ipc), "ports": ports})
        self.put("runtime/ready.json", {"version": 1, "pid": 12, "startedAt": "2026-10-13T00:00:00Z",
                 "chainId": "42431", "frontendOrigin": guard._ORIGIN, "ports": ports})
        self.put("runtime/hosted.json", {"version": 1, "port": 8794, "hosted": {
            "origin": guard._ORIGIN, "chainId": "42431", "directory": str(self.root / "runtime/hosted")}, "executor": {
                "taskConfigFile": str(self.root / "runtime/task.json"), "gameConfigFile": str(self.root / "runtime/game.json")}})
        b = self.get("operator/bootstrap.json")
        self.put("runtime/arena.json", {"chainId": "42431", "escrowAddress": b["contracts"]["escrow"], "ipcDirectory": str(self.ipc),
                 "rpcUrl": b["publicRpcUrl"], "tasks": {t["taskId"]: {"problemId": t["problemId"]} for t in b["tasks"]}})
        self.put("runtime/task.json", {"version": 1, "identity": b["identity"], "guardianKeyFile": b["roleKeyFiles"]["guardian"],
                 "rpcUrlFile": b["rpcUrlFile"], "rpcTransport": "direct", "publicRpcUrl": b["publicRpcUrl"],
                 "walletDirectory": str(self.root / "runtime/wallets"), "arenaUrl": "http://127.0.0.1:4002", "underwriterUrl": "http://127.0.0.1:4001",
                 "models": [{"id": "kimi-k2.6"}, {"id": "kimi-k3"}]})
        self.put("runtime/game.json", {"version": 1, "chainId": "42431", "identity": b["identity"], "account": b["contracts"]["account"],
                 "token": b["asset"]["address"], "rpcUrlFile": b["rpcUrlFile"], "rpcTransport": "direct", "upstreamTransport": "direct",
                 "sponsorKeyFile": b["roleKeyFiles"]["sponsor"], "walletDirectory": str(self.root / "runtime/wallets"),
                 "creditsDirectory": str(self.root / "runtime/credits"), "models": [{"id": "kimi-k2.6"}, {"id": "kimi-k3"}]})
        self.put("runtime/deployment.json", {"chainId": "42431", "contracts": b["contracts"], "asset": b["asset"], "deploymentBlock": 1,
                 "rpcUrl": b["publicRpcUrl"], "underwriterUrl": "http://127.0.0.1:4001", "arenaUrl": "http://127.0.0.1:4002", "agents": b["dashboardAgents"]})
        self.put("runtime/hosted/database/session.json", {"version": 1,
            "configBinding": hashlib.sha256(json.dumps({"origin": guard._ORIGIN, "chainId": "42431"}, separators=(",", ":")).encode()).hexdigest(),
            "challenges": [], "sessions": [], "agents": [], "runs": [], "creations": [], "sponsoredOwners": {}, "sponsoredTotal": 0})
        self.put("runtime/settlement-journal.json", {})
        self.put("runtime/arena-http-journal.json", {"runs": [], "submissions": []})
        self.put("gateway/magpie/config/magpie/providers.json", {"noAutoGroups": True, "providers": [
            {"id": "cheap", "key": "c" * 64, "chat": "http://127.0.0.1:3437/v1", "models": ["kimi-k2.6"]},
            {"id": "strong", "key": "c" * 64, "chat": "http://127.0.0.1:3437/v1", "models": ["kimi-k3"]}]})

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        path.chmod(0o600)

    def put(self, name, value):
        self.write(name, json.dumps(value, ensure_ascii=False, separators=(",", ":")))

    def get(self, name):
        return json.loads((self.root / name).read_text())

    def capture(self):
        return guard.capture(self.project)

    def rejects(self, fn, code=None):
        with self.assertRaises(guard.StateError) as caught:
            fn()
        self.assertRegex(str(caught.exception), r"^STATE_[A-Z_]+$")
        self.assertNotIn("PRIVATE_SENTINEL", str(caught.exception))
        if code: self.assertEqual(caught.exception.code, code)

    def relay(self, state="Quoted", attempts=None):
        b = self.get("operator/bootstrap.json")
        request = {"agentId": "1", "taskId": "0", "service": "tabby/mission", "model": "cheap", "messages": [{"role": "user", "content": "hello"}]}
        digest = guard._keccak(guard._canonical(request))
        payment = guard._keccak(bytes(32) + bytes.fromhex(digest[2:]) + bytes.fromhex(HASH[2:]))
        record = {"quote": {"paymentId": payment, "price": "10000", "agentId": "1", "taskId": "0",
                            "service": "tabby/mission", "model": "cheap", "requestDigest": digest,
                            "serverNonce": HASH, "chainId": "42431", "account": b["contracts"]["account"],
                            "asset": b["asset"]["address"], "payTo": b["payTo"], "quoteExpiry": "2000000000", "createdBlock": 1},
                  "request": request, "state": state, "refunds": []}
        if state == "Delivered":
            record.update(proof=self.proof(), receipt={"paymentId": payment, "txHash": HASH, "requestDigest": digest}, result={})
        if attempts is not None: record["upstreamAttempts"] = attempts
        self.relay_path = "runtime/goal-cheap/" + payment + ".json"
        self.put(self.relay_path, record)
        return record

    def proof(self):
        return {"txHash": HASH, "blockNumber": 1, "blockHash": HASH, "timestamp": 1, "fromCash": "10000", "fromCredit": "0"}

    def resolved_record(self):
        attempts = [{"upstream": "magpie-cheap", "model": "cheap/kimi-k2.6", "startedAt": 1,
                     "state": "Unknown", "reason": "NETWORK_OR_TIMEOUT"}]
        record = self.relay("Refunded", attempts)
        record["proof"] = self.proof()
        record["quote"]["requestDigest"] = guard._keccak(guard._canonical(record["request"]))
        record["operatorResolution"] = {"version": 1, "paymentId": record["quote"]["paymentId"], "resolutionId": UUID,
            "evidenceDigest": HASH, "expectedAttemptsDigest": guard._keccak(guard._canonical(attempts)),
            "reason": "operator-accepted-nondelivery-cost", "resolvedAt": 1}
        record["refunds"] = [{"id": HASH, "amount": "10000", "state": "Confirmed",
            "transaction": {"rawTransaction": "0x01", "txHash": guard._keccak(b"\x01"), "nonce": 1}}]
        self.put(self.relay_path, record)
        return record

    def sealed_allowance(self):
        record = self.relay("Refunded")
        (self.root / self.relay_path).unlink()
        request = {"agentId": "1", "taskId": "1", "service": "infercredit/allowance", "model": "inference-allowance-v1",
                   "messages": [{"role": "user", "content": "Purchase one task-bound prepaid inference allowance package."}],
                   "allowance": {"creditsRaw": "200000", "modelCatalogDigest": HASH}}
        q = record["quote"]
        q.update({k: request[k] for k in ("agentId", "taskId", "service", "model")})
        q["requestDigest"] = guard._keccak(guard._canonical(request))
        q["paymentId"] = guard._keccak((1).to_bytes(32, "big") + bytes.fromhex(q["requestDigest"][2:]) + bytes.fromhex(q["serverNonce"][2:]))
        record["request"] = request
        record["proof"] = self.proof()
        record["receipt"] = {**q, **self.proof(), "upstream": "allowance-ledger", "usage": None}
        record["result"] = {"kind": "inference-allowance", "paymentId": q["paymentId"], "agentId": "1", "taskId": "1", "creditsRaw": "200000"}
        record["refunds"] = [{"id": HASH, "amount": "10000", "state": "Confirmed",
            "transaction": {"rawTransaction": "0x01", "txHash": guard._keccak(b"\x01"), "nonce": 1}}]
        physical_request = {"model": "cheap/kimi-k2.6", "messages": [{"role": "user", "content": "hello"}], "max_completion_tokens": 1024, "stream": False}
        ledger = {"version": 1, "binding": {"agentId": "1", "taskId": "1", "wallet": ADDRESS.lower()},
                  "catalog": [{"id": model["id"], "model": model["model"], "responseModel": model["responseModel"],
                               "route": "http://127.0.0.1:3436/v1/chat/completions", "inputMicroCreditsPerToken": "1" if i == 0 else "3",
                               "outputMicroCreditsPerToken": "2" if i == 0 else "6", "maxCompletionTokens": 1024}
                              for i, model in enumerate(self.get("gateway/ready.json")["models"])],
                  "grants": [{"id": q["paymentId"], "credits": "200000", "source": {"kind": "chain-payment", "paymentId": q["paymentId"], "txHash": HASH}}],
                  "invocations": [{"id": "round:0", "state": "Unknown", "requestDigest": guard._digest(physical_request), "request": physical_request,
                                   "modelId": "cheap", "reservedCredits": "10000", "maxPromptTokens": 500, "maxCompletionTokens": 1024}]}
        closure = {"version": 1, "resolutionId": UUID, "evidenceDigest": HASH, "reason": "operator-accepted-unknown-cost",
                   "paymentId": q["paymentId"], "expectedLedgerDigest": guard._digest(ledger), "binding": ledger["binding"], "sealedAt": 1}
        ledger["closure"] = closure
        record["operatorCompensation"] = {"version": 1, "reason": "operator-accepted-unknown-inference-cost", "resolvedAt": 1,
                   "paymentId": q["paymentId"], "resolutionId": UUID, "evidenceDigest": HASH, "closure": closure, "certificateDigest": guard._keccak(guard._canonical(closure))}
        self.ledger_path = "runtime/hosted/agents/a/runs/b/task-executor/workflow/inference-ledger/session.json"
        self.purchase_path = "runtime/hosted/agents/a/runs/b/task-executor/workflow/allowance-purchase/session.json"
        self.relay_path = "runtime/allowance/" + q["paymentId"] + ".json"
        self.put(self.ledger_path, ledger)
        self.put(self.purchase_path, {"version": 1, "config": {"catalog": ledger["catalog"]},
                 "handle": {"version": 1, "quote": q, "input": request, "submission": {"from": ADDRESS, "txHash": HASH}},
                 "inference": {"receipt": record["receipt"], "result": record["result"]}})
        self.put(self.relay_path, record)
        return record, ledger

    def test_keccak_vectors(self):
        self.assertEqual(guard._keccak(b""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(guard._keccak(b"abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
        # Independently checked against this repository's ethers implementation,
        # including the Keccak rate boundary and a multi-block message.
        for size, expected in ((135, "cbdfd9dee5faad3818d6b06f95a219fd290b0e1706f6a82e5a595b9ce9faca62"),
                               (136, "7ce759f1ab7f9ce437719970c26b0a66ff11fe3e38e17df89cf5d29c7d7f807e"),
                               (137, "ac73d4fae68b8453f764007c1a20ce95994187861f0c3227a3a8e99a73a3b1db"),
                               (272, "fdf2ec49e749960d3c8521a0219af8d03e30e2b3bf19bd16150ee0eaf133d66e")):
            self.assertEqual(guard._keccak(bytes(i % 256 for i in range(size))), "0x" + expected)

    def test_capture_is_secret_free_and_covers_arbitrary_private_files(self):
        self.write("runtime/hosted/agents/x/runs/y/provider-response.txt", "PRIVATE_SENTINEL_RESPONSE")
        snapshot = self.capture()
        guard.require_quiescent(snapshot)
        self.assertIn("runtime/hosted/agents/x/runs/y/provider-response.txt", snapshot["files"])
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(snapshot))
        self.assertEqual(guard.compare(snapshot, self.capture(), "build"), [])

    def test_missing_and_invalid_critical_files_fail_closed(self):
        before = (self.root / "operator/bootstrap.json").read_bytes()
        for bad in (b"{", b"{}", b'{"version":1,"version":2}', b'{"version":NaN}'):
            (self.root / "operator/bootstrap.json").write_bytes(bad)
            self.rejects(self.capture)
        (self.root / "operator/bootstrap.json").write_bytes(before)
        (self.root / "gateway/attempts.jsonl").unlink()
        self.rejects(self.capture, "STATE_CRITICAL_MISSING")

    def test_hosted_inflight_states_and_agent_reservations(self):
        db = self.get("runtime/hosted/database/session.json")
        for status in ("Queued", "Running", "Paused"):
            db["runs"] = [{"requestId": UUID, "agentId": UUID, "action": "goal", "status": status,
                           "reservedRaw": "10000", "chargedRaw": "0", "recoverable": False}]
            self.put("runtime/hosted/database/session.json", db)
            self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_HOSTED_INFLIGHT")
        db["runs"] = []
        for extra in ({"reservedRaw": "1"}, {"activeRequestId": UUID}):
            db["agents"] = [{"id": UUID, "status": "Ready", "reservedRaw": "0", "spentRaw": "0", **extra}]
            self.put("runtime/hosted/database/session.json", db)
            self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_AGENT_INFLIGHT")

    def test_unpaid_quoted_is_allowed_paid_and_processing_are_rejected(self):
        self.relay()
        guard.require_quiescent(self.capture())
        for state in ("Paid", "Processing"):
            self.relay(state)
            self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_RELAY_INFLIGHT")

    def test_quoted_with_a_proof_is_not_treated_as_unpaid(self):
        record = self.relay()
        record["proof"] = self.proof()
        self.put(self.relay_path, record)
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_RELAY_INFLIGHT")

    def test_known_refunded_unknown_requires_real_digest_and_signed_refund(self):
        record = self.resolved_record()
        guard.require_quiescent(self.capture())
        for mutate in (lambda r: r["operatorResolution"].update(expectedAttemptsDigest=HASH),
                       lambda r: r["refunds"][0].update(state="Prepared"),
                       lambda r: r["refunds"][0]["transaction"].update(rawTransaction="0x02"),
                       lambda r: r["operatorResolution"].update(arbitraryApproved=True)):
            broken = copy.deepcopy(record); mutate(broken)
            self.put(self.relay_path, broken)
            self.rejects(self.capture)

    def test_unresolved_unknown_and_dispatching_are_rejected(self):
        for state in ("Unknown", "Dispatching"):
            self.relay("Delivered", [{"upstream": "p", "model": "m", "startedAt": 1, "state": state}])
            self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_RELAY_UNKNOWN")

    def test_legally_sealed_unknown_requires_unique_bound_purchase_and_full_refund(self):
        record, ledger = self.sealed_allowance()
        guard.require_quiescent(self.capture())
        before = self.capture()
        broken = copy.deepcopy(ledger); broken["closure"]["expectedLedgerDigest"] = "f" * 64
        self.put(self.ledger_path, broken)
        self.rejects(self.capture, "STATE_CLOSURE_INVALID")
        self.put(self.ledger_path, ledger)
        self.put("runtime/hosted/agents/a/runs/duplicate/inference-ledger/session.json", ledger)
        self.rejects(self.capture, "STATE_COMPENSATION_INVALID")
        (self.root / "runtime/hosted/agents/a/runs/duplicate/inference-ledger/session.json").unlink()
        original = self.get(self.purchase_path)
        purchase = copy.deepcopy(original); purchase["handle"]["submission"]["from"] = "0x" + "3" * 40
        self.put(self.purchase_path, purchase)
        self.rejects(self.capture, "STATE_COMPENSATION_INVALID")
        self.put(self.purchase_path, original)
        record["refunds"][0]["state"] = "Prepared"
        self.put(self.relay_path, record)
        self.rejects(self.capture, "STATE_COMPENSATION_INVALID")
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(before))

    def test_gateway_unknown_requires_exact_existing_resolution_evidence(self):
        at = "2026-10-14T00:00:00Z"
        intent = {"attempt": 1, "phase": "DispatchIntent", "at": at, "model": "kimi-k2.6", "requestDigest": "a" * 64, "maxCompletionTokens": 1024}
        unknown = {"attempt": 1, "phase": "OutcomeUnknown", "at": at, "diagnostic": {"reason": "NETWORK"}}
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n" + json.dumps(unknown) + "\n")
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GATEWAY_UNKNOWN")
        _, ledger = self.sealed_allowance()
        request = ledger["invocations"][0]["request"]
        intent["requestDigest"] = hashlib.sha256(json.dumps({**request, "model": "kimi-k2.6"}, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n" + json.dumps(unknown) + "\n")
        snapshot = self.capture()
        guard.require_quiescent(snapshot)
        self.assertEqual(snapshot["gateway"]["resolvedUnknown"], [{"attempt": 1, "requestDigest": intent["requestDigest"],
                         "paymentId": ledger["closure"]["paymentId"], "source": "sealed-allowance"}])
        second_intent = {**intent, "attempt": 2}
        second_unknown = {**unknown, "attempt": 2}
        self.write("gateway/attempts.jsonl", "\n".join(json.dumps(e) for e in (intent, unknown, second_intent, second_unknown)) + "\n")
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GATEWAY_UNKNOWN")

    def test_bridge_reconstruction_preserves_field_order_and_html_bytes(self):
        request = {"model": "cheap/kimi-k2.6", "messages": [{"role": "user", "content": "<x>&中文\u2028"}],
                   "max_completion_tokens": 1024, "stream": False, "thinking": {"type": "disabled"}}
        wire = '{"model":"kimi-k2.6","messages":[{"role":"user","content":"<x>&中文\u2028"}],"max_completion_tokens":1024,"stream":false,"thinking":{"type":"disabled"}}'.encode()
        self.assertEqual(guard._bridge_request_digest(request), hashlib.sha256(wire).hexdigest())
        sorted_body = guard._canonical({**request, "model": "kimi-k2.6"})
        self.assertNotEqual(guard._bridge_request_digest(request), hashlib.sha256(sorted_body).hexdigest())
        escaped = wire.replace(b"<", b"\\u003c").replace(b">", b"\\u003e").replace(b"&", b"\\u0026")
        self.assertNotEqual(guard._bridge_request_digest(request), hashlib.sha256(escaped).hexdigest())
        self.assertNotEqual(guard._bridge_request_digest(request), guard._bridge_request_digest(dict(reversed(list(request.items())))))
        request["messages"][0]["role"] = "developer"
        self.assertIsNone(guard._bridge_request_digest(request))

    def test_planner_wire_digest_requires_its_own_verified_operator_resolution(self):
        record = self.resolved_record()
        record["request"]["max_completion_tokens"] = 512
        record["request"]["thinking"] = {"type": "disabled"}
        digest = guard._keccak(guard._canonical(record["request"]))
        record["quote"]["requestDigest"] = digest
        record["quote"]["paymentId"] = guard._keccak(bytes(32) + bytes.fromhex(digest[2:]) + bytes.fromhex(record["quote"]["serverNonce"][2:]))
        record["operatorResolution"]["paymentId"] = record["quote"]["paymentId"]
        old_path = self.relay_path
        self.relay_path = "runtime/planner/" + record["quote"]["paymentId"] + ".json"
        (self.root / old_path).unlink()
        self.put(self.relay_path, record)
        inference = {k: v for k, v in record["request"].items() if k not in {"agentId", "taskId", "service", "tier"}}
        inference["model"] = "cheap/kimi-k2.6"
        wire_digest = hashlib.sha256(json.dumps({**inference, "model": "kimi-k2.6"}, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        intent = {"attempt": 1, "phase": "DispatchIntent", "at": "2026-10-14T00:00:00Z", "model": "kimi-k2.6", "maxCompletionTokens": 512, "requestDigest": wire_digest}
        unknown = {"attempt": 1, "phase": "OutcomeUnknown", "at": intent["at"]}
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n" + json.dumps(unknown) + "\n")
        snapshot = self.capture()
        guard.require_quiescent(snapshot)
        self.assertEqual(snapshot["gateway"]["resolvedUnknown"][0]["source"], "operator-resolution")
        intent["requestDigest"] = guard._digest({**inference, "model": "kimi-k2.6"})
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n" + json.dumps(unknown) + "\n")
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GATEWAY_UNKNOWN")

    def test_invalid_gateway_response_evidence_is_rejected(self):
        intent = {"attempt": 1, "phase": "DispatchIntent", "at": "2026-10-14T00:00:00Z", "model": "kimi-k2.6", "requestDigest": "a" * 64, "maxCompletionTokens": 1024}
        response = {"attempt": 1, "phase": "Response", "at": intent["at"], "model": intent["model"], "httpStatus": 200, "transport": "direct", "responseDigest": "b" * 64}
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n" + json.dumps(response) + "\n")
        self.rejects(self.capture, "STATE_GATEWAY_EVIDENCE_INVALID")

    def test_gateway_inflight_is_rejected_and_response_count_is_saved(self):
        intent = {"attempt": 1, "phase": "DispatchIntent", "at": "2026-10-14T00:00:00Z", "model": "kimi-k2.6", "requestDigest": "a" * 64, "maxCompletionTokens": 1024}
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n")
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GATEWAY_INFLIGHT")
        self.write("gateway/responses/attempt-1.json", "PRIVATE_SENTINEL_RESPONSE")
        response = {"attempt": 1, "phase": "Response", "at": "2026-10-14T00:00:01Z", "model": "kimi-k2.6", "httpStatus": 200, "transport": "direct",
                    "responseDigest": hashlib.sha256(b"PRIVATE_SENTINEL_RESPONSE").hexdigest()}
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n" + json.dumps(response) + "\n")
        snapshot = self.capture(); guard.require_quiescent(snapshot)
        self.assertEqual(snapshot["gateway"]["dispatches"], 1)
        self.assertEqual(snapshot["gateway"]["responses"], 1)

    def test_arena_running_is_rejected(self):
        self.put("runtime/arena-http-journal.json", {"runs": [{"runId": UUID, "taskId": "1", "status": "running"}], "submissions": []})
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_ARENA_INFLIGHT")

    def test_mission_and_game_and_reward_inflight_are_rejected(self):
        base = "runtime/hosted/agents/a/runs/b/"
        cases = [(base + "mission/session.json", {"version": 1, "view": {}, "calls": [{"started": True}], "result": {"terminal": True}}, "STATE_MISSION_INFLIGHT"),
                 (base + "game/session.json", {"phase": "Stopped", "turns": [{"outcome": "OutcomeUnknown"}]}, "STATE_GAME_INFLIGHT"),
                 ("runtime/credits/a/session.json", {"version": 1, "accounts": [], "grants": [], "redemptions": [{"status": "OutcomeUnknown"}]}, "STATE_REWARD_INFLIGHT")]
        for path, value, code in cases:
            self.put(path, value)
            self.rejects(lambda: guard.require_quiescent(self.capture()), code)
            (self.root / path).unlink()

    def test_financial_key_auth_and_configuration_changes_are_rejected(self):
        before = self.capture()
        for path in ("operator/vendor.key", "runtime/hosted/database/session.json", "runtime/task.json",
                     "runtime/hosted.json", "runtime/deployment.json", "operator/bootstrap.json"):
            original = (self.root / path).read_bytes()
            if path.endswith(".key"):
                self.write(path, "PRIVATE_SENTINEL_CHANGED")
            else:
                value = self.get(path)
                if path.endswith("database/session.json"): value["sessions"] = [{"digest": "a" * 64}]
                else: value["unexpected"] = "changed"
                self.put(path, value)
            self.rejects(lambda: guard.compare(before, self.capture(), "restart"), "STATE_PROTECTED_CHANGED")
            (self.root / path).write_bytes(original)

    def test_every_new_or_removed_private_file_is_protected(self):
        before = self.capture()
        self.write("runtime/new-model-response.txt", "PRIVATE_SENTINEL_NEW")
        self.rejects(lambda: guard.compare(before, self.capture(), "restart"), "STATE_PROTECTED_CHANGED")
        (self.root / "runtime/new-model-response.txt").unlink()
        self.assertEqual(guard.compare(before, self.capture(), "cold"), [])

    def test_restart_allows_only_ready_pid_and_bridge_key_changes(self):
        before = self.capture()
        gateway = self.get("gateway/ready.json"); gateway.update(pid=20, magpiePid=21, startedAt="2026-10-14T01:00:00Z")
        self.put("gateway/ready.json", gateway)
        ready = self.get("runtime/ready.json"); ready["pid"] = 22; self.put("runtime/ready.json", ready)
        providers = self.get("gateway/magpie/config/magpie/providers.json")
        for p in providers["providers"]: p["key"] = "d" * 64
        self.put("gateway/magpie/config/magpie/providers.json", providers)
        after = self.capture()
        self.assertEqual(guard.compare(before, after, "restart"), ["gateway/magpie/config/magpie/providers.json", "gateway/ready.json", "runtime/ready.json"])
        self.rejects(lambda: guard.compare(before, after, "cold"), "STATE_PROTECTED_CHANGED")
        self.rejects(lambda: guard.compare(before, after, "build"), "STATE_BUILD_MUTATION")
        providers["providers"][0]["chat"] = "http://127.0.0.1:9999/v1"
        self.put("gateway/magpie/config/magpie/providers.json", providers)
        self.rejects(lambda: guard.compare(before, self.capture(), "restart"), "STATE_METADATA_CHANGED")

    def test_lock_lifecycle_allowed_but_permissions_not(self):
        before = self.capture()
        self.put("runtime/runtime-journal/.writer/owner.json", {"pid": 30, "token": UUID})
        (self.root / "runtime/runtime-journal/.writer").chmod(0o700)
        self.assertEqual(guard.compare(before, self.capture(), "restart"), ["runtime/runtime-journal/.writer", "runtime/runtime-journal/.writer/owner.json"])
        locked = self.capture()
        (self.root / "runtime/runtime-journal/.writer/owner.json").chmod(0o644)
        self.rejects(lambda: guard.compare(locked, self.capture(), "restart"), "STATE_PERMISSIONS_CHANGED")

    def test_settlement_cold_backup_is_allowed_without_changing_transactions(self):
        verdict = {"version": 1, "taskId": "1", "runId": UUID, "passed": True, "chainId": "42431"}
        entry = {"verdict": verdict, "verdictHash": hashlib.sha256(json.dumps(verdict, separators=(",", ":")).encode()).hexdigest(),
                 "rawTx": "0x01", "txHash": guard._keccak(b"\x01")}
        self.put("runtime/settlement-journal.json", {"1": entry})
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_SETTLEMENT_INFLIGHT")
        entry["settlement"] = {"taskId": "1", "runId": UUID, "passed": True, "txHash": entry["txHash"], "blockNumber": 1, "feedback": []}
        self.put("runtime/settlement-journal.json", {})
        (self.ipc / "settlements.json").write_text(json.dumps({"1": entry}))
        (self.ipc / "settlements.json").chmod(0o600)
        (self.ipc / "settler.owner").write_text("30")
        (self.ipc / "settler.owner").chmod(0o600)
        before = self.capture()
        self.put("runtime/settlement-journal.json", {"1": entry})
        shutil.rmtree(self.ipc)
        self.assertEqual(guard.compare(before, self.capture(), "cold"), ["@ipc/settlements.json", "@ipc/settler.owner", "runtime/settlement-journal.json"])

    def test_permission_and_owner_changes_are_protected(self):
        before = self.capture()
        after = copy.deepcopy(before)
        after["files"]["runtime/task.json"]["uid"] += 1
        self.rejects(lambda: guard.compare(before, after, "restart"), "STATE_PROTECTED_CHANGED")
        (self.root / "runtime/task.json").chmod(0o644)
        self.rejects(lambda: guard.compare(before, self.capture(), "build"), "STATE_BUILD_MUTATION")

    def test_symlinks_cannot_escape_or_replace_critical_files(self):
        (self.root / "outside").symlink_to(self.project / "secret")
        (self.project / "secret").write_text("PRIVATE_SENTINEL_EXTERNAL")
        self.rejects(self.capture, "STATE_SYMLINK_ESCAPE")
        (self.root / "outside").unlink()
        (self.root / "inside").symlink_to(self.root / "operator/vendor.key")
        self.assertIn("inside", self.capture()["symlinks"])
        (self.root / "operator/vendor.key").unlink()
        (self.root / "operator/vendor.key").symlink_to(self.root / "operator/sponsor.key")
        self.rejects(self.capture, "STATE_PATH_INVALID")

    def test_production_sponsorship_cannot_be_enabled(self):
        journal = self.get("runtime/runtime-journal/session.json")
        journal["testSponsorship"] = {"file": "grant.json"}
        self.put("runtime/runtime-journal/session.json", journal)
        self.rejects(self.capture, "STATE_PRODUCTION_SPONSORSHIP_ENABLED")


if __name__ == "__main__":
    unittest.main()
