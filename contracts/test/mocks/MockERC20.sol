// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @dev Hook a recipient can register to be notified inside `transfer`.
///      A plain ERC-20 has NO such callback (Codex R2 review A) — this exists
///      only so a test can model a deliberately hostile settlement token, and
///      it is never armed in the ordinary ERC-20 suites.
interface ITransferHook {
    function onTokenTransfer() external;
}

/// @notice Minimal ERC-20 for the ERC-20 settlement mode (ENGINEERING §3).
/// @dev `cheatSetReturnsNothing(true)` turns it into a USDT-style token that
///      returns no data, to prove SafeTransferLib tolerates it.
contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public returnsNothing;
    bool public approvalReturnsNothing;
    /// @dev Codex review R6: lets a test make the provider leg of a payment fail
    ///      in ERC-20 mode, the way `RejectingProvider` does for native mode.
    mapping(address => bool) public blocked;
    /// @dev recipient => contract poked inside `transfer`. Off by default: a
    ///      standard ERC-20 gives the receiver no callback.
    mapping(address => address) public transferHook;

    error TransferBlocked(address to);
    error InsufficientBalance(address from, uint256 have, uint256 want);
    error InsufficientAllowance(address owner, address spender, uint256 have, uint256 want);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    /// @dev `approve` returns a bool in the ordinary `returnsNothing` mode: the
    ///      test harness calls it through the typed interface and would fail to
    ///      decode an empty return. `returnsNothing` targets `transfer` /
    ///      `transferFrom`, which is what SafeTransferLib has to tolerate.
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        if (approvalReturnsNothing) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return _ret();
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(from, msg.sender, allowed, value);
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return _ret();
    }

    function cheatSetReturnsNothing(bool v) external {
        returnsNothing = v;
    }

    /// @dev Enabled only after typed fixture approvals; protocol approvals use
    ///      SafeTransferLib and must accept the empty successful return.
    function cheatSetApprovalReturnsNothing(bool v) external {
        approvalReturnsNothing = v;
    }

    /// @notice Make every transfer to `who` revert.
    function cheatSetBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    /// @notice Turn this token into a hostile, callback-bearing settlement asset
    ///         for transfers to `to`. NOT standard ERC-20 behaviour; only armed
    ///         by the token-driven reentrancy test.
    function cheatSetTransferHook(address to, address target) external {
        transferHook[to] = target;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (blocked[to]) revert TransferBlocked(to);
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance(from, bal, value);
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);

        address hook = transferHook[to];
        if (hook != address(0)) ITransferHook(hook).onTokenTransfer();
    }

    function _ret() private view returns (bool) {
        if (returnsNothing) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}
