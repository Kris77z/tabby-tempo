// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IERC8004Adapter} from "../src/interfaces/IERC8004Adapter.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

/// @title Feedback.t.sol — ENGINEERING §4.4 reputation write-back (reviews #4/#5)
/// @notice Two rules are under test:
///   1. Funds and reputation are DECOUPLED. A canonical-registry failure must
///      never roll back a settlement or a liquidation; it parks a
///      `pendingFeedback[taskId][type]` entry instead.
///   2. "repayment" is written ONLY when a real Active loan was really repaid.
///      A pure-cash task writes "task-success" and nothing else, so that a
///      credit tier can never be reached without genuine repayment history
///      (review r2 联调 #3).
contract FeedbackTest is InferCreditTestBase {
    function _successfulCreditTask() internal returns (uint256 agentId, uint256 taskId) {
        _seedVault(VAULT_SEED);
        agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        taskId = _createTask(poster, DEMO_REWARD);
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
    }

    // =====================================================================
    // happy path: two entries, both attributed to the adapter
    // =====================================================================

    function test_Settle_Passed_WithLoan_WritesTaskSuccessAndRepayment() public {
        (uint256 agentId, uint256 taskId) = _successfulCreditTask();

        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(_feedbackCount(agentId, "task-success"), 1, "task-success written once");
        assertEq(_feedbackCount(agentId, "repayment"), 1, "repayment written once");
        assertEq(_feedbackCount(agentId, "default"), 0, "no default");
        assertFalse(escrow.pendingFeedback(taskId, FB_TASK_SUCCESS), "nothing pending");
        assertFalse(escrow.pendingFeedback(taskId, FB_REPAYMENT), "nothing pending");
    }

    /// §6.1 step 3: the underwriter reads with `clients=[adapter]`, so every
    /// InferCredit entry must be written BY the adapter, not by the escrow.
    /// Anything else would be invisible to the score and trivially Sybil-able.
    function test_FeedbackIsAttributedToTheAdapterAsClient() public {
        (uint256 agentId, uint256 taskId) = _successfulCreditTask();

        vm.prank(verifier);
        escrow.settle(taskId, true);

        address[] memory wrongClient = new address[](1);
        wrongClient[0] = address(escrow);
        (uint64 viaEscrow,,) = reputation.getSummary(agentId, wrongClient, "infercredit", "repayment");
        assertEq(viaEscrow, 0, "TaskEscrow must NOT be the reporting client");

        assertEq(_feedbackCount(agentId, "repayment"), 1, "the adapter is");
    }

    /// Codex review R1: ERC-8004 leaves `summaryValue`'s aggregation
    /// implementation-defined ("aggregated validation statistics"). InferCredit's
    /// InferScore (§6.1 step 4) counts EVENTS, so it must depend on `count` only.
    /// Flipping the registry between mean and sum must not move the score.
    function test_InferScoreDependsOnCountOnlyNotOnSummaryValue() public {
        (uint256 agentId, uint256 taskId) = _successfulCreditTask();

        vm.prank(verifier);
        escrow.settle(taskId, true);

        address[] memory clients = new address[](1);
        clients[0] = address(adapter);

        reputation.cheatSetSummaryMode(MockReputationRegistry.SummaryMode.Mean);
        (uint64 countMean, int128 valueMean,) =
            reputation.getSummary(agentId, clients, "infercredit", "repayment");

        reputation.cheatSetSummaryMode(MockReputationRegistry.SummaryMode.Sum);
        (uint64 countSum, int128 valueSum,) =
            reputation.getSummary(agentId, clients, "infercredit", "repayment");

        assertEq(countMean, countSum, "count is stable across aggregation modes");
        assertEq(countMean, 1, "one repayment event");
        assertEq(valueMean, valueSum, "with a single entry the two modes coincide here");

        // the protocol ledger, which is the first source of truth (§6.1 step 2),
        // is unaffected by anything the registry chooses to aggregate
        assertEq(manager.repaymentCount(agentId), 1, "protocol ledger is the authority");
    }

    /// With several entries the two modes genuinely diverge; `count` must not.
    function test_SummaryValueDivergesButCountDoesNot() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);

        vm.startPrank(address(escrow));
        adapter.reportFeedback(agentId, "task-success", int128(100), 0);
        adapter.reportFeedback(agentId, "task-success", int128(50), 0);
        vm.stopPrank();

        address[] memory clients = new address[](1);
        clients[0] = address(adapter);

        reputation.cheatSetSummaryMode(MockReputationRegistry.SummaryMode.Mean);
        (uint64 c1, int128 mean,) = reputation.getSummary(agentId, clients, "infercredit", "task-success");
        reputation.cheatSetSummaryMode(MockReputationRegistry.SummaryMode.Sum);
        (uint64 c2, int128 sum,) = reputation.getSummary(agentId, clients, "infercredit", "task-success");

        assertEq(c1, 2, "two events");
        assertEq(c2, 2, "count is the ONLY stable field");
        assertEq(mean, int128(75), "mean");
        assertEq(sum, int128(150), "sum");
        assertTrue(mean != sum, "the two readings really do differ");
    }

    // =====================================================================
    // review #4: pure-cash tasks must never mint a repayment
    // =====================================================================

    /// §4.5 清单项：纯 cash 任务不产生 repayment 反馈
    function test_Settle_Passed_PureCashTask_WritesNoRepayment() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 0.5 ether);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);

        // the agent pays the provider entirely from its own cash — no loan
        _payProvider(agentId, DEMO_QUOTE, keccak256("cash-only"), _emptyAuth(), bytes(""), agentWallet);
        assertLoanStatus(taskId, ICreditManager.LoanStatus.None, "no loan opened");

        vm.prank(verifier);
        escrow.settle(taskId, true);

        assertEq(_feedbackCount(agentId, "task-success"), 1, "task success IS recorded");
        assertEq(_feedbackCount(agentId, "repayment"), 0, "but a repayment is NOT invented");
        assertEq(manager.repaymentCount(agentId), 0, "nor counted in the protocol ledger");
        assertFalse(
            escrow.pendingFeedback(taskId, FB_REPAYMENT), "and it must not be parked as pending either"
        );
    }

    /// The protocol's own ledger is the first source of truth (§6.1 step 2);
    /// reputation is only a mirror. Seven pure-cash successes must therefore
    /// still leave `repaymentCount == 0`, which is what keeps Tier A out of
    /// reach without real repayments (review r2 联调 #3).
    function test_SevenPureCashSuccesses_YieldZeroRepayments() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 5 ether);

        for (uint256 i; i < 7; i++) {
            uint256 taskId = _createTask(poster, DEMO_REWARD);
            _acceptTask(taskId, agentId, agentWallet);
            _payProvider(
                agentId,
                DEMO_QUOTE,
                keccak256(abi.encodePacked("cash", i)),
                _emptyAuth(),
                bytes(""),
                agentWallet
            );
            vm.prank(verifier);
            escrow.settle(taskId, true);
        }

        assertEq(_feedbackCount(agentId, "task-success"), 7, "seven successes");
        assertEq(manager.repaymentCount(agentId), 0, "zero repayments -> Tier A is unreachable");
    }

    // =====================================================================
    // review #5: a reputation failure must not roll back money
    // =====================================================================

    /// §4.5 清单项：feedback 失败不阻塞清算
    function test_Settle_Passed_ReputationFailureDoesNotRollBackSettlement() public {
        (uint256 agentId, uint256 taskId) = _successfulCreditTask();
        reputation.cheatSetFailing(true);

        vm.prank(verifier);
        escrow.settle(taskId, true);

        // money still moved, atomically
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "loan repaid regardless");
        assertEq(account.cash(agentId), DEMO_RESIDUE_1, "residue still paid out");
        assertTaskStatus(taskId, ITaskEscrow.TaskStatus.Settled, "task still settled");

        // and reputation is parked, not lost
        assertTrue(escrow.pendingFeedback(taskId, FB_TASK_SUCCESS), "parked");
        assertTrue(escrow.pendingFeedback(taskId, FB_REPAYMENT), "parked");
        assertEq(reputation.entryCount(), 0, "nothing reached the registry");
    }

    /// The same guarantee on the liquidation path: writing the "default" mark
    /// must not be able to block a liquidation.
    function test_Liquidation_ReputationFailureDoesNotBlockLiquidation() public {
        (uint256 agentId, uint256 taskId) = _successfulCreditTask();
        reputation.cheatSetFailing(true);

        vm.prank(verifier);
        escrow.settle(taskId, false);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "liquidation completed");
        assertEq(manager.defaultCount(agentId), 1, "protocol ledger recorded the default");
        assertTrue(manager.protocolFrozen(agentId), "agent frozen");
        assertEq(reputation.entryCount(), 0, "registry write failed, as injected");
    }

    /// A registry that burns all forwarded gas is the nastier failure mode a
    /// naive try/catch does not survive. The settlement must still stand.
    function test_Settle_Passed_ReputationOutOfGasDoesNotRollBackSettlement() public {
        (, uint256 taskId) = _successfulCreditTask();
        reputation.cheatSetOutOfGas(true);

        vm.prank(verifier);
        escrow.settle{gas: 1_500_000}(taskId, true);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "settlement survived");
        assertTrue(escrow.pendingFeedback(taskId, FB_REPAYMENT), "parked for retry");
    }

    // =====================================================================
    // retryFeedback: permissionless, idempotent per (taskId, type)
    // =====================================================================

    /// §4.5 清单项：retry 幂等
    function test_RetryFeedback_IsPermissionlessAndWritesExactlyOnce() public {
        (uint256 agentId, uint256 taskId) = _successfulCreditTask();
        reputation.cheatSetFailing(true);

        vm.prank(verifier);
        escrow.settle(taskId, true);
        assertTrue(escrow.pendingFeedback(taskId, FB_REPAYMENT), "parked");

        reputation.cheatSetFailing(false);

        vm.prank(stranger); // anyone may push it through
        escrow.retryFeedback(taskId, FB_REPAYMENT);

        assertEq(_feedbackCount(agentId, "repayment"), 1, "written once");
        assertFalse(escrow.pendingFeedback(taskId, FB_REPAYMENT), "no longer pending");
        assertTrue(escrow.feedbackSent(taskId, FB_REPAYMENT), "marked as sent");

        // a second retry must not create a duplicate entry.
        // Order matters: the feedback type is already cached, so `expectRevert`
        // is armed immediately before the only external call in this block.
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NoPendingFeedback.selector, taskId, FB_REPAYMENT));
        vm.prank(stranger);
        escrow.retryFeedback(taskId, FB_REPAYMENT);

        assertEq(_feedbackCount(agentId, "repayment"), 1, "still exactly one entry");
    }

    /// Retrying a type that was never parked must not fabricate reputation.
    function test_RevertWhen_RetryFeedbackWithNothingPending() public {
        (uint256 agentId, uint256 taskId) = _successfulCreditTask();

        vm.prank(verifier);
        escrow.settle(taskId, true); // both entries land immediately

        vm.expectRevert(
            abi.encodeWithSelector(ITaskEscrow.NoPendingFeedback.selector, taskId, FB_TASK_SUCCESS)
        );
        escrow.retryFeedback(taskId, FB_TASK_SUCCESS);

        assertEq(_feedbackCount(agentId, "task-success"), 1, "no duplicate");
    }

    /// A still-failing registry must leave the entry parked, not consume it.
    function test_RetryFeedback_StillFailing_StaysPending() public {
        (, uint256 taskId) = _successfulCreditTask();
        reputation.cheatSetFailing(true);

        vm.prank(verifier);
        escrow.settle(taskId, true);

        escrow.retryFeedback(taskId, FB_REPAYMENT);

        assertTrue(
            escrow.pendingFeedback(taskId, FB_REPAYMENT), "a failed retry must not clear the pending flag"
        );
    }

    function test_RevertWhen_RetryFeedbackWithUnknownType() public {
        (, uint256 taskId) = _successfulCreditTask();

        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.UnknownFeedbackType.selector, uint8(99)));
        escrow.retryFeedback(taskId, 99);
    }

    // =====================================================================
    // adapter access control
    // =====================================================================

    function test_RevertWhen_ReportFeedbackFromNonReporter() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.NotReporter.selector, stranger));
        adapter.reportFeedback(agentId, "repayment", 100, 0);
    }

    function test_RevertWhen_EnrollFromNonCreditManager() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.NotCreditManager.selector, stranger));
        adapter.enroll(agentId);
    }

    /// `reapprove` is the ONLY path that may bump the snapshot version (§4.1).
    function test_RevertWhen_ReapproveFromNonCreditManager() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.NotCreditManager.selector, stranger));
        adapter.reapprove(agentId);
    }
}
