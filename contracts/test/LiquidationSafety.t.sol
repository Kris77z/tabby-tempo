// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {LiquidationTest, LiquidationOverLeveredTest} from "./Liquidation.t.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {SafeTransferLib} from "../src/utils/SafeTransferLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {RejectingProvider} from "./mocks/MaliciousActors.sol";

/// @notice Default retries and failed liquidation distributions. The existing
///         production and above-100%-LTV specifications are paired below.
contract LiquidationSafetyTest is InferCreditTestBase {
    function test_TaskDeadlineRemainsAnIndependentExitWhenSignedDueIsUintMax() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, 0);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.08 ether,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            type(uint256).max,
            keccak256("max-due")
        );
        uint256 deadline = escrow.getTask(taskId).deadline;
        vm.warp(deadline);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICreditManager.LoanNotLiquidatable.selector, taskId, type(uint256).max, deadline
            )
        );
        manager.liquidateExpiredLoan(taskId);
        vm.warp(deadline + 1);
        uint256 assetsBefore = _balanceOf(address(manager));
        uint256 posterBefore = _balanceOf(poster);
        vm.prank(stranger);
        manager.liquidateExpiredLoan(taskId);
        assertTaskStatus(
            taskId, ITaskEscrow.TaskStatus.Failed, "task deadline is independent of the loan clock"
        );
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "signed due cannot prevent default");
        assertEq(manager.totalOutstanding(), 0);
        assertEq(manager.defaultCount(agentId), 1);
        assertEq(_balanceOf(address(manager)), assetsBefore + 0.092 ether);
        assertEq(_balanceOf(poster), posterBefore + 0.058 ether);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(_balanceOf(address(escrow)), 0);
    }

    function _liquidateVia(uint256 taskId, uint256 route) private {
        if (route == 0) {
            vm.prank(verifier);
            escrow.settle{gas: 1_200_000}(taskId, false);
        } else if (route == 1) {
            vm.warp(escrow.getTask(taskId).deadline + 1);
            vm.prank(stranger);
            escrow.expireTask{gas: 1_200_000}(taskId);
        } else {
            vm.warp(manager.getLoan(taskId).loanDueAt + GRACE + 1);
            vm.prank(stranger);
            manager.liquidateExpiredLoan{gas: 1_200_000}(taskId);
        }
    }

    function test_DefaultFeedbackRetryWorksForBothPushRoutesAndPullWithoutDuplicates() public {
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NoPendingDefaultFeedback.selector, 777));
        manager.retryDefaultFeedback(777);
        for (uint256 route; route < 3; route++) {
            Scenario memory s = _openLoan(DEMO_REWARD, 0, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
            uint256 vaultBefore = manager.vaultBalance();
            uint256 assetsBefore = _balanceOf(address(manager));
            uint256 posterBefore = _balanceOf(poster);
            if (route == 2) reputation.cheatSetOutOfGas(true);
            else reputation.cheatSetFailing(true);
            _liquidateVia(s.taskId, route);
            assertLoanStatus(
                s.taskId, ICreditManager.LoanStatus.Defaulted, "feedback failure cannot block default"
            );
            assertTaskStatus(s.taskId, ITaskEscrow.TaskStatus.Failed, "task remains terminated");
            assertEq(manager.vaultBalance(), vaultBefore + 0.092 ether);
            assertEq(_balanceOf(address(manager)), assetsBefore + 0.092 ether);
            assertEq(_balanceOf(poster), posterBefore + 0.058 ether);
            assertEq(manager.defaultCount(s.agentId), 1);
            assertEq(manager.repaymentCount(s.agentId), 0);
            assertTrue(manager.protocolFrozen(s.agentId));
            assertTrue(account.protocolFrozen(s.agentId));
            assertTrue(manager.pendingDefaultFeedback(s.taskId));
            assertTrue(escrow.pendingFeedback(s.taskId, FB_DEFAULT));
            assertFalse(manager.defaultFeedbackSent(s.taskId));
            assertFalse(escrow.feedbackSent(s.taskId, FB_DEFAULT));
            assertEq(_feedbackCount(s.agentId, "default"), 0);
            bytes memory original = abi.encode(manager.getLiquidation(s.taskId));

            vm.prank(stranger);
            assertFalse(
                manager.retryDefaultFeedback{gas: 700_000}(s.taskId), "a failing retry remains pending"
            );
            assertTrue(escrow.pendingFeedback(s.taskId, FB_DEFAULT));
            reputation.cheatSetFailing(false);
            reputation.cheatSetOutOfGas(false);
            vm.prank(stranger);
            escrow.retryFeedback(s.taskId, FB_DEFAULT);
            assertTrue(escrow.feedbackSent(s.taskId, FB_DEFAULT));
            assertFalse(escrow.pendingFeedback(s.taskId, FB_DEFAULT));
            assertEq(_feedbackCount(s.agentId, "default"), 1, "adapter sent one default entry");
            assertEq(_feedbackCount(s.agentId, "repayment"), 0);
            assertEq(manager.defaultCount(s.agentId), 1, "retries never recount default");
            assertEq(
                abi.encode(manager.getLiquidation(s.taskId)), original, "original burden remains immutable"
            );
            vm.expectRevert(
                abi.encodeWithSelector(ITaskEscrow.NoPendingFeedback.selector, s.taskId, FB_DEFAULT)
            );
            escrow.retryFeedback(s.taskId, FB_DEFAULT);
            vm.expectRevert(
                abi.encodeWithSelector(ICreditManager.NoPendingDefaultFeedback.selector, s.taskId)
            );
            manager.retryDefaultFeedback(s.taskId);
            assertEq(_feedbackCount(s.agentId, "default"), 1);
        }
    }

    function test_PosterTransferFailureRollsBackCashEscrowLoanFreezeAndRetryState() public {
        _setProtocolFee(1_000); // Failed tasks never charge the snapshotted fee.
        Scenario memory s = _openLoan(DEMO_REWARD, 0, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        _depositCash(s.agentId, agentOwner, 0.03 ether);
        _fundBackstop(s.agentId, agentOwner, 0.02 ether);
        uint256 otherTask = _createTask(poster2, 0.07 ether);
        uint256 vaultBefore = manager.vaultBalance();
        uint256 managerBefore = _balanceOf(address(manager));
        uint256 posterBefore = _balanceOf(poster);
        if (_useErc20()) token.cheatSetBlocked(poster, true);
        else vm.etch(poster, address(new RejectingProvider()).code);

        for (uint256 route; route < 3; route++) {
            if (route == 1) vm.warp(escrow.getTask(s.taskId).deadline + 1);
            if (route == 2) vm.warp(manager.getLoan(s.taskId).loanDueAt + GRACE + 1);
            if (_useErc20()) {
                vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, poster));
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(SafeTransferLib.NativeTransferFailed.selector, poster, 0.088 ether)
                );
            }
            if (route == 0) {
                vm.prank(verifier);
                escrow.settle(s.taskId, false);
            } else if (route == 1) {
                vm.prank(stranger);
                escrow.expireTask(s.taskId);
            } else {
                vm.prank(stranger);
                manager.liquidateExpiredLoan(s.taskId);
            }
            assertTaskStatus(s.taskId, ITaskEscrow.TaskStatus.Assigned, "task termination rolled back");
            assertEq(escrow.getTask(s.taskId).escrowBalance, DEMO_REWARD);
            assertEq(escrow.getTask(otherTask).escrowBalance, 0.07 ether);
            assertEq(escrow.totalEscrowed(), 0.22 ether);
            assertEq(_balanceOf(address(escrow)), 0.22 ether);
            assertEq(account.cash(s.agentId), 0.03 ether);
            assertEq(_balanceOf(address(account)), 0.03 ether);
            assertEq(manager.getLoan(s.taskId).principal, 0.08 ether);
            assertEq(manager.getLoan(s.taskId).fee, 0.012 ether);
            assertLoanStatus(s.taskId, ICreditManager.LoanStatus.Active, "loan remains retryable");
            assertEq(manager.totalOutstanding(), 0.092 ether);
            assertEq(manager.defaultCount(s.agentId), 0);
            assertEq(manager.vaultBalance(), vaultBefore);
            assertEq(_balanceOf(address(manager)), managerBefore);
            assertEq(manager.backstop(s.agentId), 0.02 ether);
            assertEq(manager.backstopTotal(), 0.02 ether);
            assertEq(_balanceOf(poster), posterBefore);
            assertFalse(manager.protocolFrozen(s.agentId));
            assertFalse(account.protocolFrozen(s.agentId));
            assertEq(manager.getLiquidation(s.taskId).poster, address(0));
            assertEq(manager.getRecovered(s.taskId).poster, address(0));
            assertFalse(escrow.pendingFeedback(s.taskId, FB_DEFAULT));
            assertFalse(escrow.feedbackSent(s.taskId, FB_DEFAULT));
            assertEq(reputation.entryCount(), 0);
            if (_useErc20()) assertEq(token.allowance(address(escrow), address(manager)), 0);
        }
        if (_useErc20()) token.cheatSetBlocked(poster, false);
        else vm.etch(poster, bytes(""));
        manager.liquidateExpiredLoan(s.taskId);
        assertLoanStatus(
            s.taskId, ICreditManager.LoanStatus.Defaulted, "the same task can retry successfully"
        );
        assertEq(manager.vaultBalance(), vaultBefore + 0.092 ether);
        assertEq(_balanceOf(address(manager)), managerBefore + 0.092 ether);
        assertEq(_balanceOf(poster), posterBefore + 0.088 ether);
        assertEq(manager.backstop(s.agentId), 0.02 ether);
        assertEq(_balanceOf(feeRecipient), 0);
        assertEq(escrow.totalEscrowed(), 0.07 ether);
        assertEq(_balanceOf(address(escrow)), 0.07 ether);
        assertEq(_feedbackCount(s.agentId, "default"), 1);
    }
}

contract Erc20LiquidationSafetyTest is LiquidationSafetyTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }

    function test_NoReturnTokenLiquidatesAndConsumesOnlyTheTaskAllowance() public {
        Scenario memory s = _openLoan(DEMO_REWARD, 0, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        _depositCash(s.agentId, agentOwner, 0.03 ether);
        _approve(address(escrow), address(manager), DEMO_REWARD);
        vm.deal(address(escrow), 1 wei);
        vm.prank(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.ValueMismatch.selector, 0, 1));
        manager.liquidateWithEscrow{value: 1 wei}(s.taskId, poster);
        assertLoanStatus(s.taskId, ICreditManager.LoanStatus.Active, "wrong settlement mode cannot liquidate");
        assertEq(token.balanceOf(address(escrow)), DEMO_REWARD);
        assertEq(token.allowance(address(escrow), address(manager)), DEMO_REWARD);
        token.cheatSetReturnsNothing(true);
        token.cheatSetApprovalReturnsNothing(true);
        vm.prank(verifier);
        escrow.settle(s.taskId, false);
        assertEq(token.allowance(address(escrow), address(manager)), 0);
        assertEq(manager.getLiquidation(s.taskId).cashUsed, 0.03 ether);
        assertEq(manager.getLiquidation(s.taskId).escrowSlashed, 0.062 ether);
        assertEq(token.balanceOf(address(manager)), manager.vaultBalance());
        assertEq(token.balanceOf(address(account)), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(manager.defaultCount(s.agentId), 1);
    }
}

contract Erc20LiquidationTest is LiquidationTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}

contract Erc20LiquidationOverLeveredTest is LiquidationOverLeveredTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}
