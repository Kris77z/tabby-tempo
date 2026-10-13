// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount, REASON_AUTH_CALLER_MISMATCH} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";

/// @title Draw.t.sol — ENGINEERING §4.5 invariants I1–I7
/// @notice One test per invariant plus every §4.5 checklist line that lands on
///         the draw path. Test names carry the invariant id so a reviewer can
///         trace `test_..._I4` back to the clause it enforces.
///
/// Credit is only ever drawn through `AgentAccount.payProvider` (draw is
/// `onlyAgentAccount`), so these tests exercise the real tx3 path.
///
/// SPEC QUESTION Q1 (see contracts/TEST_PLAN.md): §4.3 defines
/// `SpendRejected.reason = 4` as 授权无效 (invalid authorization), while §4.5 requires I1–I7 to be
/// " require". These tests take the position that AgentAccount only raises
/// SpendRejected for what it can decide locally (whitelist / limits / freeze /
/// structurally-absent auth / auth.agentId mismatch) and lets the
/// CreditManager's I1–I7 custom errors bubble up unchanged — masking them all
/// behind reason 4 would make the invariants undiagnosable.
contract DrawTest is InferCreditTestBase {
    // =====================================================================
    // baseline: the happy path the invariants are carved out of
    // =====================================================================

    /// tx3 of §5: cash 0.04 + draw 0.08 → provider receives 0.12 atomically.
    function test_Draw_HappyPath_OpensLoanAndPaysProviderAtomically() public {
        Scenario memory s = _demoOrderOne();

        assertEq(s.principal, 0.08 ether, "principal = quote - cash");
        assertEq(s.fee, 0.012 ether, "fee = principal x 1500bps");

        ICreditManager.TaskLoan memory loan = manager.getLoan(s.taskId);
        assertEq(loan.agentId, s.agentId, "loan bound to agent");
        assertEq(loan.principal, 0.08 ether, "principal booked");
        assertEq(loan.fee, 0.012 ether, "fee frozen at draw time (review #2)");
        assertLoanStatus(s.taskId, ICreditManager.LoanStatus.Active, "loan is Active after draw");

        assertEq(_balanceOf(provider), DEMO_QUOTE, "provider paid the full quote in one tx");
        assertEq(account.cash(s.agentId), 0, "cash spent first");
        assertEq(manager.totalOutstanding(), 0.092 ether, "outstanding = principal + fee");

        IAgentAccount.PaymentRecord memory rec = account.getPayment(s.paymentId);
        assertEq(rec.agentId, s.agentId, "PaymentRecord.agentId is mandatory (r4 #4)");
        assertEq(rec.taskId, s.taskId, "PaymentRecord.taskId");
        assertEq(rec.fromCash, DEMO_SEED_CASH, "fromCash leg");
        assertEq(rec.fromCredit, 0.08 ether, "fromCredit leg");
        assertEq(rec.refundedAmount, 0, "nothing refunded yet");
    }

    // =====================================================================
    // EIP-712 wire format (§4.2 domain: name="InferCredit", version="1")
    // =====================================================================

    function test_DomainSeparatorMatchesSpec() public view {
        assertEq(
            manager.DOMAIN_SEPARATOR(),
            _domainSeparator(),
            "EIP-712 domain must be name=InferCredit version=1 chainId verifyingContract"
        );
    }

    function test_AuthorizationStructHashMatchesSpec() public {
        ICreditManager.CreditAuthorization memory a = _auth(1, 1, 1 ether, TIER_C_FEE_BPS, TIER_C);
        assertEq(manager.hashAuthorization(a), _hashAuth(a), "CreditAuthorization type hash drift");
    }

    // =====================================================================
    // I1 — !drawPaused && agent not protocol-frozen
    // =====================================================================

    function test_RevertWhen_DrawPaused_I1() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        vm.prank(guardian);
        manager.setDrawPaused(true);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(ICreditManager.DrawPaused.selector);
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a), agentWallet);
    }

    function test_RevertWhen_AgentProtocolFrozen_I1() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        vm.prank(guardian);
        manager.freezeAgent(agentId);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert();
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a), agentWallet);
    }

    /// A paused protocol must not block a payment that needs no credit at all.
    function test_PureCashPaymentUnaffectedByDrawPause_I1() public {
        (uint256 agentId,) = _standardSetup(DEMO_REWARD, DEMO_QUOTE);

        vm.prank(guardian);
        manager.setDrawPaused(true);

        ICreditManager.CreditAuthorization memory a = _emptyAuth();
        _payProvider(agentId, DEMO_QUOTE, keccak256("cashonly"), a, bytes(""), agentWallet);

        assertEq(_balanceOf(provider), DEMO_QUOTE, "pure cash payment must still go through");
    }

    // =====================================================================
    // I2 — signature valid, nonce unused, now <= authDeadline
    // =====================================================================

    /// §4.5 清单项：authDeadline 过期后 draw（I2）
    function test_RevertWhen_AuthDeadlineExpired_I2() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);

        vm.warp(a.authDeadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.AuthExpired.selector, a.authDeadline, a.authDeadline + 1)
        );
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, sig, agentWallet);
    }

    /// The boundary is inclusive: §4.2 says "draw ", §4.5 I2 says
    /// `block.timestamp <= authDeadline`. Exactly-at-deadline must SUCCEED.
    function test_DrawAtExactAuthDeadlineSucceeds_I2() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);

        vm.warp(a.authDeadline);
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, sig, agentWallet);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Active, "<= authDeadline is valid");
    }

    function test_RevertWhen_SignerIsNotUnderwriter_I2() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(ICreditManager.BadSignature.selector);
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, _sign(ROGUE_PK, a), agentWallet);
    }

    /// Tampering with any signed field must invalidate the signature. Covers
    /// the underwriter-key-is-a-systemic-single-point surface of RISK_AND_MVP §1.3 from the
    /// other side: a leaked *authorization* must not be editable.
    function test_RevertWhen_PrincipalCapTamperedAfterSigning_I2() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);

        // 0.09 keeps the tampered payload INSIDE I6 (0.09 x 1.15 = 0.1035 <= 0.12),
        // so the signature is the only thing wrong with it. Codex R2 review C:
        // a rejection test that violates two invariants at once silently
        // legislates an error precedence the spec declines to define.
        a.principalCap = 0.09 ether; // raise the cap after the fact

        vm.expectRevert(ICreditManager.BadSignature.selector);
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, sig, agentWallet);
    }

    // =====================================================================
    // I3 — double identity check (review r2 #2: BOTH, not either)
    // =====================================================================

    /// §4.5 清单项：身份轮换后旧 auth 复活（I3 版本号）
    /// After `reapprove` the snapshot version is bumped, which retroactively
    /// invalidates every authorization signed against the previous version —
    /// even though the live identity now matches the snapshot again.
    function test_RevertWhen_OldAuthReplayedAfterReapprove_I3() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);
        assertEq(a.identityVersion, 1, "enroll starts at version 1");

        // identity is transferred, then re-underwritten
        identity.cheatSetOwnerOnly(agentId, otherAgentOwner);
        vm.prank(guardian);
        manager.reapproveAgent(agentId);

        assertEq(adapter.snapshotVersion(agentId), 2, "reapprove increments the version");
        assertFalse(adapter.identityChanged(agentId), "snapshot is fresh again");

        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.IdentityVersionMismatch.selector, agentId, 2, 1)
        );
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, sig, agentWallet);
    }

    /// §4.5 清单项：换钱包但快照未刷新时 draw/pay 被实时校验拦截（I3 实时项，r2 #2）
    /// The version still matches — only the LIVE comparison can catch this.
    function test_RevertWhen_WalletRotatedAndSnapshotStale_I3() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);

        _bindWallet(agentId, agentOwner, AGENT_WALLET2_PK, block.timestamp + 1 hours);

        assertTrue(adapter.identityChanged(agentId), "live wallet now differs from the snapshot");
        assertEq(adapter.snapshotVersion(agentId), a.identityVersion, "version alone is NOT enough");

        vm.deal(agentWallet2, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.IdentityChanged.selector, agentId));
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, sig, agentWallet2);
    }

    /// Same clause, owner side: buying a high-score identity (RISK_AND_MVP §1.4).
    function test_RevertWhen_OwnerTransferredAndSnapshotStale_I3() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);

        identity.cheatSetOwnerOnly(agentId, otherAgentOwner);

        assertTrue(adapter.identityChanged(agentId), "owner change is an identity change");
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.IdentityChanged.selector, agentId));
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, sig, agentWallet);
    }

    /// The old wallet must lose access immediately, without waiting for a
    /// snapshot refresh — and this holds for a PURE CASH payment too (r2 #2).
    function test_RevertWhen_StaleWalletPaysWithCashOnly_I3() public {
        (uint256 agentId,) = _standardSetup(DEMO_REWARD, DEMO_QUOTE);

        _bindWallet(agentId, agentOwner, AGENT_WALLET2_PK, block.timestamp + 1 hours);

        ICreditManager.CreditAuthorization memory a = _emptyAuth();
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentWallet.selector, agentId, agentWallet));
        _payProvider(agentId, DEMO_QUOTE, keccak256("cashonly"), a, bytes(""), agentWallet);
    }

    // =====================================================================
    // I4 — task exists, Assigned, task.agentId == auth.agentId, before deadline
    // =====================================================================

    /// §4.5 清单项：拿他人的 auth 提款（I4 违反）
    /// Agent A holds a valid authorization naming A, but the taskId inside it
    /// belongs to agent B. task.agentId != auth.agentId must stop the draw.
    function test_RevertWhen_DrawWithForeignAuth_I4() public {
        _seedVault(VAULT_SEED);

        uint256 agentA = _registerAndEnroll(agentOwner, agentWallet);
        uint256 agentB = _registerAndEnroll(otherAgentOwner, otherAgentWallet);
        _setPermissivePolicy(agentA, agentOwner);
        _depositCash(agentA, agentOwner, DEMO_SEED_CASH);

        uint256 taskOfB = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskOfB, agentB, otherAgentWallet);

        // underwriter signs for A, but the task is B's
        ICreditManager.CreditAuthorization memory a =
            _auth(agentA, taskOfB, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.TaskAgentMismatch.selector, taskOfB, agentB, agentA)
        );
        _payProvider(agentA, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a), agentWallet);
    }

    /// The other half of "someone else's auth": the caller pays for its own
    /// agentId but presents an authorization issued to a different agent.
    /// §4.3 review #1 puts this check in payProvider → SpendRejected reason 5.
    function test_RevertWhen_AuthAgentIdDoesNotMatchCaller_Reason5() public {
        _seedVault(VAULT_SEED);

        uint256 agentA = _registerAndEnroll(agentOwner, agentWallet);
        uint256 agentB = _registerAndEnroll(otherAgentOwner, otherAgentWallet);
        _setPermissivePolicy(agentB, otherAgentOwner);
        _depositCash(agentB, otherAgentOwner, DEMO_SEED_CASH);

        uint256 taskOfB = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskOfB, agentB, otherAgentWallet);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentA, taskOfB, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentAccount.SpendRejected.selector, agentB, provider, REASON_AUTH_CALLER_MISMATCH
            )
        );
        _payProvider(agentB, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a), otherAgentWallet);
    }

    function test_RevertWhen_TaskStillOpen_I4() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);

        uint256 taskId = _createTask(poster, DEMO_REWARD); // never accepted

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.TaskNotAssigned.selector, taskId));
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a), agentWallet);
    }

    function test_RevertWhen_TaskDoesNotExist_I4() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, 999_999, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.TaskNotAssigned.selector, 999_999));
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, _signAuth(a), agentWallet);
    }

    /// §4.4: "acceptTask  draw  now < deadline".
    function test_RevertWhen_TaskDeadlinePassed_I4() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);
        uint256 deadline = escrow.getTask(taskId).deadline;

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        a.authDeadline = deadline + 1 days; // auth itself is still fresh
        bytes memory sig = _signAuth(a);

        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.TaskDeadlinePassed.selector, taskId, deadline));
        _payProvider(agentId, DEMO_QUOTE, keccak256("p1"), a, sig, agentWallet);
    }

    // =====================================================================
    // I5 — one draw per task; nonce AND taskId are both consumed
    // =====================================================================

    /// §4.5 清单项：同 task 二次 draw（I5）
    function test_RevertWhen_SecondDrawOnSameTask_I5() public {
        Scenario memory s = _demoOrderOne();

        _depositCash(s.agentId, agentOwner, 0.01 ether);
        ICreditManager.CreditAuthorization memory a2 =
            _auth(s.agentId, s.taskId, 0.02 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.LoanAlreadyExists.selector, s.taskId));
        _payProvider(s.agentId, 0.03 ether, keccak256("p2"), a2, _signAuth(a2), agentWallet);
    }

    /// §4.5 清单项：换 nonce 重置额度（I5）
    /// A brand-new nonce and a brand-new signature must still be refused,
    /// because the per-task loan slot — not the nonce — is the limiting resource.
    ///
    /// @dev Codex R2 review C: this used to sign `principalCap = 1 ether`, whose
    ///      debt of 1.15 also blows through I6's 0.12 ceiling for a 0.15 reward.
    ///      Demanding `LoanAlreadyExists` from a doubly-invalid input silently
    ///      legislated an I5-before-I6 error precedence that TEST_PLAN F14
    ///      explicitly declines to specify. Cap and amount are now both 0.08
    ///      (debt 0.092 <= 0.12), so the ONLY violated condition is I5. Driven
    ///      through `_drawDirect` so the AgentAccount's policy layer cannot add
    ///      a second failure reason either.
    function test_RevertWhen_FreshNonceReusedOnSameTask_I5() public {
        Scenario memory s = _demoOrderOne();

        ICreditManager.CreditAuthorization memory a2 =
            _auth(s.agentId, s.taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        assertTrue(a2.nonce != 0, "fresh, never-used nonce");
        assertFalse(manager.usedNonces(s.agentId, a2.nonce), "nonce really is unused");

        // the fixture must be valid for every invariant except I5
        uint256 maxDebt = (escrow.payableEscrow(s.taskId) * MAX_LTV_BPS) / BPS;
        assertLe((a2.principalCap * (BPS + TIER_C_FEE_BPS)) / BPS, maxDebt, "cap must satisfy I6 on its own");

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.LoanAlreadyExists.selector, s.taskId));
        _drawDirect(a2, _signAuth(a2), 0.08 ether);
    }

    /// The nonce half of I5: replaying the very same authorization on a
    /// different task must fail on the consumed nonce.
    /// @dev Deliberately driven through `_drawDirect` so that the ONLY invalid
    ///      input is the nonce. Routed through `payProvider` the agent's cash is
    ///      zero after the first order, so a 0.12 quote would need 0.12 of credit
    ///      against a 0.08 cap and the AgentAccount would reject it with
    ///      SpendRejected(reason 2) long before the Manager ever looked at the
    ///      nonce (Codex review R4). Here `amount == cap == 0.08` and everything
    ///      else is valid.
    function test_RevertWhen_NonceReplayedOnAnotherTask_I5() public {
        Scenario memory s = _demoOrderOne();

        uint256 task2 = _createTask(poster, DEMO_REWARD);
        _acceptTask(task2, s.agentId, agentWallet);

        assertTrue(manager.usedNonces(s.agentId, 1), "draw consumed the nonce");

        ICreditManager.CreditAuthorization memory a2 =
            _auth(s.agentId, task2, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        a2.nonce = 1; // reuse

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NonceAlreadyUsed.selector, s.agentId, 1));
        _drawDirect(a2, _signAuth(a2), 0.08 ether);
    }

    /// F15 positive case: nonces are a consumed-SET, not a monotonic counter.
    /// Consuming a large nonce first must not invalidate a smaller unused one.
    function test_SmallerUnusedNonceStillValidAfterLargerOne_I5() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);

        uint256 task1 = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(task1, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory big =
            _auth(agentId, task1, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        big.nonce = 500;
        _payProvider(agentId, 0.08 ether, keccak256("p1"), big, _signAuth(big), agentWallet);

        uint256 task2 = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(task2, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory small =
            _auth(agentId, task2, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        small.nonce = 7; // lower, but never consumed
        _payProvider(agentId, 0.08 ether, keccak256("p2"), small, _signAuth(small), agentWallet);

        assertLoanStatus(task2, ICreditManager.LoanStatus.Active, "unused nonces stay usable");
        assertTrue(manager.usedNonces(agentId, 500), "500 consumed");
        assertTrue(manager.usedNonces(agentId, 7), "7 consumed");
    }

    // =====================================================================
    // I6 — LTV / fee / protocol-fee arithmetic (review r2 #1)
    // =====================================================================

    /// §4.5 清单项：I6 LTV 数值回归 —— feeBps 计入债务、协议费先扣、/10_000 不缺位（r2 #1）
    ///
    /// Fixture: reward 1.0, protocolFee 5% → payable escrow 0.95,
    ///          MAX_LTV 80% → maxDebt 0.76.
    /// principalCap 0.66 @ 1500bps → debt 0.759 ≤ 0.76  → MUST SUCCEED.
    ///
    /// A implementation that forgets `/10_000` on the DEBT side computes
    /// 0.66e18 * 11_500 = 7.59e21, i.e. ten-thousand times too large, and would
    /// reject this draw — which is exactly what this test catches.
    function test_I6_BorderlineDrawSucceeds_DenominatorPresent() public {
        _setProtocolFee(500);
        _seedVault(VAULT_SEED);

        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, 1 ether);
        _acceptTask(taskId, agentId, agentWallet);

        uint256 principalCap = 0.66 ether;
        uint256 expectedDebt = (principalCap * (BPS + TIER_C_FEE_BPS)) / BPS;
        uint256 maxDebt = ((1 ether - (1 ether * 500) / BPS) * MAX_LTV_BPS) / BPS;
        assertEq(expectedDebt, 0.759 ether, "debt side of I6");
        assertEq(maxDebt, 0.76 ether, "escrow side of I6");
        assertTrue(expectedDebt <= maxDebt, "fixture must sit just inside the bound");

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, principalCap, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, principalCap, keccak256("p1"), a, _signAuth(a), agentWallet);

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal + loan.fee, 0.759 ether, "booked debt matches the I6 arithmetic");
    }

    /// §4.5 清单项：principalCap 超 escrow LTV（I6）
    ///
    /// Same fixture, principalCap 0.67 @ 1500bps → debt 0.7705 > 0.76 → REJECT.
    /// This single case simultaneously catches three distinct mis-implementations:
    ///   (a) fee left out of the debt side       → 0.67  <= 0.76  → wrongly accepted
    ///   (b) protocol fee not deducted first     → 0.7705 <= 0.80 → wrongly accepted
    ///   (c) `/10_000` missing on the ESCROW side→ 0.7705 <= 7.6e21 → wrongly accepted
    function test_RevertWhen_PrincipalCapExceedsEscrowLtv_I6() public {
        _setProtocolFee(500);
        _seedVault(VAULT_SEED);

        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, 1 ether);
        _acceptTask(taskId, agentId, agentWallet);

        uint256 principalCap = 0.67 ether;
        uint256 debt = (principalCap * (BPS + TIER_C_FEE_BPS)) / BPS;
        uint256 maxDebt = ((1 ether - (1 ether * 500) / BPS) * MAX_LTV_BPS) / BPS;
        assertEq(debt, 0.7705 ether, "debt just over the bound");
        assertEq(maxDebt, 0.76 ether, "bound");

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, principalCap, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.DebtExceedsEscrowLtv.selector, debt, maxDebt));
        _payProvider(agentId, principalCap, keccak256("p1"), a, _signAuth(a), agentWallet);
    }

    /// I6 is evaluated against `principalCap`, not against the amount actually
    /// drawn — an over-large signed cap must be rejected even when the agent
    /// only intends to draw a small amount. (§4.5 I6 writes principalCap on the
    /// left-hand side, deliberately: the underwriter pre-clips it, §6.1 step 5.)
    function test_RevertWhen_CapTooLargeEvenIfDrawIsSmall_I6() public {
        _setProtocolFee(500);
        _seedVault(VAULT_SEED);

        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, 1 ether);
        _acceptTask(taskId, agentId, agentWallet);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.9 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert();
        _payProvider(agentId, 0.01 ether, keccak256("p1"), a, _signAuth(a), agentWallet);
    }

    /// Defence in depth: the AgentAccount already min-caps the draw against
    /// `auth.principalCap` (§4.3, tested in SpendPolicy.t.sol as reason 2), but
    /// the CreditManager must refuse an over-cap draw on its own too — otherwise
    /// I6's first clause is enforced in exactly one place.
    function test_RevertWhen_AmountExceedsPrincipalCap_I6() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, 0);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.05 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.AmountExceedsPrincipalCap.selector, 0.06 ether, 0.05 ether)
        );
        _drawDirect(a, _signAuth(a), 0.06 ether);
    }

    /// The fee is frozen at draw time against the ACTUAL amount drawn, not
    /// against the cap (review #2: " draw ").
    function test_FeeIsChargedOnActualDrawNotOnCap_I6() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, 0.02 ether);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.1 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.06 ether, keccak256("p1"), a, _signAuth(a), agentWallet);

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0.04 ether, "drew only the shortfall");
        assertEq(loan.fee, 0.006 ether, "fee = 0.04 x 1500bps, NOT 0.1 x 1500bps");
    }

    // =====================================================================
    // I7 — the two global caps (RISK_AND_MVP §1.3)
    // =====================================================================

    function test_RevertWhen_TotalOutstandingCapExceeded_I7() public {
        _seedVault(VAULT_SEED);
        vm.prank(deployer);
        manager.setGlobalLimits(0.05 ether, MAX_DRAW_PER_EPOCH);

        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(
            abi.encodeWithSelector(
                ICreditManager.TotalOutstandingCapExceeded.selector, 0.092 ether, 0.05 ether
            )
        );
        _drawDirect(a, _signAuth(a), 0.08 ether);
    }

    function test_RevertWhen_EpochDrawCapExceeded_I7() public {
        _seedVault(VAULT_SEED);
        vm.prank(deployer);
        manager.setGlobalLimits(MAX_TOTAL_OUTSTANDING, 0.05 ether);

        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.EpochDrawCapExceeded.selector, 0.08 ether, 0.05 ether)
        );
        _drawDirect(a, _signAuth(a), 0.08 ether);
    }

    /// The epoch counter must actually be per-epoch: the same draw that is
    /// refused now must succeed one day later.
    function test_EpochBudgetResetsNextEpoch_I7() public {
        _seedVault(VAULT_SEED);
        vm.prank(deployer);
        manager.setGlobalLimits(MAX_TOTAL_OUTSTANDING, 0.1 ether);

        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);

        uint256 task1 = _createTask(poster, DEMO_REWARD);
        _acceptTask(task1, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory a1 =
            _auth(agentId, task1, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.08 ether, keccak256("p1"), a1, _signAuth(a1), agentWallet);

        uint256 epoch = block.timestamp / EPOCH_LENGTH;
        assertEq(manager.drawnInEpoch(epoch), 0.08 ether, "epoch counter tracks principal drawn");

        uint256 task2 = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(task2, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory a2 =
            _auth(agentId, task2, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert();
        _payProvider(agentId, 0.08 ether, keccak256("p2"), a2, _signAuth(a2), agentWallet);

        vm.warp(block.timestamp + EPOCH_LENGTH);
        ICreditManager.CreditAuthorization memory a3 =
            _auth(agentId, task2, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.08 ether, keccak256("p3"), a3, _signAuth(a3), agentWallet);

        assertLoanStatus(task2, ICreditManager.LoanStatus.Active, "new epoch, fresh budget");
    }

    /// The vault can never lend money it does not have; the backstop pot is
    /// booked separately and is NEVER lendable (§4.2).
    function test_RevertWhen_VaultHasNoLendableLiquidity() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _fundBackstop(agentId, agentOwner, 10 ether); // backstop only, no deposit

        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.expectRevert(abi.encodeWithSelector(ICreditManager.InsufficientLiquidity.selector, 0.08 ether, 0));
        _drawDirect(a, _signAuth(a), 0.08 ether);
    }

    // =====================================================================
    // access control on the draw entry point
    // =====================================================================

    function test_RevertWhen_DrawCalledDirectlyByEOA() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotAgentAccount.selector, agentWallet));
        manager.draw(a, _signAuth(a), 0.08 ether);
    }
}
