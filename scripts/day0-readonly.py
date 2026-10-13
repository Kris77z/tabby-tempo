#!/usr/bin/env python3
"""Fixed public RPC reads; curl transport and Foundry ABI encoding/decoding.

No dotenv, account keys, transaction submission or paid endpoint authentication.
Usage: python3 scripts/day0-readonly.py [public_rpc_url] [decimal_block]
"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

CAST = os.environ.get("CAST_BIN", str(Path.home() / ".foundry/bin/cast"))
RPC = sys.argv[1] if len(sys.argv) > 1 else "https://testnet-rpc.monad.xyz"
IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713"
USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3"
SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"


def read_rpc(method, params):
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    response = subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--max-time", "20",
         "-H", "Content-Type: application/json", "--data-binary", "@-", RPC],
        input=json.dumps(request), text=True, capture_output=True,
    )
    if response.returncode:
        raise SystemExit(response.stderr.strip())
    data = json.loads(response.stdout)
    if "error" in data:
        raise RuntimeError(data["error"])
    return data["result"]


def cast(*args):
    return subprocess.check_output([CAST, *args], text=True).strip()


chain_id = int(read_rpc("eth_chainId", []), 16)
if chain_id != 10143:
    raise SystemExit(f"Expected Monad testnet chainId 10143; got {chain_id}")
latest = int(read_rpc("eth_blockNumber", []), 16)
block = int(sys.argv[2]) if len(sys.argv) > 2 else latest
block_hex = hex(block)
header = read_rpc("eth_getBlockByNumber", [block_hex, False])
if header is None:
    raise SystemExit(f"Block {block} unavailable")
print(json.dumps({"utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "rpc": RPC, "chainId": chain_id, "latestBlock": latest, "block": block,
                  "blockHash": header["hash"], "timestamp": int(header["timestamp"], 16)}), flush=True)

for address in [IDENTITY, REPUTATION,
                "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
                "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", USDC]:
    code = read_rpc("eth_getCode", [address, block_hex])
    print(json.dumps({"address": address, "codeBytes": (len(code) - 2) // 2,
                      "codeHash": cast("keccak", code)}), flush=True)
for address in [IDENTITY, REPUTATION]:
    slot = read_rpc("eth_getStorageAt", [address, SLOT, block_hex])
    implementation = "0x" + slot[-40:]
    code = read_rpc("eth_getCode", [implementation, block_hex])
    print(json.dumps({"proxy": address, "implementation": implementation,
                      "codeBytes": (len(code) - 2) // 2, "codeHash": cast("keccak", code)}), flush=True)

queries = [
    (IDENTITY, "name()(string)", []),
    (IDENTITY, "eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])", []),
    (IDENTITY, "ownerOf(uint256)(address)", ["0"]),
    (IDENTITY, "getAgentWallet(uint256)(address)", ["0"]),
    (REPUTATION, "getIdentityRegistry()(address)", []),
    (REPUTATION, "getSummary(uint256,address[],string,string)(uint64,int128,uint8)",
     ["0", "[0x000000000000000000000000000000000000dA70]", "infercredit", "repayment"]),
    (USDC, "symbol()(string)", []),
    (USDC, "decimals()(uint8)", []),
]
for address, signature, arguments in queries:
    calldata = cast("calldata", signature, *arguments)
    result = read_rpc("eth_call", [{"to": address, "data": calldata}, block_hex])
    print(json.dumps({"address": address, "signature": signature,
                      "decoded": cast("abi-decode", signature, result)}), flush=True)
