// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITaskEscrow — ENGINEERING §4.4
interface ITaskEscrow {
    /// @dev §4.4 declares `enum TaskStatus {Open, Assigned, Settled, Failed}`
    ///      but §4.5's state machine and §4.6's call table both require a
    ///      terminal `Cancelled` state (`Open → Cancelled`, "Task=Cancelled/Failed").
    ///      SPEC GAP G1 (TEST_PLAN.md sec 3) — resolved by adding `Cancelled`.
    ///      NOTE: a leading `None` is also added so that "task does not exist"
    ///      is distinguishable from a valid Open task. That DOES shift the
    ///      numeric value of every documented member by one (Open is 1, not 0).
    ///      Nothing is deployed yet, so the renumbering is free today — but any
    ///      off-chain code or document quoting the old ordinals must be updated
    ///      with it.
    enum TaskStatus {
        None,
        Open,
        Assigned,
        Settled,
        Failed,
        Cancelled
    }

    /// @dev §4.4's `Task` struct omits `deadline` and a mutable escrow balance,
    ///      yet `createTask` takes a deadline, `acceptTask`/`draw` must check
    ///      `now < deadline`, and the push liquidation path must "zero the
    ///      escrow" before calling the Manager. SPEC GAP G2 (TEST_PLAN.md sec 3)
    ///      — both fields added.
    ///
    ///      `protocolFeeBps` is a SNAPSHOT taken at `createTask` (TEST_PLAN R5).
    ///      Reading the live global rate instead would let a rate change between
    ///      draw and settle break an already-underwritten loan: at reward 0.15
    ///      and debt 0.092 a 0-bps draw passes I6, but if the rate is later
    ///      raised to 5000 bps the settlement nets only 0.075 and can no longer
    ///      repay. I6 and the settlement waterfall MUST both read this field,
    ///      never `TaskEscrow.protocolFeeBps()`.
    struct Task {
        address poster;
        uint256 reward; // originally escrowed amount (immutable once created)
        uint256 escrowBalance; // currently held; zeroed when released/refunded
        uint256 agentId; // assigned agent, 0 while Open
        uint256 deadline;
        uint16 protocolFeeBps; // snapshot at creation; the task's economics never move
        TaskStatus status;
    }

    /// Feedback type discriminators for pendingFeedback / retryFeedback.
    /// Kept as uint8 constants (not an enum) because §4.4 types the parameter
    /// as `uint8 feedbackType`.
    function FEEDBACK_TASK_SUCCESS() external view returns (uint8);
    function FEEDBACK_REPAYMENT() external view returns (uint8);
    function FEEDBACK_DEFAULT() external view returns (uint8);

    event TaskCreated(uint256 indexed taskId, address indexed poster, uint256 reward, uint256 deadline);
    event TaskAccepted(uint256 indexed taskId, uint256 indexed agentId, address wallet);
    event TaskCancelled(uint256 indexed taskId, address indexed poster, uint256 refunded);
    event TaskExpired(uint256 indexed taskId, bool hadActiveLoan, uint256 escrowMoved);
    event TaskSettled(uint256 indexed taskId, bool passed, uint256 repaid, uint256 slashed, uint256 toAgent);
    event EscrowReleasedForLiquidation(uint256 indexed taskId, uint256 amount, address poster);
    event ProtocolFeeTaken(uint256 indexed taskId, uint256 amount);
    event FeedbackPending(uint256 indexed taskId, uint8 feedbackType);
    event FeedbackSent(uint256 indexed taskId, uint8 feedbackType);

    error NotPoster(address caller);
    error NotVerifier(address caller);
    error NotCreditManager(address caller);
    error NotAgentWallet(uint256 agentId, address caller);
    error TaskNotFound(uint256 taskId);
    error InvalidTaskStatus(uint256 taskId, TaskStatus actual);
    error DeadlineInPast(uint256 deadline);
    error DeadlineNotReached(uint256 taskId, uint256 deadline);
    error TaskAlreadyTerminated(uint256 taskId);
    error ZeroReward();
    error ValueMismatch(uint256 expected, uint256 provided);
    error NoPendingFeedback(uint256 taskId, uint8 feedbackType);
    error UnknownFeedbackType(uint8 feedbackType);

    function createTask(uint256 reward, uint256 deadline) external payable returns (uint256 taskId);

    /// @dev msg.sender MUST equal the agent's CURRENT registry wallet (review r3 #2).
    function acceptTask(uint256 taskId, uint256 agentId) external;

    function cancelTask(uint256 taskId) external;

    /// @dev Permissionless after `deadline`. Branch on `loan.status` (review r5 #2):
    ///      None | ClosedByRefund → full refund to poster, Task → Failed;
    ///      Active               → push path: terminate + zero escrow, then
    ///                             CreditManager.liquidateWithEscrow{value}.
    function expireTask(uint256 taskId) external;

    /// @dev Pull path. CreditManager only. MUST NOT call back into the Manager.
    function releaseForLiquidation(uint256 taskId) external returns (uint256 escrowAmount, address poster);

    function settle(uint256 taskId, bool passed) external;

    /// @dev Permissionless, idempotent per (taskId, feedbackType).
    function retryFeedback(uint256 taskId, uint8 feedbackType) external;

    function getTask(uint256 taskId) external view returns (Task memory);

    /// @notice The CURRENT global rate, applied to tasks created from now on.
    ///         Existing tasks keep `Task.protocolFeeBps`.
    function protocolFeeBps() external view returns (uint16);

    /// @notice reward net of the task's OWN snapshotted protocol fee — the
    ///         escrow side of I6 and the base of the settlement waterfall.
    function payableEscrow(uint256 taskId) external view returns (uint256);
    function pendingFeedback(uint256 taskId, uint8 feedbackType) external view returns (bool);
    function feedbackSent(uint256 taskId, uint8 feedbackType) external view returns (bool);
}
