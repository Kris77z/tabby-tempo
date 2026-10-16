"""Offline custody guard. No RPC, subprocess, recovery, or state writes.

Snapshots contain hashes and bounded metadata, never credentials, signed bytes,
prompts, or model responses. Only an already quiescent state may be deployed.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit


class StateError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


_HASH = re.compile(r"0x[0-9a-f]{64}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
_UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
_TERMINAL = {"Succeeded", "Failed", "Refunded", "Stopped"}
_ORIGIN = "https://tempo.tabbyai.xyz"
_PORTS = {"underwriter", "arena", "fixed", "allowance", "planner", "goalCheap", "goalStrong"}
# This is an approved deployment catalog, not discovery from application code or
# from a registry response. Adding a specialist requires another trusted migration.
_SPECIALISTS = (("writer", "Writing Specialist"), ("analyst", "Analysis Specialist"),
    ("coder", "Code Specialist"), ("abi-interact", "ABI Reader & Explainer"),
    ("gas-optimization", "Gas Optimizer"), ("token-scan", "Token Risk Scanner"),
    ("tx-decode", "Transaction Decoder"), ("yield-search", "Yield Strategy Finder"))
_EXTERNAL_MODELS = (("cheap", "cheap/kimi-k2.6", "kimi-k2.6", "10000"),
                    ("strong", "strong/kimi-k3", "kimi-k3", "20000"))
_GAMES = {"maxGames": 2, "maxSpendPerGameRaw": "0", "rewardKinds": ["llm-credits"], "rewardTaskMinTokens": 2048}
_GAME_LIMITS = {"model": "kimi-k2.6", "maxCalls": 20, "maxCompletionTokens": 512,
    "deadlineDurationMs": 600000, "upstreamTimeoutMs": 55000, "inferenceRetries": 0}
_ISSUE_CODES = frozenset({"STATE_AGENT_INFLIGHT", "STATE_ARENA_INFLIGHT", "STATE_AUTONOMY_INFLIGHT",
    "STATE_EXECUTOR_INFLIGHT", "STATE_GAME_INFLIGHT", "STATE_GATEWAY_INFLIGHT", "STATE_GATEWAY_UNKNOWN",
    "STATE_HOSTED_INFLIGHT", "STATE_INFERENCE_INFLIGHT", "STATE_MIGRATION_INFLIGHT", "STATE_MISSION_INFLIGHT",
    "STATE_OPERATOR_INFLIGHT", "STATE_RECOVERY_IN_PROGRESS", "STATE_REFUND_INFLIGHT", "STATE_RELAY_INFLIGHT",
    "STATE_RELAY_UNKNOWN", "STATE_REWARD_INFLIGHT", "STATE_SETTLEMENT_INFLIGHT", "STATE_SOLVER_INFLIGHT",
    "STATE_WALLET_INFLIGHT", "STATE_WORKFLOW_INFLIGHT"})
_REQUIRED = (
    "operator/bootstrap.json", "operator/model-upstream.json", "gateway/ready.json",
    "gateway/magpie.key", "gateway/attempts.jsonl", "runtime/ready.json",
    "runtime/runtime-journal/session.json", "runtime/hosted/database/session.json",
    "runtime/arena.json", "runtime/task.json", "runtime/game.json",
    "runtime/hosted.json", "runtime/deployment.json",
)
_RC = (0x0000000000000001, 0x0000000000008082, 0x800000000000808A,
       0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
       0x8000000080008081, 0x8000000000008009, 0x000000000000008A,
       0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
       0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
       0x000000000000800A, 0x800000008000000A, 0x8000000080008081,
       0x8000000000008080, 0x0000000080000001, 0x8000000080008008)
_ROT = ((0, 36, 3, 41, 18), (1, 44, 10, 45, 2), (62, 6, 43, 15, 61),
        (28, 55, 25, 21, 56), (27, 20, 39, 8, 14))


def _keccak(data: bytes) -> str:
    """Ethereum Keccak-256 (not the differently padded hashlib.sha3_256)."""
    mask = (1 << 64) - 1
    rotate = lambda v, n: ((v << n) | (v >> (64 - n))) & mask if n else v
    padded = bytearray(data)
    padded.append(1)
    padded.extend(bytes((-len(padded)) % 136))
    padded[-1] |= 0x80
    lanes = [0] * 25
    for start in range(0, len(padded), 136):
        for i in range(17):
            lanes[i] ^= int.from_bytes(padded[start + i * 8:start + i * 8 + 8], "little")
        for rc in _RC:
            c = [lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20] for x in range(5)]
            d = [c[(x - 1) % 5] ^ rotate(c[(x + 1) % 5], 1) for x in range(5)]
            b = [0] * 25
            for x in range(5):
                for y in range(5):
                    b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(lanes[x + 5 * y] ^ d[x], _ROT[x][y])
            lanes = [b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y]) for y in range(5) for x in range(5)]
            lanes[0] ^= rc
    return "0x" + b"".join(v.to_bytes(8, "little") for v in lanes)[:32].hex()


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def _digest(value) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _js_digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _runtime_binding(bootstrap, gateway):
    catalog = [{"id": model["id"], "model": model["model"], **({"responseModel": model["responseModel"]} if "responseModel" in model else {}),
        "route": gateway["endpoint"], "inputMicroCreditsPerToken": "3" if i else "1",
        "outputMicroCreditsPerToken": "6" if i else "2", "maxCompletionTokens": 1024} for i, model in enumerate(gateway["models"])]
    return _js_digest({"bootstrap": {k: v for k, v in bootstrap.items() if k != "dashboardAgents"},
        "gateway": {k: gateway[k] for k in ("url", "endpoint", "keyFile")}, "catalog": catalog})


def _origin_binding_chain(journal, migration, audit, bootstrap, gateway):
    anchor, target = migration["publicBinding"], journal.get("effectiveBinding")
    _check(isinstance(anchor, str) and _SHA.fullmatch(anchor) is not None, "STATE_MIGRATION_INVALID")
    if target == anchor:
        return  # Preserve the original, already installed origin-only contract.
    _check(isinstance(target, str) and _SHA.fullmatch(target) is not None
           and migration.get("version") == 1 and isinstance(migration.get("previousBinding"), str)
           and _SHA.fullmatch(migration["previousBinding"]) is not None
           and audit.get("publicBinding") == anchor and audit.get("previousBinding") == migration.get("previousBinding"), "STATE_MIGRATION_INVALID")
    current, seen = anchor, set()
    while current != target:
        _check(current not in seen, "STATE_MIGRATION_INVALID"); seen.add(current)
        matches = [m for m in _array(journal.get("migrations", [])) if m.get("beforeBinding") == current]
        _check(len(matches) == 1, "STATE_MIGRATION_INVALID")
        entry = _obj(matches[0], ("id", "status", "before", "after", "appended", "beforeBinding", "afterBinding"))
        before, after, appended = _obj(entry["before"]), _obj(entry["after"]), _array(entry["appended"])
        _check(entry["status"] == "Applied" and bool(appended) and entry["id"] == _js_digest(appended)
               and before.get("frontendOrigin") == after.get("frontendOrigin") == _ORIGIN
               and {k: v for k, v in before.items() if k != "tasks"} == {k: v for k, v in after.items() if k != "tasks"}
               and _array(before.get("tasks")) + appended == after.get("tasks")
               and len({t["taskId"] for t in after["tasks"]}) == len(after["tasks"])
               and _runtime_binding(before, gateway) == current
               and _runtime_binding(after, gateway) == entry["afterBinding"], "STATE_MIGRATION_INVALID")
        current = entry["afterBinding"]
    _check(_runtime_binding(bootstrap, gateway) == target, "STATE_MIGRATION_INVALID")


def _bridge_request_digest(request):
    """Reconstruct the pinned Magpie plain OpenAI bridge body, byte for byte.

    The hosted gateway/relay sends JSON.stringify(request). Magpie's rewriteModel
    (d6096e2fb1710ba123c0d4f59ed8e7e22165de07, gateway.go) splices the
    model string into those bytes, preserving field order and unescaped HTML.
    Canonical/sorted JSON is the ledger digest, not this wire-body digest.
    Unsupported transformations fail to match; no guessed alternative is used.
    """
    if not isinstance(request, dict):
        return None
    model = request.get("model")
    if model not in {"cheap/kimi-k2.6", "strong/kimi-k3"}:
        return None
    if any(isinstance(message, dict) and message.get("role") == "developer" for message in request.get("messages", [])):
        return None
    body = {**request, "model": model.split("/", 1)[1]}
    raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _check(condition: bool, code="STATE_SCHEMA_INVALID"):
    if not condition:
        raise StateError(code)


def _obj(value, required=()):
    _check(isinstance(value, dict) and all(k in value for k in required))
    return value


def _closed(value, keys, code="STATE_SCHEMA_INVALID"):
    _check(isinstance(value, dict) and set(value) == set(keys), code)
    return value


def _array(value):
    _check(isinstance(value, list))
    return value


def _uint(value, positive=False):
    _check(isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]{0,77}", value) is not None)
    _check(int(value) < 2 ** 256 and (not positive or int(value) > 0))
    return int(value)


def _integer(value, positive=False):
    _check(type(value) is int and 0 <= value <= 2 ** 53 - 1 and (not positive or value > 0))
    return value


def _timestamp(value):
    _check(isinstance(value, str))
    try:
        _check(datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None)
    except ValueError:
        raise StateError("STATE_SCHEMA_INVALID") from None


def _address(value):
    _check(isinstance(value, str) and _ADDRESS.fullmatch(value) is not None and int(value[2:], 16) != 0)


def _public_url(value):
    _check(isinstance(value, str))
    parsed = urlsplit(value)
    _check(parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username
           and not parsed.password and not parsed.query and not parsed.fragment)


def _json(raw: bytes):
    def pairs(items):
        value = {}
        for k, v in items:
            _check(k not in value, "STATE_JSON_INVALID")
            value[k] = v
        return value
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(StateError("STATE_JSON_INVALID")))
    except StateError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise StateError("STATE_JSON_INVALID") from None


def _private_reference(path, root: Path, files: dict):
    _check(isinstance(path, str) and Path(path).is_absolute(), "STATE_PATH_INVALID")
    candidate = Path(path)
    _check(candidate == candidate.resolve(strict=True), "STATE_PATH_INVALID")
    try:
        relative = candidate.relative_to(root).as_posix()
    except ValueError:
        raise StateError("STATE_PATH_ESCAPE") from None
    record = files.get(relative)
    _check(record is not None and record["size"] > 0 and record["mode"] & 0o077 == 0, "STATE_PRIVATE_FILE_INVALID")
    return relative


def _scan(root: Path, prefix="", allow_socket=False):
    files, links, dirs, special, raw = {}, {}, {}, {}, {}
    def visit(directory: Path):
        for path in sorted(directory.iterdir()):
            info = path.lstat()
            key = prefix + path.relative_to(root).as_posix()
            metadata = {"mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
            if stat.S_ISLNK(info.st_mode):
                target = path.resolve(strict=True)
                _check(target.is_relative_to(root), "STATE_SYMLINK_ESCAPE")
                links[key] = {**metadata, "target": os.readlink(path)}
            elif stat.S_ISDIR(info.st_mode):
                dirs[key] = metadata
                visit(path)
            elif stat.S_ISREG(info.st_mode):
                fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "rb") as stream:
                    opened = os.fstat(stream.fileno())
                    _check((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino), "STATE_CAPTURE_RACE")
                    content = stream.read()
                final = path.lstat()
                _check((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) ==
                       (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns), "STATE_CAPTURE_RACE")
                files[key] = {**metadata, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                raw[key] = content
            elif allow_socket and stat.S_ISSOCK(info.st_mode) and path.name == "settler.sock":
                special[key] = {**metadata, "kind": "socket"}
            else:
                raise StateError("STATE_SPECIAL_FILE_INVALID")
    visit(root)
    return files, links, dirs, special, raw


def _confirmed_refund(record):
    refunds = _array(record["refunds"])
    for item in refunds:
        _obj(item, ("id", "amount", "state"))
        _check(_HASH.fullmatch(item["id"]) is not None)
        _uint(item["amount"], True)
        _check(item["state"] in {"Prepared", "Confirmed"})
    if not refunds or any(r["state"] != "Confirmed" for r in refunds):
        return False
    for r in refunds:
        tx = _obj(r.get("transaction"), ("rawTransaction", "txHash", "nonce"))
        _check(_HASH.fullmatch(tx["txHash"]) is not None and isinstance(tx["rawTransaction"], str))
        _integer(tx["nonce"])
        _check(_keccak(bytes.fromhex(tx["rawTransaction"][2:])) == tx["txHash"])
    return sum(_uint(r["amount"]) for r in refunds) == _uint(record["quote"]["price"])


def _valid_resolution(record):
    resolution = record.get("operatorResolution")
    if not isinstance(resolution, dict):
        return False
    expected = {"version", "paymentId", "resolutionId", "expectedAttemptsDigest", "evidenceDigest", "reason", "resolvedAt"}
    attempts = record.get("upstreamAttempts", [])
    return (set(resolution) == expected and resolution["version"] == 1
            and resolution["reason"] == "operator-accepted-nondelivery-cost"
            and type(resolution["resolvedAt"]) is int and 0 < resolution["resolvedAt"] < 2 ** 53
            and isinstance(resolution["resolutionId"], str)
            and (_HASH.fullmatch(resolution["resolutionId"]) or _UUID.fullmatch(resolution["resolutionId"]))
            and _HASH.fullmatch(resolution["evidenceDigest"]) is not None
            and resolution["paymentId"] == record["quote"]["paymentId"]
            and record["quote"]["requestDigest"] == _keccak(_canonical(record["request"]))
            and record["state"] == "Refunded" and bool(record.get("proof"))
            and "result" not in record and "receipt" not in record
            and any(a["state"] == "Unknown" for a in attempts)
            and all(a["state"] in {"Unknown", "Rejected"} for a in attempts)
            and resolution["expectedAttemptsDigest"] == _keccak(_canonical(attempts))
            and _confirmed_refund(record))


def _valid_closure(ledger):
    closure = ledger.get("closure")
    if not isinstance(closure, dict):
        return False
    keys = {"version", "resolutionId", "evidenceDigest", "reason", "paymentId", "expectedLedgerDigest", "binding", "sealedAt"}
    grants, invocations = ledger["grants"], ledger["invocations"]
    original = {k: v for k, v in ledger.items() if k != "closure"}
    return (set(closure) == keys and closure["version"] == 1
            and closure["reason"] == "operator-accepted-unknown-cost"
            and _UUID.fullmatch(closure["resolutionId"]) is not None
            and _HASH.fullmatch(closure["paymentId"]) is not None
            and _HASH.fullmatch(closure["evidenceDigest"]) is not None
            and type(closure["sealedAt"]) is int and 0 < closure["sealedAt"] < 2 ** 53
            and closure["binding"] == ledger["binding"] and closure["expectedLedgerDigest"] == _digest(original)
            and len(grants) == 1 and grants[0]["id"] == closure["paymentId"]
            and grants[0]["source"]["kind"] == "chain-payment"
            and grants[0]["source"]["paymentId"] == closure["paymentId"]
            and _HASH.fullmatch(grants[0]["source"]["txHash"]) is not None
            and bool(invocations) and all(v["state"] == "Unknown" and "result" not in v for v in invocations))


def _valid_compensation(record, ledgers, docs):
    c, q = record.get("operatorCompensation"), record["quote"]
    if not isinstance(c, dict):
        return False
    closure = c.get("closure")
    matches = [(path, value) for path, value in ledgers.items() if value.get("closure") == closure and _valid_closure(value)]
    receipt, result, proof = record.get("receipt"), record.get("result"), record.get("proof")
    purchase = docs.get(str(Path(matches[0][0]).parent.parent / "allowance-purchase/session.json")) if len(matches) == 1 else None
    if not isinstance(purchase, dict):
        return False
    handle, inference, config = purchase.get("handle", {}), purchase.get("inference", {}), purchase.get("config", {})
    purchased_quote, submission = handle.get("quote", {}), handle.get("submission", {})
    purchased_receipt, purchased_result = inference.get("receipt", {}), inference.get("result", {})
    grant = matches[0][1]["grants"][0]
    return (set(c) == {"version", "reason", "resolvedAt", "paymentId", "resolutionId", "evidenceDigest", "closure", "certificateDigest"}
            and c["version"] == 1 and c["reason"] == "operator-accepted-unknown-inference-cost"
            and type(c["resolvedAt"]) is int and 0 < c["resolvedAt"] < 2 ** 53
            and len(matches) == 1 and c["paymentId"] == q["paymentId"] == closure["paymentId"]
            and c["resolutionId"] == closure["resolutionId"] and c["evidenceDigest"] == closure["evidenceDigest"]
            and c["certificateDigest"] == _keccak(_canonical(closure))
            and q["service"] == "infercredit/allowance" and q["model"] == "inference-allowance-v1"
            and closure["binding"]["agentId"] == q["agentId"] and closure["binding"]["taskId"] == q["taskId"]
            and purchased_quote == q and purchased_quote.get("requestDigest") == _keccak(_canonical(handle.get("input")))
            and submission.get("from", "").lower() == closure["binding"]["wallet"]
            and submission.get("txHash") == grant["source"]["txHash"]
            and purchased_receipt.get("paymentId") == q["paymentId"] and purchased_receipt.get("txHash") == grant["source"]["txHash"]
            and purchased_receipt.get("agentId") == q["agentId"] and purchased_receipt.get("taskId") == q["taskId"]
            and purchased_result.get("kind") == "inference-allowance" and purchased_result.get("paymentId") == q["paymentId"]
            and purchased_result.get("creditsRaw") == grant["credits"] and config.get("catalog") == matches[0][1]["catalog"]
            and isinstance(receipt, dict) and isinstance(result, dict) and isinstance(proof, dict)
            and receipt.get("paymentId") == q["paymentId"] and receipt.get("txHash") == proof.get("txHash")
            and receipt.get("requestDigest") == q["requestDigest"] and receipt.get("upstream") == "allowance-ledger"
            and result.get("kind") == "inference-allowance" and result.get("paymentId") == q["paymentId"]
            and result.get("agentId") == q["agentId"] and result.get("taskId") == q["taskId"]
            and record["state"] == "Refunded" and "operatorResolution" not in record and _confirmed_refund(record))


def _settlement_summary(value, issues):
    _obj(value)
    for task, entry in value.items():
        _uint(task, True)
        _obj(entry, ("verdict", "verdictHash", "rawTx", "txHash"))
        verdict = _obj(entry["verdict"], ("taskId", "runId", "passed", "chainId"))
        _check(verdict["taskId"] == task and verdict["chainId"] == "42431" and type(verdict["passed"]) is bool)
        _check(_HASH.fullmatch(entry["txHash"]) is not None and isinstance(entry["rawTx"], str))
        _check(_keccak(bytes.fromhex(entry["rawTx"][2:])) == entry["txHash"])
        # verdictHash uses insertion-order JSON.stringify, not canonical JSON.
        _check(entry["verdictHash"] == hashlib.sha256(json.dumps(verdict, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest())
        if "settlement" not in entry:
            issues.add("STATE_SETTLEMENT_INFLIGHT")
        else:
            settled = _obj(entry["settlement"], ("taskId", "runId", "passed", "txHash", "blockNumber", "feedback"))
            _check(settled["taskId"] == task and settled["runId"] == verdict["runId"]
                   and settled["passed"] == verdict["passed"] and settled["txHash"] == entry["txHash"])
            _integer(settled["blockNumber"])
            _array(settled["feedback"])
    return _digest(value)


def _feature_config(journal, b, root, files, docs):
    if "features" not in journal:
        return None
    marker = journal["features"]
    _check(isinstance(marker, dict), "STATE_FEATURES_INVALID")
    _closed(marker, ("version", "file", "digest", "config", "seal") if "seal" in marker else ("version", "file", "digest", "config"), "STATE_FEATURES_INVALID")
    _check(marker["version"] == 1 and marker["file"] == str(root / "operator/features.json"), "STATE_FEATURES_INVALID")
    path = _private_reference(marker["file"], root, files)
    _check(files[path]["mode"] == 0o600 and marker["digest"] == files[path]["sha256"]
           and marker["config"] == docs.get(path), "STATE_FEATURES_INVALID")
    config = _closed(marker["config"], ("version", "id", "chainId", "origin", "externalProvider",
        "boundedGamesFile", "transactionBudgetFile", "taskTemplateDeadlineMs", "taskIds"), "STATE_FEATURES_INVALID")
    _check(config["version"] == 1 and isinstance(config["id"], str) and _UUID.fullmatch(config["id"]) is not None
           and config["chainId"] == "42431" and config["origin"] == _ORIGIN, "STATE_FEATURES_INVALID")
    _check(config["externalProvider"] == {"chainId": "42431", "registry": b["identity"],
        "agentId": b["opponentBinding"]["agentId"], "wallet": b["opponentBinding"]["wallet"]}, "STATE_FEATURES_INVALID")
    _check(config["boundedGamesFile"] == str(root / "operator/bounded-games.json")
           and config["transactionBudgetFile"] == str(root / "operator/acceptance-20261016/transaction-budget.json"), "STATE_FEATURES_INVALID")
    for key in ("boundedGamesFile", "transactionBudgetFile"):
        relative = _private_reference(config[key], root, files)
        _check(files[relative]["mode"] == 0o600, "STATE_FEATURES_INVALID")
    owner = files["runtime/runtime-journal/session.json"]
    for relative in (path, "operator/bounded-games.json", "operator/acceptance-20261016/transaction-budget.json"):
        _check(all(files[relative][k] == owner[k] for k in ("uid", "gid")), "STATE_FEATURES_INVALID")
    _integer(config["taskTemplateDeadlineMs"], True)
    _check(isinstance(config["taskIds"], list) and len(config["taskIds"]) == 1, "STATE_FEATURES_INVALID")
    _uint(config["taskIds"][0], True)
    selected = [t for t in b["tasks"] if t["taskId"] in config["taskIds"]]
    _check(len(selected) == 1 and selected[0]["deadlineMs"] == config["taskTemplateDeadlineMs"], "STATE_FEATURES_INVALID")
    # The public catalog is append-only. A feature marker cannot stand in for
    # the explicit stopped-runtime catalog migration or rewrite old tasks.
    original = _array(journal.get("originalCatalog"))
    _check(b["tasks"][:len(original)] == original and len(original) >= 4
           and config["taskIds"][0] not in {t["taskId"] for t in original}, "STATE_FEATURES_INVALID")
    _check(any(m.get("status") == "Applied" and m.get("appended") == selected
        and isinstance(m.get("before"), dict) and isinstance(m.get("after"), dict)
        and m["before"].get("tasks", []) + selected == m["after"].get("tasks") == b["tasks"]
        for m in journal.get("migrations", [])), "STATE_FEATURES_INVALID")
    return config


def _external_catalog(config, ports):
    services = []
    for task_type, name in _SPECIALISTS:
        for index, (model, physical, response, price) in enumerate(_EXTERNAL_MODELS):
            services.append({"id": f"external-{task_type}-{model}", "name": f"{name} · {model}", "taskType": task_type,
                "endpoint": f"http://127.0.0.1:{ports[f'external-{task_type}-{index}']}/v1/chat",
                "serviceId": f"tabby/external/{task_type}", "modelId": model, "physicalModel": physical,
                "responseModel": response, "priceRaw": price, "provider": config["externalProvider"]["wallet"],
                "identity": config["externalProvider"]})
    return {"version": 1, "registryUrl": f"http://127.0.0.1:{ports['external-registry']}/services",
            "services": services, "minReputation": 0, "timeoutMs": 10000}


def _external_paths(features, files, dirs, links):
    prefix = "runtime/external-services"
    names = {f"external-{task_type}-{model}" for task_type, _ in _SPECIALISTS for model, *_ in _EXTERNAL_MODELS}
    for section, records in (("files", files), ("dirs", dirs), ("links", links)):
        for name in records:
            _check(not re.match(r"runtime/external[^/]*(?:/|$)", name) or name == prefix or name.startswith(prefix + "/"), "STATE_EXTERNAL_JOURNAL_INVALID")
            if name != prefix and not name.startswith(prefix + "/"):
                continue
            _check(features is not None and section != "links", "STATE_EXTERNAL_JOURNAL_INVALID")
            parts = name.split("/")
            _check((section == "dirs" and (name == prefix or len(parts) == 3 and parts[2] in names))
                   or (section == "files" and len(parts) == 4 and parts[2] in names
                       and re.fullmatch(r"0x[0-9a-f]{64}\.json", parts[3]) is not None
                       and records[name]["mode"] == 0o600), "STATE_EXTERNAL_JOURNAL_INVALID")


def _checksum_address(value):
    _address(value)
    lower = value[2:].lower()
    hashed = _keccak(lower.encode())[2:]
    _check(value == "0x" + "".join(c.upper() if int(hashed[i], 16) >= 8 else c for i, c in enumerate(lower)))


def _iso_millis(value):
    _timestamp(value)
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _check(value == dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    return int(dt.timestamp() * 1000)


def _transaction_budget(config, b, root, files, dirs, links, docs, issues):
    path = "operator/acceptance-20261016/transaction-budget.json"
    parent = str(Path(path).parent)
    _check(parent in dirs and dirs[parent]["mode"] == 0o700 and all(dirs[parent][k] == files[path][k] for k in ("uid", "gid")), "STATE_TRANSACTION_BUDGET_INVALID")
    budget = _closed(docs.get(path), ("version", "id", "chainId", "asset", "bootstrapSnapshotFile", "bootstrapSnapshotSha256", "issuedAtMs", "expiresAtMs", "maxTransactions",
        "maxGasPerTransaction", "maxFeePerGas", "maxFeeRaw", "signers", "targets"), "STATE_TRANSACTION_BUDGET_INVALID")
    _check(budget["version"] == 1 and isinstance(budget["id"], str) and _UUID.fullmatch(budget["id"]) is not None
           and budget["chainId"] == "42431" and budget["asset"] == "0x20c0000000000000000000000000000000000000", "STATE_TRANSACTION_BUDGET_INVALID")
    domain_path = parent + "/bootstrap-domain.json"
    _check(budget["bootstrapSnapshotFile"] == str(root / domain_path)
           and _private_reference(budget["bootstrapSnapshotFile"], root, files) == domain_path
           and files[domain_path]["mode"] == 0o600 and files[domain_path]["sha256"] == budget["bootstrapSnapshotSha256"]
           and all(files[domain_path][k] == files[path][k] for k in ("uid", "gid"))
           and docs.get(domain_path) == {"version": 1, "chainId": "42431", "asset": b["asset"],
                "contracts": {key: b["contracts"][key] for key in ("account", "escrow", "manager")}}, "STATE_TRANSACTION_BUDGET_INVALID")
    issued, expires = _integer(budget["issuedAtMs"], True), _integer(budget["expiresAtMs"], True)
    _check(0 < expires - issued <= 86400000 and 1 <= _integer(budget["maxTransactions"]) <= 40, "STATE_TRANSACTION_BUDGET_INVALID")
    for key, maximum in (("maxGasPerTransaction", 20000000), ("maxFeePerGas", 3600000003), ("maxFeeRaw", 3000000)):
        _check(len(budget[key]) <= 30 and _uint(budget[key], True) <= maximum, "STATE_TRANSACTION_BUDGET_INVALID")
    _check(int(budget["maxFeePerGas"]) <= int(b["maxFeePerGas"]), "STATE_TRANSACTION_BUDGET_INVALID")
    for key in ("signers", "targets"):
        values = _array(budget[key])
        _check(1 <= len(values) <= 16 and len(set(values)) == len(values), "STATE_TRANSACTION_BUDGET_INVALID")
        for value in values: _checksum_address(value)
    _check({a.lower() for a in budget["targets"]} <= {b["contracts"][key].lower() for key in ("account", "escrow", "manager")} | {b["asset"]["address"].lower()}, "STATE_TRANSACTION_BUDGET_INVALID")
    ledger_path = parent + "/transaction-budget-ledger.json"
    # Reservations survive RPC uncertainty and consume the ceiling forever.
    # Their presence alone is not proof of an unfinished transaction; the
    # original payment/workflow journals remain the quiescence authority.
    if ledger_path in docs:
        _check(files[ledger_path]["mode"] == 0o600 and all(files[ledger_path][k] == files[path][k] for k in ("uid", "gid")), "STATE_TRANSACTION_BUDGET_INVALID")
        ledger = _closed(docs[ledger_path], ("version", "budgetId", "digest", "reservations"), "STATE_TRANSACTION_BUDGET_INVALID")
        _check(ledger["version"] == 1 and ledger["budgetId"] == budget["id"] and ledger["digest"] == files[path]["sha256"], "STATE_TRANSACTION_BUDGET_INVALID")
        rows = _array(ledger["reservations"])
        _check(len(rows) <= budget["maxTransactions"], "STATE_TRANSACTION_BUDGET_INVALID")
        hashes, fee = set(), 0
        for row in rows:
            _closed(row, ("hash", "sender", "to", "nonce", "gasLimit", "maxFeePerGas", "feeToken", "maxFeeRaw", "admittedAt"), "STATE_TRANSACTION_BUDGET_INVALID")
            _check(isinstance(row["hash"], str) and _HASH.fullmatch(row["hash"]) is not None and row["hash"] not in hashes
                   and row["sender"] in budget["signers"] and row["to"] in budget["targets"] and row["feeToken"] == budget["asset"], "STATE_TRANSACTION_BUDGET_INVALID")
            hashes.add(row["hash"]); _integer(row["nonce"])
            gas, rate, amount = (_uint(row[key], True) for key in ("gasLimit", "maxFeePerGas", "maxFeeRaw"))
            _check(gas <= int(budget["maxGasPerTransaction"]) and rate <= int(budget["maxFeePerGas"])
                   and amount == (gas * rate + 999999999999) // 1000000000000
                   and issued <= _iso_millis(row["admittedAt"]) < expires, "STATE_TRANSACTION_BUDGET_INVALID")
            fee += amount
        _check(fee <= int(budget["maxFeeRaw"]), "STATE_TRANSACTION_BUDGET_INVALID")
    for name in set(files) | set(dirs) | set(links):
        if name.startswith(parent + "/"):
            _check(name not in links and name in {path, domain_path, ledger_path, parent + "/transaction-budget.lock", parent + "/closure.json"}, "STATE_TRANSACTION_BUDGET_INVALID")
    lock = parent + "/transaction-budget.lock"
    if lock in dirs:
        _check(dirs[lock]["mode"] == 0o700, "STATE_TRANSACTION_BUDGET_INVALID")
        issues.add("STATE_OPERATOR_INFLIGHT")
    _check(lock not in files, "STATE_TRANSACTION_BUDGET_INVALID")


def _bounded_games(config, db, root, files, dirs, links, docs, issues, autonomy, sealed=False):
    path, mirror = "operator/bounded-games.json", "operator/bounded-admissions/session.json"
    grant = _closed(docs.get(path), ("version", "id", "parentRequestId", "chainId", "origin", "asset", "owner", "issuedAtMs", "expiresAtMs",
        "baselineOwnerGames", "baselineTotalGames", "maxAdditionalGames", "maxGameCalls", "maxGameCompletionTokens", "maxCashRewardsRaw", "actor"), "STATE_BOUNDED_GAMES_INVALID")
    _check(grant["version"] == 1 and grant["chainId"] == "42431" and grant["origin"] == _ORIGIN
           and grant["asset"] == "0x20c0000000000000000000000000000000000000", "STATE_BOUNDED_GAMES_INVALID")
    for key in ("id", "parentRequestId"):
        _check(isinstance(grant[key], str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", grant[key]) is not None, "STATE_BOUNDED_GAMES_INVALID")
    _checksum_address(grant["owner"])
    issued, expires = _integer(grant["issuedAtMs"], True), _integer(grant["expiresAtMs"], True)
    count = _integer(grant["maxAdditionalGames"], True)
    _check(0 < expires - issued <= 86400000 and issued <= int(datetime.now().timestamp() * 1000)
           and count <= 2 and grant["maxGameCalls"] == 20 * count and grant["maxGameCompletionTokens"] == 10240 * count
           and grant["maxCashRewardsRaw"] == "0", "STATE_BOUNDED_GAMES_INVALID")
    baseline_owner, baseline_total = _integer(grant["baselineOwnerGames"]), _integer(grant["baselineTotalGames"])
    _check(baseline_owner <= baseline_total <= 100, "STATE_BOUNDED_GAMES_INVALID")
    actor = _closed(grant["actor"], ("hostedAgentId", "registryId", "wallet"), "STATE_BOUNDED_GAMES_INVALID")
    _check(isinstance(actor["hostedAgentId"], str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", actor["hostedAgentId"]) is not None, "STATE_BOUNDED_GAMES_INVALID")
    _uint(actor["registryId"], True); _checksum_address(actor["wallet"])
    agents = [a for a in db["agents"] if a["id"] == actor["hostedAgentId"]]
    _check(len(agents) == 1, "STATE_BOUNDED_GAMES_INVALID")
    agent = agents[0]
    def bound_identity(value):
        return (isinstance(value, dict) and value.get("id") == actor["hostedAgentId"] and value.get("owner") == grant["owner"]
                and value.get("wallet") == actor["wallet"]
                and value.get("binding") == {"chainId": "42431", "agentId": actor["registryId"], "wallet": actor["wallet"]})
    _check(bound_identity(agent) and actor["wallet"] != config["externalProvider"]["wallet"]
           and actor["registryId"] != config["externalProvider"]["agentId"], "STATE_BOUNDED_GAMES_INVALID")
    settings = agent
    if sealed:
        # The grant can no longer admit a game. Preserve its original execution
        # settings without pinning the owner's later, ordinary Agent settings.
        parent_base = f"runtime/hosted/agents/{actor['hostedAgentId']}/runs/{grant['parentRequestId']}"
        parent = _obj(docs.get(parent_base + "/autonomy-host/session.json"), ("version", "config", "input"))
        original = _obj(parent["input"], ("agent", "run"))
        _check(parent["version"] == 1 and parent["config"] == autonomy and bound_identity(original["agent"])
               and original["run"].get("requestId") == grant["parentRequestId"]
               and original["run"].get("agentId") == actor["hostedAgentId"] and original["run"].get("action") == "autonomous", "STATE_BOUNDED_GAMES_INVALID")
        settings = original["agent"]
    _check(settings.get("modelId") == "kimi-k2.6" and settings.get("strategy") == "balanced" and settings.get("allowCredit") is False
           and not settings.get("configurationRequired"), "STATE_BOUNDED_GAMES_INVALID")
    state = _closed(db.get("boundedGames"), ("grant", "digest", "admissions"), "STATE_BOUNDED_GAMES_INVALID")
    _check(state["grant"] == grant and state["digest"] == files[path]["sha256"] and docs.get(mirror) == state
           and mirror in files and files[mirror]["mode"] == 0o600
           and all(files[mirror][k] == files[path][k] for k in ("uid", "gid")), "STATE_BOUNDED_GAMES_INVALID")
    for name in set(files) | set(dirs) | set(links):
        if name == "operator/bounded-admissions" or name.startswith("operator/bounded-admissions/"):
            _check(name not in links and name in {"operator/bounded-admissions", mirror,
                "operator/bounded-admissions/.writer", "operator/bounded-admissions/.writer/owner.json"}, "STATE_BOUNDED_GAMES_INVALID")
    admissions = _array(state["admissions"])
    _check(len(admissions) <= count and db["sponsoredOwners"].get(grant["owner"], 0) >= baseline_owner + len(admissions)
           and baseline_total + len(admissions) <= db["sponsoredTotal"] <= 100, "STATE_BOUNDED_GAMES_INVALID")
    children, total_calls = set(), 0
    for index, row in enumerate(admissions):
        _closed(row, ("parentRequestId", "childRequestId", "agentId", "ordinal", "admittedAt", "rewardKind"), "STATE_BOUNDED_GAMES_INVALID")
        child = row["childRequestId"]
        _check(isinstance(child, str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", child) is not None
               and child != grant["parentRequestId"] and child not in children and row["parentRequestId"] == grant["parentRequestId"]
               and row["agentId"] == actor["hostedAgentId"] and type(row["ordinal"]) is int and row["ordinal"] == index + 1
               and row["rewardKind"] == "llm-credits" and issued <= _iso_millis(row["admittedAt"]) < expires, "STATE_BOUNDED_GAMES_INVALID")
        children.add(child)
        _check(_obj(db.get("autonomousGameAdmissions")).get(child) == {"parentRequestId": row["parentRequestId"],
            "agentId": row["agentId"], "rewardKind": "llm-credits"}, "STATE_BOUNDED_GAMES_INVALID")
        parents = [r for r in db["runs"] if r["requestId"] == row["parentRequestId"]]
        _check(len(parents) == 1 and parents[0]["agentId"] == row["agentId"] and parents[0]["action"] == "autonomous", "STATE_BOUNDED_GAMES_INVALID")
        base = f"runtime/hosted/agents/{row['agentId']}/runs/{row['parentRequestId']}"
        host, loop = docs.get(base + "/autonomy-host/session.json"), docs.get(base + "/autonomy-loop/session.json")
        _check(isinstance(host, dict) and host.get("version") == 1 and host.get("config") == autonomy and isinstance(loop, dict)
               and loop.get("config", {}).get("sessionId") == row["parentRequestId"]
               and loop["config"].get("maxTasks") == 1 and loop["config"].get("maxDecisions") == 4
               and loop["config"].get("games") == {k: v for k, v in _GAMES.items() if k != "rewardTaskMinTokens"}, "STATE_BOUNDED_GAMES_INVALID")
        snapshot = _obj(host.get("children")).get(child)
        _check(isinstance(snapshot, dict) and snapshot.get("directory") == str(root / base / "children" / child)
               and snapshot.get("run", {}).get("requestId") == child and snapshot["run"].get("agentId") == row["agentId"]
               and snapshot["run"].get("action") == "game" and snapshot["run"].get("rewardKind") == "llm-credits"
               and snapshot["run"].get("reservedRaw") == "0", "STATE_BOUNDED_GAMES_INVALID")
        steps = [s for s in _array(loop.get("steps")) if s.get("childId") == child]
        _check(len(steps) == 1 and steps[0].get("decision") == {"action": "run-game", "modelId": "kimi-k2.6", "funding": "cash", "rewardKind": "llm-credits"}
               and steps[0].get("childLimits", {}).get("maxSpendRaw") == "0", "STATE_BOUNDED_GAMES_INVALID")
        outcome = steps[0].get("outcome", {})
        if outcome.get("terminal") is not True or outcome.get("chargedRaw") != "0": issues.add("STATE_GAME_INFLIGHT")
        child_base = base + "/children/" + child
        journal, game = docs.get(child_base + "/session.json"), docs.get(child_base + "/game/session.json")
        if not isinstance(journal, dict) or journal.get("result", {}).get("terminal") is not True or journal.get("phase") not in _TERMINAL:
            issues.add("STATE_GAME_INFLIGHT")
        if journal is not None:
            _check(journal.get("version") == 1 and _SHA.fullmatch(journal.get("binding", "")) is not None
                   and "award" not in journal and journal.get("result", {}).get("rewardRaw", "0") == "0", "STATE_BOUNDED_GAMES_INVALID")
            start, end = _integer(journal.get("startedAtMs"), True), _integer(journal.get("deadlineMs"), True)
            _check(issued <= start <= end <= expires and end - start <= 600000, "STATE_BOUNDED_GAMES_INVALID")
        if game is not None:
            _check(game.get("version") == 1 and game.get("matchId") == "hosted-" + child and game.get("limits") == _GAME_LIMITS
                   and game.get("profiles") == [{"model": "kimi-k2.6", "strategy": "balanced"}] * 2
                   and journal is not None and all(game.get(k) == journal.get(k) for k in ("startedAtMs", "deadlineMs")), "STATE_BOUNDED_GAMES_INVALID")
            turns = _array(game.get("turns")); total_calls += len(turns)
            _check(len(turns) <= 20, "STATE_BOUNDED_GAMES_INVALID")
            for ordinal, turn in enumerate(turns, 1):
                request = _closed(turn.get("request"), ("model", "stream", "max_completion_tokens", "thinking", "messages"), "STATE_BOUNDED_GAMES_INVALID")
                _check(turn.get("turn") == ordinal and type(turn.get("seat")) is int and turn["seat"] in {0, 1}
                       and turn.get("dispatchIntent") is True and request["model"] == "kimi-k2.6" and request["stream"] is False
                       and request["max_completion_tokens"] == 512 and request["thinking"] == {"type": "disabled"}
                       and turn.get("requestDigest") == hashlib.sha256(json.dumps(request, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
                       and turn.get("outcome") in {"IntentPersisted", "Applied", "HTTPRejected", "ResponseInvalid", "OutcomeUnknown", "DeadlineExpired"}, "STATE_BOUNDED_GAMES_INVALID")
    _check(total_calls <= grant["maxGameCalls"] and total_calls * 512 <= grant["maxGameCompletionTokens"], "STATE_BOUNDED_GAMES_INVALID")


def _external_record(value, trust, gateway):
    q, request = value["quote"], value["request"]
    _check(q["price"] == trust["priceRaw"] and q["service"] == trust["serviceId"] and q["model"] == trust["modelId"]
           and q["payTo"] == trust["provider"] and q["taskId"] == "0" and "tier" not in q, "STATE_EXTERNAL_JOURNAL_INVALID")
    _uint(q["agentId"], True)
    _closed(request, ("agentId", "taskId", "service", "model", "messages", "max_completion_tokens", "thinking"), "STATE_EXTERNAL_JOURNAL_INVALID")
    _check(request["max_completion_tokens"] == 2048 and request["thinking"] == {"type": "disabled"}, "STATE_EXTERNAL_JOURNAL_INVALID")
    messages = request["messages"]
    _check(len(messages) == 2 and all(isinstance(m, dict) and set(m) == {"role", "content"} and isinstance(m["content"], str) for m in messages)
           and messages[0]["role"] == "system" and messages[1]["role"] == "user", "STATE_EXTERNAL_JOURNAL_INVALID")
    assignment = _obj(_json(messages[1]["content"].encode()), ("originalGoal", "assignment"))
    nested = _obj(assignment["assignment"], ("name", "taskType", "goal"))
    # prepareExternalHire strips stage and the top-level taskType before
    # serializing context. The nested assignment carries the original type.
    _check(nested["taskType"] == trust["taskType"] and "stage" not in assignment and "taskType" not in assignment
           and all(isinstance(text, str) and text.strip() and len(text) <= maximum for text, maximum in
                ((assignment["originalGoal"], 12000), (nested["name"], 160), (nested["goal"], 12000))), "STATE_EXTERNAL_JOURNAL_INVALID")
    _check(value.get("route") == {"version": 1, "model": trust["modelId"], "upstreams": [{"name": trust["modelId"],
        "model": trust["physicalModel"], "baseUrl": gateway["url"]}]}, "STATE_EXTERNAL_JOURNAL_INVALID")
    if "proof" in value:
        _check(value["proof"]["fromCredit"] == "0", "STATE_EXTERNAL_JOURNAL_INVALID")
    for attempt in value.get("upstreamAttempts", []):
        _check(attempt.get("upstream") == trust["modelId"] and attempt.get("model") == trust["physicalModel"], "STATE_EXTERNAL_JOURNAL_INVALID")
    if value["state"] == "Delivered":
        receipt, result = value["receipt"], _obj(value["result"])
        _check(all(receipt.get(k) == q[k] for k in ("agentId", "taskId", "service", "price", "asset", "chainId", "account", "payTo"))
               and receipt.get("upstream") == trust["modelId"] and receipt.get("model") == trust["physicalModel"]
               and result.get("model") == trust["responseModel"], "STATE_EXTERNAL_JOURNAL_INVALID")
        _check(result.get("externalService") == {"version": 1, "id": trust["id"], "serviceId": trust["serviceId"], "taskType": trust["taskType"],
            "provider": trust["provider"], "identity": trust["identity"], "promptDigest": hashlib.sha256(messages[0]["content"].encode()).hexdigest(),
            "assignmentDigest": _digest(messages[1]["content"])}, "STATE_EXTERNAL_JOURNAL_INVALID")


def _feature_seal(journal, hosted, db, root, files, docs):
    marker = journal["features"].get("seal")
    path = "operator/acceptance-20261016/closure.json"
    if marker is None:
        _check("seal" not in journal["features"] and "boundedGamesSealed" not in hosted and path not in files, "STATE_FEATURES_SEAL_INVALID")
        return
    _closed(marker, ("version", "file", "digest"), "STATE_FEATURES_SEAL_INVALID")
    _check(marker["version"] == 1 and marker["file"] == str(root / path) and hosted.get("boundedGamesSealed") is True
           and _private_reference(marker["file"], root, files) == path
           and files[path]["mode"] == 0o600 and files[path]["sha256"] == marker["digest"]
           and all(files[path][k] == files["runtime/runtime-journal/session.json"][k] for k in ("uid", "gid")), "STATE_FEATURES_SEAL_INVALID")
    closure = _closed(docs.get(path), ("version", "id", "closedAt", "goalRequestId", "parentRequestId", "budgetId", "budgetDigest", "ledgerSha256", "boundedAdmissionsSha256"), "STATE_FEATURES_SEAL_INVALID")
    budget_path, ledger_path = ("operator/acceptance-20261016/" + name for name in ("transaction-budget.json", "transaction-budget-ledger.json"))
    state, config = db["boundedGames"], journal["features"]["config"]
    _check(closure["version"] == 1 and closure["id"] == config["id"] and closure["parentRequestId"] == state["grant"]["parentRequestId"]
           and closure["goalRequestId"] != closure["parentRequestId"] and closure["budgetId"] == docs[budget_path]["id"]
           and closure["budgetDigest"] == files[budget_path]["sha256"] and ledger_path in files
           and closure["ledgerSha256"] == files[ledger_path]["sha256"]
           and closure["boundedAdmissionsSha256"] == files["operator/bounded-admissions/session.json"]["sha256"], "STATE_FEATURES_SEAL_INVALID")
    closed_at = _iso_millis(closure["closedAt"])
    _check(closed_at <= int(datetime.now().timestamp() * 1000), "STATE_FEATURES_SEAL_INVALID")
    for key, action in (("goalRequestId", "goal"), ("parentRequestId", "autonomous")):
        _check(isinstance(closure[key], str) and _UUID.fullmatch(closure[key]) is not None, "STATE_FEATURES_SEAL_INVALID")
        matches = [r for r in db["runs"] if r["requestId"] == closure[key]]
        _check(len(matches) == 1 and matches[0]["action"] == action and matches[0]["agentId"] == state["grant"]["actor"]["hostedAgentId"]
               and matches[0]["status"] in {"Succeeded", "Failed"} and matches[0].get("result", {}).get("terminal") is True
               and matches[0]["recoverable"] is False
               and _iso_millis(matches[0].get("updatedAt")) <= closed_at, "STATE_FEATURES_SEAL_INVALID")
    _check(all(_iso_millis(r["admittedAt"]) <= closed_at for r in state["admissions"])
           and all(_iso_millis(r["admittedAt"]) <= closed_at for r in docs[ledger_path]["reservations"]), "STATE_FEATURES_SEAL_INVALID")


def _capture(project: Path) -> dict:
    project = Path(project).absolute()
    _check(project == project.resolve(strict=True), "STATE_PATH_INVALID")
    root = project / ".data" / "tempo-20261012"
    _check(root.is_dir() and root == root.resolve(strict=True), "STATE_CRITICAL_MISSING")
    files, links, dirs, special, raw = _scan(root)
    _check(all(name in files for name in _REQUIRED), "STATE_CRITICAL_MISSING")
    docs = {name: _json(content) for name, content in raw.items()
            if name.endswith(".json") and not name.startswith("gateway/responses/")}
    for name, value in docs.items():
        if name.endswith("/.writer/owner.json"):
            _obj(value, ("pid", "token"))
            _check(set(value) == {"pid", "token"} and isinstance(value["token"], str) and _UUID.fullmatch(value["token"]) is not None)
            _integer(value["pid"], True)
    b = _obj(docs["operator/bootstrap.json"], ("version", "chainId", "contracts", "deploymentBlock", "asset", "identity", "reputation", "payTo", "publicRpcUrl", "rpcTransport", "opponentBinding", "dashboardAgents", "tasks", "maxFeePerGas", "frontendOrigin", "roleKeyFiles", "rpcUrlFile", "vendorKeyFile", "gatewayReadyFile", "hostedPort"))
    _check(b["version"] == 1 and b["chainId"] == "42431" and b["frontendOrigin"] == _ORIGIN and b["hostedPort"] == 8794)
    _check(set(_obj(b["contracts"])) == {"manager", "adapter", "account", "escrow"})
    for value in [*b["contracts"].values(), b["identity"], b["reputation"], b["payTo"]]: _address(value)
    _check(len({a.lower() for a in b["contracts"].values()}) == 4)
    _integer(b["deploymentBlock"]); _uint(b["maxFeePerGas"], True); _public_url(b["publicRpcUrl"])
    _check(b["rpcTransport"] == "direct")
    asset = _obj(b["asset"], ("address", "symbol", "decimals"))
    _check(asset == {"address": "0x20c0000000000000000000000000000000000000", "symbol": "PathUSD", "decimals": 6})
    opponent = _obj(b["opponentBinding"], ("chainId", "agentId", "wallet"))
    _check(opponent["chainId"] == "42431"); _uint(opponent["agentId"], True); _address(opponent["wallet"])
    _check(3 <= len(_array(b["dashboardAgents"])) <= 12 and len(_array(b["tasks"])) >= 4)
    for agent in b["dashboardAgents"]:
        _obj(agent, ("id", "name")); _uint(agent["id"], True); _check(isinstance(agent["name"], str) and bool(agent["name"].strip()))
    for task in b["tasks"]:
        _obj(task, ("taskId", "problemId", "deadlineMs", "creditLimit")); _uint(task["taskId"], True); _integer(task["deadlineMs"], True)
        _check(task["problemId"] in {"sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"} and task["creditLimit"] == "80000")
    _check(len({a["id"] for a in b["dashboardAgents"]}) == len(b["dashboardAgents"])
           and len({t["taskId"] for t in b["tasks"]}) == len(b["tasks"]))
    roles = _obj(b["roleKeyFiles"])
    _check(set(roles) == {"guardian", "underwriter", "verifier", "refunder", "sponsor", "opponent"})
    for path in [*roles.values(), b["rpcUrlFile"], b["vendorKeyFile"], b["gatewayReadyFile"]]:
        _private_reference(path, root, files)
    upstream = _obj(docs["operator/model-upstream.json"], ("upstream",))["upstream"]
    _obj(upstream, ("name", "baseUrl", "apiKeyFile"))
    _check(upstream["name"] == "kimi" and upstream["baseUrl"] == "https://api.moonshot.cn/v1")
    _private_reference(upstream["apiKeyFile"], root, files)
    gateway = _obj(docs["gateway/ready.json"], ("version", "pid", "magpiePid", "startedAt", "url", "endpoint", "bridgeHealthUrl", "keyFile", "models", "binarySha256", "inferenceRetries", "transport"))
    _check(gateway["version"] == 1 and gateway["url"] == "http://127.0.0.1:3436/v1"
           and gateway["endpoint"] == gateway["url"] + "/chat/completions"
           and gateway["bridgeHealthUrl"] == "http://127.0.0.1:3437/health"
           and gateway["inferenceRetries"] == 0 and gateway["transport"] == "direct"
           and _SHA.fullmatch(gateway["binarySha256"]) is not None)
    _integer(gateway["pid"], True); _integer(gateway["magpiePid"], True)
    _timestamp(gateway["startedAt"])
    _check(_private_reference(gateway["keyFile"], root, files) == "gateway/magpie.key")
    _check(gateway["models"] == [{"id": "cheap", "model": "cheap/kimi-k2.6", "responseModel": "kimi-k2.6"},
                                {"id": "strong", "model": "strong/kimi-k3", "responseModel": "kimi-k3"}])
    journal = _obj(docs["runtime/runtime-journal/session.json"], ("version", "binding", "startedAt", "ipcDirectory", "ports"))
    _check(journal["version"] == 1 and _SHA.fullmatch(journal["binding"]) is not None)
    _timestamp(journal["startedAt"])
    _obj(journal["ports"])
    features = _feature_config(journal, b, root, files, docs)
    expected_ports = _PORTS | ({"external-registry"} | {f"external-{task_type}-{i}" for task_type, _ in _SPECIALISTS for i in (0, 1)} if features else set())
    _check(set(journal["ports"]) == expected_ports, "STATE_FEATURES_PORTS_INVALID" if features else "STATE_SCHEMA_INVALID")
    for value in journal["ports"].values():
        _check(type(value) is int and 1024 <= value <= 65535)
    if features:
        _check(len(set(journal["ports"].values())) == len(expected_ports) and 8794 not in journal["ports"].values()
               and not {3436, 3437} & set(journal["ports"].values()), "STATE_FEATURES_PORTS_INVALID")
    _external_paths(features, files, dirs, links)
    issues = set()
    if any(m.get("status") != "Applied" for m in _array(journal.get("migrations", []))):
        issues.add("STATE_MIGRATION_INFLIGHT")
    _check("testSponsorship" not in journal, "STATE_PRODUCTION_SPONSORSHIP_ENABLED")
    if "publicOriginMigration" in journal:
        migration = _obj(journal["publicOriginMigration"], ("id", "auditFile", "toOrigin", "publicBinding"))
        audit_path = _private_reference(migration["auditFile"], root, files)
        audit = _obj(docs.get(audit_path), ("id", "status", "origin"))
        _check(audit["id"] == migration["id"] and audit["status"] == "Applied" and audit["origin"] == migration["toOrigin"] == _ORIGIN, "STATE_MIGRATION_INVALID")
        _origin_binding_chain(journal, migration, audit, b, gateway)
    hosted_config = _obj(docs["runtime/hosted.json"], ("version", "hosted", "executor", "port"))
    hosted = _obj(hosted_config["hosted"], ("origin", "chainId", "directory"))
    _check(hosted_config["version"] == 1 and hosted_config["port"] == 8794 and hosted["chainId"] == "42431"
           and hosted["origin"] == _ORIGIN and hosted["directory"] == str(root / "runtime/hosted")
           and "testSponsorshipFile" not in hosted, "STATE_PRODUCTION_DOMAIN_INVALID")
    if features:
        _check(hosted.get("boundedGamesFile") == features["boundedGamesFile"], "STATE_FEATURES_INVALID")
        external = _external_catalog(features, journal["ports"])
        expected_goals = {"durationMs": 1200000, "chainLookup": True, "models": [{"id": response,
            "relayUrl": f"http://127.0.0.1:{journal['ports'][port]}/v1/chat", "provider": b["payTo"], "priceRaw": price,
            "service": "tabby/mission", "model": model, "physicalModel": physical, "responseModel": response}
            for port, (model, physical, response, price) in zip(("goalCheap", "goalStrong"), _EXTERNAL_MODELS)], "external": external}
        _check(hosted_config.get("goals") == expected_goals, "STATE_EXTERNAL_CONFIG_INVALID")
        autonomy = {"maxTasks": 1, "maxDecisions": 4, "durationMs": 1200000,
            "plannerRelayUrl": f"http://127.0.0.1:{journal['ports']['planner']}/v1/chat", "plannerProvider": b["payTo"], "plannerPriceRaw": "10000",
            "plannerService": "infercredit/plan", "plannerModel": "logical-planner", "plannerPhysicalModel": "cheap/kimi-k2.6", "plannerResponseModel": "kimi-k2.6", "games": _GAMES}
        _check(hosted_config.get("autonomy") == autonomy, "STATE_BOUNDED_GAMES_INVALID")
    else:
        external, autonomy = None, None
        _check("boundedGamesFile" not in hosted and "external" not in _obj(hosted_config.get("goals", {}))
               and "games" not in _obj(hosted_config.get("autonomy", {})), "STATE_FEATURES_REQUIRED")
    executor = _obj(hosted_config["executor"], ("taskConfigFile", "gameConfigFile"))
    _check(executor == {"taskConfigFile": str(root / "runtime/task.json"), "gameConfigFile": str(root / "runtime/game.json")})
    arena_config = _obj(docs["runtime/arena.json"], ("chainId", "escrowAddress", "ipcDirectory", "tasks", "rpcUrl"))
    _check(arena_config["chainId"] == "42431" and arena_config["escrowAddress"] == b["contracts"]["escrow"]
           and arena_config["ipcDirectory"] == journal["ipcDirectory"] and arena_config["rpcUrl"] == b["publicRpcUrl"]
           and arena_config["tasks"] == {t["taskId"]: {"problemId": t["problemId"]} for t in b["tasks"]})
    task_config = _obj(docs["runtime/task.json"], ("version", "identity", "guardianKeyFile", "rpcUrlFile", "rpcTransport", "publicRpcUrl", "walletDirectory", "arenaUrl", "underwriterUrl", "models"))
    _check(task_config["version"] == 1 and task_config["identity"] == b["identity"]
           and task_config["guardianKeyFile"] == b["roleKeyFiles"]["guardian"] and task_config["rpcUrlFile"] == b["rpcUrlFile"]
           and task_config["rpcTransport"] == "direct" and task_config["publicRpcUrl"] == b["publicRpcUrl"]
           and task_config["walletDirectory"] == str(root / "runtime/wallets")
           and task_config["arenaUrl"] == f"http://127.0.0.1:{journal['ports']['arena']}"
           and task_config["underwriterUrl"] == f"http://127.0.0.1:{journal['ports']['underwriter']}")
    _check([m.get("id") for m in _array(task_config["models"])] == ["kimi-k2.6", "kimi-k3"])
    if features:
        for index, model in enumerate(task_config["models"]):
            workflow = {"agentId": "1", "chainId": "42431", "account": b["contracts"]["account"], "asset": b["asset"]["address"], "escrowAddress": b["contracts"]["escrow"],
                "tasks": [t for t in b["tasks"] if t["taskId"] in features["taskIds"]], "allowCredit": True, "maxPrice": "120000",
                "deadlineMs": features["taskTemplateDeadlineMs"], "minRemainingMs": 60000, "maxCompletionTokens": 1024,
                "providers": [{"id": "trusted-fixed", "payTo": b["payTo"], "relayUrl": f"http://127.0.0.1:{journal['ports']['fixed']}/v1/chat",
                    "service": "infercredit/solve-fixed", "model": "pi-fixed-v1", "routes": [{"tier": "strong" if index else "cheap", "price": "120000",
                        "capabilities": ["python3-json-stdio", "sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"],
                        "solve": {"version": 1, "tiers": ["strong", "strong"] if index else ["cheap", "strong"], "maxRounds": 2, "maxToolCalls": 4, "maxCompletionTokens": 1024}}]}]}
            _check(model.get("physicalModels") == {"cheap": "cheap/kimi-k2.6", "strong": "strong/kimi-k3"}
                   and model.get("templates") == {strategy: workflow for strategy in ("conservative", "balanced", "aggressive")}, "STATE_FEATURES_TASK_INVALID")
    _check(not any(k.startswith("gasSponsor") or k == "gasGrantWei" for k in task_config))
    game_config = _obj(docs["runtime/game.json"], ("version", "chainId", "identity", "account", "token", "rpcUrlFile", "rpcTransport", "upstreamTransport", "sponsorKeyFile", "walletDirectory", "creditsDirectory", "models"))
    _check(game_config["version"] == 1 and game_config["chainId"] == "42431" and game_config["identity"] == b["identity"]
           and game_config["account"] == b["contracts"]["account"] and game_config["token"] == b["asset"]["address"]
           and game_config["rpcUrlFile"] == b["rpcUrlFile"] and game_config["rpcTransport"] == game_config["upstreamTransport"] == "direct"
           and game_config["sponsorKeyFile"] == b["roleKeyFiles"]["sponsor"] and game_config["walletDirectory"] == task_config["walletDirectory"]
           and game_config["creditsDirectory"] == str(root / "runtime/credits"))
    _check([m.get("id") for m in _array(game_config["models"])] == ["kimi-k2.6", "kimi-k3"])
    if features:
        _check(game_config.get("opponent") == {"binding": b["opponentBinding"], "keyFile": roles["opponent"], "modelId": "kimi-k2.6", "strategy": "balanced"}
               and game_config["models"] == [{"id": model, "baseUrl": "https://api.moonshot.cn/v1", "keyFile": b["vendorKeyFile"]} for model in ("kimi-k2.6", "kimi-k3")], "STATE_BOUNDED_GAMES_INVALID")
    deployment = _obj(docs["runtime/deployment.json"], ("chainId", "contracts", "asset", "deploymentBlock", "rpcUrl", "underwriterUrl", "arenaUrl", "agents"))
    _check(deployment["chainId"] == "42431" and deployment["contracts"] == b["contracts"] and deployment["asset"] == b["asset"]
           and deployment["deploymentBlock"] == b["deploymentBlock"] and deployment["rpcUrl"] == b["publicRpcUrl"]
           and deployment["underwriterUrl"] == task_config["underwriterUrl"] and deployment["arenaUrl"] == task_config["arenaUrl"]
           and deployment["agents"] == b["dashboardAgents"])
    ready = _obj(docs["runtime/ready.json"], ("version", "pid", "startedAt", "chainId", "frontendOrigin", "ports"))
    _check(ready["version"] == 1 and ready["chainId"] == "42431" and ready["frontendOrigin"] == _ORIGIN
           and ready["startedAt"] == journal["startedAt"] and ready["ports"] == journal["ports"])
    _integer(ready["pid"], True)
    db = _obj(docs["runtime/hosted/database/session.json"], ("version", "configBinding", "challenges", "sessions", "agents", "runs", "creations", "sponsoredOwners", "sponsoredTotal"))
    _check(db["version"] == 1 and db["configBinding"] == hashlib.sha256(json.dumps({"origin": _ORIGIN, "chainId": "42431"}, separators=(",", ":")).encode()).hexdigest())
    for name in ("challenges", "sessions", "agents", "runs", "creations"):
        _array(db[name])
    _obj(db["sponsoredOwners"]); _integer(db["sponsoredTotal"])
    for amount in db["sponsoredOwners"].values(): _integer(amount)
    for agent in db["agents"]:
        _obj(agent, ("id", "status", "reservedRaw", "spentRaw"))
        _check(agent["status"] in {"Pending", "Ready", "Paused"})
        _uint(agent["spentRaw"])
        if _uint(agent["reservedRaw"]) or "activeRequestId" in agent:
            issues.add("STATE_AGENT_INFLIGHT")
    for run in db["runs"]:
        _obj(run, ("requestId", "agentId", "action", "status", "reservedRaw", "chargedRaw", "recoverable"))
        _check(run["status"] in {"Queued", "Running", "Paused", "Succeeded", "Failed"} and type(run["recoverable"]) is bool)
        _uint(run["reservedRaw"]); _uint(run["chargedRaw"])
        if run["status"] not in {"Succeeded", "Failed"}:
            issues.add("STATE_HOSTED_INFLIGHT")
        elif not isinstance(run.get("result"), dict) or run["result"].get("terminal") is not True or run["recoverable"]:
            issues.add("STATE_HOSTED_INFLIGHT")
    if features:
        _bounded_games(features, db, root, files, dirs, links, docs, issues, autonomy, "seal" in journal["features"])
        _transaction_budget(features, b, root, files, dirs, links, docs, issues)
        _feature_seal(journal, hosted, db, root, files, docs)
    else:
        _check("boundedGames" not in db and "boundedGamesSealed" not in hosted and not any(p == "operator/bounded-admissions" or p.startswith("operator/bounded-admissions/")
            for p in set(files) | set(dirs) | set(links)), "STATE_FEATURES_REQUIRED")
    # Capture the authoritative external IPC directory without following links.
    ipc = Path(journal["ipcDirectory"])
    _check(ipc.is_absolute() and ipc.name.startswith("af-tempo-hosted-") and ipc.parent.resolve() == Path("/tmp").resolve(), "STATE_IPC_PATH_INVALID")
    if ipc.exists():
        _check(not ipc.is_symlink() and ipc.is_dir(), "STATE_IPC_PATH_INVALID")
        ipcf, ipcl, ipcd, ipcs, ipcr = _scan(ipc, "@ipc/", True)
        _check(not ipcl and not ipcd and set(ipcf) <= {"@ipc/settlements.json", "@ipc/settler.owner", "@ipc/controller.token", "@ipc/recover.lock"}, "STATE_IPC_PATH_INVALID")
        files.update(ipcf); special.update(ipcs); raw.update(ipcr)
        if "@ipc/settlements.json" in raw:
            docs["@ipc/settlements.json"] = _json(raw["@ipc/settlements.json"])
    if "@ipc/recover.lock" in files or any("/.recover" in p for p in dirs):
        issues.add("STATE_RECOVERY_IN_PROGRESS")
    settlement_key = "@ipc/settlements.json" if "@ipc/settlements.json" in docs else "runtime/settlement-journal.json"
    _check(settlement_key in docs, "STATE_CRITICAL_MISSING")
    settlements = _settlement_summary(docs[settlement_key], issues)
    if "runtime/settlement-journal.json" in docs:
        _settlement_summary(docs["runtime/settlement-journal.json"], issues if settlement_key == "runtime/settlement-journal.json" else set())
        for task_id, old in docs["runtime/settlement-journal.json"].items():
            current = docs[settlement_key].get(task_id)
            _check(isinstance(current, dict) and all(current[k] == old[k] for k in ("verdict", "verdictHash", "rawTx", "txHash")), "STATE_SETTLEMENT_CHANGED")
    if "runtime/arena-http-journal.json" in docs:
        arena = _obj(docs["runtime/arena-http-journal.json"], ("runs", "submissions"))
        _array(arena["submissions"])
        for run in _array(arena["runs"]):
            _obj(run, ("runId", "taskId", "status"))
            _check(run["status"] in {"running", "settled", "error"})
            if run["status"] == "running": issues.add("STATE_ARENA_INFLIGHT")
    attempts = [_json(line) for line in raw["gateway/attempts.jsonl"].splitlines() if line.strip()]
    dispatches, outcomes = {}, {}
    for entry in attempts:
        _obj(entry, ("attempt", "phase", "at"))
        _integer(entry["attempt"], True)
        _timestamp(entry["at"])
        _check(entry["phase"] in {"DispatchIntent", "Response", "OutcomeUnknown"})
        if entry["phase"] == "DispatchIntent":
            _obj(entry, ("model", "requestDigest", "maxCompletionTokens"))
            _check(entry["model"] in {"kimi-k2.6", "kimi-k3"} and _SHA.fullmatch(entry["requestDigest"]) is not None)
            _check(1 <= _integer(entry["maxCompletionTokens"]) <= 8192)
            _check(entry["attempt"] == len(dispatches) + 1)
            dispatches[entry["attempt"]] = entry
        else:
            _check(entry["attempt"] in dispatches and entry["attempt"] not in outcomes)
            if entry["phase"] == "Response":
                _obj(entry, ("model", "httpStatus", "transport", "responseDigest"))
                response = f"gateway/responses/attempt-{entry['attempt']}.json"
                _check(response in files and files[response]["sha256"] == entry["responseDigest"]
                       and entry["model"] == dispatches[entry["attempt"]]["model"]
                       and entry["transport"] == "direct" and type(entry["httpStatus"]) is int and 100 <= entry["httpStatus"] <= 599,
                       "STATE_GATEWAY_EVIDENCE_INVALID")
            outcomes[entry["attempt"]] = entry
    if set(dispatches) != set(outcomes): issues.add("STATE_GATEWAY_INFLIGHT")
    ledgers = {}
    for name, value in docs.items():
        if name.endswith("/inference-ledger/session.json"):
            _obj(value, ("version", "binding", "catalog", "grants", "invocations"))
            _check(value["version"] == 1)
            identity = _obj(value["binding"], ("agentId", "taskId", "wallet"))
            _check(set(identity) == {"agentId", "taskId", "wallet"}); _uint(identity["agentId"], True); _uint(identity["taskId"], True); _address(identity["wallet"])
            _check(identity["wallet"] == identity["wallet"].lower())
            catalog = _array(value["catalog"])
            _check(len(catalog) == 2 and [m.get("id") for m in catalog] == ["cheap", "strong"])
            for index, model in enumerate(catalog):
                _obj(model, ("id", "model", "route", "inputMicroCreditsPerToken", "outputMicroCreditsPerToken", "maxCompletionTokens"))
                _check(model["model"] == gateway["models"][index]["model"] and model.get("responseModel") == gateway["models"][index]["responseModel"]
                       and model["route"] == gateway["endpoint"] and model["maxCompletionTokens"] == 1024)
                _uint(model["inputMicroCreditsPerToken"], True); _uint(model["outputMicroCreditsPerToken"], True)
            for grant in _array(value["grants"]):
                _obj(grant, ("id", "credits", "source")); _uint(grant["credits"], True)
                source = _obj(grant["source"], ("kind",))
                _check(source["kind"] in {"game", "chain-payment"})
                if source["kind"] == "chain-payment":
                    _check(_HASH.fullmatch(source["paymentId"]) is not None and _HASH.fullmatch(source["txHash"]) is not None and grant["id"] == source["paymentId"])
            for invocation in _array(value["invocations"]):
                _obj(invocation, ("id", "state", "request", "requestDigest", "modelId", "reservedCredits", "maxPromptTokens", "maxCompletionTokens"))
                _check(invocation["modelId"] in {"cheap", "strong"} and invocation["requestDigest"] == _digest(invocation["request"]))
                _uint(invocation["reservedCredits"]); _integer(invocation["maxPromptTokens"]); _integer(invocation["maxCompletionTokens"], True)
                _check(invocation["state"] in {"DispatchIntent", "ResponseRecorded", "Completed", "Rejected", "Unknown", "UsageOverrun"})
                if invocation["state"] not in {"Completed", "Rejected"} and not _valid_closure(value):
                    issues.add("STATE_INFERENCE_INFLIGHT")
            if "closure" in value: _check(_valid_closure(value), "STATE_CLOSURE_INVALID")
            ledgers[name] = value
    compensated = set()
    resolved_requests = {}
    verified_relays = {}
    external_by_directory = {s["id"]: s for s in external["services"]} if external else {}

    def remember_bridge(request, payment_id, source, identity):
        digest = _bridge_request_digest(request)
        if digest:
            resolved_requests.setdefault(digest, []).append({"paymentId": payment_id, "source": source, "identity": identity})

    for name, value in docs.items():
        core = bool(re.fullmatch(r"runtime/(?:fixed|allowance|planner|goal-cheap|goal-strong)/0x[0-9a-f]{64}\.json", name))
        external_match = re.fullmatch(r"runtime/external-services/([^/]+)/0x[0-9a-f]{64}\.json", name)
        if core or external_match:
            trust = external_by_directory.get(external_match[1]) if external_match else None
            _check(core or trust is not None, "STATE_EXTERNAL_JOURNAL_INVALID")
            _obj(value, ("quote", "request", "state", "refunds"))
            q = _obj(value["quote"], ("paymentId", "price", "agentId", "taskId", "service", "model", "requestDigest", "serverNonce", "chainId", "account", "asset", "payTo", "quoteExpiry", "createdBlock"))
            _check(q["paymentId"] == Path(name).stem and _HASH.fullmatch(q["requestDigest"]) is not None)
            _uint(q["price"], True); _uint(q["agentId"]); _uint(q["taskId"])
            _uint(q["quoteExpiry"]); _integer(q["createdBlock"])
            _check(q["chainId"] == "42431" and q["account"] == b["contracts"]["account"] and q["asset"] == b["asset"]["address"] and q["payTo"] == (trust["provider"] if trust else b["payTo"])
                   and _HASH.fullmatch(q["serverNonce"]) is not None)
            request = _obj(value["request"], ("agentId", "taskId", "service", "model", "messages"))
            _array(request["messages"])
            _check(all(request[k] == q[k] for k in ("agentId", "taskId", "service", "model"))
                   and q["requestDigest"] == _keccak(_canonical(request)))
            expected_id = _keccak(int(q["taskId"]).to_bytes(32, "big") + bytes.fromhex(q["requestDigest"][2:]) + bytes.fromhex(q["serverNonce"][2:]))
            _check(q["paymentId"] == expected_id)
            if "proof" in value:
                proof = _obj(value["proof"], ("txHash", "blockNumber", "blockHash", "timestamp", "fromCash", "fromCredit"))
                _check(_HASH.fullmatch(proof["txHash"]) is not None and _HASH.fullmatch(proof["blockHash"]) is not None)
                _integer(proof["blockNumber"]); _integer(proof["timestamp"])
                _check(_uint(proof["fromCash"]) + _uint(proof["fromCredit"]) == _uint(q["price"]))
            _check(value["state"] in {"Quoted", "Paid", "Processing", "Delivered", "Refunded"})
            if value["state"] in {"Delivered", "Refunded"}:
                _check("proof" in value)
            if value["state"] == "Delivered":
                receipt = _obj(value.get("receipt"), ("paymentId", "txHash", "requestDigest"))
                _check("result" in value and receipt["paymentId"] == q["paymentId"]
                       and receipt["txHash"] == value["proof"]["txHash"] and receipt["requestDigest"] == q["requestDigest"])
            if trust:
                _external_record(value, trust, gateway)
            _check(q["paymentId"] not in verified_relays, "STATE_RELAY_RECORD_INVALID")
            verified_relays[q["paymentId"]] = value
            refunds = _array(value["refunds"])
            if any(r.get("state") != "Confirmed" for r in refunds): issues.add("STATE_REFUND_INFLIGHT")
            for attempt in _array(value.get("upstreamAttempts", [])):
                _obj(attempt, ("upstream", "model", "startedAt", "state")); _integer(attempt["startedAt"])
                _check(attempt["state"] in {"Dispatching", "Rejected", "Unknown", "Delivered"})
            resolved = bool(_valid_resolution(value)) or bool(_valid_compensation(value, ledgers, docs))
            if "operatorResolution" in value: _check(_valid_resolution(value), "STATE_RESOLUTION_INVALID")
            if "operatorCompensation" in value:
                _check(_valid_compensation(value, ledgers, docs), "STATE_COMPENSATION_INVALID")
                compensated.add(q["paymentId"])
            if _valid_resolution(value):
                inference = {k: v for k, v in value["request"].items() if k not in {"agentId", "taskId", "service", "tier"}}
                for index, a in enumerate(value.get("upstreamAttempts", [])):
                    if a["state"] == "Unknown":
                        remember_bridge({**inference, "model": a["model"]}, q["paymentId"], "operator-resolution", f"relay:{q['paymentId']}:{index}")
            if value["state"] in {"Paid", "Processing"} or (value["state"] == "Quoted" and (value.get("proof") or refunds or value.get("upstreamAttempts"))):
                issues.add("STATE_RELAY_INFLIGHT")
            if any(a["state"] in {"Dispatching", "Unknown"} for a in value.get("upstreamAttempts", [])) and not resolved:
                issues.add("STATE_RELAY_UNKNOWN")
            if value["state"] == "Refunded" and not _confirmed_refund(value): issues.add("STATE_REFUND_INFLIGHT")
    for ledger in ledgers.values():
        if "closure" in ledger and ledger["closure"]["paymentId"] not in compensated:
            issues.add("STATE_INFERENCE_INFLIGHT")
        elif "closure" in ledger:
            for invocation in ledger["invocations"]:
                payment_id = ledger["closure"]["paymentId"]
                remember_bridge(invocation.get("request"), payment_id, "sealed-allowance", f"ledger:{payment_id}:{invocation['id']}")
    used_resolutions = set()
    resolved_unknown = []
    for attempt, outcome in outcomes.items():
        if outcome["phase"] == "OutcomeUnknown":
            digest = dispatches[attempt]["requestDigest"]
            matches = [row for row in resolved_requests.get(digest, []) if row["identity"] not in used_resolutions]
            # One durable intent needs its own unique resolution. Identical
            # prompts cannot let one historical refund excuse a later dispatch.
            if len(matches) != 1:
                issues.add("STATE_GATEWAY_UNKNOWN")
            else:
                row = matches[0]
                used_resolutions.add(row["identity"])
                resolved_unknown.append({"attempt": attempt, "requestDigest": digest, "paymentId": row["paymentId"], "source": row["source"]})
    for name, value in docs.items():
        if name.startswith("runtime/credits/") and name.endswith("/session.json"):
            _obj(value, ("version", "accounts", "grants", "redemptions")); _check(value["version"] == 1)
            _array(value["accounts"]); _array(value["grants"])
            for record in _array(value["redemptions"]):
                _obj(record, ("status",))
                _check(record["status"] in {"DispatchIntent", "ResponseRecorded", "Completed", "Failed", "OutcomeUnknown", "UsageOverrun"})
                if record["status"] not in {"Completed", "Failed"}: issues.add("STATE_REWARD_INFLIGHT")
        if "/runs/" in name and name.endswith("/session.json"):
            _obj(value)
            if name.endswith("/mission/session.json"):
                _obj(value, ("version", "view", "calls")); _check(value["version"] == 1)
                for call in _array(value["calls"]):
                    if call.get("started") and not call.get("response") and not call.get("unpaid"):
                        recovery = call.get("recovery", {})
                        payment = call.get("handle", {}).get("quote", {}).get("paymentId")
                        matches = [r for p, r in docs.items() if (re.fullmatch(r"runtime/goal-(?:cheap|strong)/0x[0-9a-f]{64}\.json", p)
                            or re.fullmatch(r"runtime/external-services/[^/]+/0x[0-9a-f]{64}\.json", p))
                            and r.get("quote", {}).get("paymentId") == payment and verified_relays.get(payment) is r]
                        if not (recovery.get("resolved") is True and len(matches) == 1 and _valid_resolution(matches[0])):
                            issues.add("STATE_MISSION_INFLIGHT")
                if value.get("result", {}).get("terminal") is not True: issues.add("STATE_MISSION_INFLIGHT")
            elif name.endswith("/game/session.json") and "turns" in value:
                _check(value.get("phase") in {"Running", "Complete", "Stopped"})
                if value["phase"] == "Running" or any(t.get("outcome") in {"IntentPersisted", "OutcomeUnknown"} for t in _array(value["turns"])):
                    issues.add("STATE_GAME_INFLIGHT")
            elif name.endswith("/autonomy-loop/session.json"):
                if value.get("phase") not in {"Stopped", "Completed"}: issues.add("STATE_AUTONOMY_INFLIGHT")
            elif name.endswith("/workflow/session.json"):
                if value.get("phase") not in _TERMINAL: issues.add("STATE_WORKFLOW_INFLIGHT")
                if value.get("phase") == "Stopped" and (value.get("child", {}).get("inference") or value.get("handle", {}).get("submission")):
                    issues.add("STATE_WORKFLOW_INFLIGHT")
            elif name.endswith("/task-executor/session.json") or re.fullmatch(r"runtime/hosted/agents/[^/]+/runs/[^/]+/session.json", name):
                if value.get("result", {}).get("terminal") is not True: issues.add("STATE_EXECUTOR_INFLIGHT")
        if name.startswith("runtime/wallets/") and name.endswith("/session.json"):
            _obj(value)
            if "/operator/" in name:
                if value.get("directory") or value.get("hash"): issues.add("STATE_OPERATOR_INFLIGHT")
            elif "phase" in value and value["phase"] not in _TERMINAL: issues.add("STATE_WALLET_INFLIGHT")
        if name.startswith("runtime/fixed/solve-runs/") and name.endswith("/session.json"):
            _obj(value, ("phase", "rounds"))
            if value["phase"] not in {"Delivered", "Undelivered"} or any(r.get("state") == "Dispatching" for r in _array(value["rounds"])):
                issues.add("STATE_SOLVER_INFLIGHT")
    # All response and game/private run files remain protected by the full
    # inventory even when no generic gateway dispatch was involved.
    metadata = {
        "gateway/ready.json": _digest({k: v for k, v in gateway.items() if k not in {"pid", "magpiePid", "startedAt"}}),
        "runtime/ready.json": _digest({k: v for k, v in ready.items() if k != "pid"}),
    }
    providers_name = "gateway/magpie/config/magpie/providers.json"
    if providers_name in docs:
        provider_doc = _obj(docs[providers_name], ("providers",))
        providers = _array(provider_doc["providers"])
        _check(len(providers) == 2 and all(isinstance(p, dict) and isinstance(p.get("key"), str) and _SHA.fullmatch(p["key"]) for p in providers))
        _check(len({p["key"] for p in providers}) == 1)
        metadata[providers_name] = _digest({**provider_doc, "providers": [{**p, "key": "<rotating-bridge-key>"} for p in providers]})
    second = _scan(root)
    _check(({k: v for k, v in files.items() if not k.startswith("@ipc/")}, links, dirs) == second[:3], "STATE_CAPTURE_RACE")
    if ipc.exists():
        repeated = _scan(ipc, "@ipc/", True)
        _check(({k: v for k, v in files.items() if k.startswith("@ipc/")}, {}, {}, special) == repeated[:4], "STATE_CAPTURE_RACE")
    else:
        _check(not any(k.startswith("@ipc/") for k in files) and not special, "STATE_CAPTURE_RACE")
    return {"version": 1, "project": str(project), "root": str(root), "ipcDirectory": str(ipc),
            "files": files, "symlinks": links, "directories": dirs, "special": special,
            "semantic": {name: _digest(value) for name, value in docs.items()}, "metadata": metadata,
            "settlements": settlements, "issues": sorted(issues), "features": bool(features),
            "gateway": {"dispatches": len(dispatches), "responses": sum(e["phase"] == "Response" for e in outcomes.values()),
                        "unknown": sum(e["phase"] == "OutcomeUnknown" for e in outcomes.values()), "resolvedUnknown": resolved_unknown,
                        "journalSha256": files["gateway/attempts.jsonl"]["sha256"]},
            "hosted": {"agents": len(db["agents"]), "runs": len(db["runs"]), "semanticSha256": _digest(db)}}


def capture(project: Path) -> dict:
    try:
        return _capture(project)
    except StateError:
        raise
    except Exception:
        raise StateError("STATE_CAPTURE_FAILED") from None


def require_quiescent(snapshot) -> None:
    try:
        _check(snapshot["version"] == 1 and isinstance(snapshot["issues"], list), "STATE_SNAPSHOT_INVALID")
        _check(all(isinstance(code, str) and code in _ISSUE_CODES for code in snapshot["issues"]), "STATE_SNAPSHOT_INVALID")
        if snapshot["issues"]:
            raise StateError(snapshot["issues"][0])
    except StateError:
        raise
    except Exception:
        raise StateError("STATE_SNAPSHOT_INVALID") from None


def _lock_path(name, snapshot):
    return bool(re.fullmatch(r"runtime/(?:runtime-journal|hosted/database)/\.writer(?:/owner\.json)?", name)
                or snapshot.get("features") and re.fullmatch(r"operator/bounded-admissions/\.writer(?:/owner\.json)?", name))


def _lifecycle_permissions(snapshot, name, record):
    if record is None: return
    if name.startswith("@ipc/"):
        owner = snapshot["files"]["runtime/runtime-journal/session.json"]
        mode = 0o600
    else:
        owner = snapshot["files"][name.split("/.writer")[0] + "/session.json"]
        mode = 0o700 if name.endswith("/.writer") else 0o600
    _check(record["mode"] == mode and all(record[k] == owner[k] for k in ("uid", "gid")), "STATE_PERMISSIONS_CHANGED")


def compare(before, after, phase="cold") -> list[str]:
    """Return permitted changed paths; every other state change is fatal."""
    try:
        _check(phase in {"cold", "build", "restart"}, "STATE_PHASE_INVALID")
        require_quiescent(before); require_quiescent(after)
        _check(before["root"] == after["root"] and before["ipcDirectory"] == after["ipcDirectory"], "STATE_DOMAIN_CHANGED")
        _check(before["settlements"] == after["settlements"], "STATE_SETTLEMENT_CHANGED")
        allowed = []
        for section in ("files", "symlinks", "directories", "special"):
            for name in sorted(set(before[section]) | set(after[section])):
                left, right = before[section].get(name), after[section].get(name)
                if left == right: continue
                _check(phase != "build", "STATE_BUILD_MUTATION")
                if section != "symlinks" and (_lock_path(name, before) and _lock_path(name, after) or name in {"@ipc/settler.owner", "@ipc/controller.token", "@ipc/settler.sock"}):
                    _lifecycle_permissions(before, name, left)
                    _lifecycle_permissions(after, name, right)
                    if left and right:
                        _check(all(left.get(k) == right.get(k) for k in ("mode", "uid", "gid")), "STATE_PERMISSIONS_CHANGED")
                    allowed.append(name); continue
                if section == "files" and name in {"runtime/settlement-journal.json", "@ipc/settlements.json"}:
                    if right:
                        _check(after["semantic"].get(name) == before["settlements"], "STATE_SETTLEMENT_CHANGED")
                    if left and right:
                        _check(all(left[k] == right[k] for k in ("mode", "uid", "gid")), "STATE_PERMISSIONS_CHANGED")
                    allowed.append(name); continue
                if phase == "restart" and section == "files" and name in before["metadata"] and name in after["metadata"]:
                    _check(left is not None and right is not None, "STATE_CRITICAL_MISSING")
                    _check(all(left[k] == right[k] for k in ("mode", "uid", "gid")), "STATE_PERMISSIONS_CHANGED")
                    _check(before["metadata"][name] == after["metadata"][name], "STATE_METADATA_CHANGED")
                    allowed.append(name); continue
                raise StateError("STATE_PROTECTED_CHANGED")
        return sorted(set(allowed))
    except StateError:
        raise
    except Exception:
        raise StateError("STATE_SNAPSHOT_INVALID") from None
