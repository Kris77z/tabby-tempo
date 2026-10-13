// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title SafeTransferLib
/// @notice Minimal, dependency-free replacement for OpenZeppelin's SafeERC20 +
///         Address.sendValue. Handles the two settlement modes of ENGINEERING §3:
///         native coin (`asset == address(0)`) and ERC-20.
/// @dev Tolerates non-standard ERC-20s that return no data on success.
library SafeTransferLib {
    error NativeTransferFailed(address to, uint256 amount);
    error ERC20CallFailed(address token);
    error ERC20OperationFailed(address token);

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, value)));
        _checkReturn(address(token), ok, data);
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, value)));
        _checkReturn(address(token), ok, data);
    }

    function safeApprove(IERC20 token, address spender, uint256 value) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.approve, (spender, value)));
        _checkReturn(address(token), ok, data);
    }

    /// @notice Forwards all remaining gas, unlike `transfer`/`send`.
    function safeTransferNative(address to, uint256 value) internal {
        (bool ok,) = payable(to).call{value: value}("");
        if (!ok) revert NativeTransferFailed(to, value);
    }

    /// @notice Pay `to` in whichever settlement mode `asset` selects.
    function payOut(address asset, address to, uint256 value) internal {
        if (value == 0) return;
        if (asset == address(0)) {
            safeTransferNative(to, value);
        } else {
            safeTransfer(IERC20(asset), to, value);
        }
    }

    function _checkReturn(address token, bool ok, bytes memory data) private view {
        if (!ok) {
            if (data.length > 0) {
                assembly {
                    revert(add(data, 0x20), mload(data))
                }
            }
            revert ERC20CallFailed(token);
        }
        if (data.length == 0) {
            if (token.code.length == 0) revert ERC20CallFailed(token);
            return; // non-standard token, no return value
        }
        if (!abi.decode(data, (bool))) revert ERC20OperationFailed(token);
    }
}
