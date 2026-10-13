// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ERC8004Adapter} from "../src/ERC8004Adapter.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {IERC8004Adapter} from "../src/interfaces/IERC8004Adapter.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "../src/interfaces/IReputationRegistry.sol";

/// @title Deploy — the four P0 contracts, wired (ENGINEERING §2 / §4.6)
/// @dev Deliberately mirrors `InferCreditTestBase.setUp()` so the deployed
///      topology and the tested topology cannot drift apart.
///
/// Required env:
///   PRIVATE_KEY            deployer key (separate from UNDERWRITER / GUARDIAN, §6.1)
///   UNDERWRITER / VERIFIER / RELAY_REFUNDER
/// Optional env:
///   SETTLEMENT_ASSET (0 = native MON, otherwise the ERC-20 — §3 item 3)
///   IDENTITY_REGISTRY / REPUTATION_REGISTRY (paired override; network defaults)
///   TREASURY / GUARDIAN / FEE_RECIPIENT (default: deployer / deployer / treasury)
///   MAX_LTV_BPS (8000) | GRACE (3600) | PROTOCOL_FEE_BPS (0)
///   MAX_TOTAL_OUTSTANDING (50e18) | MAX_DRAW_PER_EPOCH (20e18), native only
/// ERC-20 requires both limits explicitly, in that token's smallest units.
contract Deploy is Script {
    error InvalidBasisPoints(uint256 value);
    error IncompleteRegistryPair();
    error RegistryDefaultsUnavailable(uint256 chainId);
    error ZeroRegistryAddress();
    error RegistryHasNoCode(address registry);
    error RegistryIdentityMismatch(address expected, address actual);
    error MissingERC20Limits();
    error TempoSettlementAssetRequired();

    address internal constant MAINNET_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant MAINNET_REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address internal constant TESTNET_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant TESTNET_REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    struct Params {
        address deployer;
        address settlementAsset;
        address identityRegistry;
        address reputationRegistry;
        address underwriter;
        address treasury;
        address guardian;
        address verifier;
        address relayRefunder;
        address feeRecipient;
        uint16 maxLtvBps;
        uint16 protocolFeeBps;
        uint256 grace;
        uint256 maxTotalOutstanding;
        uint256 maxDrawPerEpoch;
    }

    struct Deployment {
        ERC8004Adapter adapter;
        CreditManager manager;
        AgentAccount account;
        TaskEscrow escrow;
    }

    function _readParams(address deployer) internal view returns (Params memory p) {
        p.deployer = deployer;
        p.settlementAsset = vm.envOr("SETTLEMENT_ASSET", address(0));
        if ((block.chainid == 42431 || block.chainid == 4217) && p.settlementAsset == address(0)) {
            revert TempoSettlementAssetRequired();
        }
        (p.identityRegistry, p.reputationRegistry) = _registryPair();
        p.underwriter = vm.envAddress("UNDERWRITER");
        p.treasury = vm.envOr("TREASURY", deployer);
        p.guardian = vm.envOr("GUARDIAN", deployer);
        p.verifier = vm.envAddress("VERIFIER");
        p.relayRefunder = vm.envAddress("RELAY_REFUNDER");
        p.feeRecipient = vm.envOr("FEE_RECIPIENT", p.treasury);
        p.maxLtvBps = _basisPoints(vm.envOr("MAX_LTV_BPS", uint256(8_000)));
        p.protocolFeeBps = _basisPoints(vm.envOr("PROTOCOL_FEE_BPS", uint256(0)));
        p.grace = vm.envOr("GRACE", uint256(1 hours));
        bool hasTotalLimit = bytes(vm.envOr("MAX_TOTAL_OUTSTANDING", string(""))).length != 0;
        bool hasEpochLimit = bytes(vm.envOr("MAX_DRAW_PER_EPOCH", string(""))).length != 0;
        if (p.settlementAsset != address(0) && (!hasTotalLimit || !hasEpochLimit)) {
            revert MissingERC20Limits();
        }
        p.maxTotalOutstanding = hasTotalLimit ? vm.envUint("MAX_TOTAL_OUTSTANDING") : 50 ether;
        p.maxDrawPerEpoch = hasEpochLimit ? vm.envUint("MAX_DRAW_PER_EPOCH") : 20 ether;
    }

    function _registryPair() private view returns (address identity, address reputation) {
        bool hasIdentity = bytes(vm.envOr("IDENTITY_REGISTRY", string(""))).length != 0;
        bool hasReputation = bytes(vm.envOr("REPUTATION_REGISTRY", string(""))).length != 0;
        if (hasIdentity != hasReputation) revert IncompleteRegistryPair();
        if (hasIdentity) {
            identity = vm.envAddress("IDENTITY_REGISTRY");
            reputation = vm.envAddress("REPUTATION_REGISTRY");
        } else if (block.chainid == 10143) {
            (identity, reputation) = (TESTNET_IDENTITY, TESTNET_REPUTATION);
        } else if (block.chainid == 143) {
            (identity, reputation) = (MAINNET_IDENTITY, MAINNET_REPUTATION);
        } else {
            revert RegistryDefaultsUnavailable(block.chainid);
        }
        if (identity == address(0) || reputation == address(0)) revert ZeroRegistryAddress();
    }

    /// Validate the actual target network before any deployment is broadcast.
    function _preflight(Params memory p) internal view {
        if (p.identityRegistry.code.length == 0) revert RegistryHasNoCode(p.identityRegistry);
        if (p.reputationRegistry.code.length == 0) revert RegistryHasNoCode(p.reputationRegistry);
        address identity = IReputationRegistry(p.reputationRegistry).getIdentityRegistry();
        if (identity != p.identityRegistry) revert RegistryIdentityMismatch(p.identityRegistry, identity);
    }

    /// P0 stays at or below 100% LTV. Above-100% deployments belong only to
    /// isolated test harnesses; validate before narrowing environment values.
    function _basisPoints(uint256 value) internal pure returns (uint16) {
        if (value > 10_000) revert InvalidBasisPoints(value);
        return uint16(value);
    }

    function _deploy(Params memory p) internal returns (Deployment memory d) {
        d.adapter = new ERC8004Adapter(
            IIdentityRegistry(p.identityRegistry), IReputationRegistry(p.reputationRegistry), p.deployer
        );

        d.manager = new CreditManager(
            CreditManager.Config({
                settlementAsset: p.settlementAsset,
                adapter: IERC8004Adapter(address(d.adapter)),
                underwriter: p.underwriter,
                treasury: p.treasury,
                guardian: p.guardian,
                relayRefunder: p.relayRefunder,
                owner: p.deployer,
                maxLtvBps: p.maxLtvBps,
                grace: p.grace
            })
        );

        d.account = new AgentAccount(p.settlementAsset, IERC8004Adapter(address(d.adapter)), p.deployer);

        d.escrow = new TaskEscrow(
            p.settlementAsset,
            IERC8004Adapter(address(d.adapter)),
            p.verifier,
            p.feeRecipient,
            p.protocolFeeBps,
            p.deployer
        );
    }

    /// @dev §4.6: the call graph must be wired in exactly one shape, and each
    ///      wiring setter is one-shot so a live deployment cannot be re-pointed.
    function _wire(Params memory p, Deployment memory d) internal {
        d.manager.setProtocolContracts(IAgentAccount(address(d.account)), ITaskEscrow(address(d.escrow)));
        d.account.setProtocolContracts(ICreditManager(address(d.manager)), address(d.escrow));
        d.escrow.setProtocolContracts(ICreditManager(address(d.manager)), IAgentAccount(address(d.account)));

        d.adapter.setCreditManager(address(d.manager));
        d.adapter.setReporter(address(d.escrow), true);

        d.manager.setGlobalLimits(p.maxTotalOutstanding, p.maxDrawPerEpoch);
    }

    function run() external returns (Deployment memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Params memory p = _readParams(vm.addr(pk));
        _preflight(p);

        vm.startBroadcast(pk);
        d = _deploy(p);
        _wire(p, d);
        vm.stopBroadcast();

        console2.log("ERC8004Adapter ", address(d.adapter));
        console2.log("CreditManager  ", address(d.manager));
        console2.log("AgentAccount   ", address(d.account));
        console2.log("TaskEscrow     ", address(d.escrow));
        console2.log("settlementAsset", p.settlementAsset);
        console2.log("NOTE: providers still need AgentAccount.setProviderWhitelist()");
    }
}
