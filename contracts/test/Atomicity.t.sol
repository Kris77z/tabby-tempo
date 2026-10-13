// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {ReentrancyGuard} from "../src/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "../src/utils/SafeTransferLib.sol";
import {RejectingProvider, ReentrantAgent, ReentrantPoster} from "./mocks/MaliciousActors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title Atomicity.t.sol — payment failure rolls everything back; re-entry fails
/// @notice Codex review R6. Two gaps in the original suite:
///
///   1. The happy path paid an EOA, which cannot reject funds, so nothing ever
///      exercised "draw succeeded but the payment leg failed". RISK_AND_MVP §5.1
///      requires draw + pay to be atomic; that is only meaningful if a failing
///      pay actually unwinds the draw. Six ledgers must all revert together:
///      cash, vault liquidity, the loan record, the nonce, the paymentId and the
///      epoch/outstanding counters — and the physical asset balances with them.
///
///   2. The two "NoDeadlock" tests only prove the normal path completes. They
///      cannot detect a missing guard, because nothing re-enters. These tests
///      use receivers that actively call back.
contract AtomicityTest is InferCreditTestBase {
    RejectingProvider internal badProvider;
    ReentrantAgent internal evilAgent;

    function setUp() public virtual override {
        super.setUp();
        badProvider = new RejectingProvider();
        evilAgent = new ReentrantAgent(IAgentAccount(address(account)));

        vm.startPrank(deployer);
        account.setProviderWhitelist(address(badProvider), true);
        account.setProviderWhitelist(address(evilAgent), true);
        vm.stopPrank();
    }

    /// @notice Register an agent whose REGISTRY WALLET is the attacker contract.
    /// @dev Codex R2 review B: unless the re-entrant caller is the agent's own
    ///      wallet, `onlyAgentWallet` rejects the inner call and a "reentrancy"
    ///      test would pass even with the guard deleted. Here every precondition
    ///      of the inner `payProvider` holds except the guard.
    function _evilAgentSetup(uint256 cash) internal returns (uint256 agentId) {
        agentId = _registerAndEnroll(agentOwner, address(evilAgent));
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, cash);
        vm.deal(address(evilAgent), 1 ether); // gas only
    }

    /// @dev Snapshot of everything a failed payment must restore.
    struct Ledger {
        uint256 cash;
        uint256 vaultBalance;
        uint256 totalOutstanding;
        uint256 drawnInEpoch;
        uint256 debtSpentInDay;
        uint8 loanStatus;
        bool nonceUsed;
        uint256 managerAssets;
        uint256 accountAssets;
        uint256 paymentFromCash;
        uint256 paymentFromCredit;
    }

    function _snapshot(uint256 agentId, uint256 taskId, uint256 nonce, bytes32 paymentId)
        internal
        view
        returns (Ledger memory l)
    {
        IAgentAccount.PaymentRecord memory rec = account.getPayment(paymentId);
        l = Ledger({
            cash: account.cash(agentId),
            vaultBalance: manager.vaultBalance(),
            totalOutstanding: manager.totalOutstanding(),
            drawnInEpoch: manager.drawnInEpoch(block.timestamp / EPOCH_LENGTH),
            debtSpentInDay: account.debtSpentInDay(agentId, block.timestamp / 1 days),
            loanStatus: uint8(manager.getLoan(taskId).status),
            nonceUsed: manager.usedNonces(agentId, nonce),
            managerAssets: _balanceOf(address(manager)),
            accountAssets: _balanceOf(address(account)),
            paymentFromCash: rec.fromCash,
            paymentFromCredit: rec.fromCredit
        });
    }

    function _assertLedgerUnchanged(Ledger memory before, Ledger memory afterL) internal pure {
        assertEq(afterL.cash, before.cash, "cash must be restored");
        assertEq(afterL.vaultBalance, before.vaultBalance, "vault ledger must be restored");
        assertEq(afterL.totalOutstanding, before.totalOutstanding, "outstanding must be restored");
        assertEq(afterL.drawnInEpoch, before.drawnInEpoch, "epoch counter must be restored");
        assertEq(afterL.debtSpentInDay, before.debtSpentInDay, "daily policy budget must be restored");
        assertEq(afterL.loanStatus, before.loanStatus, "no loan may survive a failed payment");
        assertEq(afterL.nonceUsed, before.nonceUsed, "the nonce must NOT be burned");
        assertEq(afterL.managerAssets, before.managerAssets, "manager's real balance must be restored");
        assertEq(afterL.accountAssets, before.accountAssets, "account's real balance must be restored");
        assertEq(afterL.paymentFromCash, before.paymentFromCash, "no PaymentRecord may survive");
        assertEq(afterL.paymentFromCredit, before.paymentFromCredit, "no PaymentRecord may survive");
    }

    function _blockProvider(address who) internal {
        if (_useErc20()) token.cheatSetBlocked(who, true);
    }

    function _expectProviderFailure(address who, uint256 amount) internal {
        if (_useErc20()) {
            vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, who));
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(SafeTransferLib.NativeTransferFailed.selector, who, amount)
            );
        }
    }

    // =====================================================================
    // failed payment leg → full rollback
    // =====================================================================

    /// Draw + pay must be one indivisible step (RISK_AND_MVP §5.1).
    function test_PaymentLegFailure_RollsBackEveryLedger() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);
        bytes32 paymentId = keccak256("doomed");

        _blockProvider(address(badProvider));
        Ledger memory before = _snapshot(agentId, taskId, a.nonce, paymentId);

        vm.prank(agentWallet);
        _expectProviderFailure(address(badProvider), DEMO_QUOTE);
        account.payProvider(agentId, address(badProvider), DEMO_QUOTE, paymentId, a, sig);

        _assertLedgerUnchanged(before, _snapshot(agentId, taskId, a.nonce, paymentId));
        assertEq(_balanceOf(address(badProvider)), 0, "the provider received nothing");
    }

    /// And the authorization must still be spendable afterwards: a failed
    /// delivery attempt cannot cost the agent its underwriting.
    function test_AfterPaymentLegFailure_SameAuthorizationStillWorks() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);

        _blockProvider(address(badProvider));
        vm.prank(agentWallet);
        _expectProviderFailure(address(badProvider), DEMO_QUOTE);
        account.payProvider(agentId, address(badProvider), DEMO_QUOTE, keccak256("doomed"), a, sig);

        // retry against a provider that can actually receive
        _payProvider(agentId, DEMO_QUOTE, keccak256("retry"), a, sig, agentWallet);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Active, "the retry succeeds");
        assertEq(_balanceOf(provider), DEMO_QUOTE, "the good provider is paid in full");
        assertTrue(manager.usedNonces(agentId, a.nonce), "the nonce is consumed exactly once, here");
    }

    /// A pure-cash payment has no draw to unwind, but the cash must still come
    /// back and the paymentId must stay free.
    function test_PureCashPaymentLegFailure_RollsBack() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 0.5 ether);

        bytes32 paymentId = keccak256("doomed-cash");
        _blockProvider(address(badProvider));

        vm.prank(agentWallet);
        _expectProviderFailure(address(badProvider), 0.2 ether);
        account.payProvider(agentId, address(badProvider), 0.2 ether, paymentId, _emptyAuth(), bytes(""));

        assertEq(account.cash(agentId), 0.5 ether, "cash restored");
        assertEq(account.getPayment(paymentId).agentId, 0, "paymentId not consumed");

        // the same paymentId is still usable against a working provider
        _payProvider(agentId, 0.2 ether, paymentId, _emptyAuth(), bytes(""), agentWallet);
        assertEq(account.cash(agentId), 0.3 ether, "and the retry goes through");
    }

    /// The vault must not leak: if the payment fails after the Manager pushed
    /// funds to the Account, the physical balances must end where they started.
    function test_PaymentLegFailure_NoAssetsStrandedInTheAccount() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);

        uint256 managerBefore = _balanceOf(address(manager));
        uint256 accountBefore = _balanceOf(address(account));

        _blockProvider(address(badProvider));
        vm.prank(agentWallet);
        _expectProviderFailure(address(badProvider), DEMO_QUOTE);
        account.payProvider(agentId, address(badProvider), DEMO_QUOTE, keccak256("d"), a, _signAuth(a));

        assertEq(_balanceOf(address(manager)), managerBefore, "vault assets intact");
        assertEq(_balanceOf(address(account)), accountBefore, "no dust stranded in the account");
        assertEq(
            manager.vaultBalance(),
            _balanceOf(address(manager)) - manager.backstopTotal(),
            "ledger and real balance agree"
        );
    }

    // =====================================================================
    // active re-entry
    // =====================================================================

    /// The guard itself, proved exactly.
    ///
    /// Codex R2 review B: `SafeTransferLib.safeTransferNative` discards the
    /// callee's revert data and throws `NativeTransferFailed`, so an outer
    /// `expectRevert(ReentrantCall.selector)` can never match even when the
    /// guard works perfectly. The attacker therefore makes the inner call with a
    /// low-level `call`, records the selector and returns normally — the outer
    /// payment completes and the test asserts the exact inner error.
    ///
    /// The attacker is the agent's registry wallet AND a whitelisted provider,
    /// so if the guard were removed the inner call would SUCCEED and every
    /// assertion below would fail. That is what makes this a guard test rather
    /// than an authentication test.
    ///
    /// Runs in both settlement modes: native via `receive`, ERC-20 via a
    /// deliberately hostile token hook (a standard ERC-20 has no such callback).
    function test_ReentrancyGuardIsArmedOnPayProvider() public {
        uint256 agentId = _evilAgentSetup(1 ether);
        if (_useErc20()) token.cheatSetTransferHook(address(evilAgent), address(evilAgent));

        evilAgent.arm(agentId, keccak256("inner"), 0.01 ether, true); // swallow & record
        uint256 paidBefore = _balanceOf(address(evilAgent));

        evilAgent.attack(address(evilAgent), 0.05 ether, keccak256("outer"));

        assertTrue(evilAgent.fired(), "the callback really ran - otherwise this proves nothing");
        assertFalse(evilAgent.innerSucceeded(), "the re-entrant payment must NOT go through");
        assertEq(
            evilAgent.innerError(),
            ReentrancyGuard.ReentrantCall.selector,
            "and it must be stopped by the reentrancy guard specifically"
        );

        // exactly one payment happened
        assertEq(account.cash(agentId), 0.95 ether, "only the outer 0.05 left the account");
        assertEq(
            _balanceOf(address(evilAgent)) - paidBefore,
            0.05 ether,
            "the provider was paid exactly once, not twice"
        );
        assertEq(account.getPayment(keccak256("outer")).fromCash, 0.05 ether, "outer recorded");
        assertEq(account.getPayment(keccak256("inner")).agentId, 0, "inner never recorded");
    }

    /// The same attack with the inner error left to propagate: the callback
    /// reverts, so the payment leg fails and the whole outer call unwinds.
    ///
    /// Native only. `SafeTransferLib` wraps the inner failure, so the caller
    /// sees `NativeTransferFailed(to, amount)` — not `ReentrantCall` (Codex R2
    /// review B; the exact inner error is pinned by the test above instead).
    function test_RevertWhen_ProviderReentersPayProvider() public {
        vm.skip(_useErc20()); // a standard ERC-20 gives the receiver no callback
        uint256 agentId = _evilAgentSetup(1 ether);

        evilAgent.arm(agentId, keccak256("reenter"), 0.01 ether, false); // propagate

        vm.expectRevert(
            abi.encodeWithSelector(
                SafeTransferLib.NativeTransferFailed.selector, address(evilAgent), 0.05 ether
            )
        );
        evilAgent.attack(address(evilAgent), 0.05 ether, keccak256("outer"));

        assertEq(account.cash(agentId), 1 ether, "nothing moved");
        assertEq(account.getPayment(keccak256("outer")).agentId, 0, "outer payment rolled back");
        assertEq(account.getPayment(keccak256("reenter")).agentId, 0, "inner payment never happened");
    }

    /// Codex R2 review A: the positive counterpart. A plain ERC-20 transfer does
    /// NOT call the receiver, so an armed attacker simply never fires and the
    /// payment must succeed normally. Asserting a revert here (as the previous
    /// ERC-20 mirror did) was asserting an attack that cannot happen.
    function test_PlainErc20TransferGivesReceiverNoCallback() public {
        vm.skip(!_useErc20());
        uint256 agentId = _evilAgentSetup(1 ether);

        evilAgent.arm(agentId, keccak256("inner"), 0.01 ether, true);
        // NOTE: no transfer hook armed - this is an ordinary ERC-20

        evilAgent.attack(address(evilAgent), 0.05 ether, keccak256("outer"));

        assertFalse(evilAgent.fired(), "a standard ERC-20 never calls back into the receiver");
        assertEq(account.cash(agentId), 0.95 ether, "the payment simply succeeds");
        assertEq(token.balanceOf(address(evilAgent)), 0.05 ether, "provider paid once");
        assertEq(account.getPayment(keccak256("inner")).agentId, 0, "no inner payment");
    }

    /// A poster that re-enters `cancelTask` while receiving its refund must not
    /// be able to drain a second refund out of the escrow.
    function test_RevertWhen_PosterReentersCancelTask() public {
        vm.skip(_useErc20()); // ERC-20 transfers give the receiver no callback

        ReentrantPoster evilPoster = new ReentrantPoster(ITaskEscrow(address(escrow)));
        vm.deal(address(evilPoster), 1 ether);

        uint256 escrowBefore = _balanceOf(address(escrow));
        evilPoster.createTask{value: DEMO_REWARD}(DEMO_REWARD, block.timestamp + 1 days);
        assertEq(_balanceOf(address(escrow)) - escrowBefore, DEMO_REWARD, "escrowed");

        vm.expectRevert();
        evilPoster.cancel();

        assertEq(_balanceOf(address(escrow)), escrowBefore + DEMO_REWARD, "escrow untouched");
        assertEq(escrow.getTask(evilPoster.taskId()).escrowBalance, DEMO_REWARD, "no double refund");
    }

    // =====================================================================
    // G3 — refund registration and funds must be one atomic step
    // =====================================================================

    /// TEST_PLAN G3 (Codex ruling): "资金到账、登记、债务调整必须同交易原子完成;
    /// 登记失败不能留下已收款". If `registerRefund` rejects the refundId, the
    /// Manager must not have kept the money.
    function test_RefundRegistrationFailure_LeavesNoStrandedFunds() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 0.5 ether);

        bytes32 paymentId = keccak256("cash-only");
        _payProvider(agentId, 0.2 ether, paymentId, _emptyAuth(), bytes(""), agentWallet);

        bytes32 refundId = keccak256("r1");
        _approve(relayRefunder, address(manager), 0.4 ether);
        vm.prank(relayRefunder);
        manager.processRefund{value: _val(0.1 ether)}(paymentId, 0.1 ether, refundId);

        uint256 managerAssets = _balanceOf(address(manager));
        uint256 relayAssets = _balanceOf(relayRefunder);

        // replaying the same refundId must revert and keep the relay's money
        vm.prank(relayRefunder);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.RefundIdAlreadyUsed.selector, refundId));
        manager.processRefund{value: _val(0.1 ether)}(paymentId, 0.1 ether, refundId);

        assertEq(_balanceOf(address(manager)), managerAssets, "manager kept nothing from the rejection");
        assertEq(_balanceOf(relayRefunder), relayAssets, "the relay was not charged");
    }
}

/// @notice The same atomicity suite in ERC-20 settlement mode.
contract Erc20AtomicityTest is AtomicityTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}
