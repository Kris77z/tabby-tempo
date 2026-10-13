"use client";
import { useState, type FormEvent } from "react";
import { inputUsdc, strategyLabel, type AgentSettings, type HostedCatalogModel } from "../../lib/hosted-client";
import { validateAgentSettings } from "../../lib/agent-settings";
import { settlementSymbol } from "../../lib/networks";
import styles from "./hosted.module.css";

// Adapted from Agora src/components/onboarding/create-agent-form.tsx:
// profile form → review facts → submit, with platform settings replacing role/trust.
export function AgentSettingsForm({ initial, chainId, models, busy, serverError, onSubmit, onClose }: {
  initial?: AgentSettings; chainId?: string; models: HostedCatalogModel[]; busy: boolean; serverError?: string;
  onSubmit: (settings: AgentSettings) => Promise<boolean>; onClose: () => void;
}) {
  const symbol = settlementSymbol(chainId);
  const [name, setName] = useState(initial?.name ?? "");
  const [modelId, setModel] = useState(initial?.modelId ?? models[0]?.id ?? "");
  const [strategy, setStrategy] = useState(initial?.strategy ?? "balanced");
  const [perRun, setPerRun] = useState(inputUsdc(initial?.perRunBudgetRaw ?? "120000"));
  const [total, setTotal] = useState(inputUsdc(initial?.totalBudgetRaw ?? "1000000"));
  const [allowCredit, setAllowCredit] = useState(initial?.allowCredit ?? false), [error, setError] = useState("");
  const [review, setReview] = useState<AgentSettings | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      const settings = validateAgentSettings({ name, modelId, strategy, perRun, total, allowCredit }, models);
      if (!initial && !review) { setReview(settings); return; }
      if (await onSubmit(settings)) onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "设置无效。"); }
  }
  return <form className={styles.settingsForm} onSubmit={event => void submit(event)}>
    <div className={styles.stepIndicator} aria-label="配置进度"><span className={!review ? styles.stepActive : ""}>01 配置</span><span>—</span><span className={review ? styles.stepActive : ""}>02 确认</span></div>
    {!review ? <>
      <label>名称<input name="name" value={name} maxLength={80} required placeholder="给你的 Agent 起个名字" onChange={event => setName(event.target.value)} autoFocus disabled={busy} /></label>
      <label>模型<select aria-label="模型" value={modelId} onChange={event => setModel(event.target.value)} disabled={busy || !models.length}>{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
      <label>策略<select aria-label="策略" value={strategy} onChange={event => setStrategy(event.target.value as AgentSettings["strategy"])} disabled={busy}>{Object.entries(strategyLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <div className={styles.fieldRow}><label>单次推理预算（{symbol}）<input inputMode="decimal" value={perRun} onChange={event => setPerRun(event.target.value)} required disabled={busy} /></label><label>累计推理预算（{symbol}）<input inputMode="decimal" value={total} onChange={event => setTotal(event.target.value)} required disabled={busy} /></label></div>
      <label className={styles.checkLabel}><input type="checkbox" checked={allowCredit} onChange={event => setAllowCredit(event.target.checked)} disabled={busy} />允许任务授信</label>
      <p className={styles.help}>预算限制实际推理购买支出。任务授信须经平台核验；入金、gas 和借款手续费单独记录。</p>
    </> : <div className={styles.reviewBox}><dl className={styles.factList}><div><dt>名称</dt><dd>{review.name}</dd></div><div><dt>模型</dt><dd>{models.find(model => model.id === review.modelId)?.label}</dd></div><div><dt>策略</dt><dd>{strategyLabel[review.strategy]}</dd></div><div><dt>单次 / 累计预算</dt><dd>{inputUsdc(review.perRunBudgetRaw)} / {inputUsdc(review.totalBudgetRaw)} {symbol}</dd></div><div><dt>任务授信</dt><dd>{review.allowCredit ? "允许申请" : "关闭"}</dd></div></dl><p>平台将生成新的独立钱包，并初始化链上身份。你可在创建后查看钱包、入账和执行状态。</p></div>}
    {error && <p className={styles.errorText} role="alert">{error}</p>}
    {serverError && <p className={styles.errorText} role="alert">{serverError}</p>}
    <div className={styles.formActions}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={review ? () => setReview(null) : onClose}>{review ? "返回编辑" : "取消"}</button><button className={styles.primaryButton} disabled={busy || !models.length} type="submit">{busy ? "提交中…" : initial ? "保存设置" : review ? "确认创建" : "检查配置"}</button></div>
  </form>;
}
