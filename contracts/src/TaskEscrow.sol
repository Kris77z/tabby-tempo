// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITaskEscrow} from "./interfaces/ITaskEscrow.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {IAgentAccount} from "./interfaces/IAgentAccount.sol";
import {IERC8004Adapter} from "./interfaces/IERC8004Adapter.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

/// @title TaskEscrow — ENGINEERING §4.4 (waterfall + slashing + reputation)
/// @dev Task lifecycle, settlements, liquidation transfers and feedback.
contract TaskEscrow is ITaskEscrow, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    uint8 public constant FEEDBACK_TASK_SUCCESS = 1;
    uint8 public constant FEEDBACK_REPAYMENT = 2;
    uint8 public constant FEEDBACK_DEFAULT = 3;

    address public immutable settlementAsset;
    IERC8004Adapter public immutable adapter;

    address public owner;
    /// @notice P0 = the Arena signing service address (§6.3).
    address public verifier;
    address public feeRecipient;
    ICreditManager public creditManager;
    IAgentAccount public agentAccount;

    /// @notice CURRENT global rate. Taken off the reward BEFORE the I6 LTV
    ///         check and before repay (§4.5 I6: the protocol fee comes off the
    ///         escrow side first). Changing it MUST NOT alter the economics of
    ///         tasks that already exist — every task snapshots the rate it was
    ///         created under into `Task.protocolFeeBps` (TEST_PLAN R5).
    uint16 public protocolFeeBps;

    uint256 public nextTaskId = 1;
    uint256 public totalEscrowed;

    mapping(uint256 taskId => Task) internal _tasks;
    mapping(uint256 taskId => mapping(uint8 feedbackType => bool)) internal _pendingFeedback;
    mapping(uint256 taskId => mapping(uint8 feedbackType => bool)) internal _feedbackSent;

    bool private _wired;

    error NotOwner(address caller);
    error AlreadyWired();
    error FeeTooHigh(uint16 bps);
    error InsufficientEscrow(uint256 taskId, uint256 debt, uint256 available);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert NotVerifier(msg.sender);
        _;
    }

    modifier onlyCreditManager() {
        if (msg.sender != address(creditManager)) revert NotCreditManager(msg.sender);
        _;
    }

    constructor(
        address settlementAsset_,
        IERC8004Adapter adapter_,
        address verifier_,
        address feeRecipient_,
        uint16 protocolFeeBps_,
        address owner_
    ) {
        if (protocolFeeBps_ > BPS_DENOMINATOR) revert FeeTooHigh(protocolFeeBps_);
        settlementAsset = settlementAsset_;
        adapter = adapter_;
        verifier = verifier_;
        feeRecipient = feeRecipient_;
        protocolFeeBps = protocolFeeBps_;
        owner = owner_;
    }

    // ---------------------------------------------------------------------
    // wiring / admin (implemented — plumbing only)
    // ---------------------------------------------------------------------

    function setProtocolContracts(ICreditManager creditManager_, IAgentAccount agentAccount_)
        external
        onlyOwner
    {
        if (_wired) revert AlreadyWired();
        creditManager = creditManager_;
        agentAccount = agentAccount_;
        _wired = true;
    }

    function setVerifier(address verifier_) external onlyOwner {
        verifier = verifier_;
    }

    function setProtocolFeeBps(uint16 bps) external onlyOwner {
        if (bps > BPS_DENOMINATOR) revert FeeTooHigh(bps);
        protocolFeeBps = bps;
    }

    // ---------------------------------------------------------------------
    // task lifecycle
    // ---------------------------------------------------------------------

    /// Spec §4.4: the deadline is mandatory (review r3 #2 — otherwise a task
    /// with no loan locks its escrow forever). Native mode: payable with
    /// `msg.value == reward`; ERC-20 mode: `msg.value == 0` + safeTransferFrom.
    /// Task → Open, escrowBalance = reward,
    /// protocolFeeBps = the CURRENT global rate, snapshotted here forever
    /// (TEST_PLAN R5).
    function createTask(uint256 reward, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 taskId)
    {
        if (reward == 0) revert ZeroReward();
        if (deadline <= block.timestamp) revert DeadlineInPast(deadline);
        uint256 expectedValue = settlementAsset == address(0) ? reward : 0;
        if (msg.value != expectedValue) revert ValueMismatch(expectedValue, msg.value);

        taskId = nextTaskId++;
        _tasks[taskId] = Task({
            poster: msg.sender,
            reward: reward,
            escrowBalance: reward,
            agentId: 0,
            deadline: deadline,
            protocolFeeBps: protocolFeeBps,
            status: TaskStatus.Open
        });
        totalEscrowed += reward;
        if (settlementAsset != address(0)) {
            SafeTransferLib.safeTransferFrom(IERC20(settlementAsset), msg.sender, address(this), reward);
        }
        emit TaskCreated(taskId, msg.sender, reward, deadline);
    }

    /// Spec §4.4 (review r3 #2): msg.sender MUST be the agent's CURRENT registry
    /// wallet — read live, never from the snapshot — so nobody can take a task
    /// on someone else's behalf. Requires Open and now < deadline.
    /// Task → Assigned.
    function acceptTask(uint256 taskId, uint256 agentId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound(taskId);
        if (t.status != TaskStatus.Open) revert InvalidTaskStatus(taskId, t.status);
        if (block.timestamp >= t.deadline) revert DeadlineNotReached(taskId, t.deadline);
        (, address wallet) = adapter.resolveAgent(agentId);
        if (wallet == address(0) || msg.sender != wallet) revert NotAgentWallet(agentId, msg.sender);
        t.agentId = agentId;
        t.status = TaskStatus.Assigned;
        emit TaskAccepted(taskId, agentId, wallet);
    }

    /// Spec §4.4: poster only, Open only (never once assigned), full refund.
    /// Task → Cancelled.
    function cancelTask(uint256 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound(taskId);
        if (msg.sender != t.poster) revert NotPoster(msg.sender);
        if (t.status != TaskStatus.Open) revert InvalidTaskStatus(taskId, t.status);
        uint256 amount = t.escrowBalance;
        t.escrowBalance = 0;
        t.status = TaskStatus.Cancelled;
        totalEscrowed -= amount;
        SafeTransferLib.payOut(settlementAsset, t.poster, amount);
        emit TaskCancelled(taskId, t.poster, amount);
    }

    /// Spec §4.4 v5.1 (review r5 #2): permissionless once past the deadline.
    /// Branch on creditManager.loans(taskId).status, NOT on "does a loan record
    /// exist" — a ClosedByRefund loan still has a record and must not be pushed
    /// into liquidation:
    ///   None | ClosedByRefund → full escrow back to poster, Task → Failed
    ///   Active                → push path (review r4 #3): terminate the task
    ///                           and zero the escrow FIRST, then call
    ///                           creditManager.liquidateWithEscrow{value: escrow}
    ///                           (the Manager never calls back — no cycle)
    function expireTask(uint256 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound(taskId);
        if (t.status != TaskStatus.Open && t.status != TaskStatus.Assigned) {
            revert InvalidTaskStatus(taskId, t.status);
        }
        if (block.timestamp <= t.deadline) revert DeadlineNotReached(taskId, t.deadline);
        ICreditManager.LoanStatus loanStatus = creditManager.getLoan(taskId).status;
        if (
            loanStatus != ICreditManager.LoanStatus.Active && loanStatus != ICreditManager.LoanStatus.None
                && loanStatus != ICreditManager.LoanStatus.ClosedByRefund
        ) revert InvalidTaskStatus(taskId, t.status);
        uint256 amount = t.escrowBalance;
        t.escrowBalance = 0;
        t.status = TaskStatus.Failed;
        totalEscrowed -= amount;
        bool active = loanStatus == ICreditManager.LoanStatus.Active;
        if (active) _pushLiquidation(taskId, amount, t.poster);
        else SafeTransferLib.payOut(settlementAsset, t.poster, amount);
        emit TaskExpired(taskId, active, amount);
    }

    /// Spec §4.4 (pull path): CreditManager only. Pushes the escrow to the
    /// Manager, marks the task Failed, returns the poster for the residual
    /// refund. MUST NOT call back into the CreditManager (§4.6 anti-reentrancy).
    function releaseForLiquidation(uint256 taskId)
        external
        onlyCreditManager
        nonReentrant
        returns (uint256 amount, address poster)
    {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound(taskId);
        if (t.status != TaskStatus.Assigned) revert InvalidTaskStatus(taskId, t.status);
        amount = t.escrowBalance;
        poster = t.poster;
        t.escrowBalance = 0;
        t.status = TaskStatus.Failed;
        totalEscrowed -= amount;
        SafeTransferLib.payOut(settlementAsset, msg.sender, amount);
        emit EscrowReleasedForLiquidation(taskId, amount, poster);
    }

    /// Spec §4.4, verifier only. Branches on loan.status, never on existence.
    ///
    /// passed == true (funds settle atomically, RISK_AND_MVP §3):
    ///   Active → 1. protocol fee
    ///            2. creditManager.repay(principal + fee)
    ///            3. residue → agentAccount.creditCash
    ///            P0 has no automatic backstop top-up.
    ///            writes "task-success" AND "repayment" feedback
    ///   None | ClosedByRefund → skip repay entirely; reward minus protocol fee
    ///            goes straight to cash. Writes "task-success" only — NEVER
    ///            "repayment" (review #4: no phantom repayment counts).
    ///
    /// passed == false:
    ///   Active → terminate the task, zero the escrow, then push
    ///            creditManager.liquidateWithEscrow{value: escrow}
    ///   None | ClosedByRefund → full escrow back to the poster, no liquidation
    ///
    /// A task already terminated by liquidation MUST revert here, and a second
    /// settle MUST revert (the Task state machine is one-way).
    function settle(uint256 taskId, bool passed) external onlyVerifier nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.status == TaskStatus.None) revert TaskNotFound(taskId);
        if (t.status != TaskStatus.Assigned) revert InvalidTaskStatus(taskId, t.status);
        ICreditManager.TaskLoan memory loan = creditManager.getLoan(taskId);
        if (
            loan.status != ICreditManager.LoanStatus.Active && loan.status != ICreditManager.LoanStatus.None
                && loan.status != ICreditManager.LoanStatus.ClosedByRefund
        ) revert InvalidTaskStatus(taskId, t.status);
        uint256 amount = t.escrowBalance;
        t.escrowBalance = 0;
        t.status = passed ? TaskStatus.Settled : TaskStatus.Failed;
        totalEscrowed -= amount;
        if (!passed) {
            uint256 slashed;
            if (loan.status == ICreditManager.LoanStatus.Active) {
                _pushLiquidation(taskId, amount, t.poster);
                slashed = creditManager.getLiquidation(taskId).escrowSlashed;
            } else {
                SafeTransferLib.payOut(settlementAsset, t.poster, amount);
            }
            emit TaskSettled(taskId, false, 0, slashed, 0);
            return;
        }

        uint256 fee = t.reward * t.protocolFeeBps / BPS_DENOMINATOR;
        amount -= fee;
        if (loan.status == ICreditManager.LoanStatus.Active && loan.principal + loan.fee > amount) {
            revert InsufficientEscrow(taskId, loan.principal + loan.fee, amount);
        }
        SafeTransferLib.payOut(settlementAsset, feeRecipient, fee);
        emit ProtocolFeeTaken(taskId, fee);
        uint256 repaid;
        if (loan.status == ICreditManager.LoanStatus.Active) {
            uint256 debt = loan.principal + loan.fee;
            if (settlementAsset != address(0)) {
                SafeTransferLib.safeApprove(IERC20(settlementAsset), address(creditManager), debt);
            }
            (repaid,) = creditManager.repay{value: settlementAsset == address(0) ? debt : 0}(taskId, debt);
            amount -= repaid;
        }
        if (amount != 0) {
            if (settlementAsset != address(0)) {
                SafeTransferLib.safeApprove(IERC20(settlementAsset), address(agentAccount), amount);
            }
            agentAccount.creditCash{value: settlementAsset == address(0) ? amount : 0}(t.agentId, amount);
        }
        emit TaskSettled(taskId, true, repaid, 0, amount);
        _reportFeedback(taskId, FEEDBACK_TASK_SUCCESS);
        if (loan.status == ICreditManager.LoanStatus.Active) {
            _reportFeedback(taskId, FEEDBACK_REPAYMENT);
        }
    }

    function _pushLiquidation(uint256 taskId, uint256 amount, address poster) private {
        if (settlementAsset != address(0)) {
            SafeTransferLib.safeApprove(IERC20(settlementAsset), address(creditManager), amount);
        }
        creditManager.liquidateWithEscrow{value: settlementAsset == address(0) ? amount : 0}(taskId, poster);
    }

    /// Spec §4.4 (review #5): reputation writes are decoupled from funds.
    /// Funds settle atomically; the trusted adapter bounds and catches registry
    /// failures, returning false to park pendingFeedback[taskId][type].
    /// `retryFeedback` is permissionless and idempotent per (taskId, type):
    /// once sent, a retry is a no-op (or reverts NoPendingFeedback) and NEVER
    /// writes a second feedback entry.
    function retryFeedback(uint256 taskId, uint8 feedbackType) external nonReentrant {
        _feedbackTag(feedbackType); // Validate the type before looking up pending state.
        if (feedbackType == FEEDBACK_DEFAULT) {
            if (!creditManager.pendingDefaultFeedback(taskId)) {
                revert NoPendingFeedback(taskId, feedbackType);
            }
            if (creditManager.retryDefaultFeedback(taskId)) emit FeedbackSent(taskId, feedbackType);
            else emit FeedbackPending(taskId, feedbackType);
            return;
        }
        if (!_pendingFeedback[taskId][feedbackType]) revert NoPendingFeedback(taskId, feedbackType);
        _reportFeedback(taskId, feedbackType);
    }

    function _reportFeedback(uint256 taskId, uint8 feedbackType) private {
        if (_feedbackSent[taskId][feedbackType]) return;
        bool ok = adapter.reportFeedback(_tasks[taskId].agentId, _feedbackTag(feedbackType), 100, 0);
        _pendingFeedback[taskId][feedbackType] = !ok;
        if (ok) {
            _feedbackSent[taskId][feedbackType] = true;
            emit FeedbackSent(taskId, feedbackType);
        } else {
            emit FeedbackPending(taskId, feedbackType);
        }
    }

    function _feedbackTag(uint8 feedbackType) private pure returns (string memory) {
        if (feedbackType == FEEDBACK_TASK_SUCCESS) return "task-success";
        if (feedbackType == FEEDBACK_REPAYMENT) return "repayment";
        if (feedbackType == FEEDBACK_DEFAULT) return "default";
        revert UnknownFeedbackType(feedbackType);
    }

    // ---------------------------------------------------------------------
    // views (implemented: pure storage reads)
    // ---------------------------------------------------------------------

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function tasks(uint256 taskId)
        external
        view
        returns (address, uint256, uint256, uint256, uint256, uint16, TaskStatus)
    {
        Task memory t = _tasks[taskId];
        return (t.poster, t.reward, t.escrowBalance, t.agentId, t.deadline, t.protocolFeeBps, t.status);
    }

    function pendingFeedback(uint256 taskId, uint8 feedbackType) external view returns (bool) {
        if (feedbackType == FEEDBACK_DEFAULT) return creditManager.pendingDefaultFeedback(taskId);
        return _pendingFeedback[taskId][feedbackType];
    }

    function feedbackSent(uint256 taskId, uint8 feedbackType) external view returns (bool) {
        if (feedbackType == FEEDBACK_DEFAULT) return creditManager.defaultFeedbackSent(taskId);
        return _feedbackSent[taskId][feedbackType];
    }

    /// @notice Reward net of the task's OWN snapshotted protocol fee — the
    ///         escrow side of I6 and the base of the settlement waterfall.
    ///         Deliberately reads `t.protocolFeeBps`, never the live global rate.
    function payableEscrow(uint256 taskId) external view returns (uint256) {
        Task memory t = _tasks[taskId];
        return t.reward - (t.reward * t.protocolFeeBps) / BPS_DENOMINATOR;
    }

    receive() external payable {}
}
