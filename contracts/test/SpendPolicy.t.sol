// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {
    IAgentAccount,
    REASON_NOT_WHITELISTED,
    REASON_OVER_LIMIT,
    REASON_FROZEN,
    REASON_INVALID_AUTH,
    REASON_AUTH_CALLER_MISMATCH
} from "../src/interfaces/IAgentAccount.sol";

/// @title SpendPolicy.t.sol — ENGINEERING §4.3 + RISK_AND_MVP §5.2
/// @notice Three groups:
///   - the two independent freeze bits (`ownerFrozen` vs `protocolFrozen`) and
///     the rule that an agent owner can never clear the protocol's (review #9);
///   - the exact `SpendRejected(agentId, target, reason)` revert data for every
///     reason code, because the reverse demo decodes it in the frontend
///     (review #10: a revert rolls back logs, so an event would never arrive);
///   - 永远取三者最小值: policy cap vs auth.principalCap vs global headroom.
contract SpendPolicyTest is InferCreditTestBase {
    function _readyAgent() internal returns (uint256 agentId, uint256 taskId) {
        _seedVault(VAULT_SEED);
        agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);
    }

    // =====================================================================
    // reason 1 — provider not whitelisted (RISK_AND_MVP §1.1 / §7 reverse demo)
    // =====================================================================

    /// §4.5 清单项：SpendRejected 各 reason 的 revert data（reason 1）
    /// This is the reverse demo of TRACK_NARRATIVE: borrowed money sent to a
    /// non-whitelisted address must revert, and the frontend must be able to
    /// decode WHY out of the revert data.
    function test_RevertWhen_ProviderNotWhitelisted_Reason1() public {
        (uint256 agentId, uint256 taskId) = _readyAgent();
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, evilProvider, REASON_NOT_WHITELISTED
            )
        );
        account.payProvider(agentId, evilProvider, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a));
    }

    /// Pure-cash spending is purpose-bound too: the whitelist is not a
    /// credit-only control.
    function test_RevertWhen_PureCashToNonWhitelistedProvider_Reason1() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, evilProvider, REASON_NOT_WHITELISTED
            )
        );
        account.payProvider(agentId, evilProvider, 0.01 ether, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    function test_RemovingAProviderFromTheWhitelistTakesEffectImmediately() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(deployer);
        account.setProviderWhitelist(provider, false);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, provider, REASON_NOT_WHITELISTED
            )
        );
        account.payProvider(agentId, provider, 0.01 ether, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    // =====================================================================
    // reason 2 — over limit (the three-layer min, RISK_AND_MVP §5.2)
    // =====================================================================

    /// Layer 1: the agent owner's own per-tx debt cap.
    function test_RevertWhen_CreditExceedsPolicyMaxDebtPerTx_Reason2() public {
        (uint256 agentId, uint256 taskId) = _readyAgent();
        _setPolicy(agentId, agentOwner, type(uint256).max, 0.05 ether, type(uint256).max, false);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        // needs 0.08 of credit, policy allows 0.05
        account.payProvider(agentId, provider, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a));
    }

    /// Layer 2: the underwriter's signed cap. Reaching it through payProvider
    /// must surface as reason 2, since §4.3 folds `auth.principalCap` into the
    /// same min. (The CreditManager's own duplicate check is asserted in
    /// Draw.t.sol via a direct `draw` call.)
    function test_RevertWhen_CreditExceedsAuthPrincipalCap_Reason2() public {
        (uint256 agentId, uint256 taskId) = _readyAgent();

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.05 ether, TIER_C_FEE_BPS, TIER_C);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        // cash 0.04 + needed credit 0.08 > signed cap 0.05
        account.payProvider(agentId, provider, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a));
    }

    /// The min really is a MIN: the smallest of the three binds even when the
    /// other two are generous.
    function test_SmallestOfTheThreeLimitsBinds() public {
        (uint256 agentId, uint256 taskId) = _readyAgent();
        _setPolicy(agentId, agentOwner, type(uint256).max, 0.06 ether, type(uint256).max, false);

        // policy 0.06 | auth cap 0.07 | global headroom 20 -> effective 0.06
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.07 ether, TIER_C_FEE_BPS, TIER_C);

        // 0.04 cash + 0.06 credit == 0.10 is exactly at the limit: allowed
        _payProvider(agentId, 0.1 ether, keccak256("p1"), a, _signAuth(a), agentWallet);
        assertEq(manager.getLoan(taskId).principal, 0.06 ether, "drew exactly the effective limit");
    }

    function test_RevertWhen_CashSpendExceedsMaxCashPerTx_Reason2() public {
        (uint256 agentId,) = _readyAgent();
        _setPolicy(agentId, agentOwner, 0.01 ether, type(uint256).max, type(uint256).max, false);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        account.payProvider(agentId, provider, 0.02 ether, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    /// `maxDebtPerDay` accumulates across transactions within the same day.
    function test_RevertWhen_DailyDebtBudgetExhausted_Reason2() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPolicy(agentId, agentOwner, type(uint256).max, 1 ether, 0.1 ether, false);

        uint256 task1 = _createTask(poster, 1 ether, 30 days);
        _acceptTask(task1, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory a1 =
            _auth(agentId, task1, 0.07 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.07 ether, keccak256("p1"), a1, _signAuth(a1), agentWallet);

        uint256 task2 = _createTask(poster, 1 ether, 30 days);
        _acceptTask(task2, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory a2 =
            _auth(agentId, task2, 0.07 ether, TIER_C_FEE_BPS, TIER_C);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        // 0.07 + 0.07 > 0.1 daily budget
        account.payProvider(agentId, provider, 0.07 ether, keccak256("p2"), a2, _signAuth(a2));
    }

    function test_DailyDebtBudgetResetsNextDay() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPolicy(agentId, agentOwner, type(uint256).max, 1 ether, 0.1 ether, false);

        uint256 task1 = _createTask(poster, 1 ether, 30 days);
        _acceptTask(task1, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory a1 =
            _auth(agentId, task1, 0.07 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.07 ether, keccak256("p1"), a1, _signAuth(a1), agentWallet);

        vm.warp(block.timestamp + 1 days);

        uint256 task2 = _createTask(poster, 1 ether, 30 days);
        _acceptTask(task2, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory a2 =
            _auth(agentId, task2, 0.07 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.07 ether, keccak256("p2"), a2, _signAuth(a2), agentWallet);

        assertLoanStatus(task2, ICreditManager.LoanStatus.Active, "fresh daily budget");
    }

    // =====================================================================
    // reason 3 — frozen, and the two independent freeze bits (review #9)
    // =====================================================================

    function test_RevertWhen_OwnerFrozen_Reason3() public {
        (uint256 agentId,) = _readyAgent();
        _setPolicy(agentId, agentOwner, type(uint256).max, type(uint256).max, type(uint256).max, true);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_FROZEN)
        );
        account.payProvider(agentId, provider, 0.01 ether, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    function test_RevertWhen_ProtocolFrozen_Reason3() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(guardian);
        manager.freezeAgent(agentId);
        assertTrue(account.protocolFrozen(agentId), "the freeze is mirrored onto the account");

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_FROZEN)
        );
        account.payProvider(agentId, provider, 0.01 ether, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    /// §4.5 清单项：owner 解冻不能绕过协议冻结
    /// The two bits are stored separately precisely so that an agent owner
    /// rewriting its own Policy cannot clear the protocol's risk control.
    function test_OwnerCannotClearProtocolFreezeByRewritingPolicy() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(guardian);
        manager.freezeAgent(agentId);

        // the owner "unfreezes" itself
        _setPermissivePolicy(agentId, agentOwner);
        assertFalse(account.getPolicy(agentId).ownerFrozen, "owner bit is indeed cleared");
        assertTrue(account.protocolFrozen(agentId), "protocol bit survives");

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_FROZEN)
        );
        account.payProvider(agentId, provider, 0.01 ether, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    /// Symmetrically: only the guardian may write the protocol bit.
    function test_RevertWhen_SetProtocolFrozenCalledByStranger() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotCreditManager.selector, stranger));
        account.setProtocolFrozen(agentId, false);
    }

    function test_RevertWhen_FreezeAgentCalledByStranger() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotGuardian.selector, stranger));
        manager.freezeAgent(agentId);
    }

    /// Clearing the owner bit alone must restore spending when the protocol bit
    /// was never set — the two bits are independent, not a single flag.
    function test_OwnerCanUnfreezeItsOwnBit() public {
        (uint256 agentId,) = _readyAgent();
        _setPolicy(agentId, agentOwner, type(uint256).max, type(uint256).max, type(uint256).max, true);
        _setPermissivePolicy(agentId, agentOwner);

        _payProvider(agentId, 0.01 ether, keccak256("p1"), _emptyAuth(), bytes(""), agentWallet);
        assertEq(_balanceOf(provider), 0.01 ether, "spending works again");
    }

    /// TEST_PLAN G4 (Codex ruling): a manual unfreeze is an operational decision,
    /// never a rewrite of credit history. It must clear the freeze bit and
    /// NOTHING else — the default count, the loan's terminal state and the
    /// reputation trail all survive it.
    function test_UnfreezeDoesNotEraseDefaultHistory() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
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
        assertEq(manager.defaultCount(agentId), 1, "the default happened");

        vm.prank(guardian);
        manager.unfreezeAgent(agentId);

        assertFalse(manager.protocolFrozen(agentId), "the freeze bit is cleared");
        assertFalse(account.protocolFrozen(agentId), "and mirrored onto the account");
        assertEq(manager.defaultCount(agentId), 1, "but the default count is NOT rewritten");
        assertLoanStatus(taskId, ICreditManager.LoanStatus.Defaulted, "nor the loan's terminal state");
        assertEq(_feedbackCount(agentId, "default"), 1, "nor the on-chain reputation trail");
        assertEq(manager.repaymentCount(agentId), 0, "and it certainly is not a repayment");
    }

    /// Unfreezing must not silently refresh the identity snapshot either — that
    /// is `reapproveAgent`'s job, and conflating them would let a guardian
    /// re-enable credit for an identity that has since changed hands.
    function test_UnfreezeDoesNotRefreshTheIdentitySnapshot() public {
        (uint256 agentId,) = _readyAgent();
        uint64 versionBefore = adapter.snapshotVersion(agentId);

        identity.cheatSetOwnerOnly(agentId, otherAgentOwner);
        vm.prank(guardian);
        manager.freezeAgent(agentId);
        vm.prank(guardian);
        manager.unfreezeAgent(agentId);

        assertEq(adapter.snapshotVersion(agentId), versionBefore, "version untouched");
        assertTrue(adapter.identityChanged(agentId), "the identity is still stale");
    }

    function test_RevertWhen_UnfreezeCalledByStranger() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotGuardian.selector, stranger));
        manager.unfreezeAgent(agentId);
    }

    // =====================================================================
    // reason 4 / 5 — authorization problems
    // =====================================================================

    /// §4.3 reason 4（授权无效）: credit is required but no usable authorization
    /// was supplied at all. Everything that needs chain state to decide
    /// (signature, nonce, identity, task) is the CreditManager's job — see
    /// SPEC QUESTION Q1 in contracts/TEST_PLAN.md.
    function test_RevertWhen_CreditNeededButAuthIsEmpty_Reason4() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, provider, REASON_INVALID_AUTH
            )
        );
        // cash is only 0.04, so 0.12 needs credit — but no auth was given
        account.payProvider(agentId, provider, DEMO_QUOTE, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    function test_RevertWhen_CreditNeededButSignatureIsMalformed_Reason4() public {
        (uint256 agentId, uint256 taskId) = _readyAgent();
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, provider, REASON_INVALID_AUTH
            )
        );
        account.payProvider(agentId, provider, DEMO_QUOTE, keccak256("p1"), a, hex"dead");
    }

    /// §4.3 review #1, reason 5 — see also
    /// Draw.t.sol::test_RevertWhen_AuthAgentIdDoesNotMatchCaller_Reason5.
    function test_RevertWhen_AuthIsForAnotherAgent_Reason5() public {
        (uint256 agentId, uint256 taskId) = _readyAgent();

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId + 999, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.prank(agentWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentId, provider, REASON_AUTH_CALLER_MISMATCH
            )
        );
        account.payProvider(agentId, provider, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a));
    }

    // =====================================================================
    // caller authentication (§4.3 onlyAgentWallet, live registry read)
    // =====================================================================

    function test_RevertWhen_PayProviderCalledByAgentOwnerInsteadOfWallet() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(agentOwner); // the owner is not the operational wallet
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentWallet.selector, agentId, agentOwner));
        account.payProvider(agentId, provider, 0.01 ether, keccak256("p1"), _emptyAuth(), bytes(""));
    }

    function test_RevertWhen_SetPolicyCalledByNonOwner() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(agentWallet); // the wallet spends, the OWNER sets policy
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentOwner.selector, agentId, agentWallet));
        account.setPolicy(
            agentId,
            IAgentAccount.Policy({maxCashPerTx: 0, maxDebtPerTx: 0, maxDebtPerDay: 0, ownerFrozen: false})
        );
    }

    // =====================================================================
    // payment bookkeeping
    // =====================================================================

    /// `paymentId` binds the payment to exactly one relay quote (review #6),
    /// so it must not be reusable for a second payment.
    function test_RevertWhen_PaymentIdReused() public {
        (uint256 agentId,) = _readyAgent();
        bytes32 paymentId = keccak256("quote-1");

        _payProvider(agentId, 0.01 ether, paymentId, _emptyAuth(), bytes(""), agentWallet);

        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.PaymentIdAlreadyUsed.selector, paymentId));
        account.payProvider(agentId, provider, 0.01 ether, paymentId, _emptyAuth(), bytes(""));
    }

    /// Protocol-only entry points must be closed to outsiders, otherwise anyone
    /// could mint cash or drain an account.
    function test_RevertWhen_CreditCashCalledByStranger() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotProtocol.selector, stranger));
        account.creditCash{value: _val(1 ether)}(agentId, 1 ether);
    }

    function test_RevertWhen_DebitForLiquidationCalledByStranger() public {
        (uint256 agentId,) = _readyAgent();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotCreditManager.selector, stranger));
        account.debitForLiquidation(agentId, 1 ether);
    }

    function test_RevertWhen_RegisterRefundCalledByStranger() public {
        (uint256 agentId,) = _readyAgent();
        bytes32 paymentId = keccak256("quote-1");
        _payProvider(agentId, 0.01 ether, paymentId, _emptyAuth(), bytes(""), agentWallet);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotCreditManager.selector, stranger));
        account.registerRefund(paymentId, keccak256("r1"), 0.01 ether);
    }

    /// ENGINEERING §3: native mode must reject a `msg.value` that disagrees with
    /// the declared amount, in BOTH directions.
    function test_RevertWhen_DepositCashValueMismatch_NativeMode() public {
        vm.skip(_useErc20()); // the ERC-20 half lives in Erc20PairingTest
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.ValueMismatch.selector, 1 ether, 0.5 ether));
        account.depositCash{value: 0.5 ether}(agentId, 1 ether);
    }
}
