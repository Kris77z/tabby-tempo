// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ERC8004Adapter} from "../src/ERC8004Adapter.sol";
import {CreditManager} from "../src/CreditManager.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {IERC8004Adapter} from "../src/interfaces/IERC8004Adapter.sol";
import {SafeTransferLib} from "../src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "../src/utils/ReentrancyGuard.sol";
import {MockERC20, ITransferHook} from "./mocks/MockERC20.sol";

/// @dev A legitimate treasury, so the nested withdrawal satisfies access and
///      liquidity checks. Native receive and explicit hostile-token hooks both
///      exercise the same attack. Ordinary ERC-20 transfers have no callback.
contract FoundationTreasury is ITransferHook {
    CreditManager public manager;
    MockERC20 public immutable token;
    bool public armed;
    bool public bubble;
    uint256 public callbacks;
    bytes4 public innerError;

    constructor(MockERC20 token_) {
        token = token_;
    }

    function setManager(CreditManager manager_) external {
        manager = manager_;
    }

    function deposit(uint256 amount) external {
        if (address(token) != address(0)) token.approve(address(manager), type(uint256).max);
        manager.deposit{value: address(token) == address(0) ? amount : 0}(amount);
    }

    function withdraw(uint256 amount) external {
        manager.withdraw(amount);
    }

    function arm(bool bubble_) external {
        armed = true;
        bubble = bubble_;
    }

    function onTokenTransfer() external {
        _callback();
    }

    receive() external payable {
        _callback();
    }

    function _callback() private {
        if (!armed) return;
        armed = false;
        callbacks += 1;
        (bool ok, bytes memory reason) = address(manager).call(abi.encodeCall(manager.withdraw, (1 wei)));
        if (!ok) {
            innerError = bytes4(reason);
            if (bubble) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
    }
}

/// @notice These scenarios use only the foundation batch, never a task, draw,
///         payment or settlement. Every funding assertion checks actual assets.
contract FoundationsTest is InferCreditTestBase {
    function test_IdentityLifecycleUsesLiveRegistryAndExplicitReapproval() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        (address snapOwner, address snapWallet, uint64 version) = adapter.snapshots(agentId);
        assertEq(snapOwner, agentOwner);
        assertEq(snapWallet, agentWallet);
        assertEq(version, 1);
        assertFalse(adapter.identityChanged(agentId));

        vm.prank(agentOwner);
        identity.transferIdentity(agentId, otherAgentOwner);
        (address liveOwner, address liveWallet) = adapter.resolveAgent(agentId);
        assertEq(liveOwner, otherAgentOwner);
        assertEq(liveWallet, address(0));
        assertTrue(adapter.identityChanged(agentId));
        assertEq(adapter.snapshotVersion(agentId), 1);

        _bindWallet(agentId, otherAgentOwner, AGENT_WALLET2_PK, block.timestamp + 1 hours);
        assertTrue(adapter.identityChanged(agentId));
        vm.prank(guardian);
        manager.reapproveAgent(agentId);
        (snapOwner, snapWallet, version) = adapter.snapshots(agentId);
        assertEq(snapOwner, otherAgentOwner);
        assertEq(snapWallet, agentWallet2);
        assertEq(version, 2);
        assertFalse(adapter.identityChanged(agentId));
        vm.prank(guardian);
        manager.reapproveAgent(agentId);
        assertEq(adapter.snapshotVersion(agentId), 3);
    }

    function test_IdentityChangedDetectsEachMutableField() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        identity.cheatSetOwnerOnly(agentId, otherAgentOwner);
        assertTrue(adapter.identityChanged(agentId), "owner alone invalidates snapshot");
        vm.prank(guardian);
        manager.reapproveAgent(agentId);
        identity.cheatSetWalletOnly(agentId, agentWallet2);
        assertTrue(adapter.identityChanged(agentId), "wallet alone invalidates snapshot");
    }

    function test_AdapterLifecycleRequiresManagerAndValidEnrollmentState() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.AgentNotEnrolled.selector, agentId));
        adapter.identityChanged(agentId);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.AgentNotEnrolled.selector, agentId));
        manager.reapproveAgent(agentId);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.NotCreditManager.selector, stranger));
        adapter.enroll(agentId);
        _enroll(agentId);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.NotCreditManager.selector, stranger));
        adapter.reapprove(agentId);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.AgentAlreadyEnrolled.selector, agentId));
        manager.enrollAgent(agentId);
        assertEq(adapter.snapshotVersion(agentId), 1);
    }

    function test_EnrollmentAndReapprovalRequireGuardian() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotGuardian.selector, agentOwner));
        manager.enrollAgent(agentId);
        assertEq(adapter.snapshotVersion(agentId), 0);
        _enroll(agentId);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotGuardian.selector, agentOwner));
        manager.reapproveAgent(agentId);
        assertEq(adapter.snapshotVersion(agentId), 1);
    }

    function test_AdapterAndAccountWiringIsOwnedNonzeroAndOneShot() public {
        ERC8004Adapter unwiredAdapter = new ERC8004Adapter(identity, reputation, deployer);
        AgentAccount unwiredAccount = new AgentAccount(settlementAsset, unwiredAdapter, deployer);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC8004Adapter.NotOwner.selector, stranger));
        unwiredAdapter.setCreditManager(address(manager));
        vm.prank(deployer);
        vm.expectRevert(IERC8004Adapter.ZeroAddress.selector);
        unwiredAdapter.setCreditManager(address(0));
        vm.prank(deployer);
        unwiredAdapter.setCreditManager(address(manager));
        assertTrue(unwiredAdapter.isReporter(address(manager)));
        vm.prank(deployer);
        vm.expectRevert(IERC8004Adapter.AlreadyWired.selector);
        unwiredAdapter.setCreditManager(stranger);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotOwner.selector, stranger));
        unwiredAccount.setProtocolContracts(manager, address(escrow));
        vm.startPrank(deployer);
        vm.expectRevert(IAgentAccount.ZeroAddress.selector);
        unwiredAccount.setProtocolContracts(ICreditManager(address(0)), address(escrow));
        vm.expectRevert(IAgentAccount.ZeroAddress.selector);
        unwiredAccount.setProtocolContracts(manager, address(0));
        unwiredAccount.setProtocolContracts(manager, address(escrow));
        vm.expectRevert(IAgentAccount.AlreadyWired.selector);
        unwiredAccount.setProtocolContracts(manager, stranger);
        vm.stopPrank();
        assertEq(address(unwiredAccount.creditManager()), address(manager));
        assertEq(unwiredAccount.taskEscrow(), address(escrow));
    }

    function test_OnlyTreasuryCanDepositOrWithdraw() public {
        _seedVault(3 ether);
        _approve(stranger, address(manager), 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotTreasury.selector, stranger));
        manager.deposit{value: _val(1 ether)}(1 ether);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotTreasury.selector, guardian));
        manager.withdraw(1 ether);
        assertEq(manager.vaultBalance(), 3 ether);
        assertEq(_balanceOf(address(manager)), 3 ether);
    }

    function test_VaultCashAndThirdPartyBackstopConserveAssets() public {
        uint256 agentA = _registerAndEnroll(agentOwner, agentWallet);
        uint256 agentB = _registerAndEnroll(otherAgentOwner, otherAgentWallet);
        uint256 treasuryBefore = _balanceOf(treasury);
        uint256 ownerBefore = _balanceOf(agentOwner);
        uint256 strangerBefore = _balanceOf(stranger);
        _seedVault(7 ether);
        _depositCash(agentA, agentOwner, 3 ether);
        _fundBackstop(agentA, agentOwner, 2 ether);
        _fundBackstop(agentB, stranger, 5 ether);
        assertEq(account.cash(agentA), 3 ether);
        assertEq(_balanceOf(address(account)), 3 ether);
        assertEq(_balanceOf(agentOwner), ownerBefore - 5 ether);
        assertEq(_balanceOf(stranger), strangerBefore - 5 ether);
        assertEq(manager.vaultBalance(), 7 ether);
        assertEq(manager.backstop(agentA), 2 ether);
        assertEq(manager.backstop(agentB), 5 ether);
        assertEq(manager.backstopTotal(), 7 ether);
        assertEq(_balanceOf(address(manager)), 14 ether);

        vm.prank(treasury);
        manager.withdraw(7 ether);
        assertEq(_balanceOf(treasury), treasuryBefore);
        assertEq(manager.vaultBalance(), 0);
        assertEq(manager.backstopTotal(), 7 ether);
        assertEq(_balanceOf(address(manager)), 7 ether);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.InsufficientLiquidity.selector, 1, 0));
        manager.withdraw(1);
        assertEq(manager.backstop(agentA), 2 ether);
        assertEq(manager.backstop(agentB), 5 ether);
        assertEq(manager.totalOutstanding(), 0);
    }

    function test_UnbookedAssetsCannotBeWithdrawnAsVaultLiquidity() public {
        if (_useErc20()) {
            token.mint(address(manager), 4 ether);
        } else {
            vm.deal(address(manager), 4 ether);
        }
        assertEq(_balanceOf(address(manager)), 4 ether);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.InsufficientLiquidity.selector, 1, 0));
        manager.withdraw(1);
        assertEq(manager.vaultBalance(), 0);
        assertEq(manager.backstopTotal(), 0);
        assertEq(_balanceOf(address(manager)), 4 ether);
    }

    function test_CashAndPolicyPermissionsFollowCurrentOwnerBeforeReapproval() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _depositCash(agentId, agentOwner, 1 ether);
        vm.prank(agentOwner);
        identity.transferIdentity(agentId, otherAgentOwner);
        _approve(agentOwner, address(account), 1 ether);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentOwner.selector, agentId, agentOwner));
        account.depositCash{value: _val(1 ether)}(agentId, 1 ether);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentOwner.selector, agentId, agentOwner));
        account.setPolicy(agentId, IAgentAccount.Policy(0, 0, 0, false));
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentOwner.selector, agentId, agentWallet));
        account.setPolicy(agentId, IAgentAccount.Policy(0, 0, 0, false));
        _depositCash(agentId, otherAgentOwner, 2 ether);
        _setPolicy(agentId, otherAgentOwner, 11, 12, 13, true);
        IAgentAccount.Policy memory p = account.getPolicy(agentId);
        assertEq(p.maxCashPerTx, 11);
        assertEq(p.maxDebtPerTx, 12);
        assertEq(p.maxDebtPerDay, 13);
        assertTrue(p.ownerFrozen);
        assertTrue(adapter.identityChanged(agentId));
        assertEq(adapter.snapshotVersion(agentId), 1);
        assertEq(account.cash(agentId), 3 ether);
        assertEq(_balanceOf(address(account)), 3 ether);
    }

    function test_OwnerAndProtocolFreezeBitsRemainIndependent() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        vm.prank(guardian);
        manager.freezeAgent(agentId);
        _setPermissivePolicy(agentId, agentOwner);
        assertFalse(account.getPolicy(agentId).ownerFrozen);
        assertTrue(manager.protocolFrozen(agentId));
        assertTrue(account.protocolFrozen(agentId));
        _setPolicy(agentId, agentOwner, 0, 0, 0, true);
        vm.prank(guardian);
        manager.unfreezeAgent(agentId);
        assertFalse(manager.protocolFrozen(agentId));
        assertFalse(account.protocolFrozen(agentId));
        assertTrue(account.getPolicy(agentId).ownerFrozen);
    }

    function test_PublicFreezeRequiresLiveChangeAndReapprovalDoesNotUnfreeze() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotGuardian.selector, stranger));
        manager.freezeAgent(agentId);
        vm.prank(agentOwner);
        identity.unsetAgentWallet(agentId);
        vm.prank(stranger);
        manager.freezeAgent(agentId);
        assertTrue(manager.protocolFrozen(agentId));
        assertTrue(account.protocolFrozen(agentId));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.NotGuardian.selector, stranger));
        manager.unfreezeAgent(agentId);
        vm.prank(guardian);
        manager.unfreezeAgent(agentId);
        assertTrue(adapter.identityChanged(agentId), "unfreeze never refreshes snapshot");
        assertEq(adapter.snapshotVersion(agentId), 1);
        vm.prank(guardian);
        manager.freezeAgent(agentId);
        vm.prank(guardian);
        manager.reapproveAgent(agentId);
        assertFalse(adapter.identityChanged(agentId));
        assertEq(adapter.snapshotVersion(agentId), 2);
        assertTrue(manager.protocolFrozen(agentId), "reapproval is separate from unfreeze");
        assertTrue(account.protocolFrozen(agentId));
    }

    function test_AccountProtocolFreezeRequiresManagerEvenForGuardian() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotCreditManager.selector, guardian));
        account.setProtocolFrozen(agentId, true);
        assertFalse(account.protocolFrozen(agentId));
        assertFalse(manager.protocolFrozen(agentId));
    }

    function test_FailedFreezeMirrorRollsBackManagerFlag() public {
        CreditManager mismatchedManager = _newManager(treasury);
        vm.prank(deployer);
        mismatchedManager.setProtocolContracts(account, escrow);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.NotCreditManager.selector, address(mismatchedManager))
        );
        mismatchedManager.freezeAgent(agentId);
        assertFalse(mismatchedManager.protocolFrozen(agentId));
        assertFalse(account.protocolFrozen(agentId));
    }

    function test_AllFundingRejectsWrongNativeValueWithoutChangingBalances() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 amount = 2 ether;
        uint256 sent = _useErc20() ? 1 wei : 1 ether;
        uint256 expected = _val(amount);
        _approve(treasury, address(manager), amount);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.ValueMismatch.selector, expected, sent));
        manager.deposit{value: sent}(amount);
        _approve(stranger, address(manager), amount);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.ValueMismatch.selector, expected, sent));
        manager.fundBackstop{value: sent}(agentId, amount);
        _approve(agentOwner, address(account), amount);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.ValueMismatch.selector, expected, sent));
        account.depositCash{value: sent}(agentId, amount);
        assertEq(manager.vaultBalance(), 0);
        assertEq(manager.backstop(agentId), 0);
        assertEq(manager.backstopTotal(), 0);
        assertEq(account.cash(agentId), 0);
        assertEq(_balanceOf(address(manager)), 0);
        assertEq(_balanceOf(address(account)), 0);
    }

    function test_ZeroAmountsDoNotCreateLedgerEntries() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        vm.prank(treasury);
        vm.expectRevert(ICreditManager.ZeroAmount.selector);
        manager.deposit(0);
        vm.prank(treasury);
        vm.expectRevert(ICreditManager.ZeroAmount.selector);
        manager.withdraw(0);
        vm.expectRevert(ICreditManager.ZeroAmount.selector);
        manager.fundBackstop(agentId, 0);
        vm.prank(agentOwner);
        vm.expectRevert(IAgentAccount.ZeroAmount.selector);
        account.depositCash(agentId, 0);
        assertEq(manager.vaultBalance(), 0);
        assertEq(manager.backstopTotal(), 0);
        assertEq(account.cash(agentId), 0);
    }

    function test_WithdrawBlocksValidTreasuryReentryAndPaysOnlyOnce() public {
        (FoundationTreasury receiver, CreditManager receiverManager) = _treasuryFixture();
        receiver.arm(false);
        receiver.withdraw(1 ether);
        assertEq(receiver.callbacks(), 1, "actual receiver or token callback");
        assertEq(receiver.innerError(), ReentrancyGuard.ReentrantCall.selector);
        assertEq(receiverManager.vaultBalance(), 2 ether);
        assertEq(_balanceOf(address(receiverManager)), 2 ether);
        assertEq(_balanceOf(address(receiver)), 2 ether);
    }

    function test_FailedWithdrawalRollsBackVaultAndAssets() public {
        (FoundationTreasury receiver, CreditManager receiverManager) = _treasuryFixture();
        receiver.arm(true);
        if (_useErc20()) {
            vm.expectRevert(ReentrancyGuard.ReentrantCall.selector);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    SafeTransferLib.NativeTransferFailed.selector, address(receiver), 1 ether
                )
            );
        }
        receiver.withdraw(1 ether);
        assertEq(receiverManager.vaultBalance(), 3 ether);
        assertEq(_balanceOf(address(receiverManager)), 3 ether);
        assertEq(_balanceOf(address(receiver)), 1 ether);
    }

    function _treasuryFixture()
        internal
        returns (FoundationTreasury receiver, CreditManager receiverManager)
    {
        receiver = new FoundationTreasury(token);
        receiverManager = _newManager(address(receiver));
        receiver.setManager(receiverManager);
        _fund(address(receiver), 4 ether);
        receiver.deposit(3 ether);
        if (_useErc20()) token.cheatSetTransferHook(address(receiver), address(receiver));
    }

    function _newManager(address treasury_) internal returns (CreditManager) {
        return new CreditManager(
            CreditManager.Config({
                settlementAsset: settlementAsset,
                adapter: adapter,
                underwriter: underwriter,
                treasury: treasury_,
                guardian: guardian,
                relayRefunder: relayRefunder,
                owner: deployer,
                maxLtvBps: MAX_LTV_BPS,
                grace: GRACE
            })
        );
    }
}

contract Erc20FoundationsTest is FoundationsTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }

    function test_ERC20FailedTransferFromDoesNotCreditAnyLedger() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _approve(treasury, address(manager), 1 ether);
        _approve(stranger, address(manager), 1 ether);
        _approve(agentOwner, address(account), 1 ether);
        token.cheatSetBlocked(address(manager), true);
        token.cheatSetBlocked(address(account), true);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, address(manager)));
        manager.deposit(1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, address(manager)));
        manager.fundBackstop(agentId, 1 ether);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.TransferBlocked.selector, address(account)));
        account.depositCash(agentId, 1 ether);
        assertEq(manager.vaultBalance(), 0);
        assertEq(manager.backstop(agentId), 0);
        assertEq(manager.backstopTotal(), 0);
        assertEq(account.cash(agentId), 0);
        assertEq(token.balanceOf(address(manager)), 0);
        assertEq(token.balanceOf(address(account)), 0);
        assertEq(token.balanceOf(treasury), 1_000 ether);
        assertEq(token.balanceOf(stranger), 1_000 ether);
        assertEq(token.balanceOf(agentOwner), 1_000 ether);
        assertEq(token.allowance(treasury, address(manager)), 1 ether);
        assertEq(token.allowance(stranger, address(manager)), 1 ether);
        assertEq(token.allowance(agentOwner, address(account)), 1 ether);
    }

    function test_ERC20NoReturnValueFundingAndWithdrawalConserveAssets() public {
        token.cheatSetReturnsNothing(true);
        test_VaultCashAndThirdPartyBackstopConserveAssets();
    }

    function test_ERC20FundingCallbackCannotWithdrawExistingLiquidity() public {
        (FoundationTreasury receiver, CreditManager receiverManager) = _treasuryFixture();
        token.cheatSetTransferHook(address(receiverManager), address(receiver));
        receiver.arm(false);
        receiver.deposit(1 ether);
        assertEq(receiver.callbacks(), 1);
        assertEq(receiver.innerError(), ReentrancyGuard.ReentrantCall.selector);
        assertEq(receiverManager.vaultBalance(), 4 ether);
        assertEq(token.balanceOf(address(receiverManager)), 4 ether);
        assertEq(token.balanceOf(address(receiver)), 0);
    }
}
