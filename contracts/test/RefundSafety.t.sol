// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";

contract RefundSafetyTest is InferCreditTestBase {
    function _repay(uint256 taskId, uint256 amount) private {
        if (_useErc20()) token.mint(address(escrow), amount);
        else vm.deal(address(escrow), address(escrow).balance + amount);
        _approve(address(escrow), address(manager), amount);
        vm.prank(address(escrow));
        manager.repay{value: _val(amount)}(taskId, amount);
    }

    function _refund(bytes32 paymentId, uint256 amount, bytes32 refundId) internal {
        _approve(relayRefunder, address(manager), amount);
        vm.prank(relayRefunder);
        manager.processRefund{value: _val(amount)}(paymentId, amount, refundId);
    }

    function test_PartialRepayAndHalfRefundCloseDebtButReturnCollectedFeeInTwoSteps() public {
        Scenario memory s = _openLoan(DEMO_REWARD, DEMO_SEED_CASH, DEMO_QUOTE, TIER_C_FEE_BPS, TIER_C);
        _repay(s.taskId, 0.052 ether); // Fee 0.012 + principal 0.04.
        assertEq(manager.getLoan(s.taskId).principal, 0.04 ether);
        assertEq(manager.getLoan(s.taskId).fee, 0);
        uint256 vaultBefore = manager.vaultBalance();
        _refund(s.paymentId, 0.06 ether, keccak256("half1"));
        assertLoanStatus(
            s.taskId, ICreditManager.LoanStatus.ClosedByRefund, "zero debt closes before full refund"
        );
        assertEq(account.getPayment(s.paymentId).refundedAmount, 0.06 ether);
        assertEq(manager.totalOutstanding(), 0);
        assertEq(
            manager.vaultBalance(), vaultBefore + 0.034 ether, "principal recovered minus half of paid fee"
        );
        assertEq(account.cash(s.agentId), 0.026 ether, "cash share plus only half of paid fee");
        vm.warp(escrow.getTask(s.taskId).deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.LoanNotActive.selector, s.taskId));
        manager.liquidateExpiredLoan(s.taskId);
        _refund(s.paymentId, 0.06 ether, keccak256("half2"));
        assertEq(account.cash(s.agentId), 0.092 ether, "second half refund plus the remaining 0.006 fee");
        assertEq(_balanceOf(address(account)), 0.092 ether);
        assertEq(manager.vaultBalance(), VAULT_SEED);
        assertEq(_balanceOf(address(manager)), VAULT_SEED);
        assertEq(manager.defaultCount(s.agentId), 0);
        assertEq(manager.repaymentCount(s.agentId), 0);
        assertEq(_feedbackCount(s.agentId, "repayment"), 0);
    }

    function test_FullRefundOnlyRetiresRemainingPrincipalAndUsesItsIncomingLiquidityForFeeReturn() public {
        Scenario memory s = _openLoan(DEMO_REWARD, DEMO_SEED_CASH, DEMO_QUOTE, TIER_C_FEE_BPS, TIER_C);
        _fundBackstop(s.agentId, agentOwner, 0.02 ether);
        _repay(s.taskId, 0.05 ether);
        assertEq(manager.getLoan(s.taskId).principal, 0.042 ether);
        uint256 withdrawable = manager.vaultBalance();
        vm.prank(treasury);
        manager.withdraw(withdrawable);
        assertEq(manager.vaultBalance(), 0);
        _refund(s.paymentId, DEMO_QUOTE, keccak256("full"));
        assertLoanStatus(s.taskId, ICreditManager.LoanStatus.ClosedByRefund, "remaining principal only");
        assertEq(manager.totalOutstanding(), 0);
        assertEq(manager.vaultBalance(), 0.03 ether);
        assertEq(_balanceOf(address(manager)), 0.05 ether, "vault plus protected backstop");
        assertEq(manager.backstop(s.agentId), 0.02 ether);
        assertEq(manager.backstopTotal(), 0.02 ether);
        assertEq(account.cash(s.agentId), 0.09 ether, "cash leg + already paid principal + paid fee");
        assertEq(_balanceOf(address(account)), 0.09 ether);
        assertEq(manager.repaymentCount(s.agentId), 0);
    }

    function testFuzz_PartialInstalmentsPreserveCumulativeCashAndFeeRounding(uint256 a, uint256 b) public {
        Scenario memory s = _openLoan(40, 5, 13, 7_500, TIER_C); // 8 principal, 6 fee.
        a = bound(a, 1, 11);
        b = bound(b, 1, 12 - a);
        uint256 total = a + b;
        uint256 epoch = block.timestamp / EPOCH_LENGTH;
        uint256 day = block.timestamp / account.DAY_LENGTH();
        uint256 issued = manager.drawnInEpoch(epoch);
        uint256 spent = account.debtSpentInDay(s.agentId, day);
        _refund(s.paymentId, a, keccak256("part1"));
        _refund(s.paymentId, b, keccak256("part2"));
        uint256 cash = total * 5 / 13;
        uint256 principal = 8 - (total - cash);
        uint256 fee = 6 - total * 6 / 13;
        assertEq(account.cash(s.agentId), cash);
        assertEq(manager.getLoan(s.taskId).principal, principal);
        assertEq(manager.getLoan(s.taskId).fee, fee);
        assertEq(manager.totalOutstanding(), principal + fee);
        _refund(s.paymentId, 13 - total, keccak256("part3"));
        assertLoanStatus(
            s.taskId, ICreditManager.LoanStatus.ClosedByRefund, "last instalment clears every wei"
        );
        assertEq(account.cash(s.agentId), 5);
        assertEq(_balanceOf(address(account)), 5);
        assertEq(manager.vaultBalance(), VAULT_SEED);
        assertEq(manager.totalOutstanding(), 0);
        assertEq(manager.drawnInEpoch(epoch), issued);
        assertEq(account.debtSpentInDay(s.agentId, day), spent);
    }

    function test_OneWeiRefundCanCloseDebtAndItsCashTailNeverDefaults() public {
        Scenario memory s = _openLoan(2, 1, 2, 0, TIER_C);
        _refund(s.paymentId, 1, keccak256("tiny1"));
        assertLoanStatus(
            s.taskId, ICreditManager.LoanStatus.ClosedByRefund, "rounded credit share clears debt"
        );
        assertEq(account.getPayment(s.paymentId).refundedAmount, 1);
        assertEq(account.cash(s.agentId), 0);
        _refund(s.paymentId, 1, keccak256("tiny2"));
        assertEq(account.cash(s.agentId), 1);
        assertEq(_balanceOf(address(account)), 1);
        vm.warp(escrow.getTask(s.taskId).deadline + 1);
        escrow.expireTask(s.taskId);
        assertEq(manager.defaultCount(s.agentId), 0);
        assertEq(manager.repaymentCount(s.agentId), 0);
        assertFalse(manager.protocolFrozen(s.agentId));
        assertEq(manager.vaultBalance(), VAULT_SEED);
    }

    function test_AgentZeroPaymentIsRealAndRefundIdsAreGlobalAcrossPayments() public {
        vm.store(address(identity), bytes32(0), bytes32(0)); // Configure this registry fixture to begin at token ID 0.
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        assertEq(agentId, 0);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 0.5 ether);
        _payProvider(agentId, 0.1 ether, bytes32(0), _emptyAuth(), bytes(""), agentWallet);
        bytes32 otherPayment = keccak256("other-payment");
        _payProvider(agentId, 0.1 ether, otherPayment, _emptyAuth(), bytes(""), agentWallet);
        bytes32 refundId = keccak256("global-refund");
        _refund(bytes32(0), 0.1 ether, refundId);
        uint256 managerBefore = _balanceOf(address(manager));
        uint256 relayBefore = _balanceOf(relayRefunder);
        _approve(relayRefunder, address(manager), 0.1 ether);
        vm.prank(relayRefunder);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.RefundIdAlreadyUsed.selector, refundId));
        manager.processRefund{value: _val(0.1 ether)}(otherPayment, 0.1 ether, refundId);
        assertEq(account.getPayment(otherPayment).refundedAmount, 0);
        assertEq(_balanceOf(address(manager)), managerBefore);
        assertEq(_balanceOf(relayRefunder), relayBefore);
        _refund(otherPayment, 0.1 ether, keccak256("other-refund"));
        assertEq(account.cash(0), 0.5 ether);
        assertEq(_balanceOf(address(account)), 0.5 ether);
    }
}

contract Erc20RefundSafetyTest is RefundSafetyTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}
