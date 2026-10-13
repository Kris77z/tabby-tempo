import { amount } from "../lib/format";
import type { Profile, PublicConfig } from "../lib/types";
import { Mark } from "./icons";
export function Routing({ profile, config, paying }: { profile: Profile; config: PublicConfig; paying: boolean }) {
  const latest = profile.evidence.find(e => e.kind === "payment");
  const mode = latest && BigInt(latest.fromCredit || "0") > 0n ? "cash + credit-draw" : "cash first";
  return <div className={`routing-panel${paying ? " is-paying" : ""}`}><div className="routing-heading"><span className="eyebrow">COMPUTE UNDERWRITING</span><span className="live-label"><span className="dot" />{paying ? "付款处理中" : "资金路径"}</span></div>
    <div className="route-map"><svg className="route-lines" viewBox="0 0 900 180" preserveAspectRatio="none" aria-hidden="true"><path d="M170 90 C280 90 285 90 405 90" /><path d="M485 90 C590 90 600 45 730 45" /><path d="M485 90 C590 90 600 135 730 135" /></svg>
      <div className="route-agent"><span className="agent-avatar">{profile.agent.name.charAt(0)}</span><strong>Agent #{profile.agent.id}</strong><small>cash {amount(profile.cash, config.asset.decimals)} {config.asset.symbol}</small></div>
      <div className="route-gateway"><Mark /><strong>InferCredit</strong><span className="route-mode">{mode}</span><small>Tier {profile.credit.terms.tier} · 任务绑定授信</small></div>
      <div className="route-providers">{config.providers.length ? config.providers.map(provider => <div key={provider.address}><span className="provider-initial">{provider.name.charAt(0)}</span><span><strong>{provider.name}</strong><small>{provider.allowed ? "whitelisted" : "not whitelisted"}</small></span><span className={`provider-dot${provider.allowed ? "" : " off"}`} /></div>) : <div className="provider-empty">尚未配置 Provider</div>}</div>
    </div>
    <div className="routing-counts"><span><strong>{profile.counts.payments}</strong> payments</span><span><strong>{profile.counts.draws}</strong> credit draws</span><span><strong>{profile.counts.defaults}</strong> defaults</span><span className="count-note">近期事件窗口内统计</span></div>
  </div>;
}
