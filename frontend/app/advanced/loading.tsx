import { TerminalTheme } from "../../components/terminal/terminal-theme";
import { TerminalHeader } from "../../components/terminal/terminal-header";
import "../../components/terminal/protocol.css";

export default function LoadingProtocol() {
  return <TerminalTheme><div className="advanced-terminal"><TerminalHeader workspace="protocol" section="protocol" status="READING" />
    <main className="protocol-content" aria-busy="true"><div className="unconfigured" role="status"><span className="eyebrow">AGENT FINANCIAL IDENTITY</span>
      <h1>协议档案读取中。</h1><p>正在核验网络、完整任务账本与交易回执。完成后显示现金、债务与评分。</p><a href="/dashboard">返回托管工作台 →</a>
    </div></main></div></TerminalTheme>;
}
