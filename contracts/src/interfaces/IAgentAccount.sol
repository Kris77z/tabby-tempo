// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICreditManager} from "./ICreditManager.sol";

// SpendRejected reason codes (§4.3). File-level constants: Solidity forbids
// state/constant variables inside an `interface`.
uint8 constant REASON_NOT_WHITELISTED = 1;
uint8 constant REASON_OVER_LIMIT = 2;
uint8 constant REASON_FROZEN = 3;
uint8 constant REASON_INVALID_AUTH = 4;
uint8 constant REASON_AUTH_CALLER_MISMATCH = 5;

/// @title IAgentAccount — ENGINEERING §4.3
interface IAgentAccount {
    struct Policy {
        uint256 maxCashPerTx;
        uint256 maxDebtPerTx;
        uint256 maxDebtPerDay;
        bool ownerFrozen; // owner-set freeze; protocolFrozen is stored separately
    }

    /// @dev `agentId` is mandatory: a pure-cash payment has no taskId (taskId = 0)
    ///      and the refund path resolves the credited agent from it (review r4 #4).
    struct PaymentRecord {
        uint256 agentId;
        uint256 taskId;
        uint256 fromCash;
        uint256 fromCredit;
        uint256 refundedAmount; // cumulative, <= fromCash + fromCredit
    }

    /// @dev Rejections use a custom error, not an event: a revert rolls back logs
    ///      so no event would ever be emitted (review #10). The SDK/frontend
    ///      decodes the revert data to show the reason.
    /// reason: 1 = not whitelisted, 2 = over limit, 3 = frozen,
    ///         4 = invalid authorization, 5 = authorization/caller mismatch
    error SpendRejected(uint256 agentId, address target, uint8 reason);

    event ProviderPaid(
        uint256 indexed agentId,
        address indexed provider,
        bytes32 indexed paymentId,
        uint256 fromCash,
        uint256 fromCredit
    );
    event CashCredited(uint256 indexed agentId, address indexed from, uint256 amount);
    event CashDebitedForLiquidation(uint256 indexed agentId, uint256 amount);
    event PolicySet(uint256 indexed agentId, Policy policy);
    event ProtocolFrozenSet(uint256 indexed agentId, bool frozen);
    event ProviderWhitelisted(address indexed provider, bool allowed);
    event RefundRegistered(bytes32 indexed paymentId, bytes32 indexed refundId, uint256 amount);

    error NotAgentOwner(uint256 agentId, address caller);
    error NotAgentWallet(uint256 agentId, address caller);
    error NotProtocol(address caller);
    error NotCreditManager(address caller);
    error NotOwner(address caller);
    error AlreadyWired();
    error ZeroAddress();
    error ValueMismatch(uint256 expected, uint256 provided);
    error PaymentIdAlreadyUsed(bytes32 paymentId);
    error UnknownPayment(bytes32 paymentId);
    error RefundIdAlreadyUsed(bytes32 refundId);
    error RefundExceedsPayment(bytes32 paymentId, uint256 attempted, uint256 remaining);
    error ZeroAmount();
    error ProviderTransferFailed(address provider, uint256 amount);

    // ---- owner surface ----
    function depositCash(uint256 agentId, uint256 amount) external payable;
    function setPolicy(uint256 agentId, Policy calldata p) external;

    /// @notice cash first, credit for the shortfall, atomic payment to provider.
    ///         Limit rule = min(policy cap, auth.principalCap, global headroom).
    function payProvider(
        uint256 agentId,
        address provider,
        uint256 amount,
        bytes32 paymentId,
        ICreditManager.CreditAuthorization calldata auth,
        bytes calldata underwriterSig
    ) external;

    // ---- protocol surface ----
    /// @dev TaskEscrow (settlement) | CreditManager (refund / recovery).
    function creditCash(uint256 agentId, uint256 amount) external payable;

    /// @dev Protocol-level debit: NOT blocked by ownerFrozen or policy limits.
    ///      Debits at most `maxAmount`, pushes the funds to the CreditManager.
    function debitForLiquidation(uint256 agentId, uint256 maxAmount) external returns (uint256 debited);

    /// @dev SPEC GAP G3 (TEST_PLAN.md sec 3) — §4.3 stores `payments` and `refundConsumed` on the
    ///      AgentAccount, but §4.2's `processRefund` lives on the CreditManager
    ///      and must consume both. §4.6's call table has no row for it. This is
    ///      the missing cross-contract entry point.
    /// @return record The payment record BEFORE this refund was applied.
    /// @return cashShare Portion of `amount` attributable to the cash leg.
    /// @return creditShare Portion of `amount` attributable to the credit leg.
    function registerRefund(bytes32 paymentId, bytes32 refundId, uint256 amount)
        external
        returns (PaymentRecord memory record, uint256 cashShare, uint256 creditShare);

    function setProtocolFrozen(uint256 agentId, bool frozen) external;

    // ---- views ----
    function cash(uint256 agentId) external view returns (uint256);
    function policies(uint256 agentId)
        external
        view
        returns (uint256 maxCashPerTx, uint256 maxDebtPerTx, uint256 maxDebtPerDay, bool ownerFrozen);
    function getPolicy(uint256 agentId) external view returns (Policy memory);
    function protocolFrozen(uint256 agentId) external view returns (bool);
    function providerWhitelist(address provider) external view returns (bool);
    function payments(bytes32 paymentId)
        external
        view
        returns (
            uint256 agentId,
            uint256 taskId,
            uint256 fromCash,
            uint256 fromCredit,
            uint256 refundedAmount
        );
    function getPayment(bytes32 paymentId) external view returns (PaymentRecord memory);
    function refundConsumed(bytes32 refundId) external view returns (bool);
    function debtSpentInDay(uint256 agentId, uint256 day) external view returns (uint256);
    function settlementAsset() external view returns (address);
}
