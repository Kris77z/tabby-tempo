// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {
    IAgentAccount,
    REASON_INVALID_AUTH,
    REASON_FROZEN,
    REASON_OVER_LIMIT,
    REASON_NOT_WHITELISTED
} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Adds only batch-two gaps: no-task cash accounting, exact deadline
///         boundaries, total escrow conservation and ClosedByRefund routing.
contract CashLifecycleTest is InferCreditTestBase {
    function test_CashPaymentNeedsNoEnrollmentOrTaskAndNeverBorrowsImplicitly() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        _setPolicy(agentId, agentOwner, 0.2 ether, 0, 0, false);
        _depositCash(agentId, agentOwner, 0.3 ether);
        vm.prank(guardian);
        manager.setDrawPaused(true);

        // Credit context is irrelevant when cash covers the payment, including
        // an unrelated agent/task and an invalid signature.
        ICreditManager.CreditAuthorization memory unrelated = _emptyAuth();
        unrelated.agentId = agentId + 999;
        unrelated.taskId = 999;
        unrelated.nonce = 42;
        bytes32 paymentId = bytes32(0);
        _payProvider(agentId, 0.2 ether, paymentId, unrelated, hex"dead", agentWallet);
        IAgentAccount.PaymentRecord memory paid = account.getPayment(paymentId);
        assertEq(paid.agentId, agentId);
        assertEq(paid.taskId, 0);
        assertEq(paid.fromCash, 0.2 ether);
        assertEq(paid.fromCredit, 0);
        assertEq(paid.refundedAmount, 0);
        assertEq(account.cash(agentId), 0.1 ether);
        assertEq(_balanceOf(address(account)), 0.1 ether);
        assertEq(_balanceOf(provider), 0.2 ether);
        assertEq(adapter.snapshotVersion(agentId), 0, "cash needs no underwriting enrollment");
        assertEq(manager.totalOutstanding(), 0);
        assertEq(manager.drawnInEpoch(block.timestamp / EPOCH_LENGTH), 0);
        assertEq(account.debtSpentInDay(agentId, block.timestamp / 1 days), 0);
        assertFalse(manager.usedNonces(unrelated.agentId, unrelated.nonce));

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, provider, REASON_INVALID_AUTH
            )
        );
        account.payProvider(agentId, provider, 0.2 ether, keccak256("no-context"), _emptyAuth(), bytes(""));
        assertEq(account.cash(agentId), 0.1 ether);
        assertEq(_balanceOf(address(account)), 0.1 ether);
        assertEq(_balanceOf(provider), 0.2 ether);
        assertEq(account.getPayment(keccak256("no-context")).fromCash, 0);

        uint256 otherId = _registerAgent(otherAgentOwner, otherAgentWallet);
        _setPolicy(otherId, otherAgentOwner, 0.2 ether, 0, 0, false);
        _depositCash(otherId, otherAgentOwner, 0.2 ether);
        vm.prank(otherAgentWallet);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.PaymentIdAlreadyUsed.selector, paymentId));
        account.payProvider(otherId, provider, 0.2 ether, paymentId, _emptyAuth(), bytes(""));
        assertEq(account.cash(otherId), 0.2 ether, "payment identifiers are global");
        assertEq(account.getPayment(paymentId).agentId, agentId);
    }

    function test_TaskDeadlineEqualityAndUnknownTaskChecks() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        uint256 nowTs = block.timestamp;
        vm.prank(poster);
        vm.expectRevert(ITaskEscrow.ZeroReward.selector);
        escrow.createTask(0, nowTs + 1 hours);
        _approve(poster, address(escrow), DEMO_REWARD);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.DeadlineInPast.selector, nowTs));
        escrow.createTask{value: _val(DEMO_REWARD)}(DEMO_REWARD, nowTs);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.TaskNotFound.selector, 777));
        escrow.acceptTask(777, agentId);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.TaskNotFound.selector, 777));
        escrow.cancelTask(777);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.TaskNotFound.selector, 777));
        escrow.expireTask(777);
        assertEq(escrow.nextTaskId(), 1, "failed creation consumes no identifier");

        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        uint256 deadline = escrow.getTask(taskId).deadline;
        vm.warp(deadline);
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.DeadlineNotReached.selector, taskId, deadline));
        escrow.acceptTask(taskId, agentId);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.DeadlineNotReached.selector, taskId, deadline));
        escrow.expireTask(taskId);
        assertEq(escrow.totalEscrowed(), DEMO_REWARD);
        vm.warp(deadline + 1);
        escrow.expireTask(taskId);
        assertEq(escrow.totalEscrowed(), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITaskEscrow.InvalidTaskStatus.selector, taskId, ITaskEscrow.TaskStatus.Failed
            )
        );
        escrow.expireTask(taskId);
    }

    function test_CancelAndClosedByRefundExpiryConserveAllEscrowWithoutFees() public {
        _setProtocolFee(5_000);
        uint256 posterBefore = _balanceOf(poster);
        uint256 openTask = _createTask(poster, 0.15 ether, 1 hours);
        uint256 closedTask = _createTask(poster, 0.2 ether, 1 hours);
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        _acceptTask(closedTask, agentId, agentWallet);
        assertEq(escrow.totalEscrowed(), 0.35 ether);
        assertEq(_balanceOf(address(escrow)), 0.35 ether);

        vm.prank(poster);
        escrow.cancelTask(openTask);
        assertEq(escrow.totalEscrowed(), 0.2 ether);
        assertEq(_balanceOf(address(escrow)), 0.2 ether);
        assertEq(escrow.getTask(openTask).reward, 0.15 ether, "original reward survives refund");

        // Refund business is implemented later. Supply only its terminal loan
        // status here to independently verify the promised no-debt exit.
        ICreditManager.TaskLoan memory closed =
            ICreditManager.TaskLoan(agentId, 0, 0, block.timestamp, ICreditManager.LoanStatus.ClosedByRefund);
        vm.mockCall(address(manager), abi.encodeCall(manager.getLoan, (closedTask)), abi.encode(closed));
        vm.warp(escrow.getTask(closedTask).deadline + 1);
        vm.prank(stranger);
        escrow.expireTask(closedTask);
        vm.clearMockedCalls();
        assertTaskStatus(closedTask, ITaskEscrow.TaskStatus.Failed, "closed loan expires without liquidation");
        assertEq(escrow.getTask(closedTask).escrowBalance, 0);
        assertEq(escrow.getTask(closedTask).reward, 0.2 ether);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(_balanceOf(address(escrow)), 0);
        assertEq(_balanceOf(poster), posterBefore, "cancel and expiry refund the full reward");
        assertEq(_balanceOf(feeRecipient), 0, "protocol fees apply to successful settlement only");
        assertEq(manager.getLiquidation(closedTask).poster, address(0));
    }
}

contract Erc20CashLifecycleTest is CashLifecycleTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }

    function test_ERC20CreationAndRefundFailuresRestoreTaskAccountingAndAssets() public {
        _approve(poster, address(escrow), DEMO_REWARD);
        uint256 posterBefore = token.balanceOf(poster);
        token.cheatSetBlocked(address(escrow), true);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, address(escrow)));
        escrow.createTask(DEMO_REWARD, block.timestamp + 1 hours);
        assertEq(escrow.nextTaskId(), 1);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(poster), posterBefore);
        assertEq(token.allowance(poster, address(escrow)), DEMO_REWARD);

        token.cheatSetBlocked(address(escrow), false);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 1 hours);
        token.cheatSetBlocked(poster, true);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, poster));
        escrow.cancelTask(taskId);
        vm.warp(escrow.getTask(taskId).deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, poster));
        escrow.expireTask(taskId);
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Open, "failed transfers cannot terminate a task");
        assertEq(escrow.getTask(taskId).escrowBalance, DEMO_REWARD);
        assertEq(escrow.totalEscrowed(), DEMO_REWARD);
        assertEq(token.balanceOf(address(escrow)), DEMO_REWARD);
        assertEq(token.balanceOf(poster), posterBefore - DEMO_REWARD);
        token.cheatSetBlocked(poster, false);
        escrow.expireTask(taskId);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(poster), posterBefore);
    }

    function test_ERC20CashGuardsUseLiveWalletAndBothFreezeBits() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 1 ether);
        _bindWallet(agentId, agentOwner, AGENT_WALLET2_PK, block.timestamp + 1 hours);
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentWallet.selector, agentId, agentWallet));
        account.payProvider(agentId, provider, 0.1 ether, bytes32(0), _emptyAuth(), bytes(""));
        _setPolicy(agentId, agentOwner, 1 ether, 0, 0, true);
        vm.prank(agentWallet2);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_FROZEN)
        );
        account.payProvider(agentId, provider, 0.1 ether, bytes32(0), _emptyAuth(), bytes(""));
        vm.prank(guardian);
        manager.freezeAgent(agentId);
        _setPolicy(agentId, agentOwner, 0.1 ether, 0, 0, false);
        vm.prank(agentWallet2);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_FROZEN)
        );
        account.payProvider(agentId, provider, 0.1 ether, bytes32(0), _emptyAuth(), bytes(""));
        vm.prank(guardian);
        manager.unfreezeAgent(agentId);
        vm.prank(agentWallet2);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        account.payProvider(agentId, provider, 0.2 ether, bytes32(0), _emptyAuth(), bytes(""));
        vm.prank(deployer);
        account.setProviderWhitelist(provider, false);
        vm.prank(agentWallet2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, provider, REASON_NOT_WHITELISTED
            )
        );
        account.payProvider(agentId, provider, 0.1 ether, bytes32(0), _emptyAuth(), bytes(""));
        assertEq(account.cash(agentId), 1 ether);
        assertEq(token.balanceOf(address(account)), 1 ether);
        assertEq(token.balanceOf(provider), 0);
        assertEq(account.getPayment(bytes32(0)).fromCash, 0);
    }

    function test_ERC20NoReturnValueCashPaymentAndBookkeeping() public {
        token.cheatSetReturnsNothing(true);
        test_CashPaymentNeedsNoEnrollmentOrTaskAndNeverBorrowsImplicitly();
    }
}
