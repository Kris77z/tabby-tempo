// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @title Identity.t.sol — the real ERC-8004 identity lifecycle
/// @notice Codex review R1: the free-form `cheatSetOwner` helper let tests reach
///         a state the canonical registry never produces — an identity whose
///         owner changed while its wallet binding survived. A real ERC-721
///         transfer CLEARS the wallet, and rebinding requires the new wallet's
///         signed consent before a deadline.
///
///         The single-field cheats stay (they isolate the "owner changed" and
///         "wallet changed" halves of I3), but the full lifecycle is pinned here:
///         transfer → wallet is zero → rebind with consent → re-approve →
///         every pre-transfer authorization is dead.
///
///         Attack being defended (RISK_AND_MVP §1.4): buying a high-score agentId
///         must not let the buyer inherit live credit.
contract IdentityTest is InferCreditTestBase {
    // =====================================================================
    // registry-level semantics
    // =====================================================================

    function test_IdentityTransfer_ClearsTheWalletBinding() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        assertEq(identity.getAgentWallet(agentId), agentWallet, "bound before the transfer");

        vm.prank(agentOwner);
        identity.transferIdentity(agentId, otherAgentOwner);

        assertEq(identity.ownerOf(agentId), otherAgentOwner, "new owner");
        assertEq(identity.getAgentWallet(agentId), address(0), "a transfer clears the wallet binding");
    }

    /// The new wallet must consent. An owner cannot bind a wallet that never
    /// agreed — otherwise an attacker could point an agent at someone else's
    /// address, or a buyer could re-bind the seller's wallet.
    function test_RevertWhen_RebindingWithoutTheNewWalletsSignature() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        uint256 deadline = block.timestamp + 1 hours;

        // signature produced by the WRONG key
        bytes32 digest = identity.walletBindingDigest(agentId, agentWallet2, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_WALLET_PK, digest);

        vm.prank(agentOwner);
        vm.expectRevert(
            abi.encodeWithSelector(MockIdentityRegistry.BadWalletSignature.selector, agentId, agentWallet2)
        );
        identity.setAgentWallet(agentId, agentWallet2, deadline, abi.encodePacked(r, s, v));
    }

    function test_RevertWhen_RebindingAfterTheConsentDeadline() public {
        uint256 agentId = _registerAgent(agentOwner, agentWallet);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = identity.walletBindingDigest(agentId, agentWallet2, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_WALLET2_PK, digest);

        vm.warp(deadline + 1);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(MockIdentityRegistry.BindingExpired.selector, deadline));
        identity.setAgentWallet(agentId, agentWallet2, deadline, abi.encodePacked(r, s, v));
    }

    // =====================================================================
    // protocol-level consequences
    // =====================================================================

    /// The full sale-of-a-credit-history lifecycle, end to end.
    function test_IdentityTransferLifecycle_OldAuthorizationIsDeadAfterReapprove() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        ICreditManager.CreditAuthorization memory oldAuth =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        oldAuth.authDeadline = block.timestamp + 30 days; // deliberately long-lived
        bytes memory oldSig = _signAuth(oldAuth);
        assertEq(oldAuth.identityVersion, 1, "enrolled at version 1");

        // 1. the identity is sold
        vm.prank(agentOwner);
        identity.transferIdentity(agentId, otherAgentOwner);
        assertTrue(adapter.identityChanged(agentId), "owner AND wallet both moved");

        // 2. with no wallet bound, nobody can spend at all
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.NotAgentWallet.selector, agentId, agentWallet));
        account.payProvider(agentId, provider, 0.01 ether, keccak256("x"), _emptyAuth(), bytes(""));

        // 3. the buyer rebinds its own wallet, with consent
        _bindWallet(agentId, otherAgentOwner, AGENT_WALLET2_PK, block.timestamp + 1 hours);
        assertEq(identity.getAgentWallet(agentId), agentWallet2, "rebound to the buyer's wallet");
        assertTrue(adapter.identityChanged(agentId), "still stale: the snapshot is pre-sale");

        // 4. the underwriter re-reviews, which is the only way to refresh it
        vm.prank(guardian);
        manager.reapproveAgent(agentId);
        assertFalse(adapter.identityChanged(agentId), "snapshot is current again");
        assertEq(adapter.snapshotVersion(agentId), 2, "version bumped by the re-approval");

        // 5. the authorization signed before the sale is now worthless
        vm.deal(agentWallet2, 1 ether);
        vm.prank(agentWallet2);
        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.IdentityVersionMismatch.selector, agentId, 2, 1)
        );
        account.payProvider(agentId, provider, DEMO_QUOTE, keccak256("p1"), oldAuth, oldSig);
    }

    /// After the re-approval the agent is a normal, creditworthy agent again —
    /// the freeze must not be a one-way door (TEST_PLAN G4).
    function test_AfterReapprove_FreshAuthorizationWorksAgain() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);

        vm.prank(agentOwner);
        identity.transferIdentity(agentId, otherAgentOwner);
        _bindWallet(agentId, otherAgentOwner, AGENT_WALLET2_PK, block.timestamp + 1 hours);

        vm.prank(guardian);
        manager.reapproveAgent(agentId);

        ICreditManager.CreditAuthorization memory fresh =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        assertEq(fresh.identityVersion, 2, "signed against the refreshed snapshot");

        vm.deal(agentWallet2, 1 ether);
        vm.prank(agentWallet2);
        account.payProvider(agentId, provider, DEMO_QUOTE, keccak256("p1"), fresh, _signAuth(fresh));

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Active, "re-approved agent can borrow");
    }

    /// A cleared wallet must also block task acceptance, not only payments.
    function test_RevertWhen_AcceptTaskWithNoWalletBound() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        uint256 taskId = _createTask(poster, DEMO_REWARD);

        vm.prank(agentOwner);
        identity.unsetAgentWallet(agentId);

        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.NotAgentWallet.selector, agentId, agentWallet));
        escrow.acceptTask(taskId, agentId);
    }

    /// address(0) must never be accepted as "the current wallet": an unbound
    /// agent has no operator, and a call from address(0) is not reachable, but
    /// a naive `wallet == msg.sender` check on a zeroed slot combined with a
    /// zero-address caller check is the classic way this goes wrong.
    function test_UnboundAgentHasNoValidOperator() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        vm.prank(agentOwner);
        identity.unsetAgentWallet(agentId);

        (, address wallet) = adapter.resolveAgent(agentId);
        assertEq(wallet, address(0), "no operator");
        assertTrue(adapter.identityChanged(agentId), "unbinding is an identity change");
    }
}
