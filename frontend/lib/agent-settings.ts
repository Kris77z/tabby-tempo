import { usdcRaw, type AgentSettings, type HostedCatalogModel } from "./hosted-client";

export type AgentSettingsDraft = { name: string; modelId: string; strategy: AgentSettings["strategy"]; perRun: string; total: string; allowCredit: boolean };

/** Shared form/terminal contract; the server still enforces its catalog and limits. */
export function validateAgentSettings(draft: AgentSettingsDraft, models: HostedCatalogModel[]): AgentSettings {
  const settings: AgentSettings = { name: draft.name.trim(), modelId: draft.modelId, strategy: draft.strategy,
    perRunBudgetRaw: usdcRaw(draft.perRun), totalBudgetRaw: usdcRaw(draft.total), allowCredit: draft.allowCredit };
  if (!settings.name || settings.name.length > 80 || /[\x00-\x1f\x7f]/.test(settings.name)) throw new Error("名称须为 1–80 个字符。");
  if (!models.some(model => model.id === settings.modelId)) throw new Error("请选择平台提供的模型。");
  if (BigInt(settings.totalBudgetRaw) < BigInt(settings.perRunBudgetRaw)) throw new Error("累计预算不能小于单次预算。");
  return settings;
}
