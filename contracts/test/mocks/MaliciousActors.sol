// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentAccount} from "../../src/interfaces/IAgentAccount.sol";
import {ICreditManager} from "../../src/interfaces/ICreditManager.sol";
import {ITaskEscrow} from "../../src/interfaces/ITaskEscrow.sol";

/// @notice A provider contract with no `receive`/`fallback`: any native transfer
///         to it reverts.
/// @dev Codex R1 review R6: the happy path pays an EOA, which can never fail.
///      This is the counterpart — the payment leg fails and every ledger written
///      earlier in `payProvider` (cash, vault, loan, nonce, paymentId, epoch,
///      outstanding) must roll back with it.
contract RejectingProvider {
    // deliberately no receive() and no fallback()
    uint256 public touched;

    function poke() external {
        touched++;
    }
}

/// @notice An attacker that is SIMULTANEOUSLY the agent's registry wallet and a
///         whitelisted provider, so its re-entrant call satisfies every
///         precondition of `payProvider` except the reentrancy guard.
///
/// @dev Codex R2 review B: the previous attacker was a plain contract that was
///      not the agent's wallet. With the guard deleted, its inner call would
///      still have been rejected by `onlyAgentWallet` — so a passing test proved
///      the wallet check, not the guard. Making the attacker the wallet closes
///      that hole: if the guard is removed, the inner payment SUCCEEDS and every
///      assertion in the guard tests fails.
///
///      Two capture modes, because the two questions are different:
///
///      - `swallow = false` — the inner revert propagates out of `receive()`,
///        so the native transfer fails and the caller observes whatever
///        `SafeTransferLib` wraps it in. This is the "outer call fails and the
///        ledger rolls back" test.
///      - `swallow = true` — the inner call is made with a low-level `call`,
///        the error selector is recorded, and the callback returns normally.
///        The outer payment then succeeds and the test can assert the EXACT
///        inner error (`ReentrantCall`), that the attack really fired, and that
///        the provider was paid exactly once. This is the "the guard itself is
///        armed" test, and it is the only form that survives
///        `SafeTransferLib`'s error wrapping (Codex R2 review B).
///
///      `onTokenTransfer()` is the ERC-20 entry point: plain ERC-20 transfers
///      give the receiver no callback at all (Codex R2 review A), so in ERC-20
///      mode the callback is driven by a token that explicitly pokes this hook.
///      In both modes the re-entrant `payProvider` call carries
///      `msg.sender == address(this) == the agent's registry wallet`.
contract ReentrantAgent {
    IAgentAccount public immutable account;

    uint256 public agentId;
    uint256 public innerAmount;
    bytes32 public innerPaymentId;
    bool public armed;
    bool public swallow;

    bool public fired;
    bool public innerSucceeded;
    bytes4 public innerError;

    constructor(IAgentAccount account_) {
        account = account_;
    }

    function arm(uint256 agentId_, bytes32 innerPaymentId_, uint256 innerAmount_, bool swallow_) external {
        agentId = agentId_;
        innerPaymentId = innerPaymentId_;
        innerAmount = innerAmount_;
        swallow = swallow_;
        armed = true;
        fired = false;
        innerSucceeded = false;
        innerError = bytes4(0);
    }

    /// @notice The OUTER payment. `msg.sender` reaching `payProvider` is this
    ///         contract, which is the agent's registry wallet.
    function attack(address provider, uint256 amount, bytes32 paymentId) external {
        ICreditManager.CreditAuthorization memory empty;
        account.payProvider(agentId, provider, amount, paymentId, empty, bytes(""));
    }

    receive() external payable {
        _reenter();
    }

    /// @dev Poked by `MockERC20`'s transfer hook in ERC-20 mode.
    function onTokenTransfer() external {
        _reenter();
    }

    function _reenter() private {
        if (!armed) return;
        armed = false;
        fired = true;

        ICreditManager.CreditAuthorization memory empty;
        bytes memory data = abi.encodeCall(
            IAgentAccount.payProvider, (agentId, address(this), innerAmount, innerPaymentId, empty, bytes(""))
        );

        if (swallow) {
            (bool ok, bytes memory ret) = address(account).call(data);
            innerSucceeded = ok;
            if (!ok && ret.length >= 4) {
                bytes4 sel;
                assembly {
                    sel := mload(add(ret, 0x20))
                }
                innerError = sel;
            }
            // returns normally: the OUTER payment is allowed to complete
        } else {
            (bool ok, bytes memory ret) = address(account).call(data);
            innerSucceeded = ok;
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}

/// @notice A poster that re-enters the escrow when it receives its refund.
/// @dev Native mode only — a plain ERC-20 transfer gives the receiver no
///      callback, so the ERC-20 mirror of this test is skipped rather than
///      pretending an attack happened (Codex R2 review A).
contract ReentrantPoster {
    ITaskEscrow public immutable escrow;

    uint256 public taskId;
    bool public armed;
    bool public reentered;

    constructor(ITaskEscrow escrow_) {
        escrow = escrow_;
    }

    function createTask(uint256 reward, uint256 deadline) external payable returns (uint256 id) {
        id = escrow.createTask{value: msg.value}(reward, deadline);
        taskId = id;
    }

    function cancel() external {
        armed = true;
        escrow.cancelTask(taskId);
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        reentered = true;
        escrow.cancelTask(taskId); // must revert, not double-refund
    }
}
