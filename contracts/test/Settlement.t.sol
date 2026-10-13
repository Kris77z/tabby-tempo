// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {FeedbackTest} from "./Feedback.t.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";
import {SafeTransferLib} from "../src/utils/SafeTransferLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {RejectingProvider} from "./mocks/MaliciousActors.sol";

/// @notice Missing settlement boundaries, with real assets in both modes.
contract SettlementTest is InferCreditTestBase {
    function test_ClosedByRefundRoutesSuccessAndFailureWithoutRepayment() public {
        _setProtocolFee(1_000);
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        uint256 passedTask = _createTask(poster, 1 ether);
        uint256 failedTask = _createTask(poster, 1 ether);
        _acceptTask(passedTask, agentId, agentWallet);
        _acceptTask(failedTask, agentId, agentWallet);
        uint256 posterBefore = _balanceOf(poster);
        // Refund processing belongs to the next batch. Only the incoming loan
        // status is supplied here; all task transitions and transfers are real.
        ICreditManager.TaskLoan memory closed =
            ICreditManager.TaskLoan(agentId, 0, 0, block.timestamp, ICreditManager.LoanStatus.ClosedByRefund);
        vm.mockCall(address(manager), abi.encodeCall(manager.getLoan, (passedTask)), abi.encode(closed));
        vm.mockCall(address(manager), abi.encodeCall(manager.getLoan, (failedTask)), abi.encode(closed));
        vm.startPrank(verifier);
        escrow.settle(passedTask, true);
        escrow.settle(failedTask, false);
        vm.stopPrank();
        assertTaskStatus(passedTask, ITaskEscrow.TaskStatus.Settled, "closed-loan success");
        assertTaskStatus(failedTask, ITaskEscrow.TaskStatus.Failed, "closed-loan failure");
        assertLoanStatus(passedTask, ICreditManager.LoanStatus.ClosedByRefund, "no fabricated repayment");
        assertEq(_balanceOf(poster) - posterBefore, 1 ether);
        assertEq(account.cash(agentId), 0.9 ether);
        assertEq(_balanceOf(address(account)), 0.9 ether);
        assertEq(_balanceOf(feeRecipient), 0.1 ether);
        assertEq(manager.vaultBalance(), 0);
        assertEq(_balanceOf(address(manager)), 0);
        assertEq(manager.repaymentCount(agentId), 0);
        assertEq(manager.defaultCount(agentId), 0);
        assertEq(_feedbackCount(agentId, "task-success"), 1);
        assertEq(_feedbackCount(agentId, "repayment"), 0);
        assertFalse(escrow.pendingFeedback(failedTask, FB_TASK_SUCCESS));
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(_balanceOf(address(escrow)), 0);
        vm.clearMockedCalls();
    }

    function test_SettlementTransferFailureRestoresEveryEarlierLegAndCanRetry() public {
        _setProtocolFee(1_000);
        Scenario memory s = _openLoan(1 ether, 0, 0.5 ether, TIER_B_FEE_BPS, TIER_B);
        _fundBackstop(s.agentId, agentOwner, 0.03 ether);
        uint256 otherTask = _createTask(poster2, 0.02 ether);
        uint256 managerBefore = _balanceOf(address(manager));
        uint256 vaultBefore = manager.vaultBalance();
        uint256 stages = _useErc20() ? 3 : 1;
        for (uint256 i; i < stages; i++) {
            address blocked = i == 0 ? feeRecipient : i == 1 ? address(manager) : address(account);
            if (_useErc20()) token.cheatSetBlocked(blocked, true);
            else vm.etch(blocked, address(new RejectingProvider()).code);
            vm.prank(verifier);
            if (_useErc20()) {
                vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, blocked));
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(SafeTransferLib.NativeTransferFailed.selector, blocked, 0.1 ether)
                );
            }
            escrow.settle(s.taskId, true);
            assertTaskStatus(s.taskId, ITaskEscrow.TaskStatus.Assigned, "failed distribution rolls back task");
            assertEq(escrow.getTask(s.taskId).escrowBalance, 1 ether);
            assertEq(escrow.totalEscrowed(), 1.02 ether);
            assertEq(_balanceOf(address(escrow)), 1.02 ether);
            assertEq(escrow.getTask(otherTask).escrowBalance, 0.02 ether);
            assertLoanStatus(s.taskId, ICreditManager.LoanStatus.Active, "repay is also rolled back");
            assertEq(manager.getLoan(s.taskId).principal, 0.5 ether);
            assertEq(manager.getLoan(s.taskId).fee, 0.04 ether);
            assertEq(manager.totalOutstanding(), 0.54 ether);
            assertEq(manager.repaymentCount(s.agentId), 0);
            assertEq(manager.vaultBalance(), vaultBefore);
            assertEq(_balanceOf(address(manager)), managerBefore);
            assertEq(manager.backstop(s.agentId), 0.03 ether);
            assertEq(manager.backstopTotal(), 0.03 ether);
            assertEq(account.cash(s.agentId), 0);
            assertEq(_balanceOf(address(account)), 0);
            assertEq(_balanceOf(feeRecipient), 0);
            assertEq(reputation.entryCount(), 0);
            assertFalse(escrow.feedbackSent(s.taskId, FB_TASK_SUCCESS));
            assertFalse(escrow.pendingFeedback(s.taskId, FB_REPAYMENT));
            if (_useErc20()) {
                assertEq(token.allowance(address(escrow), address(manager)), 0);
                assertEq(token.allowance(address(escrow), address(account)), 0);
                token.cheatSetBlocked(blocked, false);
            } else {
                vm.etch(blocked, bytes(""));
            }
        }
        vm.prank(verifier);
        escrow.settle(s.taskId, true);
        assertEq(manager.vaultBalance(), vaultBefore + 0.54 ether);
        assertEq(_balanceOf(address(manager)), managerBefore + 0.54 ether);
        assertEq(account.cash(s.agentId), 0.36 ether);
        assertEq(_balanceOf(address(account)), 0.36 ether);
        assertEq(_balanceOf(feeRecipient), 0.1 ether);
        assertEq(manager.backstop(s.agentId), 0.03 ether, "successful tasks do not refill backstop");
        assertEq(escrow.totalEscrowed(), 0.02 ether);
        assertEq(_balanceOf(address(escrow)), 0.02 ether);
        assertEq(manager.repaymentCount(s.agentId), 1);
        assertEq(_feedbackCount(s.agentId, "repayment"), 1);
    }

    function test_ProtocolCashCreditRequiresActualFundsAndIgnoresSpendFreezes() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        _setPolicy(agentId, agentOwner, 0, 0, 0, true);
        vm.prank(guardian);
        manager.freezeAgent(agentId);
        _fund(address(manager), 0.3 ether);
        _fund(address(escrow), 0.3 ether);
        address[2] memory callers = [address(manager), address(escrow)];
        for (uint256 i; i < callers.length; i++) {
            _approve(callers[i], address(account), 0.3 ether);
            vm.prank(callers[i]);
            vm.expectRevert(IAgentAccount.ZeroAmount.selector);
            account.creditCash(agentId, 0);
            uint256 wrongValue = _useErc20() ? 1 : 0;
            if (_useErc20()) vm.deal(callers[i], 1 wei);
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAgentAccount.ValueMismatch.selector, _val(0.3 ether), wrongValue)
            );
            account.creditCash{value: wrongValue}(agentId, 0.3 ether);
            assertEq(account.cash(agentId), i * 0.3 ether);
            vm.prank(callers[i]);
            account.creditCash{value: _val(0.3 ether)}(agentId, 0.3 ether);
            assertEq(_balanceOf(callers[i]), 0);
        }
        assertEq(account.cash(agentId), 0.6 ether);
        assertEq(_balanceOf(address(account)), 0.6 ether);
        assertTrue(account.protocolFrozen(agentId));
        assertTrue(account.getPolicy(agentId).ownerFrozen);
    }

    function test_RetryCannotForgeResultsForUnknownOpenAssignedOrFailedTasks() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        for (uint8 feedbackType = FB_TASK_SUCCESS; feedbackType <= FB_DEFAULT; feedbackType++) {
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NoPendingFeedback.selector, 777, feedbackType));
            escrow.retryFeedback(777, feedbackType);
            vm.prank(stranger);
            vm.expectRevert(
                abi.encodeWithSelector(ITaskEscrow.NoPendingFeedback.selector, taskId, feedbackType)
            );
            escrow.retryFeedback(taskId, feedbackType);
        }
        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Open
            )
        );
        escrow.settle(taskId, true);
        _acceptTask(taskId, agentId, agentWallet);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NoPendingFeedback.selector, taskId, FB_REPAYMENT));
        escrow.retryFeedback(taskId, FB_REPAYMENT);
        vm.prank(verifier);
        escrow.settle(taskId, false);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NoPendingFeedback.selector, taskId, FB_DEFAULT));
        escrow.retryFeedback(taskId, FB_DEFAULT);
        assertEq(reputation.entryCount(), 0);
        assertEq(manager.repaymentCount(agentId), 0);
        assertEq(manager.defaultCount(agentId), 0);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(_balanceOf(address(escrow)), 0);
    }
}

contract Erc20SettlementTest is SettlementTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }

    function test_NoReturnApprovalsAndTransfersSettleWithNoRemainingAllowance() public {
        Scenario memory s = _openLoan(DEMO_REWARD, DEMO_SEED_CASH, DEMO_QUOTE, TIER_C_FEE_BPS, TIER_C);
        token.cheatSetReturnsNothing(true);
        token.cheatSetApprovalReturnsNothing(true);
        vm.prank(verifier);
        escrow.settle(s.taskId, true);
        assertLoanStatus(s.taskId, ICreditManager.LoanStatus.Repaid, "nonstandard tokens really settle");
        assertEq(manager.vaultBalance(), VAULT_SEED + 0.012 ether);
        assertEq(token.balanceOf(address(manager)), manager.vaultBalance());
        assertEq(account.cash(s.agentId), DEMO_RESIDUE_1);
        assertEq(token.balanceOf(address(account)), DEMO_RESIDUE_1);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.allowance(address(escrow), address(manager)), 0);
        assertEq(token.allowance(address(escrow), address(account)), 0);
    }
}

contract Erc20FeedbackTest is FeedbackTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}

/// @notice An above-100% LTV test deployment makes this success-path safety
///         check reachable without changing a production task or loan record.
contract UnderfundedSettlementTest is InferCreditTestBase {
    function _maxLtvBps() internal pure override returns (uint16) {
        return 20_000;
    }

    function test_UnderfundedSuccessRejectsWithoutSettledTaskOrPartialDebt() public {
        _setProtocolFee(1_000);
        Scenario memory s = _openLoan(1 ether, 0, 1 ether, TIER_C_FEE_BPS, TIER_C);
        _createTask(poster2, 1 ether); // Other posters' funds cannot cover it.
        uint256 vaultBefore = manager.vaultBalance();
        uint256 assetsBefore = _balanceOf(address(manager));
        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(TaskEscrow.InsufficientEscrow.selector, s.taskId, 1.15 ether, 0.9 ether)
        );
        escrow.settle(s.taskId, true);
        assertTaskStatus(s.taskId, ITaskEscrow.TaskStatus.Assigned, "underfunded task remains unsettled");
        assertLoanStatus(s.taskId, ICreditManager.LoanStatus.Active, "no partial success state");
        assertEq(manager.totalOutstanding(), 1.15 ether);
        assertEq(manager.vaultBalance(), vaultBefore);
        assertEq(_balanceOf(address(manager)), assetsBefore);
        assertEq(manager.repaymentCount(s.agentId), 0);
        assertEq(escrow.totalEscrowed(), 2 ether);
        assertEq(_balanceOf(address(escrow)), 2 ether);
        assertEq(_balanceOf(feeRecipient), 0);
        assertEq(account.cash(s.agentId), 0);
        assertEq(reputation.entryCount(), 0);
    }
}

contract Erc20UnderfundedSettlementTest is UnderfundedSettlementTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}
