// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICreditManager — ENGINEERING §4.2 (v5.3)
interface ICreditManager {
    /// @dev EIP-712 payload signed by the underwriter.
    ///      domain: name="InferCredit", version="1", chainId, verifyingContract.
    struct CreditAuthorization {
        uint256 agentId;
        uint256 taskId;
        uint256 principalCap; // max drawable principal
        uint16 feeBps; // factor fee, charged on the ACTUAL drawn amount (review #2)
        uint8 riskTier;
        uint64 identityVersion; // invalidated by identity rotation (review #9)
        uint256 authDeadline; // draw must happen at or before this timestamp
        uint256 loanDueAt; // after this + GRACE the loan may be liquidated
        uint256 nonce;
        bytes32 evidenceHash;
    }

    /// @dev ClosedByRefund: a refund that clears the remaining debt closes the
    ///      loan without repayment credit or default. Partial repayments or
    ///      integer rounding can close it before the whole payment is refunded.
    enum LoanStatus {
        None,
        Active,
        Repaid,
        Defaulted,
        ClosedByRefund
    }

    struct TaskLoan {
        uint256 agentId;
        uint256 principal; // outstanding principal
        uint256 fee; // outstanding fee, frozen at draw time = principal * feeBps / 10_000
        uint256 loanDueAt;
        LoanStatus status;
    }

    /// @dev Per-party actual burden recorded at liquidation time; the recovery
    ///      waterfall in `processRefund` is capped layer-by-layer by these
    ///      numbers (review r4 #1).
    struct LiquidationRecord {
        uint256 cashUsed;
        uint256 escrowSlashed;
        uint256 backstopUsed;
        uint256 lpLoss;
        address poster;
    }

    event LoanOpened(uint256 indexed taskId, uint256 indexed agentId, uint256 amount, uint8 tier);
    event LoanRepaid(uint256 indexed taskId, uint256 principal, uint256 fee);
    event LoanDefaulted(
        uint256 indexed taskId, uint256 loss, uint256 escrowSlashed, uint256 cashUsed, uint256 backstopUsed
    );
    event LoanClosedByRefund(uint256 indexed taskId, uint256 principalForgiven, uint256 feeForgiven);
    event RefundProcessed(
        bytes32 indexed paymentId,
        bytes32 indexed refundId,
        uint256 amount,
        uint256 debtReduced,
        uint256 toCash
    );
    event RecoveryDistributed(
        uint256 indexed taskId, uint256 toLp, uint256 toBackstop, uint256 toPoster, uint256 toCash
    );
    event AgentFrozen(uint256 indexed agentId, address by);
    event AgentUnfrozen(uint256 indexed agentId, address by);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event BackstopFunded(uint256 indexed agentId, uint256 amount);
    event DrawPausedSet(bool paused);
    event GlobalLimitsSet(uint256 maxTotalOutstanding, uint256 maxDrawPerEpoch);

    // ---- access / config ----
    error NotTreasury(address caller);
    error NotGuardian(address caller);
    error NotAgentAccount(address caller);
    error NotTaskEscrow(address caller);
    error NotRelayRefunder(address caller);
    error NotOwner(address caller);
    error AlreadyWired();
    error ZeroAddress();

    // ---- draw invariants I1..I7 ----
    error DrawPaused(); // I1
    error AgentIsFrozen(uint256 agentId); // I1
    error BadSignature(); // I2
    error NonceAlreadyUsed(uint256 agentId, uint256 nonce); // I2 / I5
    error AuthExpired(uint256 authDeadline, uint256 nowTs); // I2
    error IdentityChanged(uint256 agentId); // I3 (live check)
    error IdentityVersionMismatch(uint256 agentId, uint64 expected, uint64 provided); // I3 (snapshot)
    error TaskNotAssigned(uint256 taskId); // I4
    error TaskAgentMismatch(uint256 taskId, uint256 taskAgentId, uint256 authAgentId); // I4
    error TaskDeadlinePassed(uint256 taskId, uint256 deadline); // I4
    error LoanAlreadyExists(uint256 taskId); // I5
    error AmountExceedsPrincipalCap(uint256 amount, uint256 principalCap); // I6
    error DebtExceedsEscrowLtv(uint256 debt, uint256 maxDebt); // I6
    error TotalOutstandingCapExceeded(uint256 attempted, uint256 cap); // I7
    error EpochDrawCapExceeded(uint256 attempted, uint256 cap); // I7
    error InsufficientLiquidity(uint256 requested, uint256 available); // vault

    // ---- lifecycle ----
    error LoanNotActive(uint256 taskId);
    error LoanNotLiquidatable(uint256 taskId, uint256 loanDueAt, uint256 taskDeadline);
    error RefundIdAlreadyUsed(bytes32 refundId);
    error RefundExceedsPayment(bytes32 paymentId, uint256 attempted, uint256 remaining);
    error UnknownPayment(bytes32 paymentId);
    error ValueMismatch(uint256 expected, uint256 provided);
    error ZeroAmount();
    error NoPendingDefaultFeedback(uint256 taskId);

    // ---- vault ----
    function deposit(uint256 amount) external payable;
    function withdraw(uint256 amount) external;
    function fundBackstop(uint256 agentId, uint256 amount) external payable;

    // ---- credit ----
    function draw(CreditAuthorization calldata auth, bytes calldata underwriterSig, uint256 amount) external;

    function repay(uint256 taskId, uint256 amount)
        external
        payable
        returns (uint256 applied, uint256 remaining);

    /// @dev push path — TaskEscrow only, escrow arrives with the call.
    function liquidateWithEscrow(uint256 taskId, address poster) external payable;

    /// @dev pull path — permissionless; pulls escrow via releaseForLiquidation.
    function liquidateExpiredLoan(uint256 taskId) external;

    /// @dev Default reporting belongs to the Manager for both push and pull
    ///      liquidation, so no callback into an already-locked Escrow is needed.
    function retryDefaultFeedback(uint256 taskId) external returns (bool sent);
    function pendingDefaultFeedback(uint256 taskId) external view returns (bool);
    function defaultFeedbackSent(uint256 taskId) external view returns (bool);

    /// @dev v5.1: explicit `amount` + replay-guarding `refundId`.
    function processRefund(bytes32 paymentId, uint256 amount, bytes32 refundId) external payable;

    function freezeAgent(uint256 agentId) external;

    // ---- views ----
    function loans(uint256 taskId)
        external
        view
        returns (uint256 agentId, uint256 principal, uint256 fee, uint256 loanDueAt, LoanStatus status);
    function getLoan(uint256 taskId) external view returns (TaskLoan memory);
    function liquidations(uint256 taskId)
        external
        view
        returns (
            uint256 cashUsed,
            uint256 escrowSlashed,
            uint256 backstopUsed,
            uint256 lpLoss,
            address poster
        );
    function getLiquidation(uint256 taskId) external view returns (LiquidationRecord memory);

    /// @notice Cumulative recovery already returned to each burden layer by
    ///         `processRefund`. The per-layer cap is
    ///         `liquidations[taskId].X - getRecovered(taskId).X` (TEST_PLAN F11).
    function getRecovered(uint256 taskId) external view returns (LiquidationRecord memory);
    function backstop(uint256 agentId) external view returns (uint256);
    function protocolFrozen(uint256 agentId) external view returns (bool);
    function totalOutstanding() external view returns (uint256);
    function drawnInEpoch(uint256 epoch) external view returns (uint256);
    function maxTotalOutstanding() external view returns (uint256);
    function maxDrawPerEpoch() external view returns (uint256);
    function drawPaused() external view returns (bool);
    function usedNonces(uint256 agentId, uint256 nonce) external view returns (bool);
    function repaymentCount(uint256 agentId) external view returns (uint256);
    function defaultCount(uint256 agentId) external view returns (uint256);
    function settlementAsset() external view returns (address);
    function MAX_LTV_BPS() external view returns (uint16);
    function GRACE() external view returns (uint256);
    function EPOCH_LENGTH() external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function hashAuthorization(CreditAuthorization calldata auth) external view returns (bytes32);
}
