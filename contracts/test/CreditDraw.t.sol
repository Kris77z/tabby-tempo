// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {DrawTest} from "./Draw.t.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount, REASON_OVER_LIMIT} from "../src/interfaces/IAgentAccount.sol";

/// @notice The existing I1-I7 suite previously ran only in native mode.
contract Erc20DrawTest is DrawTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}

/// @notice Only draw/payment gaps not already covered by the existing suites.
contract CreditDrawTest is InferCreditTestBase {
    function test_StrictSignatureRejectsMalleabilityInvalidRecoveryAndCrossChainReplay() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes32 digest = _hashAuth(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(UNDERWRITER_PK, digest);
        bytes32 highS =
            bytes32(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), underwriter, "mathematically valid but malleable");
        vm.expectRevert(ICreditManager.BadSignature.selector);
        _payProvider(agentId, DEMO_QUOTE, bytes32(0), a, abi.encodePacked(r, highS, flippedV), agentWallet);
        vm.expectRevert(ICreditManager.BadSignature.selector);
        _payProvider(agentId, DEMO_QUOTE, bytes32(0), a, abi.encodePacked(r, s, uint8(v - 27)), agentWallet);
        vm.expectRevert(ICreditManager.BadSignature.selector);
        _payProvider(
            agentId,
            DEMO_QUOTE,
            bytes32(0),
            a,
            abi.encodePacked(bytes32(0), bytes32(0), uint8(27)),
            agentWallet
        );
        uint256 originalChainId = block.chainid;
        bytes memory valid = abi.encodePacked(r, s, v);
        vm.chainId(originalChainId + 1);
        vm.expectRevert(ICreditManager.BadSignature.selector);
        _payProvider(agentId, DEMO_QUOTE, bytes32(0), a, valid, agentWallet);
        vm.chainId(originalChainId);
        assertFalse(manager.usedNonces(agentId, a.nonce));
        assertEq(account.debtSpentInDay(agentId, block.timestamp / 1 days), 0);
        assertEq(account.cash(agentId), DEMO_SEED_CASH);
        _payProvider(agentId, DEMO_QUOTE, bytes32(0), a, valid, agentWallet);
        assertLoanStatus(
            taskId, ICreditManager.LoanStatus.Active, "the original canonical signature still works"
        );
    }

    function test_NonceConsumptionIsScopedToAgent() public {
        Scenario memory first = _demoOrderOne();
        uint256 otherId = _registerAndEnroll(otherAgentOwner, otherAgentWallet);
        _setPermissivePolicy(otherId, otherAgentOwner);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, otherId, otherAgentWallet);
        ICreditManager.CreditAuthorization memory a =
            _auth(otherId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        a.nonce = 1; // Already consumed by the first agent, unused by this one.
        _payProvider(otherId, 0.08 ether, keccak256("other-agent"), a, _signAuth(a), otherAgentWallet);
        assertTrue(manager.usedNonces(first.agentId, 1));
        assertTrue(manager.usedNonces(otherId, 1));
        assertEq(manager.getLoan(first.taskId).agentId, first.agentId);
        assertEq(manager.getLoan(taskId).agentId, otherId);
        assertEq(manager.totalOutstanding(), 0.184 ether);
        assertEq(manager.drawnInEpoch(block.timestamp / EPOCH_LENGTH), 0.16 ether);
        assertEq(_balanceOf(provider), 0.2 ether);
        assertEq(_balanceOf(address(manager)), VAULT_SEED - 0.16 ether);
        assertEq(_balanceOf(address(account)), 0);
    }

    function test_AccountGlobalHeadroomIncludesFeeAndEpochUsesOnlyPrincipal() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, DEMO_SEED_CASH);
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        bytes memory sig = _signAuth(a);
        vm.prank(deployer);
        manager.setGlobalLimits(DEMO_DEBT_1 - 1, MAX_DRAW_PER_EPOCH);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        _payProvider(agentId, DEMO_QUOTE, bytes32(0), a, sig, agentWallet);
        vm.prank(deployer);
        manager.setGlobalLimits(DEMO_DEBT_1, 0.08 ether - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        _payProvider(agentId, DEMO_QUOTE, bytes32(0), a, sig, agentWallet);
        assertFalse(manager.usedNonces(agentId, a.nonce));
        assertEq(account.cash(agentId), DEMO_SEED_CASH);
        assertEq(_balanceOf(address(manager)), VAULT_SEED);
        assertEq(_balanceOf(address(account)), DEMO_SEED_CASH);
        assertEq(account.debtSpentInDay(agentId, block.timestamp / 1 days), 0);
        vm.prank(deployer);
        manager.setGlobalLimits(DEMO_DEBT_1, 0.08 ether);
        _payProvider(agentId, DEMO_QUOTE, bytes32(0), a, sig, agentWallet);
        assertEq(manager.totalOutstanding(), DEMO_DEBT_1);
        assertEq(manager.drawnInEpoch(block.timestamp / EPOCH_LENGTH), 0.08 ether);
        assertEq(account.debtSpentInDay(agentId, block.timestamp / 1 days), 0.08 ether);
        assertEq(_balanceOf(provider), DEMO_QUOTE);
    }

    function test_LoweringDailyPolicyBelowSpentRejectsWithoutResetOrUnderflow() public {
        (uint256 agentId, uint256 firstTask) = _standardSetup(DEMO_REWARD, 0);
        ICreditManager.CreditAuthorization memory first =
            _auth(agentId, firstTask, 0.08 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.08 ether, bytes32(0), first, _signAuth(first), agentWallet);
        uint256 secondTask = _createTask(poster, DEMO_REWARD);
        _acceptTask(secondTask, agentId, agentWallet);
        ICreditManager.CreditAuthorization memory second =
            _auth(agentId, secondTask, 0.01 ether, TIER_C_FEE_BPS, TIER_C);
        _setPolicy(agentId, agentOwner, 0, 0.1 ether, 0.07 ether, false);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentAccount.SpendRejected.selector, agentId, provider, REASON_OVER_LIMIT)
        );
        _payProvider(agentId, 0.01 ether, keccak256("second"), second, _signAuth(second), agentWallet);
        assertEq(account.debtSpentInDay(agentId, block.timestamp / 1 days), 0.08 ether);
        assertFalse(manager.usedNonces(agentId, second.nonce));
        _setPolicy(agentId, agentOwner, 0, 0.1 ether, 0.09 ether, false);
        _payProvider(agentId, 0.01 ether, keccak256("second"), second, _signAuth(second), agentWallet);
        assertEq(account.debtSpentInDay(agentId, block.timestamp / 1 days), 0.09 ether);
        assertEq(manager.totalOutstanding(), 0.1035 ether);
        assertEq(_balanceOf(provider), 0.09 ether);
    }

    function test_DrawUsesTaskFeeSnapshotAfterGlobalRateChange() public {
        (uint256 agentId, uint256 taskId) = _standardSetup(DEMO_REWARD, 0.02 ether);
        _setProtocolFee(5_000);
        ICreditManager.CreditAuthorization memory a =
            _auth(agentId, taskId, 0.1 ether, TIER_C_FEE_BPS, TIER_C);
        _payProvider(agentId, 0.06 ether, bytes32(0), a, _signAuth(a), agentWallet);
        assertEq(escrow.getTask(taskId).protocolFeeBps, 0);
        assertEq(manager.getLoan(taskId).principal, 0.04 ether);
        assertEq(manager.getLoan(taskId).fee, 0.006 ether);
        assertEq(manager.totalOutstanding(), 0.046 ether);
        assertEq(_balanceOf(provider), 0.06 ether);
    }
}

contract Erc20CreditDrawTest is CreditDrawTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}
