/** Shared public metadata; no endpoint, wallet or credential. Imported roles retain canonical task types. */
export interface MissionSpecialist {id:string;serviceId:string;name:string;kind:string;detail:string;aliases:string[];output:'text'|'json';directory?:string}
export const missionSpecialists:MissionSpecialist[] = [
  {
    "id": "writer",
    "serviceId": "tabby/writer",
    "name": "Writing Specialist",
    "kind": "写作",
    "detail": "writing · synthesis",
    "aliases": [
      "writer"
    ],
    "output": "text"
  },
  {
    "id": "analyst",
    "serviceId": "tabby/analyst",
    "name": "Analysis Specialist",
    "kind": "分析",
    "detail": "data · reasoning",
    "aliases": [
      "analyst"
    ],
    "output": "text"
  },
  {
    "id": "coder",
    "serviceId": "tabby/coder",
    "name": "Code Specialist",
    "kind": "代码",
    "detail": "generation · review",
    "aliases": [
      "coder"
    ],
    "output": "text"
  },
  {
    "id": "abi-interact",
    "serviceId": "abi-reader-v1",
    "name": "ABI Reader & Explainer",
    "kind": "ABI 解读",
    "detail": "abi · solidity · interface · evm · monad",
    "aliases": [
      "abi-reader",
      "abi-reader-v1",
      "abi-interact",
      "abi-read",
      "abi"
    ],
    "output": "text",
    "directory": "abi-reader"
  },
  {
    "id": "gas-optimization",
    "serviceId": "gas-optimizer-v1",
    "name": "Gas Optimizer",
    "kind": "Gas 优化",
    "detail": "solidity · gas · optimization · monad · evm",
    "aliases": [
      "gas-optimizer",
      "gas-optimizer-v1",
      "gas-optimization",
      "gas"
    ],
    "output": "json",
    "directory": "gas-optimizer"
  },
  {
    "id": "token-scan",
    "serviceId": "token-scanner-v1",
    "name": "Token Risk Scanner",
    "kind": "Token 扫描",
    "detail": "erc20 · erc721 · rugpull · honeypot · monad · security",
    "aliases": [
      "token-scanner",
      "token-scanner-v1",
      "token-scan",
      "token-risk"
    ],
    "output": "json",
    "directory": "token-scanner"
  },
  {
    "id": "tx-decode",
    "serviceId": "tx-decoder-v1",
    "name": "Transaction Decoder",
    "kind": "交易解码",
    "detail": "calldata · events · evm · monad · decode",
    "aliases": [
      "tx-decoder",
      "tx-decoder-v1",
      "tx-decode",
      "transaction-analysis"
    ],
    "output": "text",
    "directory": "tx-decoder"
  },
  {
    "id": "yield-search",
    "serviceId": "yield-finder-v1",
    "name": "Yield Strategy Finder",
    "kind": "收益策略",
    "detail": "defi · yield · apy · staking · farming · monad",
    "aliases": [
      "yield-finder",
      "yield-finder-v1",
      "yield-search",
      "yield"
    ],
    "output": "text",
    "directory": "yield-finder"
  }
];
export function resolveSpecialist(taskType:string){const key=taskType.trim().toLowerCase();return missionSpecialists.find(s=>s.aliases.includes(key));}
/** The independent reviewer must know the same output contract as the executor. */
export function specialistOutputContract(taskType:string){
 const role=resolveSpecialist(taskType);
 if(role?.id==='gas-optimization')return {serviceId:role.serviceId,format:'json',fields:{optimizations:'array of {title,location,currentGas,optimizedGas,savings,suggestion,code?}',summary:'string'},rules:'Gas figures without benchmarks must be labelled unknown/unmeasured. Static suggestions are not measured savings.'};
 if(role?.id==='token-scan')return {serviceId:role.serviceId,format:'json',fields:{riskScore:'number 0-100 or null if insufficient evidence (analytical assessment, not an on-chain rating)',riskLevel:'unknown|safe|low|medium|high|critical',findings:'array of {title,severity:info|warning|danger,description,evidence}',tokenomics:'{totalSupply:string,ownerBalance:string,isMintable:boolean|unknown,isPausable:boolean|unknown,hasBlacklist:boolean|unknown}',recommendation:'string'},rules:'Assess only supplied source/data. Unknown deployed balances remain unknown; booleans describe observable properties of complete supplied source, not verified deployed state. Label suggestions and risks as such.'};
 return {serviceId:role?.serviceId,format:'text',rules:'Use the dedicated specialist section structure and original user constraints.'};
}
