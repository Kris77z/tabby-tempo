// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";

/// @title Liquidation.t.sol — ENGINEERING §4.2 `_liquidate` + §4.5 checklist
/// @notice Covers the waterfall order, both entry points (push / pull), the
///         "fact of default != actual loss" rule and the no-deadlock property
///         of the anti-reentrancy design in §4.6.
contract LiquidationTest is InferCreditTestBase {
    // =====================================================================
    // waterfall order — review r2 #4: "cash  poster"
    // =====================================================================

    /// §4.5 清单项：清算清偿顺序逐层断言 —— cash 先动、escrow 只补不足（r2 #4）
    ///
    /// debt 0.092 | cash 0.03 | escrow 0.15
    ///   layer 1 cash    → 0.03
    ///   layer 2 escrow  → 0.062 (only the shortfall)
    ///   layer 3 backstop→ 0
    ///   layer 4 LP loss → 0, and the untouched 0.088 escrow goes back to poster
    function test_Liquidation_WaterfallTakesCashBeforeEscrow() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);

        // draw the full 0.08 with no cash, then top the cash back up to 0.03
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
        _depositCash(agentId, agentOwner, 0.03 ether);

        uint256 posterBefore = _balanceOf(poster);

        vm.prank(verifier);
        escrow.settle(taskId, false); // push path

        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.cashUsed, 0.03 ether, "layer 1: agent cash moves FIRST");
        assertEq(r.escrowSlashed, 0.062 ether, "layer 2: escrow only tops up the shortfall");
        assertEq(r.backstopUsed, 0, "layer 3 untouched");
        assertEq(r.lpLoss, 0, "layer 4: LP fully made whole");
        assertEq(r.poster, poster, "poster recorded for the later recovery (r4 #1)");

        assertEq(account.cash(agentId), 0, "agent cash drained by the protocol-level debit");
        assertEq(
            _balanceOf(poster) - posterBefore,
            DEMO_REWARD - 0.062 ether,
            "unused escrow is refunded to the poster in the same tx"
        );
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "loan is Defaulted");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "task terminated");
    }

    /// §4.5 清单项：债务 0.1 / escrow 1 / cash 0.2 场景 —— poster 拿回全部 escrow
    /// Verbatim fixture from the spec (debt 0.1 = principal 0.1 at 0 bps).
    function test_Liquidation_CashCoversDebt_PosterKeepsWholeEscrow() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, 1 ether);
        _acceptTask(taskId, agentId, agentWallet);

        _drawWithLoanDue(
            agentId, taskId, 0.1 ether, 0.1 ether, 0, TIER_A, block.timestamp + 1 hours, keccak256("p1")
        );
        _depositCash(agentId, agentOwner, 0.2 ether);

        uint256 posterBefore = _balanceOf(poster);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.cashUsed, 0.1 ether, "the whole debt came out of the agent's own cash");
        assertEq(r.escrowSlashed, 0, "an honest poster loses nothing (RISK_AND_MVP sec 1.2 note)");
        assertEq(_balanceOf(poster) - posterBefore, 1 ether, "poster gets the WHOLE escrow back");
        assertEq(account.cash(agentId), 0.1 ether, "only the debt was debited, not the balance");
    }

    /// §4.5 清单项：清算扣 cash 不受 ownerFrozen 阻止
    /// The owner freezing its own account must not shield it from liquidation.
    function test_Liquidation_DebitsCashDespiteOwnerFrozen() public {
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
        _depositCash(agentId, agentOwner, 0.05 ether);

        // owner slams the door AFTER borrowing
        _setPolicy(agentId, agentOwner, 0, 0, 0, true);
        assertTrue(account.getPolicy(agentId).ownerFrozen, "owner froze the account");

        vm.prank(verifier);
        escrow.settle(taskId, false);

        assertEq(
            manager.getLiquidation(taskId).cashUsed,
            0.05 ether,
            "debitForLiquidation is protocol-level and ignores ownerFrozen / policy limits"
        );
        assertEq(account.cash(agentId), 0, "cash really left the account");
    }

    /// The protocol-level debit must also ignore the per-tx / per-day policy
    /// caps — otherwise setting maxDebtPerTx = 0 would make an agent unslashable.
    function test_Liquidation_DebitsCashDespiteZeroPolicyLimits() public {
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
        _depositCash(agentId, agentOwner, 0.05 ether);
        _setPolicy(agentId, agentOwner, 0, 0, 0, false);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        assertEq(manager.getLiquidation(taskId).cashUsed, 0.05 ether, "policy caps do not apply");
    }

    // =====================================================================
    // fact of default != actual loss (review r2 #5)
    // =====================================================================

    /// §4.5 清单项：清算足额回收仍记 Defaulted、不计正常还款（r2 #5）
    function test_Liquidation_FullRecoveryStillRecordsDefault() public {
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
        _depositCash(agentId, agentOwner, 1 ether); // more than enough

        uint256 repaymentsBefore = manager.repaymentCount(agentId);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        assertEq(manager.getLiquidation(taskId).lpLoss, 0, "loss is zero");
        assertLoanStatus(
            taskId, ICreditManager.LoanStatus.Defaulted, "terminal state stays Defaulted even at zero loss"
        );
        assertEq(manager.repaymentCount(agentId), repaymentsBefore, "NOT counted as a repayment");
        assertEq(manager.defaultCount(agentId), 1, "counted as a default");
        assertTrue(manager.protocolFrozen(agentId), "entering liquidation freezes the agent");
        assertEq(_feedbackCount(agentId, "default"), 1, "default reputation written");
        assertEq(_feedbackCount(agentId, "repayment"), 0, "no repayment reputation");
    }

    /// The protocol freeze from a liquidation must survive the owner rewriting
    /// its own Policy (§4.5: "owner ").
    function test_Liquidation_ProtocolFreezeSurvivesOwnerPolicyRewrite() public {
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
        escrow.settle(taskId, false);
        assertTrue(manager.protocolFrozen(agentId), "frozen by the protocol");

        _setPermissivePolicy(agentId, agentOwner); // ownerFrozen = false
        assertTrue(manager.protocolFrozen(agentId), "owner cannot clear the protocol freeze");
    }

    // =====================================================================
    // push vs pull entry points (review r4 #3/#4)
    // =====================================================================

    /// §4.5 清单项：liquidateWithEscrow 仅 TaskEscrow 可调
    function test_RevertWhen_LiquidateWithEscrowCalledByStranger() public {
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
        manager.liquidateWithEscrow{value: _val(1 ether)}(taskId, poster);
    }

    /// §4.5 清单项：pull 型任何人可调
    function test_LiquidateExpiredLoan_IsPermissionless() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 loanDueAt = block.timestamp + 1 hours;
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, loanDueAt, keccak256("p1")
        );

        vm.warp(loanDueAt + GRACE + 1);

        vm.prank(stranger); // a total outsider
        manager.liquidateExpiredLoan(taskId);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "anybody can trigger it");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "releaseForLiquidation ends the task");
    }

    /// Not liquidatable before `loanDueAt + GRACE` while the task deadline is
    /// still in the future.
    function test_RevertWhen_LiquidateExpiredLoanTooEarly() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 loanDueAt = block.timestamp + 1 hours;
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, loanDueAt, keccak256("p1")
        );

        vm.warp(loanDueAt + GRACE); // exactly at the boundary — NOT yet past it
        uint256 deadline = escrow.getTask(taskId).deadline;

        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.LoanNotLiquidatable.selector, taskId, loanDueAt, deadline)
        );
        manager.liquidateExpiredLoan(taskId);
    }

    /// §4.5 清单项：任务到期而贷款未到期 —— liquidateExpiredLoan 可执行（r4 #3）
    /// The underwriter guarantees `loanDueAt <= task.deadline`, so the only
    /// reachable edge is: past the task deadline, still inside the loan's GRACE.
    function test_LiquidateExpiredLoan_TaskExpiredButLoanStillInGrace() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);

        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 deadline = escrow.getTask(taskId).deadline;
        uint256 loanDueAt = deadline; // the underwriter's upper bound
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, loanDueAt, keccak256("p1")
        );

        vm.warp(deadline + 1);
        assertTrue(block.timestamp <= loanDueAt + GRACE, "loan itself is still within GRACE");

        manager.liquidateExpiredLoan(taskId);

        assertLoanStatus(
            taskId,
            ICreditManager.LoanStatus.Defaulted,
            "task expiry is an independent liquidation cause (r4 #3)"
        );
    }

    /// §4.5 清单项：超时 liquidate 终结任务并退剩余 escrow，不等迟到 settle（r2 #5）
    function test_LiquidateExpiredLoan_TerminatesTaskAndRefundsResidualEscrow() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 loanDueAt = block.timestamp + 1 hours;
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, loanDueAt, keccak256("p1")
        );

        uint256 posterBefore = _balanceOf(poster);
        vm.warp(loanDueAt + GRACE + 1);
        manager.liquidateExpiredLoan(taskId);

        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "task is terminated by liquidation");
        assertEq(escrow.getTask(taskId).escrowBalance, 0, "escrow drained from the task");
        assertEq(
            _balanceOf(poster) - posterBefore,
            DEMO_REWARD - 0.092 ether,
            "residual escrow refunded immediately, without waiting for a late settle"
        );
    }

    /// §4.5 清单项：被终结后 settle revert
    function test_RevertWhen_SettleAfterLiquidation() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 loanDueAt = block.timestamp + 1 hours;
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, loanDueAt, keccak256("p1")
        );

        vm.warp(loanDueAt + GRACE + 1);
        manager.liquidateExpiredLoan(taskId);

        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Failed
            )
        );
        escrow.settle(taskId, true); // a late PASS must NOT resurrect the task
    }

    /// §4.5 清单项：重复 liquidate
    function test_RevertWhen_LiquidateTwice() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 loanDueAt = block.timestamp + 1 hours;
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, loanDueAt, keccak256("p1")
        );

        vm.warp(loanDueAt + GRACE + 1);
        manager.liquidateExpiredLoan(taskId);

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.LoanNotActive.selector, taskId));
        manager.liquidateExpiredLoan(taskId);
    }

    /// A ClosedByRefund loan must never be liquidatable, no matter how overdue
    /// (review r4 #2). The companion case (expiry) lives in Refund.t.sol.
    function test_RevertWhen_LiquidateClosedByRefundLoan() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 loanDueAt = block.timestamp + 1 hours;
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, loanDueAt, keccak256("p1")
        );

        _approve(relayRefunder, address(manager), 0.08 ether);
        vm.prank(relayRefunder);
        manager.processRefund{value: _val(0.08 ether)}(keccak256("p1"), 0.08 ether, keccak256("refund-1"));
        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "full refund closes it");

        vm.warp(loanDueAt + GRACE + 1);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.LoanNotActive.selector, taskId));
        manager.liquidateExpiredLoan(taskId);
    }

    // =====================================================================
    // no deadlock (§4.6 anti-reentrancy design)
    // =====================================================================

    /// §4.5 清单项：失败路径 settle -> liquidate 全程不因重入锁死锁（r3 #1）
    /// Call chain: Escrow.settle → Manager.liquidateWithEscrow →
    ///             Account.debitForLiquidation → (value push back to Manager).
    /// Each contract guards its own entry point; the graph is acyclic, so the
    /// whole chain must complete in ONE transaction without a guard collision.
    function test_FailurePath_SettleToLiquidate_NoReentrancyDeadlock() public {
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
        _depositCash(agentId, agentOwner, 0.04 ether); // forces the cash layer to run

        vm.prank(verifier);
        escrow.settle(taskId, false);

        // If any guard had collided the call would have reverted, so simply
        // observing the terminal state proves the chain completed.
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "chain completed");
        assertEq(manager.getLiquidation(taskId).cashUsed, 0.04 ether, "cash layer ran inside settle");
        assertEq(escrow.getTask(taskId).escrowBalance, 0, "escrow was zeroed BEFORE the push");
    }

    /// §4.5 清单项：expireTask 有 loan 走 push 路径，全程无重入死锁
    function test_ExpireTask_WithActiveLoan_PushPath_NoDeadlock() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 2 hours);
        _acceptTask(taskId, agentId, agentWallet);
        uint256 deadline = escrow.getTask(taskId).deadline;
        _drawWithLoanDue(
            agentId, taskId, 0.08 ether, 0.08 ether, TIER_C_FEE_BPS, TIER_C, deadline, keccak256("p1")
        );
        _depositCash(agentId, agentOwner, 0.02 ether);

        uint256 posterBefore = _balanceOf(poster);
        vm.warp(deadline + 1);

        vm.prank(stranger); // expireTask is permissionless
        escrow.expireTask(taskId);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "push path completed");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "task terminated first");
        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.cashUsed, 0.02 ether, "cash layer still runs first on the expiry path");
        assertEq(r.escrowSlashed, 0.072 ether, "escrow only covers the shortfall");
        assertEq(_balanceOf(poster) - posterBefore, DEMO_REWARD - 0.072 ether, "residual back to poster");
    }

    /// `releaseForLiquidation` is the pull-side escrow tap and must be closed to
    /// everyone but the CreditManager — otherwise anyone could drain an escrow.
    function test_RevertWhen_ReleaseForLiquidationCalledByStranger() public {
        uint256 taskId = _createTask(poster, DEMO_REWARD);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NotCreditManager.selector, stranger));
        escrow.releaseForLiquidation(taskId);
    }
}

/// @notice Deliberately over-levered deployment (MAX_LTV_BPS = 20_000).
/// @dev SPEC FINDING F6: with the I6 bound at MAX_LTV_BPS <= 10_000 the escrow
///      alone always covers the whole debt, so waterfall layers 3 (backstop) and
///      4 (LP loss) can never execute on a task loan. They are nonetheless part
///      of §4.2, so they are pinned down here under a configuration that can
///      actually reach them.
contract LiquidationOverLeveredTest is InferCreditTestBase {
    function _maxLtvBps() internal pure override returns (uint16) {
        return 20_000;
    }

    /// debt 0.092 | cash 0.01 | escrow 0.05 | backstop 0.02
    ///   layer 1 cash     → 0.01
    ///   layer 2 escrow   → 0.05  (all of it, still short)
    ///   layer 3 backstop → 0.02
    ///   layer 4 LP loss  → 0.012
    function test_Liquidation_AllFourLayers() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _fundBackstop(agentId, agentOwner, 0.02 ether);

        uint256 taskId = _createTask(poster, 0.05 ether);
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
        _depositCash(agentId, agentOwner, 0.01 ether);

        uint256 posterBefore = _balanceOf(poster);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.cashUsed, 0.01 ether, "layer 1");
        assertEq(r.escrowSlashed, 0.05 ether, "layer 2: the whole escrow, capped at the debt");
        assertEq(r.backstopUsed, 0.02 ether, "layer 3");
        assertEq(r.lpLoss, 0.012 ether, "layer 4: remainder is the LP loss");
        assertEq(_balanceOf(poster), posterBefore, "nothing left over for the poster");
        assertEq(manager.backstop(agentId), 0, "backstop pot consumed");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "Defaulted");
        assertEq(manager.vaultBalance(), VAULT_SEED, "only actual recovery enters the vault");
        assertEq(_balanceOf(address(manager)), VAULT_SEED, "physical assets agree after backstop consumption");
        assertEq(manager.backstopTotal(), 0);
        assertEq(manager.totalOutstanding(), 0);
        assertEq(_balanceOf(address(account)), 0);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(_balanceOf(address(escrow)), 0);
        assertTrue(account.protocolFrozen(agentId), "protocol freeze is mirrored");
    }

    /// The escrow layer is capped at the REMAINING debt, never at the whole
    /// debt — otherwise the cash layer would be double-counted.
    function test_Liquidation_EscrowLayerCappedByRemainingDebt() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);

        uint256 taskId = _createTask(poster, 0.2 ether);
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
        _depositCash(agentId, agentOwner, 0.06 ether);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.cashUsed + r.escrowSlashed, 0.092 ether, "layers sum to exactly the debt");
        assertEq(r.escrowSlashed, 0.032 ether, "0.092 - 0.06, not 0.092");
    }
}
