import { Contract, getAddress, Interface, verifyTypedData, ZeroAddress, ZeroHash,
  type BlockTag, type Provider, type Signer, type TransactionReceipt } from "ethers";

export const IDENTITY_ABI = [
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
  "function register(string agentURI) returns(uint256 agentId)",
  "function ownerOf(uint256) view returns(address)",
  "function getAgentWallet(uint256) view returns(address)",
  "function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes signature)",
  "function transferFrom(address from,address to,uint256 tokenId)",
  "function eip712Domain() view returns(bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)",
];
export const WALLET_SET_TYPES = { AgentWalletSet: [
  { name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" },
  { name: "owner", type: "address" }, { name: "deadline", type: "uint256" },
] };
export interface RegistryOptions { provider: Provider; address: string; expectedChainId: bigint }
export interface Identity { agentId: bigint; owner: string; wallet: string }
export interface WalletConsent {
  agentId: bigint; newWallet: string; owner: string; deadline: bigint;
  chainId: bigint; registryAddress: string; signature: string;
}
export interface Registration { agentId: bigint; owner: string; agentURI: string; receipt: TransactionReceipt }

export function uint(value: bigint, name: string, bits = 256): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 2n ** BigInt(bits)) throw new Error(`INVALID_${name}`);
  return value;
}
export function registryOptions(options: RegistryOptions): RegistryOptions {
  if (!options.provider) throw new Error("PROVIDER_REQUIRED");
  uint(options.expectedChainId, "CHAIN_ID");
  if (options.expectedChainId === 0n) throw new Error("INVALID_CHAIN_ID");
  const address = getAddress(options.address);
  if (address === ZeroAddress) throw new Error("REGISTRY_ADDRESS_REQUIRED");
  return { ...options, address };
}
export async function assertNetwork(options: RegistryOptions): Promise<void> {
  // JsonRpcProvider/BrowserProvider expose send; query the current chain rather
  // than trusting a statically cached Network object when available.
  const rpc = options.provider as Provider & { send?: (method: string, params: unknown[]) => Promise<unknown> };
  const chainId = rpc.send ? BigInt(String(await rpc.send("eth_chainId", []))) : (await options.provider.getNetwork()).chainId;
  if (chainId !== options.expectedChainId) throw new Error("NETWORK_MISMATCH");
  if (await options.provider.getCode(options.address) === "0x") throw new Error("REGISTRY_HAS_NO_CODE");
}
export async function assertTransactionSigner(signer: Signer, options: RegistryOptions): Promise<string> {
  if (signer.provider !== options.provider) throw new Error("SIGNER_PROVIDER_MISMATCH");
  await assertNetwork(options);
  return getAddress(await signer.getAddress());
}
export function walletSetTypedData(consent: Omit<WalletConsent, "signature">) {
  uint(consent.agentId, "AGENT_ID"); uint(consent.deadline, "DEADLINE"); uint(consent.chainId, "CHAIN_ID");
  if (consent.chainId === 0n || getAddress(consent.newWallet) === ZeroAddress) throw new Error("INVALID_WALLET_CONSENT");
  const registryAddress = getAddress(consent.registryAddress);
  if (registryAddress === ZeroAddress) throw new Error("REGISTRY_ADDRESS_REQUIRED");
  return { domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: consent.chainId, verifyingContract: registryAddress },
    types: WALLET_SET_TYPES,
    message: { agentId: consent.agentId, newWallet: getAddress(consent.newWallet), owner: getAddress(consent.owner), deadline: consent.deadline } };
}
export function registrationFromReceipt(receipt: TransactionReceipt, address: string, owner: string, agentURI: string): Registration {
  if (receipt.status !== 1) throw new Error("REGISTRATION_TRANSACTION_FAILED");
  const iface = new Interface(IDENTITY_ABI);
  const registry = getAddress(address); const expectedOwner = getAddress(owner);
  const events = receipt.logs.flatMap(log => {
    if (getAddress(log.address) !== registry) return [];
    try { const event = iface.parseLog(log); return event?.name === "Registered" ? [event] : []; }
    catch { return []; }
  });
  if (events.length !== 1 || getAddress(events[0].args.owner) !== expectedOwner || events[0].args.agentURI !== agentURI) throw new Error("REGISTRATION_EVENT_MISMATCH");
  return { agentId: BigInt(events[0].args.agentId), owner: expectedOwner, agentURI, receipt };
}

export class IdentityRegistry {
  readonly options: RegistryOptions;
  private readonly contract: Contract;
  constructor(options: RegistryOptions) {
    this.options = registryOptions(options);
    this.contract = new Contract(this.options.address, IDENTITY_ABI, this.options.provider);
  }
  async readIdentity(agentId: bigint, blockTag?: BlockTag): Promise<Identity> {
    uint(agentId, "AGENT_ID"); await assertNetwork(this.options);
    const block = blockTag ?? (await this.options.provider.getBlock("latest"))?.number;
    if (block === undefined) throw new Error("BLOCK_UNAVAILABLE");
    const [owner, wallet] = await Promise.all([
      this.contract.getFunction("ownerOf").staticCall(agentId, { blockTag: block }),
      this.contract.getFunction("getAgentWallet").staticCall(agentId, { blockTag: block }),
    ]);
    return { agentId, owner: getAddress(owner), wallet: getAddress(wallet) };
  }
  async register(ownerSigner: Signer, agentURI: string): Promise<Registration> {
    if (typeof agentURI !== "string") throw new Error("INVALID_AGENT_URI");
    const owner = await assertTransactionSigner(ownerSigner, this.options);
    const receipt = await (await this.contract.connect(ownerSigner).getFunction("register(string)")(agentURI)).wait();
    if (!receipt) throw new Error("REGISTRATION_RECEIPT_MISSING");
    return registrationFromReceipt(receipt, this.options.address, owner, agentURI);
  }
  private async signingContext(agentId: bigint, deadline?: bigint) {
    await assertNetwork(this.options);
    const block = await this.options.provider.getBlock("latest");
    if (!block) throw new Error("BLOCK_UNAVAILABLE");
    const [identity, domain] = await Promise.all([
      this.readIdentity(agentId, block.number),
      this.contract.getFunction("eip712Domain").staticCall({ blockTag: block.number }),
    ]);
    if (domain.fields !== "0x0f" || domain.name !== "ERC8004IdentityRegistry" || domain.version !== "1" || domain.chainId !== this.options.expectedChainId || getAddress(domain.verifyingContract) !== this.options.address || domain.salt !== ZeroHash || domain.extensions.length !== 0) throw new Error("IDENTITY_DOMAIN_MISMATCH");
    const limit = deadline ?? BigInt(block.timestamp + 300);
    uint(limit, "DEADLINE");
    if (limit < BigInt(block.timestamp) || limit > BigInt(block.timestamp + 300)) throw new Error("WALLET_DEADLINE_INVALID");
    return { identity, deadline: limit };
  }
  async signWalletConsent(newWalletSigner: Signer, agentId: bigint, deadline?: bigint): Promise<WalletConsent> {
    uint(agentId, "AGENT_ID");
    const { identity, deadline: limit } = await this.signingContext(agentId, deadline);
    if (newWalletSigner.provider && (await newWalletSigner.provider.getNetwork()).chainId !== this.options.expectedChainId) throw new Error("NETWORK_MISMATCH");
    const consent = { agentId, newWallet: getAddress(await newWalletSigner.getAddress()), owner: identity.owner,
      deadline: limit, chainId: this.options.expectedChainId, registryAddress: this.options.address };
    const typed = walletSetTypedData(consent);
    return { ...consent, signature: await newWalletSigner.signTypedData(typed.domain, typed.types, typed.message) };
  }
  async bindWallet(ownerSigner: Signer, consent: WalletConsent): Promise<TransactionReceipt> {
    const owner = await assertTransactionSigner(ownerSigner, this.options);
    if (consent.chainId !== this.options.expectedChainId || getAddress(consent.registryAddress) !== this.options.address) throw new Error("WALLET_CONSENT_DOMAIN_MISMATCH");
    const context = await this.signingContext(consent.agentId, consent.deadline);
    if (context.identity.owner !== getAddress(consent.owner)) throw new Error("IDENTITY_OWNER_CHANGED");
    if (owner !== context.identity.owner) throw new Error("NOT_IDENTITY_OWNER");
    const typed = walletSetTypedData(consent);
    let wallet: string;
    try { wallet = verifyTypedData(typed.domain, typed.types, typed.message, consent.signature); }
    catch { throw new Error("WALLET_SIGNATURE_INVALID"); }
    if (getAddress(wallet) !== getAddress(consent.newWallet)) throw new Error("WALLET_SIGNATURE_INVALID");
    const receipt = await (await this.contract.connect(ownerSigner).getFunction("setAgentWallet")(consent.agentId, consent.newWallet, consent.deadline, consent.signature)).wait();
    if (!receipt || receipt.status !== 1) throw new Error("WALLET_BIND_TRANSACTION_FAILED");
    return receipt;
  }
  async transferIdentity(ownerSigner: Signer, agentId: bigint, newOwner: string): Promise<TransactionReceipt> {
    uint(agentId, "AGENT_ID"); const owner = await assertTransactionSigner(ownerSigner, this.options);
    const nextOwner = getAddress(newOwner);
    if (nextOwner === ZeroAddress) throw new Error("INVALID_NEW_OWNER");
    if ((await this.readIdentity(agentId)).owner !== owner) throw new Error("NOT_IDENTITY_OWNER");
    const receipt = await (await this.contract.connect(ownerSigner).getFunction("transferFrom")(owner, nextOwner, agentId)).wait();
    if (!receipt || receipt.status !== 1) throw new Error("IDENTITY_TRANSFER_FAILED");
    return receipt;
  }
}
