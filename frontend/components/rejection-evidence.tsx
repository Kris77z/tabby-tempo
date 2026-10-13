"use client";
import { useEffect, useRef, useState } from "react";
import { explainError } from "../lib/errors";
import { amount } from "../lib/format";
import type { PublicConfig, VerifiedRejectionEvidence } from "../lib/types";
import { ExplorerLink } from "./evidence";

export function RejectionEvidence({ config, agentId, timeoutMs }: { config: PublicConfig; agentId: string; timeoutMs: number }) {
  const controller = useRef<AbortController | null>(null);
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const [evidence, setEvidence] = useState<VerifiedRejectionEvidence | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  async function read() {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    setReading(true); setError(""); setEvidence(null);
    try {
      const response = await fetch("/api/rejection-evidence", { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) });
      const value = await response.json();
      if (!response.ok || value.verified !== true) throw new Error(value.message || "历史拒绝证据不可验证。");
      if (value.chainId !== config.chainId || value.account?.toLowerCase() !== config.contracts.account.toLowerCase()) throw new Error("拒绝证据与当前链或 Account 不一致。");
      if (value.agentId !== agentId) throw new Error(`该拒绝交易属于 Agent #${value.agentId}，请切换至对应档案。`);
      if (explainError({ data: value.revertData }).code !== "SpendRejected") throw new Error("历史拒绝数据无法解码。");
      if (!request.signal.aborted) setEvidence(value);
    } catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "历史拒绝证据不可验证。"); }
    finally { controller.current = null; if (!request.signal.aborted) setReading(false); }
  }
  const decoded = evidence ? explainError({ data: evidence.revertData }) : null;
  return <div className="recorded-rejection">
    <button className="button secondary" disabled={reading} onClick={() => void read()}>{reading ? "核验历史拒绝交易…" : "读取已执行的拒绝交易"}</button>
    <p className="control-note">只核验 CLI 已 mined 的交易及同区块 eth_call；不连接钱包，不广播新交易。</p>
    {error ? <p className="danger-text" role="alert">{error}</p> : null}
    {evidence && decoded ? <div className="operation-notice error" role="status"><strong>{decoded.code} · Agent #{evidence.agentId}</strong><p>{decoded.message}</p><code>{decoded.detail}</code>
      <p>status 0 · reverted · logs 0 · Block {evidence.block} · amount {amount(evidence.amount, config.asset.decimals)} {config.asset.symbol}</p>
      <p className="control-note">失败回执已核验；拒绝 bytes 由原交易参数在该区块 eth_call 复现，不是 revert 事件。</p>
      <ExplorerLink config={config} hash={evidence.hash} label="查看已执行的失败交易" />
      <details><summary>实际 revert bytes</summary><code className="wrap">{evidence.revertData}</code></details>
    </div> : null}
  </div>;
}
