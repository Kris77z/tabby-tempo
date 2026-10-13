// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {RefundTest, DefaultedRecoveryOverLeveredTest} from "./Refund.t.sol";
import {TaskLifecycleTest} from "./TaskLifecycle.t.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title Erc20Mode.t.sol — ENGINEERING §3 item 3, ERC-20 settlement mode
/// @notice "资金转移约定必须成对实现（review #10）：原生币路径 = 所有入金函数
///          payable + msg.value 校验；ERC-20 路径 = approve + safeTransferFrom。"
///         The whole protocol must behave identically in either mode, so the
///         two suites below simply re-run the refund and task-lifecycle
///         specifications with `settlementAsset != address(0)`.

/// @notice r5 #1 names the ERC-20 mode explicitly for instalment refunds, so the
///         entire refund specification is re-run against an ERC-20 deployment.
contract Erc20RefundTest is RefundTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}

/// @notice The task lifecycle (escrow in, waterfall out) re-run on ERC-20.
contract Erc20TaskLifecycleTest is TaskLifecycleTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}

/// @notice The isolated multi-layer recovery harness re-run on ERC-20.
/// @dev Still over-levered — see the note on DefaultedRecoveryOverLeveredTest.
contract Erc20DefaultedRecoveryOverLeveredTest is DefaultedRecoveryOverLeveredTest {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }
}

/// @notice Checks specific to the ERC-20 leg of the pairing.
contract Erc20PairingTest is InferCreditTestBase {
    function _useErc20() internal pure override returns (bool) {
        return true;
    }

    // =====================================================================
    // "msg.value == 0" on every inbound function in ERC-20 mode
    // =====================================================================

    function test_RevertWhen_NativeValueSentInErc20Mode_CreateTask() public {
        _approve(poster, address(escrow), DEMO_REWARD);
        vm.deal(poster, 1 ether);

        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(ITaskEscrow.ValueMismatch.selector, 0, 1 wei));
        escrow.createTask{value: 1 wei}(DEMO_REWARD, block.timestamp + 1 days);
    }

    function test_RevertWhen_NativeValueSentInErc20Mode_DepositCash() public {
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _approve(agentOwner, address(account), 1 ether);
        vm.deal(agentOwner, 1 ether);

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(IAgentAccount.ValueMismatch.selector, 0, 1 wei));
        account.depositCash{value: 1 wei}(agentId, 1 ether);
    }

    function test_RevertWhen_NativeValueSentInErc20Mode_Deposit() public {
        _approve(treasury, address(manager), 1 ether);
        vm.deal(treasury, 1 ether);

        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.ValueMismatch.selector, 0, 1 wei));
        manager.deposit{value: 1 wei}(1 ether);
    }

    function test_RevertWhen_NativeValueSentInErc20Mode_ProcessRefund() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 0.5 ether);
        bytes32 paymentId = keccak256("cash-only");
        _payProvider(agentId, 0.1 ether, paymentId, _emptyAuth(), bytes(""), agentWallet);

        _approve(relayRefunder, address(manager), 0.1 ether);
        vm.deal(relayRefunder, 1 ether);

        vm.prank(relayRefunder);
        vm.expectRevert(abi.encodeWithSelector(ICreditManager.ValueMismatch.selector, 0, 1 wei));
        manager.processRefund{value: 1 wei}(paymentId, 0.1 ether, keccak256("r1"));
    }

    // =====================================================================
    // approve + safeTransferFrom
    // =====================================================================

    /// Without an allowance the pull must fail — no silent partial escrow.
    function test_RevertWhen_CreateTaskWithoutAllowance() public {
        vm.prank(poster);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockERC20.InsufficientAllowance.selector, poster, address(escrow), 0, DEMO_REWARD
            )
        );
        escrow.createTask(DEMO_REWARD, block.timestamp + 1 days);
    }

    function test_CreateTask_PullsExactlyTheReward() public {
        uint256 posterBefore = token.balanceOf(poster);
        uint256 escrowBefore = token.balanceOf(address(escrow));

        _createTask(poster, DEMO_REWARD);

        assertEq(posterBefore - token.balanceOf(poster), DEMO_REWARD, "pulled from the poster");
        assertEq(token.balanceOf(address(escrow)) - escrowBefore, DEMO_REWARD, "held by the escrow");
    }

    /// USDT-style tokens return no data on success; SafeTransferLib must accept
    /// them rather than mis-reading the empty return as a failure.
    function test_NonStandardTokenWithNoReturnValueIsAccepted() public {
        token.cheatSetReturnsNothing(true);

        uint256 taskId = _createTask(poster, DEMO_REWARD);

        assertEq(escrow.getTask(taskId).escrowBalance, DEMO_REWARD, "escrow booked");
        assertEq(token.balanceOf(address(escrow)), DEMO_REWARD, "tokens really arrived");
    }

    // =====================================================================
    // r5 #1 — instalment refunds in ERC-20 mode
    // =====================================================================

    /// §4.5 清单项：ERC-20 模式分次退款 —— 累计不超原额、每次金额显式传入（r5 #1）
    /// The ERC-20 leg is where the explicit `amount` parameter matters most:
    /// there is no `msg.value` to infer the instalment size from.
    function test_InstalmentRefunds_Erc20_AmountIsExplicitAndCapped() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD, 30 days);
        _acceptTask(taskId, agentId, agentWallet);

        bytes32 paymentId = keccak256("erc20-payment");
        _drawWithLoanDue(
            agentId,
            taskId,
            DEMO_QUOTE,
            0.08 ether,
            TIER_C_FEE_BPS,
            TIER_C,
            block.timestamp + 1 hours,
            paymentId
        );

        // instalment 1: 0.03 of 0.12 → credit share 0.02 → principal 0.08 → 0.06
        _approve(relayRefunder, address(manager), 0.12 ether);
        vm.prank(relayRefunder);
        manager.processRefund(paymentId, 0.03 ether, keccak256("r1"));

        ICreditManager.TaskLoan memory loan = manager.getLoan(taskId);
        assertEq(loan.principal, 0.06 ether, "principal cut by the credit share only");
        assertEq(loan.fee, 0.009 ether, "fee cut in the same proportion");
        assertEq(account.cash(agentId), 0.01 ether, "cash share returned");
        assertEq(account.getPayment(paymentId).refundedAmount, 0.03 ether, "cumulative 0.03");

        // instalment 2: another 0.09 completes the refund
        vm.prank(relayRefunder);
        manager.processRefund(paymentId, 0.09 ether, keccak256("r2"));

        assertEq(account.getPayment(paymentId).refundedAmount, DEMO_QUOTE, "cumulative 0.12");
        assertLoanStatus(
            taskId, ICreditManager.LoanStatus.ClosedByRefund, "instalments add up to a full refund"
        );
        assertEq(account.cash(agentId), DEMO_SEED_CASH, "the whole cash leg is back");

        // instalment 3 would exceed the original payment
        vm.prank(relayRefunder);
        vm.expectRevert(
            abi.encodeWithSelector(ICreditManager.RefundExceedsPayment.selector, paymentId, 1 wei, 0)
        );
        manager.processRefund(paymentId, 1 wei, keccak256("r3"));
    }

    /// The refunded tokens must actually move; booking alone is not enough.
    function test_InstalmentRefunds_Erc20_TokensActuallyMove() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, 0.5 ether);
        bytes32 paymentId = keccak256("cash-only");
        _payProvider(agentId, 0.1 ether, paymentId, _emptyAuth(), bytes(""), agentWallet);

        uint256 refunderBefore = token.balanceOf(relayRefunder);
        _approve(relayRefunder, address(manager), 0.1 ether);
        vm.prank(relayRefunder);
        manager.processRefund(paymentId, 0.1 ether, keccak256("r1"));

        assertEq(refunderBefore - token.balanceOf(relayRefunder), 0.1 ether, "relay paid out");
        assertEq(account.cash(agentId), 0.5 ether, "agent made whole");
    }
}
