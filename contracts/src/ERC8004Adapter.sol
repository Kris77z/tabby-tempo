// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004Adapter} from "./interfaces/IERC8004Adapter.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";

/// @title ERC8004Adapter — ENGINEERING §4.1
/// @notice Live identity resolution, versioned snapshots and bounded reputation
///         writes whose failures never revert the caller's settlement.
contract ERC8004Adapter is IERC8004Adapter {
    /// @dev tag1 is fixed for every InferCredit feedback entry (§4.1).
    string public constant TAG1 = "infercredit";
    string public constant TAG_REPAYMENT = "repayment";
    string public constant TAG_TASK_SUCCESS = "task-success";
    string public constant TAG_DEFAULT = "default";
    /// @dev Leave the caller gas to finish its bookkeeping even when the
    ///      registry consumes every unit forwarded to it.
    // Tempo charges 250k gas for a fresh storage slot. The registry's first
    // feedback needs more than the Ethereum/Monad bound; keep a finite budget
    // while preserving settlement's failure isolation on either network.
    uint256 public immutable feedbackGasLimit;

    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;

    address public owner;
    address public creditManager;

    mapping(uint256 agentId => AgentSnapshot) internal _snapshots;
    mapping(address reporter => bool) public isReporter;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyCreditManager() {
        if (msg.sender != creditManager) revert NotCreditManager(msg.sender);
        _;
    }

    modifier onlyReporter() {
        if (!isReporter[msg.sender]) revert NotReporter(msg.sender);
        _;
    }

    constructor(IIdentityRegistry identity_, IReputationRegistry reputation_, address owner_) {
        identity = identity_;
        reputation = reputation_;
        owner = owner_;
        feedbackGasLimit = block.chainid == 42431 || block.chainid == 4217 ? 4_000_000 : 500_000;
    }

    // ---------------------------------------------------------------------
    // wiring (implemented — plumbing only, no protocol semantics)
    // ---------------------------------------------------------------------

    function setCreditManager(address creditManager_) external onlyOwner {
        if (creditManager != address(0)) revert AlreadyWired();
        if (creditManager_ == address(0)) revert ZeroAddress();
        creditManager = creditManager_;
        isReporter[creditManager_] = true;
    }

    /// @notice Reporter set = {TaskEscrow, CreditManager} (§4.1).
    function setReporter(address reporter, bool allowed) external onlyOwner {
        isReporter[reporter] = allowed;
    }

    // ---------------------------------------------------------------------
    // §4.1 identity lifecycle
    // ---------------------------------------------------------------------

    /// Spec: live read of the canonical registry. Payment and credit wallet
    /// checks use this, never the snapshot (review r2 #2).
    function resolveAgent(uint256 agentId) public view returns (address, address) {
        return (identity.ownerOf(agentId), identity.getAgentWallet(agentId));
    }

    /// Spec: true when live (owner, wallet) differs from the snapshot.
    /// Reverts for an un-enrolled agent (version == 0).
    function identityChanged(uint256 agentId) external view returns (bool) {
        AgentSnapshot memory s = _snapshots[agentId];
        if (s.version == 0) revert AgentNotEnrolled(agentId);
        (address currentOwner, address currentWallet) = resolveAgent(agentId);
        return currentOwner != s.owner || currentWallet != s.wallet;
    }

    function snapshotVersion(uint256 agentId) external view returns (uint64) {
        return _snapshots[agentId].version;
    }

    function snapshots(uint256 agentId) external view returns (address, address, uint64) {
        AgentSnapshot memory s = _snapshots[agentId];
        return (s.owner, s.wallet, s.version);
    }

    /// Spec: first-time init, version = 1. Reverts if already enrolled.
    function enroll(uint256 agentId) external onlyCreditManager {
        if (_snapshots[agentId].version != 0) revert AgentAlreadyEnrolled(agentId);
        (address currentOwner, address currentWallet) = resolveAgent(agentId);
        _snapshots[agentId] = AgentSnapshot(currentOwner, currentWallet, 1);
        emit AgentEnrolled(agentId, currentOwner, currentWallet, 1);
    }

    /// Spec: the ONLY path that refreshes the snapshot and increments version.
    /// The bump retroactively invalidates every outstanding CreditAuthorization
    /// carrying the previous identityVersion (I3).
    function reapprove(uint256 agentId) external onlyCreditManager {
        uint64 version = _snapshots[agentId].version;
        if (version == 0) revert AgentNotEnrolled(agentId);
        (address currentOwner, address currentWallet) = resolveAgent(agentId);
        version += 1;
        _snapshots[agentId] = AgentSnapshot(currentOwner, currentWallet, version);
        emit AgentReapproved(agentId, currentOwner, currentWallet, version);
    }

    /// Spec: writes tag1 = "infercredit" through the canonical ERC-8004 ABI
    ///   giveFeedback(agentId, value, valueDecimals, tag1, tag2,
    ///                endpoint, feedbackURI, feedbackHash)
    /// with endpoint = "", feedbackURI = "" and feedbackHash = bytes32(0) in P0.
    ///
    /// MUST NOT bubble a registry failure up to the caller (review #5:
    /// reputation writes never roll back settlement); returns false instead so
    /// the caller can park a pendingFeedback entry. The handling must survive a
    /// callee that burns all forwarded gas, not only one that reverts.
    ///
    /// TEST_PLAN G6: the adapter is the registry's `client` because the adapter
    /// is the direct caller — that holds regardless of where the try/catch
    /// lives. Catching here is a choice about WHERE the rule is enforced
    /// (once, centrally) and not a prerequisite for correct client attribution.
    function reportFeedback(uint256 agentId, string calldata tag2, int128 value, uint8 valueDecimals)
        external
        onlyReporter
        returns (bool)
    {
        try reputation.giveFeedback{gas: feedbackGasLimit}(
            agentId, value, valueDecimals, TAG1, tag2, "", "", bytes32(0)
        ) {
            emit FeedbackReported(agentId, tag2, value, valueDecimals);
            return true;
        } catch {
            emit FeedbackReportFailed(agentId, tag2);
            return false;
        }
    }
}
