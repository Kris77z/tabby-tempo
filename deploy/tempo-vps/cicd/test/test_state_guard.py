import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "state_guard.py"
SPEC = importlib.util.spec_from_file_location("tempo_state_guard", MODULE)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)

HASH = "0x" + "1" * 64
ADDRESS = "0x" + "2" * 40
UUID = "11111111-1111-1111-1111-111111111111"
ACTOR = "11111111-1111-4111-8111-111111111111"
PARENT = "22222222-2222-4222-8222-222222222222"
CHILD = "33333333-3333-4333-8333-333333333333"
GOAL = "44444444-4444-4444-8444-444444444444"
SPECIALISTS = (("writer", "Writing Specialist"), ("analyst", "Analysis Specialist"), ("coder", "Code Specialist"),
               ("abi-interact", "ABI Reader & Explainer"), ("gas-optimization", "Gas Optimizer"), ("token-scan", "Token Risk Scanner"),
               ("tx-decode", "Transaction Decoder"), ("yield-search", "Yield Strategy Finder"))


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

    def enable_features(self):
        b, journal = self.get("operator/bootstrap.json"), self.get("runtime/runtime-journal/session.json")
        b["opponentBinding"]["wallet"] = "0x" + "5" * 40
        original = copy.deepcopy(b)
        task = {"taskId": "5", "problemId": "sum-integers", "deadlineMs": 2000000000000, "creditLimit": "80000"}
        b["tasks"].append(task); self.put("operator/bootstrap.json", b)
        journal["originalCatalog"] = original["tasks"]
        journal["migrations"] = [{"status": "Applied", "before": original, "after": b, "appended": [task]}]
        config = {"version": 1, "id": ACTOR, "chainId": "42431", "origin": guard._ORIGIN,
            "externalProvider": {"chainId": "42431", "registry": b["identity"], "agentId": b["opponentBinding"]["agentId"], "wallet": b["opponentBinding"]["wallet"]},
            "boundedGamesFile": str(self.root / "operator/bounded-games.json"),
            "transactionBudgetFile": str(self.root / "operator/acceptance-20261016/transaction-budget.json"),
            "taskTemplateDeadlineMs": task["deadlineMs"], "taskIds": ["5"]}
        self.put("operator/features.json", config)
        journal["features"] = {"version": 1, "file": str(self.root / "operator/features.json"),
            "digest": hashlib.sha256((self.root / "operator/features.json").read_bytes()).hexdigest(), "config": config}
        ports = journal["ports"]
        external = {"version": 1, "registryUrl": "http://127.0.0.1:6116/services", "services": [], "minReputation": 0, "timeoutMs": 10000}
        for task_type, name in SPECIALISTS:
            for index, (model, physical, response, price) in enumerate((("cheap", "cheap/kimi-k2.6", "kimi-k2.6", "10000"), ("strong", "strong/kimi-k3", "kimi-k3", "20000"))):
                port = 6100 + len(external["services"]); ports[f"external-{task_type}-{index}"] = port
                external["services"].append({"id": f"external-{task_type}-{model}", "name": f"{name} · {model}", "taskType": task_type,
                    "endpoint": f"http://127.0.0.1:{port}/v1/chat", "serviceId": f"tabby/external/{task_type}", "modelId": model,
                    "physicalModel": physical, "responseModel": response, "priceRaw": price, "provider": b["opponentBinding"]["wallet"], "identity": config["externalProvider"]})
        ports["external-registry"] = 6116
        self.put("runtime/runtime-journal/session.json", journal)
        ready = self.get("runtime/ready.json"); ready["ports"] = ports; self.put("runtime/ready.json", ready)
        arena = self.get("runtime/arena.json"); arena["tasks"]["5"] = {"problemId": "sum-integers"}; self.put("runtime/arena.json", arena)
        hosted = self.get("runtime/hosted.json"); hosted["hosted"]["boundedGamesFile"] = config["boundedGamesFile"]
        hosted["goals"] = {"durationMs": 1200000, "chainLookup": True, "models": [], "external": external}
        for i, (logical, physical, response, price) in enumerate((("cheap", "cheap/kimi-k2.6", "kimi-k2.6", "10000"), ("strong", "strong/kimi-k3", "kimi-k3", "20000"))):
            hosted["goals"]["models"].append({"id": response, "relayUrl": f"http://127.0.0.1:{ports['goalStrong' if i else 'goalCheap']}/v1/chat",
                "provider": b["payTo"], "priceRaw": price, "service": "tabby/mission", "model": logical, "physicalModel": physical, "responseModel": response})
        hosted["autonomy"] = {"maxTasks": 1, "maxDecisions": 4, "durationMs": 1200000, "plannerRelayUrl": "http://127.0.0.1:4005/v1/chat",
            "plannerProvider": b["payTo"], "plannerPriceRaw": "10000", "plannerService": "infercredit/plan", "plannerModel": "logical-planner",
            "plannerPhysicalModel": "cheap/kimi-k2.6", "plannerResponseModel": "kimi-k2.6",
            "games": {"maxGames": 2, "maxSpendPerGameRaw": "0", "rewardKinds": ["llm-credits"], "rewardTaskMinTokens": 2048}}
        self.put("runtime/hosted.json", hosted)
        task_config = self.get("runtime/task.json")
        for i, model in enumerate(task_config["models"]):
            workflow = {"agentId": "1", "chainId": "42431", "account": b["contracts"]["account"], "asset": b["asset"]["address"], "escrowAddress": b["contracts"]["escrow"],
                "tasks": [task], "allowCredit": True, "maxPrice": "120000", "deadlineMs": task["deadlineMs"], "minRemainingMs": 60000, "maxCompletionTokens": 1024,
                "providers": [{"id": "trusted-fixed", "payTo": b["payTo"], "relayUrl": "http://127.0.0.1:4003/v1/chat", "service": "infercredit/solve-fixed", "model": "pi-fixed-v1",
                    "routes": [{"tier": "strong" if i else "cheap", "price": "120000", "capabilities": ["python3-json-stdio", "sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"],
                        "solve": {"version": 1, "tiers": ["strong", "strong"] if i else ["cheap", "strong"], "maxRounds": 2, "maxToolCalls": 4, "maxCompletionTokens": 1024}}]}]}
            model.update(physicalModels={"cheap": "cheap/kimi-k2.6", "strong": "strong/kimi-k3"}, templates={s: copy.deepcopy(workflow) for s in ("conservative", "balanced", "aggressive")})
        self.put("runtime/task.json", task_config)
        game = self.get("runtime/game.json")
        game["opponent"] = {"binding": b["opponentBinding"], "keyFile": b["roleKeyFiles"]["opponent"], "modelId": "kimi-k2.6", "strategy": "balanced"}
        game["models"] = [{"id": model, "baseUrl": "https://api.moonshot.cn/v1", "keyFile": b["vendorKeyFile"]} for model in ("kimi-k2.6", "kimi-k3")]
        self.put("runtime/game.json", game)
        grant = {"version": 1, "id": ACTOR, "parentRequestId": PARENT, "chainId": "42431", "origin": guard._ORIGIN, "asset": b["asset"]["address"],
            "owner": "0x" + "3" * 40, "issuedAtMs": 1760000000000, "expiresAtMs": 1760003600000, "baselineOwnerGames": 3, "baselineTotalGames": 8,
            "maxAdditionalGames": 2, "maxGameCalls": 40, "maxGameCompletionTokens": 20480, "maxCashRewardsRaw": "0",
            "actor": {"hostedAgentId": ACTOR, "registryId": "9", "wallet": "0x" + "4" * 40}}
        self.put("operator/bounded-games.json", grant)
        bounded = {"grant": grant, "digest": hashlib.sha256((self.root / "operator/bounded-games.json").read_bytes()).hexdigest(), "admissions": []}
        db = self.get("runtime/hosted/database/session.json")
        db["agents"] = [{"id": ACTOR, "status": "Ready", "reservedRaw": "0", "spentRaw": "0", "owner": grant["owner"], "wallet": grant["actor"]["wallet"],
            "binding": {"chainId": "42431", "agentId": "9", "wallet": grant["actor"]["wallet"]}, "modelId": "kimi-k2.6", "strategy": "balanced", "allowCredit": False}]
        db.update(boundedGames=bounded, sponsoredOwners={grant["owner"]: 3}, sponsoredTotal=8)
        self.put("runtime/hosted/database/session.json", db); self.put("operator/bounded-admissions/session.json", bounded)
        domain = {"version": 1, "chainId": "42431", "asset": b["asset"], "contracts": {key: b["contracts"][key] for key in ("account", "escrow", "manager")}}
        self.put("operator/acceptance-20261016/bootstrap-domain.json", domain)
        self.put("operator/acceptance-20261016/transaction-budget.json", {"version": 1, "id": ACTOR, "chainId": "42431", "asset": b["asset"]["address"],
            "bootstrapSnapshotFile": str(self.root / "operator/acceptance-20261016/bootstrap-domain.json"),
            "bootstrapSnapshotSha256": hashlib.sha256((self.root / "operator/acceptance-20261016/bootstrap-domain.json").read_bytes()).hexdigest(),
            "issuedAtMs": grant["issuedAtMs"], "expiresAtMs": grant["expiresAtMs"], "maxTransactions": 10, "maxGasPerTransaction": "10000000",
            "maxFeePerGas": "10000", "maxFeeRaw": "1000", "signers": [grant["actor"]["wallet"]], "targets": [b["contracts"]["account"]]})
        (self.root / "operator/acceptance-20261016").chmod(0o700)
        return config

    def external_relay(self, state="Quoted", attempt=None, specialist="writer", model="cheap", messages=None):
        record = self.relay()
        (self.root / self.relay_path).unlink()
        trust = next(s for s in self.get("runtime/hosted.json")["goals"]["external"]["services"] if s["id"] == f"external-{specialist}-{model}")
        user = json.dumps({"originalGoal": "fixture goal", "assignment": {"name": "fixture", "taskType": specialist, "goal": "fixture goal"}}, separators=(",", ":"))
        messages = messages or [{"role": "system", "content": "PRIVATE_SENTINEL_PROMPT"}, {"role": "user", "content": user}]
        user = messages[1]["content"]
        request = {"agentId": "9", "taskId": "0", "service": trust["serviceId"], "model": model,
            "messages": messages, "max_completion_tokens": 2048, "thinking": {"type": "disabled"}}
        digest = guard._keccak(guard._canonical(request))
        q = record["quote"]; q.update(agentId="9", service=trust["serviceId"], model=model, price=trust["priceRaw"], payTo=trust["provider"], requestDigest=digest)
        q["paymentId"] = guard._keccak(bytes(32) + bytes.fromhex(digest[2:]) + bytes.fromhex(HASH[2:]))
        record.update(request=request, state=state, route={"version": 1, "model": model, "upstreams": [{"name": model, "model": trust["physicalModel"], "baseUrl": "http://127.0.0.1:3436/v1"}]})
        if state != "Quoted": record["proof"] = {**self.proof(), "fromCash": trust["priceRaw"]}
        record["upstreamAttempts"] = [] if attempt is None else [{"upstream": model, "model": trust["physicalModel"], "startedAt": 1, "state": attempt}]
        if state == "Delivered":
            record["receipt"] = {**record["proof"], **{k: q[k] for k in ("paymentId", "agentId", "taskId", "service", "price", "asset", "chainId", "account", "payTo", "requestDigest")}, "upstream": model, "model": trust["physicalModel"]}
            record["result"] = {"model": trust["responseModel"], "externalService": {"version": 1, "id": trust["id"], "serviceId": trust["serviceId"], "taskType": specialist,
                "provider": trust["provider"], "identity": trust["identity"], "promptDigest": hashlib.sha256(messages[0]["content"].encode()).hexdigest(), "assignmentDigest": guard._digest(user)}}
        self.relay_path = f"runtime/external-services/{trust['id']}/{q['paymentId']}.json"
        self.put(self.relay_path, record)
        return record

    def bounded_child(self):
        db = self.get("runtime/hosted/database/session.json"); state = db["boundedGames"]; grant = state["grant"]
        state["admissions"] = [{"parentRequestId": PARENT, "childRequestId": CHILD, "agentId": ACTOR, "ordinal": 1,
            "admittedAt": "2025-10-09T08:53:21.000Z", "rewardKind": "llm-credits"}]
        # Use an exact ISO time calculated from the grant; no wall-clock expiry exemption.
        state["admissions"][0]["admittedAt"] = guard.datetime.fromtimestamp((grant["issuedAtMs"] + 1000) / 1000, guard.datetime.fromisoformat("2025-01-01T00:00:00+00:00").tzinfo).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        db["sponsoredOwners"][grant["owner"]] += 1; db["sponsoredTotal"] += 1
        db["autonomousGameAdmissions"] = {CHILD: {"parentRequestId": PARENT, "agentId": ACTOR, "rewardKind": "llm-credits"}}
        db["runs"] = [{"requestId": PARENT, "agentId": ACTOR, "action": "autonomous", "status": "Succeeded", "reservedRaw": "0", "chargedRaw": "0", "recoverable": False, "result": {"terminal": True}}]
        self.put("runtime/hosted/database/session.json", db); self.put("operator/bounded-admissions/session.json", state)
        base = f"runtime/hosted/agents/{ACTOR}/runs/{PARENT}"
        autonomy = self.get("runtime/hosted.json")["autonomy"]
        frozen_agent = {**copy.deepcopy(db["agents"][0]), "name": "fixture actor", "perRunBudgetRaw": "120000", "totalBudgetRaw": "1000000",
            "reservedRaw": "120000", "activeRequestId": PARENT}
        original_input = {"agent": frozen_agent, "run": {"requestId": PARENT, "agentId": ACTOR, "action": "autonomous", "status": "Queued",
            "reservedRaw": "120000", "chargedRaw": "0", "recoverable": False}, "directory": str(self.root / base),
            "keyFile": str(self.root / f"runtime/hosted/agents/{ACTOR}/wallet.key"), "recover": False}
        self.put(base + "/autonomy-host/session.json", {"version": 1, "config": autonomy, "input": original_input, "children": {CHILD: {
            "agent": {**copy.deepcopy(frozen_agent), "activeRequestId": CHILD, "reservedRaw": "0"},
            "directory": str(self.root / base / "children" / CHILD), "run": {"requestId": CHILD, "agentId": ACTOR, "action": "game", "rewardKind": "llm-credits", "reservedRaw": "0"}}}})
        self.put(base + "/autonomy-loop/session.json", {"version": 1, "phase": "Completed", "config": {"sessionId": PARENT, "maxTasks": 1, "maxDecisions": 4,
            "games": {"maxGames": 2, "maxSpendPerGameRaw": "0", "rewardKinds": ["llm-credits"]}}, "steps": [{"childId": CHILD,
            "decision": {"action": "run-game", "modelId": "kimi-k2.6", "funding": "cash", "rewardKind": "llm-credits"}, "childLimits": {"maxSpendRaw": "0"}, "outcome": {"terminal": True, "chargedRaw": "0"}}]})
        child_base = base + "/children/" + CHILD
        self.put(child_base + "/session.json", {"version": 1, "binding": "a" * 64, "startedAtMs": grant["issuedAtMs"] + 2000,
            "deadlineMs": grant["issuedAtMs"] + 602000, "phase": "Succeeded", "result": {"terminal": True, "rewardRaw": "0"}})
        request = {"model": "kimi-k2.6", "stream": False, "max_completion_tokens": 512, "thinking": {"type": "disabled"},
            "messages": [{"role": "system", "content": "PRIVATE_SENTINEL_CARDS"}, {"role": "user", "content": "fixture"}]}
        self.put(child_base + "/game/session.json", {"version": 1, "matchId": "hosted-" + CHILD, "phase": "Complete",
            "startedAtMs": grant["issuedAtMs"] + 2000, "deadlineMs": grant["issuedAtMs"] + 602000,
            "limits": {"model": "kimi-k2.6", "maxCalls": 20, "maxCompletionTokens": 512, "deadlineDurationMs": 600000, "upstreamTimeoutMs": 55000, "inferenceRetries": 0},
            "profiles": [{"model": "kimi-k2.6", "strategy": "balanced"}] * 2, "turns": [{"turn": 1, "seat": 0, "dispatchIntent": True,
                "request": request, "requestDigest": hashlib.sha256(json.dumps(request, separators=(",", ":")).encode()).hexdigest(), "outcome": "Applied"}]})
        return child_base

    def seal_features(self):
        db = self.get("runtime/hosted/database/session.json")
        grant = db["boundedGames"]["grant"]
        iso = lambda ms: guard.datetime.fromtimestamp(ms / 1000, guard.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        db["runs"][0].update(updatedAt=iso(grant["issuedAtMs"] + 650000), reservedRaw="120000", chargedRaw="30000")
        db["runs"].append({"requestId": GOAL, "agentId": ACTOR, "action": "goal", "status": "Succeeded", "reservedRaw": "120000", "chargedRaw": "50000",
            "recoverable": False, "result": {"terminal": True}, "updatedAt": iso(grant["issuedAtMs"] + 660000)})
        self.put("runtime/hosted/database/session.json", db)
        budget_path = "operator/acceptance-20261016/transaction-budget.json"
        budget = self.get(budget_path)
        ledger = {"version": 1, "budgetId": budget["id"], "digest": hashlib.sha256((self.root / budget_path).read_bytes()).hexdigest(), "reservations": []}
        self.put("operator/acceptance-20261016/transaction-budget-ledger.json", ledger)
        closure = {"version": 1, "id": self.get("operator/features.json")["id"], "closedAt": iso(grant["issuedAtMs"] + 700000),
            "goalRequestId": GOAL, "parentRequestId": PARENT, "budgetId": budget["id"], "budgetDigest": ledger["digest"],
            "ledgerSha256": hashlib.sha256((self.root / "operator/acceptance-20261016/transaction-budget-ledger.json").read_bytes()).hexdigest(),
            "boundedAdmissionsSha256": hashlib.sha256((self.root / "operator/bounded-admissions/session.json").read_bytes()).hexdigest()}
        self.reseal(closure)
        hosted = self.get("runtime/hosted.json"); hosted["hosted"]["boundedGamesSealed"] = True; self.put("runtime/hosted.json", hosted)
        return closure

    def reseal(self, closure):
        path = "operator/acceptance-20261016/closure.json"; self.put(path, closure)
        journal = self.get("runtime/runtime-journal/session.json")
        journal["features"]["seal"] = {"version": 1, "file": str(self.root / path), "digest": hashlib.sha256((self.root / path).read_bytes()).hexdigest()}
        self.put("runtime/runtime-journal/session.json", journal)

    def abort_features(self):
        self.enable_features()
        db = self.get("runtime/hosted/database/session.json")
        grant = db["boundedGames"]["grant"]
        grant["actor"]["registryId"] = "73"
        self.put("operator/bounded-games.json", grant)
        db["boundedGames"]["digest"] = hashlib.sha256((self.root / "operator/bounded-games.json").read_bytes()).hexdigest()
        db["agents"][0]["binding"]["agentId"] = "73"
        self.put("operator/bounded-admissions/session.json", db["boundedGames"])
        iso = lambda ms: guard.datetime.fromtimestamp(ms / 1000, guard.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        route = self.get("runtime/hosted.json")["goals"]["models"][0]
        request = {"service": route["service"], "model": route["model"], "messages": [{"role": "system", "content": "offline review"},
            {"role": "user", "content": "offline artifact"}], "max_completion_tokens": 1536, "thinking": {"type": "disabled"}, "agentId": "73", "taskId": "0"}
        b = self.get("operator/bootstrap.json")
        digest = guard._keccak(guard._canonical(request))
        payment = guard._keccak(bytes(32) + bytes.fromhex(digest[2:]) + bytes.fromhex(HASH[2:]))
        quote = {"paymentId": payment, "agentId": "73", "taskId": "0", "requestDigest": digest, "serverNonce": HASH,
            "chainId": "42431", "account": b["contracts"]["account"], "asset": b["asset"]["address"], "payTo": route["provider"],
            "service": route["service"], "model": route["model"], "price": "10000", "quoteExpiry": "2000000000", "createdBlock": 1}
        refund = {"id": HASH, "amount": "10000", "state": "Confirmed",
            "transaction": {"rawTransaction": "0x01", "txHash": guard._keccak(b"\x01"), "nonce": 1}}
        record = {"quote": quote, "request": request, "proof": self.proof(), "state": "Refunded", "upstreamAttempts": [], "refunds": [refund]}
        self.relay_path = f"runtime/goal-cheap/{payment}.json"
        self.put(self.relay_path, record)
        handle = {"version": 1, "relayUrl": route["relayUrl"], "input": request, "quote": quote, "creditNonce": "1",
            "submission": {"from": grant["actor"]["wallet"], "nonce": 1, "txHash": HASH}}
        calls = [{"stage": stage, "started": True, "unpaid": False, "route": route,
            "response": {"text": "cached offline result", "chargedRaw": "10000", "promptTokens": 1, "completionTokens": 1}}
            for stage in ("plan", "phase-0", "review", "revision")]
        calls.append({"stage": "revision-review", "route": route, "messages": request["messages"], "max_completion_tokens": 1536,
            "started": True, "unpaid": False, "handle": handle, "recovery": {"chargedRaw": "0", "refundedRaw": "10000", "resolved": True}})
        result = {"phase": "Stopped", "terminal": True, "success": False, "chargedRaw": "40000", "refundedRaw": "10000", "reason": "HOSTED_GOAL_UNDELIVERED_REFUNDED"}
        identity = {"goal": "offline original goal", "owner": grant["owner"], "wallet": grant["actor"]["wallet"], "agentId": ACTOR,
            "chainAgentId": "73", "chainId": "42431", "strategy": "balanced", "reservedRaw": "120000"}
        self.mission_path = f"runtime/hosted/agents/{ACTOR}/runs/{GOAL}/mission/session.json"
        self.put(self.mission_path, {"version": 1, "input": identity, "route": route, "calls": calls,
            "view": {"stage": "paused", "phases": [], "calls": []}, "result": result})
        db["runs"] = [{"requestId": GOAL, "agentId": ACTOR, "action": "goal", "goal": identity["goal"], "status": "Failed", "reservedRaw": "120000",
            "chargedRaw": "40000", "recoverable": False, "result": result, "updatedAt": iso(grant["issuedAtMs"] + 650000)}]
        self.put("runtime/hosted/database/session.json", db)
        budget_path = "operator/acceptance-20261016/transaction-budget.json"
        budget = self.get(budget_path)
        ledger_path = "operator/acceptance-20261016/transaction-budget-ledger.json"
        self.put(ledger_path, {"version": 1, "budgetId": budget["id"], "digest": hashlib.sha256((self.root / budget_path).read_bytes()).hexdigest(), "reservations": []})
        closure = {"version": 1, "id": self.get("operator/features.json")["id"], "closedAt": iso(grant["issuedAtMs"] + 700000),
            "goalRequestId": GOAL, "parentRequestId": PARENT, "budgetId": budget["id"],
            "budgetDigest": hashlib.sha256((self.root / budget_path).read_bytes()).hexdigest(),
            "ledgerSha256": hashlib.sha256((self.root / ledger_path).read_bytes()).hexdigest(),
            "boundedAdmissionsSha256": hashlib.sha256((self.root / "operator/bounded-admissions/session.json").read_bytes()).hexdigest(), "outcome": "aborted-before-parent"}
        self.reseal(closure)
        hosted = self.get("runtime/hosted.json"); hosted["hosted"]["boundedGamesSealed"] = True; self.put("runtime/hosted.json", hosted)
        return closure

    def public_origin_append_chain(self):
        journal = self.get("runtime/runtime-journal/session.json"); gateway = self.get("gateway/ready.json")
        migration = journal["migrations"][0]
        previous = {**migration["before"], "frontendOrigin": "http://127.0.0.1:3028"}
        # This is the production Origin migration's actual public record shape
        # and migration ID. Temporary fixture paths require regenerated bindings.
        marker = {"version": 1, "id": "c6820c69b7e433d402e12f861184e35be6a4b35016c9dfa435ec42753686a309",
            "fromOrigin": "http://127.0.0.1:3028", "toOrigin": guard._ORIGIN, "previousBinding": guard._runtime_binding(previous, gateway),
            "publicBinding": guard._runtime_binding(migration["before"], gateway), "auditFile": str(self.root / "runtime/vps-origin-migration/session.json")}
        migration.update(id=guard._js_digest(migration["appended"]), beforeBinding=marker["publicBinding"], afterBinding=guard._runtime_binding(migration["after"], gateway))
        journal.update(binding=marker["previousBinding"], effectiveBinding=migration["afterBinding"], publicOriginMigration=marker)
        self.put("runtime/runtime-journal/session.json", journal)
        self.put("runtime/vps-origin-migration/session.json", {"version": 1, "id": marker["id"], "status": "Applied", "origin": guard._ORIGIN,
            "previousBinding": marker["previousBinding"], "publicBinding": marker["publicBinding"]})
        return journal

    def test_origin_audit_allows_only_a_complete_verified_append_chain_to_current_binding(self):
        self.enable_features(); original = self.public_origin_append_chain(); guard.require_quiescent(self.capture())
        self.assertNotEqual(original["effectiveBinding"], original["publicOriginMigration"]["publicBinding"])
        for mutate in (lambda j: j.update(effectiveBinding="f" * 64), lambda j: j["migrations"][0].update(beforeBinding="f" * 64),
                       lambda j: j["migrations"][0].update(id="f" * 64), lambda j: j["migrations"][0]["after"].update(payTo="0x" + "9" * 40),
                       lambda j: j["migrations"].append(copy.deepcopy(j["migrations"][0]))):
            changed = copy.deepcopy(original); mutate(changed); self.put("runtime/runtime-journal/session.json", changed)
            self.rejects(self.capture, "STATE_MIGRATION_INVALID")
        self.put("runtime/runtime-journal/session.json", original)
        audit = self.get("runtime/vps-origin-migration/session.json"); audit["publicBinding"] = "f" * 64; self.put("runtime/vps-origin-migration/session.json", audit)
        self.rejects(self.capture, "STATE_MIGRATION_INVALID")

    def test_sealed_acceptance_preserves_history_and_allows_later_normal_external_goal(self):
        self.enable_features(); self.bounded_child(); self.seal_features()
        before = self.capture(); guard.require_quiescent(before)
        db = self.get("runtime/hosted/database/session.json")
        db["runs"].append({"requestId": "55555555-5555-4555-8555-555555555555", "agentId": ACTOR, "action": "goal", "status": "Succeeded",
            "reservedRaw": "120000", "chargedRaw": "10000", "recoverable": False, "result": {"terminal": True}, "updatedAt": "2026-10-15T00:00:00.000Z"})
        self.put("runtime/hosted/database/session.json", db); self.external_relay("Delivered", "Delivered")
        guard.require_quiescent(self.capture())
        self.rejects(lambda: guard.compare(before, self.capture(), "restart"), "STATE_PROTECTED_CHANGED")

    def test_sealed_settings_can_change_but_current_identity_and_frozen_settings_cannot(self):
        self.enable_features(); self.bounded_child(); self.seal_features()
        db = self.get("runtime/hosted/database/session.json")
        db["agents"][0].update(modelId="kimi-k3", strategy="aggressive", allowCredit=True)
        self.put("runtime/hosted/database/session.json", db)
        guard.require_quiescent(self.capture())
        current = copy.deepcopy(db)
        for mutate in (lambda a: a.update(owner="0x" + "9" * 40), lambda a: a.update(wallet="0x" + "9" * 40),
                       lambda a: a["binding"].update(agentId="99")):
            changed = copy.deepcopy(current); mutate(changed["agents"][0]); self.put("runtime/hosted/database/session.json", changed)
            self.rejects(self.capture, "STATE_BOUNDED_GAMES_INVALID")
        self.put("runtime/hosted/database/session.json", current)
        host_path = f"runtime/hosted/agents/{ACTOR}/runs/{PARENT}/autonomy-host/session.json"
        original = self.get(host_path)
        for mutate in (lambda h: h["input"]["agent"].update(modelId="kimi-k3"), lambda h: h["input"]["agent"].update(strategy="aggressive"),
                       lambda h: h["input"]["agent"].update(allowCredit=True), lambda h: h["input"]["agent"]["binding"].update(agentId="99"),
                       lambda h: h["input"]["run"].update(requestId=GOAL)):
            changed = copy.deepcopy(original); mutate(changed); self.put(host_path, changed)
            self.rejects(self.capture, "STATE_BOUNDED_GAMES_INVALID")
        self.put(host_path, original)
        game_path = f"runtime/hosted/agents/{ACTOR}/runs/{PARENT}/children/{CHILD}/game/session.json"
        game = self.get(game_path); game["profiles"][0]["model"] = "kimi-k3"; self.put(game_path, game)
        self.rejects(self.capture, "STATE_BOUNDED_GAMES_INVALID")

    def test_unsealed_settings_remain_bound_to_the_current_actor(self):
        self.enable_features(); self.bounded_child()
        original = self.get("runtime/hosted/database/session.json")
        for values in ({"modelId": "kimi-k3"}, {"strategy": "aggressive"}, {"allowCredit": True}):
            changed = copy.deepcopy(original); changed["agents"][0].update(values); self.put("runtime/hosted/database/session.json", changed)
            self.rejects(self.capture, "STATE_BOUNDED_GAMES_INVALID")

    def test_seal_requires_terminal_original_requests_canonical_time_and_explicit_hosted_flag(self):
        self.enable_features(); self.bounded_child(); closure = self.seal_features()
        for mutate in (lambda c: c.update(parentRequestId=CHILD), lambda c: c.update(goalRequestId=CHILD), lambda c: c.update(budgetId=CHILD),
                       lambda c: c.update(closedAt="2020-01-01T00:00:00.000Z"), lambda c: c.update(closedAt="2025-10-09T16:53:20.000+08:00")):
            changed = copy.deepcopy(closure); mutate(changed); self.reseal(changed); self.rejects(self.capture)
        self.reseal(closure)
        hosted = self.get("runtime/hosted.json"); hosted["hosted"].pop("boundedGamesSealed"); self.put("runtime/hosted.json", hosted)
        self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID")
        hosted["hosted"]["boundedGamesSealed"] = True; self.put("runtime/hosted.json", hosted)
        db = self.get("runtime/hosted/database/session.json"); db["runs"][1]["result"]["terminal"] = False; self.put("runtime/hosted/database/session.json", db)
        self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID")

    def test_sealed_ledger_and_admission_bytes_cannot_change_or_hide_unknown_child(self):
        self.enable_features(); base = self.bounded_child(); self.seal_features()
        ledger_path = self.root / "operator/acceptance-20261016/transaction-budget-ledger.json"
        original = ledger_path.read_bytes(); ledger_path.write_bytes(original + b"\n")
        self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID"); ledger_path.write_bytes(original)
        mirror = self.root / "operator/bounded-admissions/session.json"
        original = mirror.read_bytes(); mirror.write_bytes(original + b"\n")
        self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID"); mirror.write_bytes(original)
        game = self.get(base + "/game/session.json"); game["phase"] = "Stopped"; game["turns"][0]["outcome"] = "OutcomeUnknown"; self.put(base + "/game/session.json", game)
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GAME_INFLIGHT")

    def test_aborted_before_parent_accepts_real_failed_goal_and_full_undispatched_refund(self):
        self.abort_features()
        snapshot = self.capture(); guard.require_quiescent(snapshot)
        self.assertEqual(snapshot["hosted"]["runs"], 1)
        self.assertFalse((self.root / f"runtime/hosted/agents/{ACTOR}/runs/{PARENT}").exists())
        mission = self.get(self.mission_path)
        self.assertEqual([c["stage"] for c in mission["calls"]], ["plan", "phase-0", "review", "revision", "revision-review"])
        self.assertEqual(mission["result"]["chargedRaw"], "40000")
        self.assertEqual(mission["result"]["refundedRaw"], "10000")

    def test_aborted_seal_allows_later_settings_games_and_reward_history_without_reopening_admissions(self):
        closure = self.abort_features()
        db = self.get("runtime/hosted/database/session.json")
        db["agents"][0].update(modelId="kimi-k3", strategy="aggressive", allowCredit=True)
        db["sponsoredOwners"][db["boundedGames"]["grant"]["owner"]] += 1; db["sponsoredTotal"] += 1
        db["runs"].append({"requestId": CHILD, "agentId": ACTOR, "action": "game", "rewardKind": "llm-credits", "status": "Succeeded",
            "reservedRaw": "0", "chargedRaw": "0", "recoverable": False, "result": {"terminal": True, "success": True}, "updatedAt": "2026-10-15T00:00:00.000Z"})
        self.put("runtime/hosted/database/session.json", db)
        base = f"runtime/hosted/agents/{ACTOR}/runs/{CHILD}"
        self.put(base + "/session.json", {"version": 1, "phase": "Succeeded", "result": {"terminal": True, "rewardRaw": "0"}})
        self.put(base + "/game/session.json", {"version": 1, "phase": "Complete", "turns": []})
        guard.require_quiescent(self.capture())
        b = self.get("operator/bootstrap.json")
        players = [{"agentId": "73", "wallet": db["agents"][0]["wallet"].lower()},
            {"agentId": b["opponentBinding"]["agentId"], "wallet": b["opponentBinding"]["wallet"].lower()}]
        reward = {"version": 1, "policy": {"version": 1, "model": "kimi-k2.6", "rewardTokens": 4096,
            "maxPromptBytes": 8192, "promptFramingReserveTokens": 256, "maxCompletionTokens": 512, "upstreamTimeoutMs": 55000,
            "maxResponseBytes": 1048576, "inferenceRetries": 0}, "accounts": sorted(players, key=lambda a: a["agentId"]),
            "grants": [{"grantId": CHILD, "matchId": "hosted-" + CHILD, "replayDigest": "a" * 64, "players": players, "winners": [0],
                "model": "kimi-k2.6", "allocations": [4096, 0], "createdAt": "2026-10-15T00:00:00.000Z"}], "redemptions": []}
        reward_path = f"runtime/credits/{ACTOR}/session.json"
        self.put(reward_path, reward); guard.require_quiescent(self.capture())
        original_db = copy.deepcopy(db)
        for mutate in (lambda a: a.update(owner="0x" + "9" * 40), lambda a: a.update(wallet="0x" + "9" * 40), lambda a: a["binding"].update(agentId="74")):
            changed = copy.deepcopy(db); mutate(changed["agents"][0]); self.put("runtime/hosted/database/session.json", changed)
            self.rejects(self.capture, "STATE_BOUNDED_GAMES_INVALID")
        self.put("runtime/hosted/database/session.json", original_db)
        for mutate in (lambda r: r["grants"][0].update(createdAt=closure["closedAt"]),
                       lambda r: r["grants"][0].update(grantId=PARENT), lambda r: r["grants"][0].update(matchId="hosted-" + PARENT),
                       lambda r: r["grants"][0].update(parentRequestId=PARENT), lambda r: r["accounts"][0].update(agentId="99")):
            changed = copy.deepcopy(reward); mutate(changed); self.put(reward_path, changed); self.rejects(self.capture)
        self.put(reward_path, reward)
        redemption = {"redemptionId": CHILD + ":round:0", "identity": players[0], "model": "kimi-k2.6", "requestDigest": "a" * 64,
            "reservedTokens": 100, "status": "Completed", "createdAt": "2026-10-15T00:00:01.000Z", "updatedAt": "2026-10-15T00:00:02.000Z"}
        reward["redemptions"] = [redemption]; self.put(reward_path, reward); guard.require_quiescent(self.capture())
        for values in ({"createdAt": closure["closedAt"]}, {"redemptionId": PARENT + ":round:0"}, {"status": "OutcomeUnknown"}):
            changed = copy.deepcopy(reward); changed["redemptions"][0].update(values); self.put(reward_path, changed)
            self.rejects(lambda: guard.require_quiescent(self.capture()))

    def test_aborted_seal_requires_exact_outcome_and_failed_terminal_goal_identity(self):
        closure = self.abort_features()
        for outcome in (None, "completed", "aborted", True):
            changed = copy.deepcopy(closure); changed["outcome"] = outcome; self.reseal(changed)
            self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID")
        changed = copy.deepcopy(closure); changed.pop("outcome"); self.reseal(changed)
        self.rejects(self.capture); self.reseal(closure)
        db = self.get("runtime/hosted/database/session.json")
        for mutate in (lambda r: r.update(status="Succeeded"), lambda r: r.update(status="Paused"), lambda r: r.update(recoverable=True),
                       lambda r: r["result"].update(terminal=False), lambda r: r["result"].update(success=True),
                       lambda r: r.update(action="autonomous"), lambda r: r.update(agentId=CHILD)):
            changed = copy.deepcopy(db); mutate(changed["runs"][0]); self.put("runtime/hosted/database/session.json", changed)
            self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID")
        self.put("runtime/hosted/database/session.json", db)
        original = self.get(self.mission_path)
        for key, value in (("chainAgentId", "9"), ("chainId", "31337"), ("owner", ADDRESS), ("wallet", ADDRESS), ("agentId", CHILD), ("goal", "another goal")):
            changed = copy.deepcopy(original); changed["input"][key] = value; self.put(self.mission_path, changed)
            self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID")

    def test_aborted_seal_rejects_parent_creation_paths_children_and_any_admission(self):
        closure = self.abort_features()
        db = self.get("runtime/hosted/database/session.json")
        parent_run = {"requestId": PARENT, "agentId": ACTOR, "action": "autonomous", "status": "Failed", "reservedRaw": "120000",
            "chargedRaw": "0", "recoverable": False, "result": {"terminal": True, "success": False}}
        for mutate in (lambda d: d["runs"].append(parent_run), lambda d: d["creations"].append({"owner": ADDRESS, "agentId": ACTOR, "requestId": PARENT, "digest": "a" * 64}),
                       lambda d: d.update(autonomousGameAdmissions={CHILD: {"parentRequestId": PARENT, "agentId": ACTOR, "rewardKind": "llm-credits"}}),
                       lambda d: d.update(autonomousGameAdmissions={PARENT: {"parentRequestId": CHILD, "agentId": ACTOR, "rewardKind": "llm-credits"}})):
            changed = copy.deepcopy(db); mutate(changed); self.put("runtime/hosted/database/session.json", changed)
            self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID")
        self.put("runtime/hosted/database/session.json", db)
        parent_path = self.root / f"runtime/hosted/agents/{ACTOR}/runs/{PARENT}"
        parent_path.mkdir(); self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID"); parent_path.rmdir()
        self.put(f"runtime/orphan/children/{CHILD}/session.json", {"parentRequestId": PARENT, "result": {"terminal": True}})
        self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID"); shutil.rmtree(self.root / "runtime/orphan")
        changed = copy.deepcopy(db)
        changed["boundedGames"]["admissions"] = [{"parentRequestId": PARENT, "childRequestId": CHILD, "agentId": ACTOR, "ordinal": 1,
            "admittedAt": closure["closedAt"], "rewardKind": "llm-credits"}]
        self.put("runtime/hosted/database/session.json", changed); self.put("operator/bounded-admissions/session.json", changed["boundedGames"])
        closure["boundedAdmissionsSha256"] = hashlib.sha256((self.root / "operator/bounded-admissions/session.json").read_bytes()).hexdigest(); self.reseal(closure)
        self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID")

    def test_aborted_seal_keeps_budget_mirror_and_all_unknown_or_pending_gateways_protected(self):
        self.abort_features()
        for name in ("operator/acceptance-20261016/transaction-budget-ledger.json", "operator/bounded-admissions/session.json"):
            path = self.root / name; raw = path.read_bytes(); path.write_bytes(raw + b"\n")
            self.rejects(self.capture, "STATE_FEATURES_SEAL_INVALID"); path.write_bytes(raw)
        self.write("gateway/attempts.jsonl", json.dumps({"attempt": 1, "phase": "DispatchIntent", "at": "2026-10-16T00:00:00.000Z",
            "model": "kimi-k2.6", "requestDigest": "a" * 64, "maxCompletionTokens": 1536}) + "\n")
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GATEWAY_INFLIGHT")
        self.write("gateway/attempts.jsonl", "")
        db = self.get("runtime/hosted/database/session.json")
        original = copy.deepcopy(db)
        db["runs"].append({"requestId": CHILD, "agentId": ACTOR, "action": "goal", "status": "Paused", "reservedRaw": "120000",
            "chargedRaw": "10000", "recoverable": True, "result": {"terminal": False}})
        self.put("runtime/hosted/database/session.json", db)
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_HOSTED_INFLIGHT")
        self.put("runtime/hosted/database/session.json", original)
        self.external_relay("Processing", "Unknown")
        self.rejects(lambda: guard.require_quiescent(self.capture()))

    def test_undispatched_refund_mission_requires_full_original_handle_and_explicit_no_dispatch(self):
        self.abort_features()
        original_record, original_mission = self.get(self.relay_path), self.get(self.mission_path)
        for mutate in (lambda r: r.pop("upstreamAttempts"), lambda r: r.update(upstreamAttempts=[{"upstream": "cheap", "model": "cheap/kimi-k2.6", "startedAt": 1, "state": "Unknown"}]),
                       lambda r: r.update(upstreamAttempts=[{"upstream": "cheap", "model": "cheap/kimi-k2.6", "startedAt": 1, "state": "Rejected"}]),
                       lambda r: r.update(result={}), lambda r: r["refunds"][0].update(state="Prepared"),
                       lambda r: r["refunds"][0].update(amount="9999"), lambda r: r["refunds"][0]["transaction"].update(rawTransaction="0x02"),
                       lambda r: r.update(state="Paid")):
            changed = copy.deepcopy(original_record); mutate(changed); self.put(self.relay_path, changed)
            self.rejects(lambda: guard.require_quiescent(self.capture()))
        self.put(self.relay_path, original_record)
        for mutate in (lambda c: c["recovery"].update(chargedRaw="10000"), lambda c: c["recovery"].update(refundedRaw="9999"),
                       lambda c: c["recovery"].update(resolved=False), lambda c: c["handle"]["submission"].update(txHash="0x" + "9" * 64),
                       lambda c: c["handle"]["submission"].update(nonce=-1), lambda c: c["handle"]["submission"].update(rawTransaction="0x02"),
                       lambda c: c["handle"]["submission"].update(**{"from": ADDRESS}), lambda c: c["handle"].update(relayUrl="http://127.0.0.1:9999/v1/chat"),
                       lambda c: c["route"].update(provider="0x" + "9" * 40), lambda c: c["handle"]["quote"].update(price="9999"),
                       lambda c: c.update(max_completion_tokens=1024), lambda c: c.update(inference={})):
            changed = copy.deepcopy(original_mission); mutate(changed["calls"][-1]); self.put(self.mission_path, changed)
            self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_MISSION_INFLIGHT")

    def test_explicit_features_accept_exact_catalog_without_changing_legacy_terminal_state(self):
        self.enable_features()
        snapshot = self.capture(); guard.require_quiescent(snapshot)
        self.assertTrue(snapshot["features"])
        self.assertEqual(len(self.get("runtime/runtime-journal/session.json")["ports"]), 24)
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(snapshot))
        self.assertEqual(guard.compare(snapshot, self.capture(), "restart"), [])

    def test_legacy_six_agents_twenty_seven_terminal_runs_need_no_features(self):
        db = self.get("runtime/hosted/database/session.json")
        db["agents"] = [{"id": str(i), "status": "Ready", "reservedRaw": "0", "spentRaw": "1"} for i in range(6)]
        db["runs"] = [{"requestId": str(i), "agentId": "0", "action": "task", "status": "Succeeded", "reservedRaw": "0", "chargedRaw": "1", "recoverable": False, "result": {"terminal": True}} for i in range(27)]
        db["testSponsorship"] = {"historical": "PRIVATE_SENTINEL_EXPIRED_GRANT"}
        self.put("runtime/hosted/database/session.json", db)
        before = self.capture(); guard.require_quiescent(before)
        self.assertEqual(before["hosted"]["agents"], 6); self.assertEqual(before["hosted"]["runs"], 27)
        self.assertFalse(before["features"])

    def test_feature_marker_requires_raw_digest_private_path_and_explicit_task_append(self):
        self.enable_features(); original = self.get("runtime/runtime-journal/session.json")
        for mutate in (lambda j: j["features"].update(digest="a" * 64), lambda j: j["features"].update(file=str(self.root / "operator/bootstrap.json")),
                       lambda j: j["features"].update(automatic=True), lambda j: j.update(migrations=[]),
                       lambda j: j["originalCatalog"][0].update(deadlineMs=1), lambda j: j.update(features=None)):
            changed = copy.deepcopy(original); mutate(changed); self.put("runtime/runtime-journal/session.json", changed)
            self.rejects(self.capture, "STATE_FEATURES_INVALID")
        self.put("runtime/runtime-journal/session.json", original)
        (self.root / "operator/features.json").chmod(0o644)
        self.rejects(self.capture, "STATE_PRIVATE_FILE_INVALID")

    def test_external_and_games_configuration_require_feature_marker(self):
        for extra in ({"goals": {"external": {}}}, {"autonomy": {"games": {}}}, {"hosted": {**self.get("runtime/hosted.json")["hosted"], "boundedGamesFile": "/tmp/grant"}}):
            hosted = self.get("runtime/hosted.json"); original = copy.deepcopy(hosted); hosted.update(extra); self.put("runtime/hosted.json", hosted)
            self.rejects(self.capture, "STATE_FEATURES_REQUIRED"); self.put("runtime/hosted.json", original)
        self.write("runtime/external-services/external-writer-cheap/" + HASH + ".json", "{}")
        self.rejects(self.capture, "STATE_EXTERNAL_JOURNAL_INVALID")

    def test_external_ports_catalog_and_task_scope_are_exact(self):
        self.enable_features(); original = self.get("runtime/hosted.json")
        for mutate in (lambda h: h["goals"]["external"]["services"][0].update(priceRaw="1"),
                       lambda h: h["goals"]["external"]["services"][0].update(provider=ADDRESS),
                       lambda h: h["goals"]["external"]["services"][0].update(responseModel="kimi-k3"),
                       lambda h: h["goals"]["external"]["services"][0].update(endpoint="https://remote.invalid/v1/chat"),
                       lambda h: h["goals"]["external"]["services"][0].update(reputation={"score": 5}),
                       lambda h: h["autonomy"]["games"].update(rewardKinds=["usdc"]),
                       lambda h: h["autonomy"].update(maxTasks=2)):
            changed = copy.deepcopy(original); mutate(changed); self.put("runtime/hosted.json", changed); self.rejects(self.capture)
        self.put("runtime/hosted.json", original)
        journal = self.get("runtime/runtime-journal/session.json"); journal["ports"]["external-writer-1"] = journal["ports"]["external-writer-0"]
        self.put("runtime/runtime-journal/session.json", journal); self.rejects(self.capture, "STATE_FEATURES_PORTS_INVALID")
        journal["ports"]["external-writer-1"] += 1; self.put("runtime/runtime-journal/session.json", journal)
        task = self.get("runtime/task.json"); task["models"][0]["templates"]["balanced"]["tasks"] = self.get("operator/bootstrap.json")["tasks"]
        self.put("runtime/task.json", task); self.rejects(self.capture, "STATE_FEATURES_TASK_INVALID")

    def test_all_external_journals_accept_only_unpaid_quotes_and_bound_deliveries(self):
        self.enable_features()
        for task_type, _ in SPECIALISTS:
            for model in ("cheap", "strong"):
                self.external_relay("Delivered", "Delivered", task_type, model)
        snapshot = self.capture(); guard.require_quiescent(snapshot)
        self.assertEqual(sum(p.startswith("runtime/external-services/") for p in snapshot["files"]), 16)
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(snapshot))
        self.external_relay(); guard.require_quiescent(self.capture())

    @unittest.skipUnless((MODULE.parents[3] / "node_modules/tsx").is_dir(), "pure application wire test requires npm ci; custody fixtures remain dependency-free")
    def test_external_real_prepare_hire_wire_and_provenance_are_accepted(self):
        self.enable_features()
        trust = self.get("runtime/hosted.json")["goals"]["external"]["services"][0]
        # Run the real pure application preparation code, with no transport,
        # key, wallet, journal or chain. This catches Python fixture drift.
        code = '''
import {prepareExternalHire} from './services/hosted-agents/src/external/hiring.ts';
import {tempoRuntimeBinding} from './scripts/tempo-hosted-runtime.ts';
import {validateGatewayCatalog} from './services/hosted-agents/src/inference-gateway.ts';
let raw='';for await (const chunk of process.stdin) raw+=chunk;
const {trust,bootstrap,gateway}=JSON.parse(raw), service={trust,service:{taskType:'writer'},registryDigest:'a'.repeat(64)};
const result=prepareExternalHire({binding:'b'.repeat(64),input:{goal:'fixture goal',chainId:'42431'}},service,
 {stage:'phase:0',taskType:'writer',originalGoal:'fixture goal',assignment:{name:'fixture',taskType:'writer',goal:'fixture goal'}});
const catalog=validateGatewayCatalog(gateway.models.map((m,i)=>({...m,route:gateway.endpoint,inputMicroCreditsPerToken:i?'3':'1',outputMicroCreditsPerToken:i?'6':'2',maxCompletionTokens:1024})));
process.stdout.write(JSON.stringify({...result,runtimeBinding:tempoRuntimeBinding(bootstrap,gateway,catalog)}));
'''
        node = Path("/Users/jungle/.nvm/versions/node/v22.23.2/bin/node")
        executable = str(node) if node.exists() else shutil.which("node")
        self.assertTrue(executable, "Node with repository tsx is required for the pure wire-contract test")
        bootstrap, gateway = self.get("operator/bootstrap.json"), self.get("gateway/ready.json")
        gateway["models"] = [dict(reversed(list(model.items()))) for model in gateway["models"]]
        result = subprocess.run([executable, "--import", "tsx", "--input-type=module", "-e", code], cwd=MODULE.parents[3],
            input=json.dumps({"trust": trust, "bootstrap": bootstrap, "gateway": gateway}), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(result.returncode, 0, "pure prepareExternalHire fixture failed")
        prepared = json.loads(result.stdout)
        self.assertEqual(prepared["runtimeBinding"], guard._runtime_binding(bootstrap, gateway))
        user = json.loads(prepared["call"]["messages"][1]["content"])
        self.assertNotIn("taskType", user); self.assertEqual(user["assignment"]["taskType"], "writer")
        record = self.external_relay("Delivered", "Delivered", messages=prepared["call"]["messages"])
        self.assertEqual(record["result"]["externalService"]["promptDigest"], prepared["hire"]["promptDigest"])
        self.assertEqual(record["result"]["externalService"]["assignmentDigest"], prepared["hire"]["assignmentDigest"])
        guard.require_quiescent(self.capture())

    def test_external_paid_processing_unknown_and_partial_refund_block_deployment(self):
        self.enable_features()
        for state in ("Paid", "Processing"):
            self.external_relay(state)
            self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_RELAY_INFLIGHT")
        self.external_relay("Delivered", "Unknown")
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_RELAY_UNKNOWN")
        record = self.external_relay("Refunded", "Rejected")
        record["refunds"] = [{"id": HASH, "amount": "10000", "state": "Prepared"}]; self.put(self.relay_path, record)
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_REFUND_INFLIGHT")

    def test_external_unknown_requires_exact_refund_resolution_and_bridge_body(self):
        self.enable_features(); record = self.external_relay("Refunded", "Unknown")
        record["refunds"] = [{"id": HASH, "amount": "10000", "state": "Confirmed", "transaction": {"rawTransaction": "0x01", "txHash": guard._keccak(b"\x01"), "nonce": 1}}]
        record["operatorResolution"] = {"version": 1, "paymentId": record["quote"]["paymentId"], "resolutionId": UUID, "evidenceDigest": HASH,
            "expectedAttemptsDigest": guard._keccak(guard._canonical(record["upstreamAttempts"])), "reason": "operator-accepted-nondelivery-cost", "resolvedAt": 1}
        self.put(self.relay_path, record)
        inference = {k: v for k, v in record["request"].items() if k not in {"agentId", "taskId", "service", "tier"}}
        wire = {**inference, "model": "kimi-k2.6"}
        intent = {"attempt": 1, "phase": "DispatchIntent", "at": "2026-10-14T00:00:00Z", "model": "kimi-k2.6", "requestDigest": hashlib.sha256(json.dumps(wire, separators=(",", ":")).encode()).hexdigest(), "maxCompletionTokens": 2048}
        unknown = {"attempt": 1, "phase": "OutcomeUnknown", "at": intent["at"]}
        self.write("gateway/attempts.jsonl", json.dumps(intent) + "\n" + json.dumps(unknown) + "\n")
        self.put(f"runtime/hosted/agents/{ACTOR}/runs/{PARENT}/mission/session.json", {"version": 1, "view": {}, "calls": [{"started": True,
            "handle": {"quote": record["quote"]}, "recovery": {"resolved": True}}], "result": {"terminal": True}})
        guard.require_quiescent(self.capture())
        record["operatorResolution"]["expectedAttemptsDigest"] = HASH; self.put(self.relay_path, record)
        self.rejects(self.capture, "STATE_RESOLUTION_INVALID")

    def test_external_unconfigured_paths_symlinks_and_payment_binding_are_rejected(self):
        self.enable_features(); record = self.external_relay(); original = copy.deepcopy(record)
        for mutate in (lambda r: r["quote"].update(payTo=ADDRESS), lambda r: r["quote"].update(price="20000"),
                       lambda r: r["route"]["upstreams"][0].update(baseUrl="https://remote.invalid/v1"),
                       lambda r: r["request"].update(max_completion_tokens=4096)):
            changed = copy.deepcopy(original); mutate(changed); self.put(self.relay_path, changed); self.rejects(self.capture)
        self.put(self.relay_path, original)
        for path in ("runtime/external-services/not-approved", "runtime/external-services/external-writer-cheap/nested", "runtime/external-unconfigured"):
            (self.root / path).mkdir(); self.rejects(self.capture, "STATE_EXTERNAL_JOURNAL_INVALID"); (self.root / path).rmdir()
        linked = self.root / "runtime/external-services/external-writer-strong"; linked.symlink_to(self.root / "operator")
        self.rejects(self.capture, "STATE_EXTERNAL_JOURNAL_INVALID"); linked.unlink()
        self.write("runtime/external-services/external-writer-cheap/unfinished.tmp", "PRIVATE_SENTINEL")
        self.rejects(self.capture, "STATE_EXTERNAL_JOURNAL_INVALID")

    def test_bounded_expired_history_is_allowed_but_mirror_actor_and_admission_tampering_are_not(self):
        self.enable_features(); child_base = self.bounded_child(); guard.require_quiescent(self.capture())
        db = self.get("runtime/hosted/database/session.json"); original = copy.deepcopy(db)
        for mutate in (lambda d: d["boundedGames"]["admissions"][0].update(parentRequestId=CHILD), lambda d: d["boundedGames"]["admissions"][0].update(rewardKind="usdc"),
                       lambda d: d["boundedGames"]["admissions"].append(d["boundedGames"]["admissions"][0]),
                       lambda d: d["agents"][0].update(allowCredit=True), lambda d: d.update(sponsoredTotal=8),
                       lambda d: d["autonomousGameAdmissions"][CHILD].update(agentId=PARENT)):
            changed = copy.deepcopy(original); mutate(changed); self.put("runtime/hosted/database/session.json", changed)
            self.put("operator/bounded-admissions/session.json", changed["boundedGames"]); self.rejects(self.capture)
        self.put("runtime/hosted/database/session.json", original); self.put("operator/bounded-admissions/session.json", original["boundedGames"])
        self.put("operator/bounded-admissions/session.json", {**original["boundedGames"], "admissions": []})
        self.rejects(self.capture, "STATE_BOUNDED_GAMES_INVALID")

    def test_bounded_terminal_parent_cannot_hide_unknown_or_unfinished_game_child(self):
        self.enable_features(); base = self.bounded_child()
        for state in ("IntentPersisted", "OutcomeUnknown"):
            game = self.get(base + "/game/session.json"); game["phase"] = "Stopped"; game["turns"][0]["outcome"] = state; self.put(base + "/game/session.json", game)
            self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GAME_INFLIGHT")
        game["phase"] = "Complete"; game["turns"][0]["outcome"] = "Applied"; self.put(base + "/game/session.json", game)
        journal = self.get(base + "/session.json"); journal["phase"] = "CreditsPending"; journal["result"]["terminal"] = False; self.put(base + "/session.json", journal)
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_GAME_INFLIGHT")
        journal["phase"] = "Succeeded"; journal["result"]["terminal"] = True; journal["award"] = {}; self.put(base + "/session.json", journal)
        self.rejects(self.capture, "STATE_BOUNDED_GAMES_INVALID")

    def test_bounded_lock_is_lifecycle_only_and_all_authorizations_and_business_files_are_protected(self):
        self.enable_features(); before = self.capture()
        self.put("operator/bounded-admissions/.writer/owner.json", {"pid": 99, "token": UUID}); (self.root / "operator/bounded-admissions/.writer").chmod(0o700)
        self.assertEqual(guard.compare(before, self.capture(), "restart"), ["operator/bounded-admissions/.writer", "operator/bounded-admissions/.writer/owner.json"])
        self.rejects(lambda: guard.compare(before, self.capture(), "build"), "STATE_BUILD_MUTATION")
        locked = self.capture(); shutil.rmtree(self.root / "operator/bounded-admissions/.writer")
        self.assertEqual(guard.compare(locked, self.capture(), "cold"), ["operator/bounded-admissions/.writer", "operator/bounded-admissions/.writer/owner.json"])
        current = self.capture(); self.external_relay()
        self.rejects(lambda: guard.compare(current, self.capture(), "restart"), "STATE_PROTECTED_CHANGED")

    def test_transaction_budget_accepts_checksummed_pathusd_target_from_lowercase_bootstrap(self):
        self.enable_features()
        path = "operator/acceptance-20261016/transaction-budget.json"
        budget = self.get(path)
        pathusd = "0x20C0000000000000000000000000000000000000"
        self.assertEqual(self.get("operator/bootstrap.json")["asset"]["address"], pathusd.lower())
        budget["targets"].append(pathusd); self.put(path, budget)
        guard.require_quiescent(self.capture())
        budget["targets"].append("0x" + "9" * 40); self.put(path, budget)
        self.rejects(self.capture, "STATE_TRANSACTION_BUDGET_INVALID")

    def test_transaction_budget_domain_allowlist_rounding_and_lock_are_enforced(self):
        self.enable_features(); path = "operator/acceptance-20261016/transaction-budget.json"; budget = self.get(path)
        ledger = {"version": 1, "budgetId": budget["id"], "digest": hashlib.sha256((self.root / path).read_bytes()).hexdigest(), "reservations": [{"hash": HASH,
            "sender": budget["signers"][0], "to": budget["targets"][0], "nonce": 0, "gasLimit": "10000000", "maxFeePerGas": "10000", "feeToken": budget["asset"], "maxFeeRaw": "1",
            "admittedAt": "2025-10-09T08:53:21.000Z"}]}
        grant = self.get("operator/bounded-games.json")
        ledger["reservations"][0]["admittedAt"] = guard.datetime.fromtimestamp((grant["issuedAtMs"] + 1000) / 1000, guard.datetime.fromisoformat("2025-01-01T00:00:00+00:00").tzinfo).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        ledger_path = "operator/acceptance-20261016/transaction-budget-ledger.json"; self.put(ledger_path, ledger)
        before = self.capture(); guard.require_quiescent(before)
        for mutate in (lambda d: d["reservations"][0].update(maxFeeRaw="2"), lambda d: d["reservations"].append(d["reservations"][0]),
                       lambda d: d["reservations"][0].update(to="0x" + "9" * 40), lambda d: d["reservations"][0].update(feeToken=ADDRESS)):
            changed = copy.deepcopy(ledger); mutate(changed); self.put(ledger_path, changed); self.rejects(self.capture, "STATE_TRANSACTION_BUDGET_INVALID")
        self.put(ledger_path, ledger)
        changed = copy.deepcopy(ledger); changed["reservations"][0]["nonce"] = 1; self.put(ledger_path, changed)
        self.rejects(lambda: guard.compare(before, self.capture(), "restart"), "STATE_PROTECTED_CHANGED")
        self.put(ledger_path, ledger)
        lock = self.root / "operator/acceptance-20261016/transaction-budget.lock"; lock.mkdir(mode=0o700)
        self.rejects(lambda: guard.require_quiescent(self.capture()), "STATE_OPERATOR_INFLIGHT"); lock.rmdir()
        domain_path = "operator/acceptance-20261016/bootstrap-domain.json"; domain = self.get(domain_path); domain["contracts"]["account"] = ADDRESS; self.put(domain_path, domain)
        self.rejects(self.capture, "STATE_TRANSACTION_BUDGET_INVALID")

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
