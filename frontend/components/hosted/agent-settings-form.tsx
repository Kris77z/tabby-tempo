"use client";
import { settlementSymbol } from "../../lib/networks";
import { useState, type FormEvent } from "react";
import { inputUsdc, strategyLabel, type HostedAgent, type AgentSettings, type HostedCatalogModel } from "../../lib/hosted-client";
import { validateAgentSettings } from "../../lib/agent-settings";
import { TerminalSelect } from "./terminal-select";
import styles from "./hosted.module.css";

// Execution settings are edited only after an Agent has been created.
export function AgentSettingsForm({ initial, chainId, models, busy, serverError, onSubmit, onClose }: {
  chainId?: string; initial: AgentSettings & Pick<HostedAgent, "configurationRequired">; models: HostedCatalogModel[]; busy: boolean; serverError?: string;
  onSubmit: (settings: AgentSettings) => Promise<boolean>; onClose: () => void;
}) {
  const symbol = settlementSymbol(chainId);
  const [name, setName] = useState(initial?.name ?? "");
  const [modelId, setModel] = useState(initial?.modelId || "");
  const [strategy, setStrategy] = useState(initial?.strategy ?? "balanced");
  const [perRun, setPerRun] = useState(inputUsdc(initial?.configurationRequired ? "120000" : initial?.perRunBudgetRaw ?? "120000"));
  const [total, setTotal] = useState(inputUsdc(initial?.configurationRequired ? "1000000" : initial?.totalBudgetRaw ?? "1000000"));
  const [allowCredit, setAllowCredit] = useState(initial?.allowCredit ?? false), [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      const settings = validateAgentSettings({ name, modelId, strategy, perRun, total, allowCredit }, models);
      if (await onSubmit(settings)) onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "设置无效。"); }
  }
  return <form className={styles.settingsForm} onSubmit={event => void submit(event)}>
    {initial?.configurationRequired && <p className={styles.help}>Agent 已创建。请选择模型，确认推理花费上限及借贷权限；保存后才允许运行。预算不是充值，借贷默认关闭。</p>}
      <label>名称<input name="name" value={name} maxLength={80} required placeholder="给你的 Agent 起个名字" onChange={event => setName(event.target.value)} autoFocus disabled={busy} /></label>
      <label>模型<TerminalSelect label="模型" value={modelId} onChange={setModel} disabled={busy || !models.length} placeholder="选择运行模型" options={models.map(m => ({ value: m.id, label: m.label }))} /></label>
      <label>策略<TerminalSelect label="策略" value={strategy} onChange={value => setStrategy(value as AgentSettings["strategy"])} disabled={busy} options={Object.entries(strategyLabel).map(([value,label]) => ({value,label}))} /></label>
      <div className={styles.fieldRow}><label>单次推理预算（{symbol}）<input inputMode="decimal" value={perRun} onChange={event => setPerRun(event.target.value)} required disabled={busy} /></label><label>累计推理预算（{symbol}）<input inputMode="decimal" value={total} onChange={event => setTotal(event.target.value)} required disabled={busy} /></label></div>
      <label className={styles.checkLabel}><input type="checkbox" checked={allowCredit} onChange={event => setAllowCredit(event.target.checked)} disabled={busy} />允许任务授信</label>
      <p className={styles.help}>预算限制实际推理购买支出。任务授信须经平台核验；入金、gas 和借款手续费单独记录。</p>
    {error && <p className={styles.errorText} role="alert">{error}</p>}
    {serverError && <p className={styles.errorText} role="alert">{serverError}</p>}
    <div className={styles.formActions}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={busy || !models.length} type="submit">{busy ? "提交中…" : "保存设置"}</button></div>
  </form>;
}
