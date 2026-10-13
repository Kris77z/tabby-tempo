// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {SafeTransferLib} from "../src/utils/SafeTransferLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {RejectingProvider} from "./mocks/MaliciousActors.sol";

/// @title Refund.t.sol — ENGINEERING §4.2 `processRefund` (v5.1, reviews r3 #3 /
///        r4 #1 / r4 #2 / r4 #4 / r5 #1)
/// @notice One test per branch of the loan-status switch, plus the replay guard
///         and the cumulative cap that replaced the old "second call reverts"
///         rule in v5.1.
///
/// Shared fixture (`_refundFixture`): reward 0.15, seed cash 0.04, quote 0.12,
/// Tier C → PaymentRecord{fromCash: 0.04, fromCredit: 0.08},
/// loan{principal: 0.08, fee: 0.012}. Debt 0.092 <= 0.15 * 80% = 0.12, so the
/// fixture is INSIDE the production I6 bound — see `DefaultedRecoveryOverLeveredTest`
/// at the bottom of this file for the scenarios that are not.
///
/// The pro-rata split of any refund R is cashShare = R/3, creditShare = 2R/3.
contract RefundTest is InferCreditTestBase {
    bytes32 internal constant PAYMENT_ID = keccak256("payment-1");

    function _refundFixture() internal returns (uint256 agentId, uint256 taskId) {
        _seedVault(VAULT_SEED);
        agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            DEMO_QUOTE,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            PAYMENT_ID
        );
    }

    function _refund(uint256 amount, bytes32 refundId) internal {
        _refund(PAYMENT_ID, amount, refundId);
    }

    function _refund(bytes32 paymentId, uint256 amount, bytes32 refundId) internal {
        _approve(relayRefunder, address(manager), amount);
        vm.prank(relayRefunder);
        manager.processRefund{value: _val(amount)}(paymentId, amount, refundId);
    }

    // =====================================================================
    // access control / value pairing
    // =====================================================================

    function test_RevertWhen_ProcessRefundCalledByStranger() public {
        _refundFixture();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotRelayRefunder.selector, stranger));
        manager.processRefund{value: _val(0.01 ether)}(PAYMENT_ID, 0.01 ether, keccak256("r1"));
    }

    function test_RevertWhen_RefundForUnknownPayment() public {
        _refundFixture();

        bytes32 ghost = keccak256("never-happened");
        _approve(relayRefunder, address(manager), 0.01 ether);
        vm.prank(relayRefunder);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.UnknownPayment.selector, ghost));
        manager.processRefund{value: _val(0.01 ether)}(ghost, 0.01 ether, keccak256("r1"));
    }

    // =====================================================================
    // r3 #3 — proportional debt reduction, fee relief, no repayment counted
    // =====================================================================

    /// §4.5 清单项：processRefund 按比例冲减债务、fee 同步减免、不计还款次数（r3 #3）
    ///
    /// Refund 0.06 of a 0.12 payment → cashShare 0.02, creditShare 0.04.
    /// creditShare / fromCredit = 50% → principal 0.08 → 0.04 and fee 0.012 →
    /// 0.006 (the fee must shrink in lock-step, otherwise a half-refunded loan
    /// still carries a full-size fee).
    function test_PartialRefund_ReducesPrincipalAndFeeProRata() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();
        uint256 outstandingBefore = manager.totalOutstanding();

        _refund(0.06 ether, keccak256("r1"));

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0.04 ether, "principal halved by the credit share");
        assertEq(loan.fee, 0.006 ether, "fee reduced in the same proportion");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Active, "a partial refund keeps it Active");

        assertEq(account.cash(agentId), 0.02 ether, "cash share returned to the agent");
        assertEq(
            manager.totalOutstanding(),
            outstandingBefore - 0.046 ether,
            "global outstanding falls by the retired principal + fee"
        );
        assertEq(manager.repaymentCount(agentId), 0, "a refund is NOT a repayment (r3 #3)");
        assertEq(_feedbackCount(agentId, "repayment"), 0, "and writes no repayment feedback");
    }

    /// §4.5 清单项：部分退款保留剩余债务
    function test_PartialRefund_RemainingDebtStillDue() public {
        (, uint256 taskId) = _refundFixture();

        _refund(0.06 ether, keccak256("r1"));

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal + loan.fee, 0.046 ether, "half the debt survives");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Active, "still Active, still liquidatable");
    }

    /// TEST_PLAN F3 (Codex ruling): a refund retires debt, but it must NOT hand
    /// the agent back this epoch's already-consumed draw budget. `drawnInEpoch`
    /// is a rate limit on new issuance, not a revolving line.
    function test_RefundDoesNotRestoreEpochDrawBudget() public {
        (, uint256 taskId) = _refundFixture();
        uint256 epoch = block.timestamp / EPOCH_LENGTH;

        assertEq(manager.drawnInEpoch(epoch), 0.08 ether, "0.08 of principal was issued");

        _refund(DEMO_QUOTE, keccak256("r1"));

        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "debt is gone");
        assertEq(manager.totalOutstanding(), 0, "outstanding falls back to zero");
        assertEq(
            manager.drawnInEpoch(epoch), 0.08 ether, "but the epoch issuance counter must NOT be rewound"
        );
    }

    // =====================================================================
    // r4 #2 — full refund closes the loan
    // =====================================================================

    /// §4.5 清单项：全额退款 -> ClosedByRefund
    function test_FullRefund_ClosesLoanAsClosedByRefund() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();

        _refund(DEMO_QUOTE, keccak256("r1"));

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0, "principal wiped");
        assertEq(loan.fee, 0, "uncollected fee forgiven outright");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "ClosedByRefund");

        assertEq(account.cash(agentId), DEMO_SEED_CASH, "the cash leg comes back to the agent");
        assertEq(manager.totalOutstanding(), 0, "nothing outstanding");
        assertEq(manager.repaymentCount(agentId), 0, "never counted as a repayment");
        assertEq(manager.defaultCount(agentId), 0, "and never as a default");
        assertFalse(manager.protocolFrozen(agentId), "no freeze");
    }

    /// §4.5 清单项：全额退款 -> ClosedByRefund，到期不触发清算（r4 #2）
    function test_ClosedByRefund_ExpiryDoesNotLiquidate() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();
        _refund(DEMO_QUOTE, keccak256("r1"));

        uint256 posterBefore = _balanceOf(poster);
        vm.warp(escrow.getTask(taskId).deadline + 1);

        vm.prank(stranger);
        escrow.expireTask(taskId);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "status must NOT become Defaulted");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Failed, "task still terminates");
        assertEq(_balanceOf(poster) - posterBefore, DEMO_REWARD, "poster gets the WHOLE escrow back");
        assertEq(manager.defaultCount(agentId), 0, "no default recorded");
        assertFalse(manager.protocolFrozen(agentId), "agent not frozen");
        assertEq(manager.getLiquidation(taskId).poster, address(0), "no liquidation record written");
    }

    // =====================================================================
    // Repaid branch — never re-credit a settled principal
    // =====================================================================

    /// §4.5 清单项：Repaid 后退款全额入 cash 不再冲减
    function test_RefundAfterRepaid_GoesEntirelyToCash() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();

        vm.prank(verifier);
        escrow.settle(taskId, true);
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "success path repaid the loan");
        assertEq(manager.repaymentCount(agentId), 1, "one genuine repayment");

        uint256 cashBefore = account.cash(agentId);
        assertEq(cashBefore, DEMO_RESIDUE_1, "settlement residue 0.15 - 0.092 = 0.058");
        uint256 outstandingBefore = manager.totalOutstanding();

        _refund(DEMO_QUOTE, keccak256("r1"));

        assertEq(account.cash(agentId), cashBefore + DEMO_QUOTE, "the WHOLE refund lands in cash");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "terminal state unchanged");
        assertEq(manager.totalOutstanding(), outstandingBefore, "nothing to reduce - debt is gone");
        assertEq(manager.repaymentCount(agentId), 1, "still exactly one repayment, not two");

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0, "settled principal must never be re-credited");
        assertEq(loan.fee, 0, "nor the settled fee");
    }

    // =====================================================================
    // r5 #1 — refundId replay guard and the cumulative cap
    // =====================================================================

    /// §4.5 清单项：同 refundId 重放被拒
    function test_RevertWhen_SameRefundIdReplayed() public {
        _refundFixture();
        bytes32 refundId = keccak256("relay-refund-1");

        _refund(0.03 ether, refundId);
        assertTrue(account.refundConsumed(refundId), "refundId consumed");

        _approve(relayRefunder, address(manager), 0.03 ether);
        vm.prank(relayRefunder);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.RefundIdAlreadyUsed.selector, refundId));
        manager.processRefund{value: _val(0.03 ether)}(PAYMENT_ID, 0.03 ether, refundId);
    }

    /// §4.5 清单项：不同 refundId 续退成功 —— the v5.1 replacement for the
    /// old "second call reverts" rule, which contradicted partial refunds.
    function test_SequentialRefunds_WithDistinctRefundIds_Accumulate() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();

        _refund(0.03 ether, keccak256("r1"));
        _refund(0.03 ether, keccak256("r2"));

        IAgentAccount.PaymentRecord memory rec = account.getPayment(PAYMENT_ID);
        assertEq(rec.refundedAmount, 0.06 ether, "cumulative refundedAmount");

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0.04 ether, "two 0.03 refunds == one 0.06 refund");
        assertEq(loan.fee, 0.006 ether, "fee relief accumulates identically");
        assertEq(account.cash(agentId), 0.02 ether, "cash share accumulates identically");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Active, "still Active");
    }

    /// The final instalment that brings the cumulative total to 100% must close
    /// the loan exactly like a single full refund would — and leave NOTHING
    /// behind: no principal, no fee, no outstanding, no unaccounted wei
    /// (Codex review R6).
    function test_SequentialRefunds_LastInstalmentClosesLoan() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();
        uint256 vaultBefore = manager.vaultBalance();
        uint256 relayBefore = _balanceOf(relayRefunder);

        _refund(0.05 ether, keccak256("r1"));
        _refund(0.05 ether, keccak256("r2"));
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Active, "still short of the full amount");

        _refund(0.02 ether, keccak256("r3")); // 0.05 + 0.05 + 0.02 == 0.12

        assertLoanStatus(
            taskId, ICreditManager.LoanStatus.ClosedByRefund, "cumulative full refund closes the loan"
        );
        assertEq(account.getPayment(PAYMENT_ID).refundedAmount, DEMO_QUOTE, "100% refunded");

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0, "principal fully retired by the instalments");
        assertEq(loan.fee, 0, "fee fully forgiven by the instalments");
        assertEq(manager.totalOutstanding(), 0, "outstanding zeroed");

        // conservation: the relay paid 0.12; it ends up split exactly between
        // the vault (the 0.08 credit leg) and the agent (the 0.04 cash leg),
        // with no wei lost to per-instalment truncation.
        assertEq(relayBefore - _balanceOf(relayRefunder), DEMO_QUOTE, "relay paid exactly 0.12");
        assertEq(manager.vaultBalance() - vaultBefore, 0.08 ether, "vault recovered the credit leg");
        assertEq(account.cash(agentId), DEMO_SEED_CASH, "agent recovered the cash leg exactly");
    }

    /// Codex review R6 — arbitrary instalment splits must be indistinguishable
    /// from one refund of the same total, with no accumulated truncation.
    /// The implementation is expected to compute each instalment's share as
    /// (cumulative entitlement so far) − (already distributed), not by rounding
    /// each instalment independently.
    function testFuzz_InstalmentRefundsEqualOneRefund(uint256 a, uint256 b) public {
        (uint256 agentId, uint256 taskId) = _refundFixture();

        a = bound(a, 1, DEMO_QUOTE - 2);
        b = bound(b, 1, DEMO_QUOTE - a - 1);
        uint256 c = DEMO_QUOTE - a - b;

        uint256 vaultBefore = manager.vaultBalance();
        uint256 relayBefore = _balanceOf(relayRefunder);

        _refund(a, keccak256("f1"));
        _refund(b, keccak256("f2"));
        _refund(c, keccak256("f3"));

        assertEq(account.getPayment(PAYMENT_ID).refundedAmount, DEMO_QUOTE, "cumulative == payment");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.ClosedByRefund, "closed by the last one");

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0, "no residual principal from rounding");
        assertEq(loan.fee, 0, "no residual fee from rounding");
        assertEq(manager.totalOutstanding(), 0, "no residual outstanding");

        assertEq(relayBefore - _balanceOf(relayRefunder), DEMO_QUOTE, "relay paid the full amount");
        assertEq(manager.vaultBalance() - vaultBefore, 0.08 ether, "credit leg, to the wei");
        assertEq(account.cash(agentId), DEMO_SEED_CASH, "cash leg, to the wei");
    }

    /// §4.5 清单项：累计不超原额
    function test_RevertWhen_CumulativeRefundExceedsPayment() public {
        _refundFixture();

        _refund(0.1 ether, keccak256("r1"));

        _approve(relayRefunder, address(manager), 0.03 ether);
        vm.prank(relayRefunder);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICreditManager.RefundExceedsPayment.selector, PAYMENT_ID, 0.03 ether, 0.02 ether
            )
        );
        manager.processRefund{value: _val(0.03 ether)}(PAYMENT_ID, 0.03 ether, keccak256("r2"));
    }

    function test_RevertWhen_SingleRefundExceedsPayment() public {
        _refundFixture();

        _approve(relayRefunder, address(manager), 0.2 ether);
        vm.prank(relayRefunder);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICreditManager.RefundExceedsPayment.selector, PAYMENT_ID, 0.2 ether, DEMO_QUOTE
            )
        );
        manager.processRefund{value: _val(0.2 ether)}(PAYMENT_ID, 0.2 ether, keccak256("r1"));
    }

    // =====================================================================
    // r4 #4 — pure cash payment (taskId == 0)
    // =====================================================================

    /// §4.5 清单项：纯 cash 支付（taskId=0）退款按 PaymentRecord.agentId 正确入账（r4 #4）
    /// There is no task and no loan, so the ONLY way to find the right agent is
    /// PaymentRecord.agentId — which is exactly why r4 #4 made it mandatory.
    function test_PureCashPayment_RefundCreditedByPaymentRecordAgentId() public {
        _seedVault(VAULT_SEED);
        uint256 agentA = _registerAndEnroll(agentOwner, agentWallet);
        uint256 agentB = _registerAndEnroll(otherAgentOwner, otherAgentWallet);
        _setPermissivePolicy(agentA, agentOwner);
        _setPermissivePolicy(agentB, otherAgentOwner);
        _depositCash(agentA, agentOwner, 0.5 ether);
        _depositCash(agentB, otherAgentOwner, 0.5 ether);

        bytes32 paymentId = keccak256("cash-only");
        ICreditManager.CreditAuthorization memory a = _emptyAuth();
        _payProvider(agentB, 0.2 ether, paymentId, a, bytes(""), otherAgentWallet);

        IAgentAccount.PaymentRecord memory rec = account.getPayment(paymentId);
        assertEq(rec.agentId, agentB, "record pins the paying agent");
        assertEq(rec.taskId, 0, "pure cash payment has no task");
        assertEq(rec.fromCredit, 0, "no credit leg");

        uint256 cashA = account.cash(agentA);
        _refund(paymentId, 0.2 ether, keccak256("r1"));

        assertEq(account.cash(agentB), 0.5 ether, "agent B is made whole");
        assertEq(account.cash(agentA), cashA, "agent A is untouched");
        assertEq(manager.repaymentCount(agentB), 0, "no repayment counted");
    }

    // =====================================================================
    // r4 #1 — Defaulted recovery at PRODUCTION LTV
    // =====================================================================

    /// §4.5 清单项：Defaulted 后 recovery 逆序含 poster（r4 #1）—— production LTV.
    /// Inside the real I6 bound only two layers can ever bear a burden: the
    /// agent's cash and the poster's escrow (see TEST_PLAN F6). This test pins
    /// the reverse order across exactly those two, so the production path is
    /// covered without any fixture gymnastics.
    ///
    /// debt 0.092 | cash at liquidation 0.03 | escrow 0.15
    ///   burdens  {cash 0.03, escrow 0.062, backstop 0, LP 0}
    /// A 0.12 refund unwinds them as: LP 0 → backstop 0 → poster 0.062 →
    /// agent cash 0.03, remainder 0.028 to the agent.
    function test_DefaultedRecovery_ProductionLtv_PosterThenCash() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();
        _depositCash(agentId, agentOwner, 0.03 ether);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.cashUsed, 0.03 ether, "burden: agent cash");
        assertEq(r.escrowSlashed, 0.062 ether, "burden: poster escrow");
        assertEq(r.backstopUsed, 0, "no backstop burden at production LTV");
        assertEq(r.lpLoss, 0, "no LP burden at production LTV");

        uint256 vaultBefore = manager.vaultBalance();
        uint256 posterBefore = _balanceOf(poster);

        _refund(DEMO_QUOTE, keccak256("r1"));

        assertEq(manager.vaultBalance(), vaultBefore, "LP lost nothing, recovers nothing");
        assertEq(manager.backstop(agentId), 0, "backstop lost nothing, recovers nothing");
        assertEq(_balanceOf(poster) - posterBefore, 0.062 ether, "poster reimbursed first (r4 #1)");
        assertEq(account.cash(agentId), 0.03 ether + 0.028 ether, "then the agent, then the remainder");

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "terminal state is unchanged");
        assertEq(manager.repaymentCount(agentId), 0, "recovery is not a repayment");
        assertEq(manager.defaultCount(agentId), 1, "the default record stands");
    }

    /// Recovery must never over-refill a layer beyond what it actually lost:
    /// a fully-recovered liquidation (lpLoss == 0) must send nothing to the vault.
    function test_DefaultedRecovery_ZeroLossLayerReceivesNothing() public {
        (uint256 agentId, uint256 taskId) = _refundFixture();

        vm.prank(verifier);
        escrow.settle(taskId, false);

        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.lpLoss, 0, "escrow covered everything");
        assertEq(r.backstopUsed, 0, "backstop untouched");
        assertEq(r.escrowSlashed, 0.092 ether, "the poster bore the whole debt");

        uint256 vaultBefore = manager.vaultBalance();
        uint256 posterBefore = _balanceOf(poster);

        _refund(DEMO_QUOTE, keccak256("r1"));

        assertEq(manager.vaultBalance(), vaultBefore, "LP lost nothing, so recovers nothing");
        assertEq(manager.backstop(agentId), 0, "backstop lost nothing, so recovers nothing");
        assertEq(_balanceOf(poster) - posterBefore, 0.092 ether, "poster is first in line here");
        assertEq(account.cash(agentId), DEMO_QUOTE - 0.092 ether, "the rest to the agent");
    }
}

/// @notice Multi-layer Defaulted recovery, in an ISOLATED over-levered harness.
/// @dev Codex review R2: the three tests below need a 0.092 debt against a 0.05
///      escrow so that the backstop and LP layers actually bear a burden. At the
///      production `MAX_LTV_BPS = 8_000` that draw is correctly REFUSED by I6
///      (0.05 * 80% = 0.04 < 0.092), so a correct implementation would never let
///      these scenarios exist. They previously sat in `RefundTest` and silently
///      inherited the production LTV, which made their target assertions
///      unreachable. Production I6 is NOT relaxed — this harness is a separate
///      deployment with `MAX_LTV_BPS = 20_000`, reachable only by
///      misconfiguration, and is labelled as such. The production-LTV recovery
///      path stays covered by `RefundTest::test_DefaultedRecovery_ProductionLtv_*`.
contract DefaultedRecoveryOverLeveredTest is InferCreditTestBase {
    bytes32 internal constant PAYMENT_ID = keccak256("payment-default");

    function _maxLtvBps() internal pure override returns (uint16) {
        return 20_000;
    }

    function _refund(uint256 amount, bytes32 refundId) internal {
        _approve(relayRefunder, address(manager), amount);
        vm.prank(relayRefunder);
        manager.processRefund{value: _val(amount)}(PAYMENT_ID, amount, refundId);
    }

    /// escrow 0.05, backstop 0.02, cash 0.02 spent on the payment then 0.01 more,
    /// quote 0.1 = 0.02 cash + 0.08 credit, debt 0.092.
    /// Liquidation burdens: {cash 0.01, escrow 0.05, backstop 0.02, LP 0.012}.
    function _defaultedFixture() internal returns (uint256 agentId, uint256 taskId) {
        _seedVault(VAULT_SEED);
        agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _fundBackstop(agentId, agentOwner, 0.02 ether);
        _depositCash(agentId, agentOwner, 0.02 ether);

        taskId = _createTask(poster, 0.05 ether, 30 days);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(
            agentId,
            taskId,
            0.1 ether,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            PAYMENT_ID
        );
        _depositCash(agentId, agentOwner, 0.01 ether);

        vm.prank(verifier);
        escrow.settle(taskId, false);
    }

    function _assertBurdens(uint256 taskId) internal view {
        ICreditManager.LiquidationRecord memory r = manager.getLiquidation(taskId);
        assertEq(r.cashUsed, 0.01 ether, "burden: agent cash");
        assertEq(r.escrowSlashed, 0.05 ether, "burden: poster escrow");
        assertEq(r.backstopUsed, 0.02 ether, "burden: backstop");
        assertEq(r.lpLoss, 0.012 ether, "burden: LP");
    }

    /// §4.5 清单项：
    ///   Defaulted 后 recovery 逆序含 poster：LP -> backstop -> poster -> cash（r4 #1）
    ///   每层回补不超过 liquidations 记录的实际承担额
    ///
    /// A 0.1 refund unwinds the four burdens in reverse:
    ///   LP 0.012 → backstop 0.02 → poster 0.05 → agent cash 0.01,
    ///   and the 0.008 left over goes to the agent's cash.
    function test_DefaultedRecovery_ReverseOrderCappedByRecordedBurden() public {
        (uint256 agentId, uint256 taskId) = _defaultedFixture();
        _assertBurdens(taskId);

        uint256 vaultBefore = manager.vaultBalance();
        uint256 posterBefore = _balanceOf(poster);

        _refund(0.1 ether, keccak256("r1"));

        assertEq(manager.vaultBalance() - vaultBefore, 0.012 ether, "1st: LP loss made whole");
        assertEq(manager.backstop(agentId), 0.02 ether, "2nd: backstop refilled to its burden");
        assertEq(_balanceOf(poster) - posterBefore, 0.05 ether, "3rd: poster reimbursed (r4 #1)");
        assertEq(account.cash(agentId), 0.01 ether + 0.008 ether, "4th: agent cash, then the remainder");

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "terminal state is unchanged");
        assertEq(manager.repaymentCount(agentId), 0, "recovery is not a repayment");
        assertEq(manager.defaultCount(agentId), 1, "the default record stands");
    }

    /// The per-layer cap is the RECORDED burden, not the refund size: a refund
    /// smaller than the total burden must stop part-way down the ladder and
    /// leave the lower layers empty-handed.
    function test_DefaultedRecovery_PartialRefundStopsMidLadder() public {
        (uint256 agentId, uint256 taskId) = _defaultedFixture();

        uint256 vaultBefore = manager.vaultBalance();
        uint256 posterBefore = _balanceOf(poster);

        _refund(0.02 ether, keccak256("r1")); // LP 0.012 + backstop 0.008

        assertEq(manager.vaultBalance() - vaultBefore, 0.012 ether, "LP fully made whole first");
        assertEq(manager.backstop(agentId), 0.008 ether, "backstop only partially refilled");
        assertEq(_balanceOf(poster), posterBefore, "poster gets nothing yet - it is 3rd in line");
        assertEq(account.cash(agentId), 0, "and the agent, 4th, gets nothing");

        ICreditManager.LiquidationRecord memory rec = manager.getRecovered(taskId);
        assertEq(rec.lpLoss, 0.012 ether, "recovery ledger tracks what LP got back");
        assertEq(rec.backstopUsed, 0.008 ether, "and what the backstop got back");
        _assertBurdens(taskId); // the ORIGINAL burden record is untouched (F11)
    }

    /// TEST_PLAN F11: §4.2 caps each recovery layer by "清算时记录的承担额" but
    /// never says the record is consumed as it is repaid. With instalment
    /// refunds (r5 #1) a literal reading lets every instalment refill each layer
    /// up to its full recorded burden again — two 0.05 refunds would hand the LP
    /// 0.012 twice. Per the Codex ruling the ORIGINAL LiquidationRecord stays
    /// intact for audit and a separate `getRecovered` ledger shrinks the cap.
    function test_DefaultedRecovery_InstalmentsDoNotDoubleRefillALayer() public {
        (uint256 agentId, uint256 taskId) = _defaultedFixture();

        uint256 vaultBefore = manager.vaultBalance();
        uint256 posterBefore = _balanceOf(poster);

        _refund(0.05 ether, keccak256("r1"));
        _refund(0.05 ether, keccak256("r2"));

        // identical to a single 0.1 refund
        assertEq(manager.vaultBalance() - vaultBefore, 0.012 ether, "LP refilled ONCE, not twice");
        assertEq(manager.backstop(agentId), 0.02 ether, "backstop refilled to its burden, not beyond");
        assertEq(_balanceOf(poster) - posterBefore, 0.05 ether, "poster reimbursed exactly once");
        assertEq(account.cash(agentId), 0.018 ether, "0.01 cash burden + 0.008 remainder");

        ICreditManager.LiquidationRecord memory rec = manager.getRecovered(taskId);
        assertEq(rec.lpLoss, 0.012 ether, "cumulative LP recovery == its burden, never more");
        assertEq(rec.backstopUsed, 0.02 ether, "cumulative backstop recovery == its burden");
        assertEq(rec.escrowSlashed, 0.05 ether, "cumulative poster recovery == its burden");
        assertEq(rec.cashUsed, 0.01 ether, "cumulative agent recovery == its burden");
        _assertBurdens(taskId); // original record still readable for audit
    }

    function test_RecoveryTransferFailureRollsBackEveryBurdenAndRefundRegistration() public {
        (uint256 agentId, uint256 taskId) = _defaultedFixture();
        uint256 managerBefore = _balanceOf(address(manager));
        uint256 vaultBefore = manager.vaultBalance();
        uint256 relayBefore = _balanceOf(relayRefunder);
        uint256 posterBefore = _balanceOf(poster);
        bytes32 refundId = keccak256("recovery-retry");
        uint256 stages = _useErc20() ? 2 : 1;
        for (uint256 i; i < stages; i++) {
            address blocked = i == 0 ? poster : address(account);
            if (_useErc20()) token.cheatSetBlocked(blocked, true);
            else vm.etch(blocked, address(new RejectingProvider()).code);
            _approve(relayRefunder, address(manager), 0.1 ether);
            vm.prank(relayRefunder);
            if (_useErc20()) {
                vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, blocked));
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(SafeTransferLib.NativeTransferFailed.selector, poster, 0.05 ether)
                );
            }
            manager.processRefund{value: _val(0.1 ether)}(PAYMENT_ID, 0.1 ether, refundId);
            assertFalse(account.refundConsumed(refundId));
            assertEq(account.getPayment(PAYMENT_ID).refundedAmount, 0);
            assertEq(manager.vaultBalance(), vaultBefore);
            assertEq(_balanceOf(address(manager)), managerBefore);
            assertEq(_balanceOf(relayRefunder), relayBefore);
            assertEq(_balanceOf(poster), posterBefore);
            assertEq(manager.backstop(agentId), 0);
            assertEq(manager.backstopTotal(), 0);
            assertEq(account.cash(agentId), 0);
            assertEq(_balanceOf(address(account)), 0);
            ICreditManager.LiquidationRecord memory r = manager.getRecovered(taskId);
            assertEq(r.lpLoss + r.backstopUsed + r.escrowSlashed + r.cashUsed, 0);
            assertEq(r.poster, address(0));
            assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "failed recovery preserves default");
            assertEq(manager.defaultCount(agentId), 1);
            assertEq(manager.repaymentCount(agentId), 0);
            assertTrue(manager.protocolFrozen(agentId));
            assertTrue(account.protocolFrozen(agentId));
            _assertBurdens(taskId);
            if (_useErc20()) {
                assertEq(token.allowance(relayRefunder, address(manager)), 0.1 ether);
                assertEq(token.allowance(address(manager), address(account)), 0);
                token.cheatSetBlocked(blocked, false);
            } else {
                vm.etch(blocked, bytes(""));
            }
        }
        _refund(0.1 ether, refundId);
        assertTrue(account.refundConsumed(refundId));
        assertEq(manager.vaultBalance(), vaultBefore + 0.012 ether);
        assertEq(_balanceOf(address(manager)), managerBefore + 0.032 ether);
        assertEq(manager.backstop(agentId), 0.02 ether);
        assertEq(_balanceOf(poster), posterBefore + 0.05 ether);
        assertEq(account.cash(agentId), 0.018 ether);
        assertEq(_balanceOf(address(account)), 0.018 ether);
        _assertBurdens(taskId);
    }
}
