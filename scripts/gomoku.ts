import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet, JsonRpcProvider } from "ethers";
import { replayMatch, runMatch, validateMatchConfig } from "../services/arena/src/gomoku/match.js";
import type { Side } from "../services/arena/src/gomoku/rules.js";

async function privateKey(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("SIGNER_FILE_REQUIRES_CURRENT_OWNER_0600");
  const key = (await readFile(path, "utf8")).trim(); new Wallet(key); return key;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const values = new Map<string, string>();
  const allowed = ["--replay", "--config", "--output", "--black-key-file", "--white-key-file", "--recover-lock", "--stop-after-plies", "--timeout-ms"];
  if (args.length % 2) throw new Error("ARGUMENT_VALUE_REQUIRED");
  for (let index = 0; index < args.length; index += 2) { if (!allowed.includes(args[index]) || values.has(args[index]) || !args[index + 1]) throw new Error("INVALID_OR_DUPLICATE_ARGUMENT"); values.set(args[index], args[index + 1]); }
  if (values.has("--recover-lock") && !["true", "false"].includes(values.get("--recover-lock")!)) throw new Error("INVALID_RECOVER_LOCK");
  if (values.get("--replay")) {
    if (values.size !== 1) throw new Error("REPLAY_TAKES_ONLY_SESSION_FILE");
    const session = JSON.parse(await readFile(resolve(values.get("--replay")!), "utf8")); const board = replayMatch(session);
    console.log(JSON.stringify({ verified: true, moves: board.moves.length, board: board.rows, result: session.result ?? null, phase: session.phase, reason: session.reason, reservedPrice: session.reservedPrice }));
  } else {
    if (["--config", "--output", "--black-key-file", "--white-key-file"].some(name => !values.get(name))) throw new Error("Usage: tsx scripts/gomoku.ts --config match.json --output /session --black-key-file /private/black.key --white-key-file /private/white.key [--recover-lock true] [--stop-after-plies 3]; replay: --replay /session/session.json");
    const config = validateMatchConfig(JSON.parse(await readFile(resolve(values.get("--config")!), "utf8")));
    const providers = { black: new JsonRpcProvider(config.players.black.rpcUrl), white: new JsonRpcProvider(config.players.white.rpcUrl) };
    try {
      const signers = { black: new Wallet(await privateKey(resolve(values.get("--black-key-file")!)), providers.black), white: new Wallet(await privateKey(resolve(values.get("--white-key-file")!)), providers.white) };
      const state = await runMatch(resolve(values.get("--output")!), config, { signers, recoverLock: values.get("--recover-lock") === "true", stopAfterPlies: values.has("--stop-after-plies") ? Number(values.get("--stop-after-plies")) : undefined, timeoutMs: values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined });
      console.log(JSON.stringify({ phase: state.phase, result: state.result ?? null, reason: state.reason, moves: replayMatch(state).moves.length, reservedPrice: state.reservedPrice, output: resolve(values.get("--output")!) }));
    } finally { providers.black.destroy(); providers.white.destroy(); }
  }
}
