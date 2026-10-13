// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReentrancyGuard
/// @notice Minimal, dependency-free non-reentrancy modifier.
/// @dev ENGINEERING §4.6: "重入锁按合约各自加在外部入口上；调用图保持无环，
///      锁与锁互不嵌套等待。" Each contract guards its own external entry points;
///      the call graph is acyclic by construction (funds are always pushed one
///      way and the callee never calls back into the caller), so no two guards
///      ever wait on each other. The Draw/Liquidation tests assert exactly this:
///      settle(false) → liquidateWithEscrow → debitForLiquidation must complete
///      without a guard collision.
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status = _NOT_ENTERED;

    error ReentrantCall();

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    function _reentrancyEntered() internal view returns (bool) {
        return _status == _ENTERED;
    }
}
