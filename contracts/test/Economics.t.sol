// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";

/// @title Economics.t.sol — the demo flywheel of ENGINEERING §6.1
/// @notice The three-order demo is the project's Definition of Done (§9), and
///         §6.1 insists the numbers must be reproducible rather than hand-tuned.
///         This file turns those numbers into assertions:
///
///   order | cash before | quote | principal | feeBps | fee      | debt     | residue
///     1   | 0.04        | 0.12  | 0.08      | 1500   | 0.012    | 0.092    | 0.058
///     2   | 0.058       | 0.12  | 0.062     | 1500   | 0.0093   | 0.0713   | 0.0787
///     3   | 0.0787      | 0.12  | 0.0413    |  800   | 0.003304 | 0.044604 | 0.105396
///
///   score = 500 + 40*min(repayments,10) + 30*min(successes,10) - 400*defaults
///   after order 1 → 570 (Tier C), order 2 → 640 (Tier B), order 3 → 710 (Tier A)
///
/// Every residue matches §6.1's "0.058 / 0.0787 / 0.105396" exactly, and only
/// with `protocolFeeBps == 0` — which is what the demo deployment must use.
contract EconomicsTest is InferCreditTestBase {
    // ---------------------------------------------------------------------
    // the underwriter's scoring rules, restated as pure functions (§6.1 step 4)
    // ---------------------------------------------------------------------

    function _inferScore(uint256 repayments, uint256 successes, uint256 defaults)
        internal
        pure
        returns (uint256)
    {
        uint256 score =
            500 + 40 * (repayments > 10 ? 10 : repayments) + 30 * (successes > 10 ? 10 : successes);
        uint256 penalty = 400 * defaults;
        return penalty >= score ? 0 : score - penalty;
    }

    /// Tier requires BOTH a score AND a real repayment history (review r2 联调 #3).
    function _tierOf(uint256 repayments, uint256 successes, uint256 defaults) internal pure returns (uint8) {
        if (defaults > 0) return 0; // rejected
        uint256 score = _inferScore(repayments, successes, defaults);
        if (score >= 700 && repayments >= 3) return TIER_A;
        if (score >= 580 && repayments >= 1) return TIER_B;
        return TIER_C;
    }

    function _feeBpsOfTier(uint8 tier) internal pure returns (uint16) {
        if (tier == TIER_A) return TIER_A_FEE_BPS;
        if (tier == TIER_B) return TIER_B_FEE_BPS;
        return TIER_C_FEE_BPS;
    }

    // ---------------------------------------------------------------------
    // one demo order, end to end
    // ---------------------------------------------------------------------

    function _runOrder(uint256 agentId, uint16 feeBps, uint8 tier, uint256 index)
        internal
        returns (uint256 principal, uint256 fee)
    {
        uint256 cashBefore = account.cash(agentId);
        // §6.1「预置脚本每单前断言 cash < quote.price」— the working-capital gap
        // must be structural, not staged.
        assertLt(cashBefore, DEMO_QUOTE, "each order must genuinely require credit");

        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);

        principal = DEMO_QUOTE - cashBefore;
        fee = (principal * feeBps) / BPS;

        _drawWithLoanDue(
            agentId,
            taskId,
            DEMO_QUOTE,
            principal,
            feeBps,
            tier,
            block.timestamp + 1 hours,
            keccak256(abi.encodePacked("demo-payment", index))
        );

        uint256 repaymentsBefore = manager.repaymentCount(agentId);

        vm.prank(verifier);
        escrow.settle(taskId, true);

        // §6.1「结算后断言还款计数 +1」
        assertEq(manager.repaymentCount(agentId), repaymentsBefore + 1, "repayment count +1");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "order settled cleanly");
    }

    // ---------------------------------------------------------------------
    // the flywheel
    // ---------------------------------------------------------------------

    function test_DemoThreeOrderEconomics_ResiduesMatchTheDocument() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);

        // ---- order 1: Tier C, 0 repayments so far -------------------------
        assertEq(_tierOf(0, 0, 0), TIER_C, "a fresh agent is Tier C");
        (uint256 p1, uint256 f1) = _runOrder(agentId, TIER_C_FEE_BPS, TIER_C, 1);
        assertEq(p1, 0.08 ether, "order 1 principal");
        assertEq(f1, 0.012 ether, "order 1 fee");
        assertEq(p1 + f1, DEMO_DEBT_1, "order 1 debt 0.092");
        assertEq(account.cash(agentId), DEMO_RESIDUE_1, "order 1 residue 0.058");

        // ---- order 2: still Tier C (score 570 < 580) ----------------------
        assertEq(_inferScore(1, 1, 0), 570, "score after one order");
        assertEq(_tierOf(1, 1, 0), TIER_C, "570 is short of Tier B's 580");
        (uint256 p2, uint256 f2) = _runOrder(agentId, TIER_C_FEE_BPS, TIER_C, 2);
        assertEq(p2, 0.062 ether, "order 2 principal");
        assertEq(f2, 0.0093 ether, "order 2 fee");
        assertEq(account.cash(agentId), DEMO_RESIDUE_2, "order 2 residue 0.0787");

        // ---- order 3: Tier B (score 640) ---------------------------------
        assertEq(_inferScore(2, 2, 0), 640, "score after two orders");
        assertEq(_tierOf(2, 2, 0), TIER_B, "C -> B happened before the demo starts");
        (uint256 p3, uint256 f3) = _runOrder(agentId, TIER_B_FEE_BPS, TIER_B, 3);
        assertEq(p3, 0.0413 ether, "order 3 principal");
        assertEq(f3, 0.003304 ether, "order 3 fee at Tier B's 800 bps");
        assertEq(account.cash(agentId), DEMO_RESIDUE_3, "order 3 residue 0.105396");

        // ---- the on-stage upgrade ----------------------------------------
        assertEq(manager.repaymentCount(agentId), 3, "three genuine repayments");
        assertEq(_feedbackCount(agentId, "repayment"), 3, "mirrored into reputation");
        assertEq(_feedbackCount(agentId, "task-success"), 3, "three task successes");
        assertEq(manager.defaultCount(agentId), 0, "no defaults");
        assertEq(_inferScore(3, 3, 0), 710, "score 710");
        assertEq(_tierOf(3, 3, 0), TIER_A, "B -> A triggers live on the third order");
    }

    /// The residues only land on the documented numbers when the protocol fee is
    /// zero. Pinning this stops a later "let's take 2%" change from silently
    /// breaking the demo script.
    function test_DemoNumbersRequireZeroProtocolFee() public view {
        assertEq(escrow.protocolFeeBps(), 0, "the demo deployment charges no protocol fee");
        assertEq(DEMO_REWARD - DEMO_DEBT_1, DEMO_RESIDUE_1, "0.15 - 0.092 == 0.058");
    }

    // ---------------------------------------------------------------------
    // Tier gate (review r2 联调 #3)
    // ---------------------------------------------------------------------

    /// Score alone must not buy Tier A: seven pure-cash successes reach 710 but
    /// carry zero repayments, so the tier must stay C.
    function test_TierA_RequiresBothScoreAndRepaymentHistory() public pure {
        assertEq(_inferScore(0, 7, 0), 710, "seven cash-only successes score 710");
        assertEq(_tierOf(0, 7, 0), TIER_C, "but without repayments it is still Tier C");
        assertEq(_tierOf(3, 3, 0), TIER_A, "three repayments unlock Tier A");
        assertEq(_tierOf(1, 2, 0), TIER_B, "score 600 + one repayment is Tier B");
    }

    function test_AnyDefaultRejectsOutright() public pure {
        assertEq(_tierOf(9, 9, 1), 0, "defaults > 0 -> rejected regardless of score");
    }

    // ---------------------------------------------------------------------
    // underwriter-side pre-clipping (§6.1 step 5, review r3 #6)
    // ---------------------------------------------------------------------

    /// The underwriter pre-clips `principalCap` so a small reward never produces
    /// a signature the chain will reject. This asserts the two formulas agree,
    /// including the rounding direction (both truncate).
    function _escrowCap(uint256 reward, uint16 protocolFeeBps_, uint16 feeBps)
        internal
        view
        returns (uint256)
    {
        uint256 net = reward - (reward * protocolFeeBps_) / BPS;
        return (((net * _maxLtvBps()) / BPS) * BPS) / (BPS + feeBps);
    }

    function test_UnderwriterPreClippedCapAlwaysPassesI6() public {
        _setProtocolFee(250);
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);

        uint256 reward = 0.13 ether; // deliberately not a round number
        uint256 cap = _escrowCap(reward, 250, TIER_C_FEE_BPS);

        uint256 taskId = _createTask(poster, reward, 30 days);
        _acceptTask(taskId, agentId, agentWallet);

        ICreditManager.CreditAuthorization memory a = _auth(agentId, taskId, cap, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, cap, keccak256("p1"), a, _signAuth(a), agentWallet);

        assertLoanStatus(
            taskId,
            ICreditManager.LoanStatus.Active,
            "a cap computed by the underwriter formula must never be refused by I6"
        );
    }

    /// One wei above the pre-clipped cap must be refused — proving the two
    /// formulas are tight against each other and not merely conservative.
    function test_OneWeiAboveThePreClippedCapIsRefused() public {
        _setProtocolFee(250);
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);

        uint256 reward = 0.13 ether;
        uint256 cap = _escrowCap(reward, 250, TIER_C_FEE_BPS);

        uint256 taskId = _createTask(poster, reward, 30 days);
        _acceptTask(taskId, agentId, agentWallet);

        // +1 wei is not always enough to cross an integer-division boundary;
        // step up until the debt side strictly exceeds the escrow side.
        uint256 net = reward - (reward * 250) / BPS;
        uint256 maxDebt = (net * _maxLtvBps()) / BPS;
        uint256 over = cap;
        while ((over * (BPS + TIER_C_FEE_BPS)) / BPS <= maxDebt) {
            over += 1;
        }

        ICreditManager.CreditAuthorization memory a = _auth(agentId, taskId, over, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(
            abi.encodeWithSelector(
                ICreditManager.DebtExceedsEscrowLtv.selector, (over * (BPS + TIER_C_FEE_BPS)) / BPS, maxDebt
            )
        );
        _payProvider(agentId, over, keccak256("p1"), a, _signAuth(a), agentWallet);
    }
}
