// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";

/// @title TaskLifecycle.t.sol — ENGINEERING §4.4 + the Task/Loan state machines
///        of §4.5
/// @notice cancel / expire / settle routing, which v5.1 (review r5 #2) requires
///         to branch on `loan.status` and NOT on "does a loan record exist".
contract TaskLifecycleTest is InferCreditTestBase {
    // =====================================================================
    // create / accept
    // =====================================================================

    function test_CreateTask_EscrowsRewardAndOpensTask() public {
        uint256 deadline = block.timestamp + DEFAULT_TASK_DURATION;
        uint256 escrowBalBefore = _balanceOf(address(escrow));

        uint256 taskId = _createTask(poster, DEMO_REWARD);

        ITaskEscrow.Task memory t = escrow.getTask(taskId);
        assertEq(t.poster, poster, "poster recorded");
        assertEq(t.reward, DEMO_REWARD, "reward recorded");
        assertEq(t.escrowBalance, DEMO_REWARD, "reward actually escrowed");
        assertEq(t.deadline, deadline, "deadline is mandatory (review r3 #2)");
        assertEq(t.agentId, 0, "no agent yet");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Open, "Open");
        assertEq(_balanceOf(address(escrow)) - escrowBalBefore, DEMO_REWARD, "funds really moved");
    }

    function test_RevertWhen_CreateTaskWithPastDeadline() public {
        _approve(poster, address(escrow), DEMO_REWARD);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.DeadlineInPast.selector, block.timestamp - 1));
        escrow.createTask{value: _val(DEMO_REWARD)}(DEMO_REWARD, block.timestamp - 1);
    }

    /// ENGINEERING §3 / §4.2: in native mode every inbound function is payable
    /// and MUST check `msg.value == amount`. Under-paying must not create an
    /// escrow the contract does not hold.
    function test_RevertWhen_CreateTaskValueMismatch_NativeMode() public {
        vm.skip(_useErc20()); // the ERC-20 half lives in Erc20PairingTest
        vm.prank(poster);
        vm.expectRevert(
            abi.encodeWithSelector(ITaskEscrow.ValueMismatch.selector, DEMO_REWARD, DEMO_REWARD - 1)
        );
        escrow.createTask{value: DEMO_REWARD - 1}(DEMO_REWARD, block.timestamp + 1 days);
    }

    function test_AcceptTask_AssignsAgent() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);

        _acceptTask(taskId, agentId, agentWallet);

        ITaskEscrow.Task memory t = escrow.getTask(taskId);
        assertEq(t.agentId, agentId, "agent assigned");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Assigned, "Assigned");
    }

    /// §4.5 清单项：非当前 registry wallet 接单被拒（r3 #2）
    function test_RevertWhen_AcceptTaskFromNonRegistryWallet() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NotAgentWallet.selector, agentId, stranger));
        escrow.acceptTask(taskId, agentId);
    }

    /// The check must read the CURRENT registry wallet, so a rotated-away wallet
    /// loses the ability to take tasks immediately (same live-read rule as I3).
    function test_RevertWhen_AcceptTaskFromRotatedAwayWallet() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);

        _bindWallet(agentId, agentOwner, AGENT_WALLET2_PK, block.timestamp + 1 hours);

        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NotAgentWallet.selector, agentId, agentWallet));
        escrow.acceptTask(taskId, agentId);
    }

    function test_RevertWhen_AcceptTaskTwice() public {
        uint256 agentA = _registerAndEnroll(agentOwner, agentWallet);
        uint256 agentB = _registerAndEnroll(otherAgentOwner, otherAgentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentA, agentWallet);

        vm.prank(otherAgentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Assigned
            )
        );
        escrow.acceptTask(taskId, agentB);
    }

    /// §4.4: "acceptTask  draw  now < deadline".
    function test_RevertWhen_AcceptTaskAfterDeadline() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        uint256 deadline = escrow.getTask(taskId).deadline;

        vm.warp(deadline + 1);
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.DeadlineNotReached.selector, taskId, deadline));
        escrow.acceptTask(taskId, agentId);
    }

    // =====================================================================
    // cancel (Open → Cancelled)
    // =====================================================================

    /// §4.5 清单项：未接单取消全额退款（r3 #2）
    function test_CancelTask_OpenTaskRefundsPosterInFull() public {
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        uint256 before = _balanceOf(poster);

        vm.prank(poster);
        escrow.cancelTask(taskId);

        assertEq(_balanceOf(poster) - before, DEMO_REWARD, "full refund");
        assertEq(escrow.getTask(taskId).escrowBalance, 0, "escrow emptied");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Cancelled, "Open -> Cancelled");
    }

    function test_RevertWhen_CancelTaskByNonPoster() public {
        uint256 taskId = _createTask(poster, DEMO_REWARD);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NotPoster.selector, stranger));
        escrow.cancelTask(taskId);
    }

    /// Once an agent has committed, the poster must not be able to yank the
    /// reward away — that would be a free denial-of-service on the agent, and
    /// with an active loan it would strip the liquidation collateral.
    function test_RevertWhen_CancelTaskAfterAssigned() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);

        vm.prank(poster);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Assigned
            )
        );
        escrow.cancelTask(taskId);
    }

    function test_RevertWhen_CancelTaskTwice() public {
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        vm.prank(poster);
        escrow.cancelTask(taskId);

        vm.prank(poster);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Cancelled
            )
        );
        escrow.cancelTask(taskId);
    }

    // =====================================================================
    // expire (loan.status == None) — review r3 #2 / r5 #2
    // =====================================================================

    /// §4.5 清单项：deadline 后无 loan 任务退款终结
    function test_ExpireTask_NoLoan_RefundsPosterAndFails() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 before = _balanceOf(poster);

        vm.warp(escrow.getTask(taskId).deadline + 1);
        vm.prank(stranger); // permissionless
        escrow.expireTask(taskId);

        assertEq(_balanceOf(poster) - before, DEMO_REWARD, "full refund to poster");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "Assigned -> Failed");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.None, "no loan was ever opened");
        assertEq(manager.getLiquidation(taskId).poster, address(0), "no liquidation record");
    }

    /// An Open (never accepted) task must also be reclaimable after its deadline
    /// — otherwise an unwanted task locks its escrow forever (review r3 #2).
    function test_ExpireTask_NeverAcceptedTaskRefundsPoster() public {
        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        uint256 before = _balanceOf(poster);

        vm.warp(escrow.getTask(taskId).deadline + 1);
        escrow.expireTask(taskId);

        assertEq(_balanceOf(poster) - before, DEMO_REWARD, "full refund");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "Open -> Failed");
    }

    function test_RevertWhen_ExpireTaskBeforeDeadline() public {
        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        uint256 deadline = escrow.getTask(taskId).deadline;

        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.DeadlineNotReached.selector, taskId, deadline));
        escrow.expireTask(taskId);
    }

    // =====================================================================
    // settle(true) — the success waterfall
    // =====================================================================

    /// §4.4 happy path with an Active loan:
    ///   reward → 1. protocol fee → 2. repay → 3. backstop top-up → 4. cash.
    function test_Settle_Passed_WaterfallOrderAndAmounts() public {
        _setProtocolFee(500); // 5%
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, 1 ether);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.5 ether,
            0.5 ether,
            TIER_B_FEE_BPS,
            TIER_B,
            block.timestamp + 1 hours,
            keccak256("p1")
        );

        uint256 debt = 0.5 ether + 0.04 ether; // 800 bps
        uint256 feeCut = 0.05 ether;
        uint256 vaultBefore = manager.vaultBalance();
        uint256 feeRecipientBefore = _balanceOf(feeRecipient);
        uint256 managerAssetsBefore = _balanceOf(address(manager));
        uint256 escrowAssetsBefore = _balanceOf(address(escrow));

        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(_balanceOf(feeRecipient) - feeRecipientBefore, feeCut, "1. protocol fee first");
        assertEq(manager.vaultBalance() - vaultBefore, debt, "2. principal + fee back to the vault");
        // TEST_PLAN F8: the Manager must keep ONLY what it actually applied.
        // Assert against the contracts' REAL asset balances, not just the ledger,
        // so a surplus silently parked inside the Manager would be caught.
        assertEq(
            _balanceOf(address(manager)) - managerAssetsBefore,
            debt,
            "the Manager's real balance grew by exactly the applied debt"
        );
        assertEq(_balanceOf(address(escrow)), escrowAssetsBefore - 1 ether, "escrow fully distributed");
        assertEq(account.cash(agentId), 1 ether - feeCut - debt, "4. residue to the agent's cash balance");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "Repaid");
        assertEq(manager.totalOutstanding(), 0, "no outstanding debt");
        assertEq(manager.repaymentCount(agentId), 1, "one genuine repayment");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Settled, "Settled");
    }

    /// The demo fixture, protocol fee 0: 0.15 − 0.092 = 0.058 (§6.1).
    function test_Settle_Passed_DemoResidue() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            DEMO_QUOTE,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            keccak256("p1")
        );

        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(account.cash(agentId), DEMO_RESIDUE_1, "residue 0.058 exactly");
    }

    /// The backstop pot must NOT be raided by a successful settlement — it is
    /// booked separately and is never lendable (§4.2).
    function test_Settle_Passed_DoesNotTouchUnconsumedBackstop() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _fundBackstop(agentId, agentOwner, 0.03 ether);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.08 ether,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            keccak256("p1")
        );

        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(manager.backstop(agentId), 0.03 ether, "backstop untouched (step 3 is a no-op)");
        assertEq(account.cash(agentId), DEMO_REWARD - 0.092 ether, "residue to cash");
    }

    function test_RevertWhen_SettleByNonVerifier() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NotVerifier.selector, stranger));
        escrow.settle(taskId, true);
    }

    /// §4.5 清单项：重复 settle —— the Task state machine is one-way.
    function test_RevertWhen_SettleTwice() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.08 ether,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            keccak256("p1")
        );

        vm.prank(verifier);
        escrow.settle(taskId, true);

        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Settled
            )
        );
        escrow.settle(taskId, true);
    }

    // =====================================================================
    // settle(false) with no loan — review r2 #5
    // =====================================================================

    /// §4.5 清单项：无 loan 失败任务 —— 全额退款不进清算（r2 #5）
    function test_Settle_Failed_NoLoan_FullRefundNoLiquidation() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 before = _balanceOf(poster);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        assertEq(_balanceOf(poster) - before, DEMO_REWARD, "poster gets everything back");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "Failed");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.None, "still no loan");
        assertEq(manager.defaultCount(agentId), 0, "no default");
        assertFalse(manager.protocolFrozen(agentId), "agent not frozen");
        assertEq(manager.getLiquidation(taskId).poster, address(0), "no liquidation record");
    }

    // =====================================================================
    // ClosedByRefund routing — review r5 #2
    // =====================================================================

    /// §4.5 清单项：ClosedByRefund 后任务成功 —— 跳过 repay、记 task-success、
    ///           不增还款次数（r5 #2）
    function test_Settle_Passed_ClosedByRefund_SkipsRepayAndCountsNoRepayment() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        bytes32 paymentId = keccak256("p1");
        _drawWithLoanDue(
            agentId,
            taskId,
            DEMO_QUOTE,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            paymentId
        );

        _approve(relayRefunder, address(manager), DEMO_QUOTE);
        vm.prank(relayRefunder);
        manager.processRefund{value: _val(DEMO_QUOTE)}(paymentId, DEMO_QUOTE, keccak256("r1"));
        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "precondition");

        uint256 vaultBefore = manager.vaultBalance();
        uint256 cashBefore = account.cash(agentId);

        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(manager.vaultBalance(), vaultBefore, "repay is skipped entirely");
        assertEq(account.cash(agentId) - cashBefore, DEMO_REWARD, "whole reward (fee 0) goes to cash");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "status must NOT become Repaid");
        assertEq(manager.repaymentCount(agentId), 0, "no repayment counted (r5 #2)");
        assertEq(_feedbackCount(agentId, "task-success"), 1, "but the task success IS recorded");
        assertEq(_feedbackCount(agentId, "repayment"), 0, "and no repayment feedback");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Settled, "Settled");
    }

    /// §4.5 清单项：ClosedByRefund 后失败/到期 —— 退还 escrow、不进清算（r5 #2）
    /// Routing by "does a loan record exist" instead of by `loan.status` would
    /// push this task into liquidation — that is precisely the bug r5 #2 closes.
    function test_Settle_Failed_ClosedByRefund_RefundsPosterNoLiquidation() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        bytes32 paymentId = keccak256("p1");
        _drawWithLoanDue(
            agentId,
            taskId,
            DEMO_QUOTE,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            paymentId
        );

        _approve(relayRefunder, address(manager), DEMO_QUOTE);
        vm.prank(relayRefunder);
        manager.processRefund{value: _val(DEMO_QUOTE)}(paymentId, DEMO_QUOTE, keccak256("r1"));

        uint256 posterBefore = _balanceOf(poster);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        assertEq(_balanceOf(poster) - posterBefore, DEMO_REWARD, "poster gets the WHOLE escrow");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "never becomes Defaulted");
        assertEq(manager.defaultCount(agentId), 0, "no default recorded");
        assertEq(manager.getLiquidation(taskId).poster, address(0), "liquidation never ran");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "Failed");
    }

    // =====================================================================
    // repay access control
    // =====================================================================

    // =====================================================================
    // R5 — the protocol fee is a per-task snapshot, not a live global read
    // =====================================================================

    /// Codex review R5. Without a snapshot, raising the global rate after a draw
    /// retroactively breaks an already-underwritten loan: reward 0.15 and debt
    /// 0.092 pass I6 at 0 bps, but a later 5000 bps rate leaves only 0.075 to
    /// settle with. The task must carry the rate it was created under.
    function test_ProtocolFeeIsSnapshottedAtTaskCreation() public {
        _setProtocolFee(0);
        uint256 taskAtZero = _createTask(poster, DEMO_REWARD, 30 days);
        assertEq(escrow.getTask(taskAtZero).protocolFeeBps, 0, "snapshot taken at creation");

        _setProtocolFee(5_000);
        assertEq(escrow.protocolFeeBps(), 5_000, "the global rate did change");
        assertEq(escrow.getTask(taskAtZero).protocolFeeBps, 0, "but the existing task keeps its own rate");

        uint256 taskAtFiveK = _createTask(poster, DEMO_REWARD, 30 days);
        assertEq(escrow.getTask(taskAtFiveK).protocolFeeBps, 5_000, "new tasks take the new rate");

        assertEq(escrow.payableEscrow(taskAtZero), DEMO_REWARD, "old task: nothing skimmed");
        assertEq(escrow.payableEscrow(taskAtFiveK), DEMO_REWARD / 2, "new task: half skimmed");
    }

    /// The economics of a live loan must survive a rate change end to end:
    /// the draw passed I6 under the old rate, so settlement must still repay in
    /// full and hand the agent the residue the underwriter promised.
    function test_RateChangeAfterDrawDoesNotBreakAnExistingLoan() public {
        _setProtocolFee(0);
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            DEMO_QUOTE,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            keccak256("p1")
        );

        // governance raises the fee mid-flight
        _setProtocolFee(5_000);

        uint256 feeRecipientBefore = _balanceOf(feeRecipient);
        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(_balanceOf(feeRecipient), feeRecipientBefore, "no fee: this task was created at 0 bps");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "still repays in full");
        assertEq(account.cash(agentId), DEMO_RESIDUE_1, "and the residue is exactly as underwritten");
    }

    /// Raising the fee must apply to tasks created afterwards — the snapshot is
    /// a stability guarantee, not a permanent zero.
    function test_RateChangeAppliesToTasksCreatedAfterwards() public {
        _setProtocolFee(1_000);
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, 1 ether, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.5 ether,
            0.5 ether,
            TIER_B_FEE_BPS,
            TIER_B,
            block.timestamp + 1 hours,
            keccak256("p1")
        );

        uint256 feeRecipientBefore = _balanceOf(feeRecipient);
        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(_balanceOf(feeRecipient) - feeRecipientBefore, 0.1 ether, "10% of the 1.0 reward");
    }

    // =====================================================================
    // F13 — settle vs expireTask after the deadline is decided by tx order
    // =====================================================================

    /// Codex ruling on F13: §4.4 allows settle after the deadline as long as the
    /// task has not been terminated, so the outcome genuinely depends on which
    /// transaction lands first. Both orderings are pinned here so the behaviour
    /// is a documented consequence rather than an accident. Giving the verifier
    /// a private window would be a product-rule change, not a clarification.
    function test_AfterDeadline_SettleFirstWins() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        uint256 deadline = escrow.getTask(taskId).deadline;
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId, taskId, DEMO_QUOTE, 0.08 ether, TIER_C_FEE_BPS, TIER_C, deadline, keccak256("p1")
        );

        vm.warp(deadline + 1);

        vm.prank(verifier);
        escrow.settle(taskId, true); // the PASS lands first

        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Settled, "a late PASS still settles");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "and the loan is repaid");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Settled
            )
        );
        escrow.expireTask(taskId);
    }

    /// The mirror image: whoever expires it first turns a passing task into a
    /// default. This is a real race in the current spec, not a test artefact.
    function test_AfterDeadline_ExpireFirstWins() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        uint256 deadline = escrow.getTask(taskId).deadline;
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId, taskId, DEMO_QUOTE, 0.08 ether, TIER_C_FEE_BPS, TIER_C, deadline, keccak256("p1")
        );

        vm.warp(deadline + 1);

        vm.prank(stranger);
        escrow.expireTask(taskId); // the outsider lands first

        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "terminated by expiry");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "and liquidated");

        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Failed
            )
        );
        escrow.settle(taskId, true);
    }

    function test_RevertWhen_RepayCalledByStranger() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.08 ether,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            keccak256("p1")
        );

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotTaskEscrow.selector, stranger));
        manager.repay{value: _val(0.092 ether)}(taskId, 0.092 ether);
    }
}

/// @notice Unit-level `repay` harness (TEST_PLAN F7, Codex ruling).
/// @dev Under a correct I6 with MAX_LTV_BPS <= 10_000 a successful settlement
///      always repays in full, so the partial branch of `repay` is unreachable
///      from `settle`. Codex's ruling: that does not justify deleting the
///      already-agreed `(applied, remaining)` interface, and it does justify NOT
///      manufacturing a mixed "Task=Settled but Loan=Active" state just to reach
///      it. So the branch is exercised where it belongs — at the unit level,
///      calling `repay` directly while impersonating the TaskEscrow.
contract PartialRepaymentTest is InferCreditTestBase {
    function _repayAs(uint256 taskId, uint256 amount) internal returns (uint256, uint256) {
        if (_useErc20()) {
            token.mint(address(escrow), amount);
            vm.prank(address(escrow));
            token.approve(address(manager), amount);
        } else {
            vm.deal(address(escrow), address(escrow).balance + amount);
        }
        vm.prank(address(escrow));
        return manager.repay{value: _val(amount)}(taskId, amount);
    }

    function _activeLoan() internal returns (uint256 agentId, uint256 taskId) {
        _seedVault(VAULT_SEED);
        agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.08 ether,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            keccak256("p1")
        );
    }

    /// §4.5 清单项：部分偿付后 loan 仍 Active
    /// Debt 0.092 (fee 0.012 + principal 0.08). Paying 0.05 retires the fee
    /// FIRST, then 0.038 of principal, leaving 0.042 outstanding and Active.
    function test_PartialRepayment_LoanStaysActive() public {
        (uint256 agentId, uint256 taskId) = _activeLoan();

        (uint256 applied, uint256 remaining) = _repayAs(taskId, 0.05 ether);

        assertEq(applied, 0.05 ether, "all of it was applicable");
        assertEq(remaining, 0.042 ether, "and 0.042 of debt is still owed");

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.fee, 0, "fee is retired FIRST");
        assertEq(loan.principal, 0.042 ether, "0.08 - (0.05 - 0.012) of principal remains");
        assertLoanStatus(
            taskId, ICreditManager.LoanStatus.Active, "a partial repayment must NOT reach Repaid"
        );
        assertEq(manager.repaymentCount(agentId), 0, "and must NOT count as a repayment");
        assertEq(manager.totalOutstanding(), 0.042 ether, "outstanding tracks the remainder");
    }

    /// Two partial repayments must compose into a full one.
    function test_PartialRepayments_AccumulateToRepaid() public {
        (uint256 agentId, uint256 taskId) = _activeLoan();

        _repayAs(taskId, 0.05 ether);
        (uint256 applied, uint256 remaining) = _repayAs(taskId, 0.042 ether);

        assertEq(applied, 0.042 ether, "the rest is applied");
        assertEq(remaining, 0, "nothing left");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "now fully repaid");
        assertEq(manager.repaymentCount(agentId), 1, "counted once, on full repayment only");
        assertEq(manager.totalOutstanding(), 0, "outstanding cleared");
    }

    function test_FeeOnlyRepaymentAndRepeatedFullRepaymentCannotMintHistory() public {
        (uint256 agentId, uint256 taskId) = _activeLoan();
        uint256 beforeAssets = _balanceOf(address(manager));
        uint256 beforeVault = manager.vaultBalance();
        vm.prank(address(escrow));
        vm.expectRevert(ICreditManager.ZeroAmount.selector);
        manager.repay(taskId, 0);
        uint256 wrongValue = _useErc20() ? 1 : 0;
        if (_useErc20()) vm.deal(address(escrow), 1 wei);
        vm.prank(address(escrow));
        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.ValueMismatch.selector, _val(1 wei), wrongValue)
        );
        manager.repay{value: wrongValue}(taskId, 1 wei);
        (uint256 applied, uint256 remaining) = _repayAs(taskId, 0.005 ether);
        assertEq(applied, 0.005 ether);
        assertEq(remaining, 0.087 ether);
        assertEq(manager.getLoan(taskId).principal, 0.08 ether, "fee-only payment retires no principal");
        assertEq(manager.getLoan(taskId).fee, 0.007 ether);
        assertEq(manager.vaultBalance(), beforeVault + 0.005 ether);
        assertEq(_balanceOf(address(manager)), beforeAssets + 0.005 ether);
        assertEq(manager.repaymentCount(agentId), 0);
        assertEq(_feedbackCount(agentId, "repayment"), 0, "unit repayments do not report task results");
        _repayAs(taskId, 0.087 ether);
        assertEq(manager.repaymentCount(agentId), 1);
        uint256 finalAssets = _balanceOf(address(manager));
        vm.prank(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.LoanNotActive.selector, taskId));
        manager.repay{value: _val(1 wei)}(taskId, 1 wei);
        assertEq(manager.repaymentCount(agentId), 1);
        assertEq(_balanceOf(address(manager)), finalAssets);
        assertEq(manager.totalOutstanding(), 0);
    }

    /// TEST_PLAN F8: an over-payment must be returned to the Escrow in the same
    /// call, verified against REAL asset balances rather than the ledger.
    function test_OverPayment_SurplusReturnedToEscrow() public {
        (, uint256 taskId) = _activeLoan();

        uint256 managerBefore = _balanceOf(address(manager));
        uint256 vaultBefore = manager.vaultBalance();
        uint256 escrowBefore = _balanceOf(address(escrow));

        (uint256 applied, uint256 remaining) = _repayAs(taskId, 0.15 ether);

        assertEq(applied, 0.092 ether, "only the outstanding debt is applicable");
        assertEq(remaining, 0, "debt cleared");
        assertEq(manager.vaultBalance() - vaultBefore, 0.092 ether, "ledger grew by the debt only");
        assertEq(
            _balanceOf(address(manager)) - managerBefore,
            0.092 ether,
            "and so did the Manager's REAL balance - the 0.058 surplus went back"
        );
        assertEq(
            _balanceOf(address(escrow)), escrowBefore + 0.058 ether, "surplus returned to the original payer"
        );
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "Repaid");
    }
}

/// @notice The `repay` unit harness in ERC-20 settlement mode.
contract Erc20PartialRepaymentTest is PartialRepaymentTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}
