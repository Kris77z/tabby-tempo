// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @notice Test double for the canonical ERC-8004 Identity Registry.
/// @dev Models the parts of the real lifecycle that InferCredit's risk controls
///      depend on (RISK_AND_MVP §1.4), instead of only exposing free-form
///      setters that let a test invent states the real registry cannot reach:
///
///      - `transferIdentity` behaves like a real ERC-721 transfer: it CLEARS the
///        wallet binding. A bought identity therefore arrives walletless and the
///        buyer must re-bind, which is what `test_IdentityTransferLifecycle_*`
///        exercises end to end.
///      - `setAgentWallet` enforces the ERC's consent rule: the NEW wallet must
///        sign, and the signature must be presented before `deadline`. Without
///        this an owner could bind a wallet that never agreed.
///
///      The free-form `cheat*` helpers are kept for unit tests that need to
///      pin a single field, and are named so a reviewer can tell them apart
///      from the faithful paths.
contract MockIdentityRegistry is IIdentityRegistry {
    uint256 public nextAgentId = 1;

    mapping(uint256 => address) internal _owner;
    mapping(uint256 => address) internal _wallet;
    mapping(uint256 => string) public agentURIOf;

    /// @dev Digest the new wallet must sign to accept a binding.
    ///      SIMPLIFICATION (Codex R2 review D): this is a plain struct hash, NOT
    ///      the canonical EIP-712 encoding the real registry uses. It is good
    ///      enough to model "the new wallet must consent before a deadline" for
    ///      protocol unit tests, and it is NOT evidence that our SDK's wallet
    ///      signatures are compatible with the canonical registry. That
    ///      compatibility is part of the Day-0 fork verification, together with
    ///      the rest of the real-deployment checks.
    bytes32 public constant WALLET_BINDING_TYPEHASH =
        keccak256("AgentWalletBinding(uint256 agentId,address newWallet,uint256 deadline)");

    error NonexistentAgent(uint256 agentId);
    error NotIdentityOwner(uint256 agentId, address caller);
    error BindingExpired(uint256 deadline);
    error BadWalletSignature(uint256 agentId, address newWallet);

    // ---------------------------------------------------------------------
    // faithful ERC-8004 surface
    // ---------------------------------------------------------------------

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        _owner[agentId] = msg.sender;
        _wallet[agentId] = msg.sender;
        agentURIOf[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address o = _owner[agentId];
        if (o == address(0)) revert NonexistentAgent(agentId);
        return o;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        if (_owner[agentId] == address(0)) revert NonexistentAgent(agentId);
        return _wallet[agentId];
    }

    /// @inheritdoc IIdentityRegistry
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        if (_owner[agentId] != msg.sender) revert NotIdentityOwner(agentId, msg.sender);
        if (block.timestamp > deadline) revert BindingExpired(deadline);
        if (_recover(walletBindingDigest(agentId, newWallet, deadline), signature) != newWallet) {
            revert BadWalletSignature(agentId, newWallet);
        }
        _wallet[agentId] = newWallet;
    }

    function unsetAgentWallet(uint256 agentId) external {
        if (_owner[agentId] != msg.sender) revert NotIdentityOwner(agentId, msg.sender);
        _wallet[agentId] = address(0);
    }

    function walletBindingDigest(uint256 agentId, address newWallet, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(WALLET_BINDING_TYPEHASH, agentId, newWallet, deadline, block.chainid, address(this))
        );
    }

    // ---------------------------------------------------------------------
    // faithful lifecycle helpers
    // ---------------------------------------------------------------------

    /// @notice Register on behalf of `owner_` with a distinct operational wallet.
    function registerFor(address owner_, address wallet_) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        _owner[agentId] = owner_;
        _wallet[agentId] = wallet_;
        emit Registered(agentId, "", owner_);
    }

    /// @notice ERC-721 transfer of the identity — clears the wallet binding, so
    ///         the buyer of a high-score identity cannot inherit its wallet.
    function transferIdentity(uint256 agentId, address newOwner) external {
        if (_owner[agentId] != msg.sender) revert NotIdentityOwner(agentId, msg.sender);
        _owner[agentId] = newOwner;
        _wallet[agentId] = address(0);
    }

    // ---------------------------------------------------------------------
    // free-form cheats (unit tests that pin one field at a time)
    // ---------------------------------------------------------------------

    /// @notice Rewrite the owner ONLY, leaving the wallet in place. This is not
    ///         a state the real registry produces via a transfer; it exists so
    ///         the "owner changed" half of I3 can be tested in isolation from
    ///         the "wallet changed" half.
    function cheatSetOwnerOnly(uint256 agentId, address newOwner) external {
        _owner[agentId] = newOwner;
    }

    /// @notice Rewrite the wallet ONLY, skipping the consent signature.
    function cheatSetWalletOnly(uint256 agentId, address newWallet) external {
        _wallet[agentId] = newWallet;
    }

    // ---------------------------------------------------------------------

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(digest, v, r, s);
    }
}
