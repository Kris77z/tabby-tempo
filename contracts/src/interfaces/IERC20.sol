// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC20 — minimal ERC-20 face used by the ERC-20 settlement mode.
/// @dev ENGINEERING §3 item 3: the settlement asset is a constructor parameter.
///      `address(0)` selects native-coin mode (every inbound function is
///      `payable` and checks `msg.value == amount`); any other address selects
///      ERC-20 mode (`msg.value == 0` + `safeTransferFrom`).
///      Non-standard tokens that return no bool are tolerated via SafeTransferLib.
interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function decimals() external view returns (uint8);
}
