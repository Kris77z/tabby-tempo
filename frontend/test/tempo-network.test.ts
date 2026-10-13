import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateDeployment, publicConfig } from "../lib/config";
import { fixtureDashboard } from "../lib/fixture";
import { TEMPO_TESTNET, networkName, settlementSymbol, hostedTransactionUrl, hostedAddressUrl } from "../lib/networks";

test("Tempo links use the verified testnet explorer and never link malformed or unsupported evidence", () => {
  const hash = `0x${"a".repeat(64)}`, address = `0x${"b".repeat(40)}`;
  assert.equal(networkName("42431"), "Tempo Moderato Testnet");
  assert.equal(settlementSymbol("42431"), "PathUSD");
  assert.equal(hostedTransactionUrl("42431", hash), `${TEMPO_TESTNET.explorerUrl}/tx/${hash}`);
  assert.equal(hostedAddressUrl("42431", address), `${TEMPO_TESTNET.explorerUrl}/address/${address}`);
  assert.equal(hostedTransactionUrl("31337", hash), null);
  assert.equal(hostedTransactionUrl("1", hash), null);
  assert.equal(hostedTransactionUrl("42431", "javascript:alert(1)"), null);
  assert.equal(hostedAddressUrl("42431", address + "/../tx"), null);
  // Existing Monad report evidence keeps its original network and currency.
  assert.equal(settlementSymbol("10143"), "USDC");
  assert.equal(hostedTransactionUrl("10143", hash), `https://testnet.monadexplorer.com/tx/${hash}`);
});

test("the Tempo example requires deployed contracts and only publishes public configuration", async () => {
  const example = JSON.parse(await readFile(new URL("../deployment.example.json", import.meta.url), "utf8"));
  assert.equal(example.chainId, "42431");
  assert.equal(example.asset.address.toLowerCase(), "0x20c0000000000000000000000000000000000000");
  assert.equal(example.asset.symbol, "PathUSD");
  assert.equal(example.asset.decimals, 6);
  assert.throws(() => validateDeployment(example), /部署地址/);
  const config = validateDeployment({ ...example, contracts: fixtureDashboard().config!.contracts });
  const published = publicConfig(config);
  assert.equal(published.explorerUrl, TEMPO_TESTNET.explorerUrl);
  assert.equal("rpcUrl" in published, false);
  assert.equal("deploymentBlock" in published, false);
  assert.throws(() => validateDeployment({ ...config, explorerUrl: "https://user:secret@explore.testnet.tempo.xyz" }), /凭据/);
});
