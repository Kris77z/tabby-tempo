// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIdentityRegistry — ERC-8004 Identity Registry (canonical subset)
/// @notice Only the surface InferCredit actually touches is declared here, but
///         every declaration below is copied VERBATIM from the ERC-8004
///         specification — selectors and return decoding must match the real
///         deployment, not a convenient local invention.
///         Canonical deployment (ENGINEERING §3):
///         0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
/// @dev Source: https://eips.ethereum.org/EIPS/eip-8004
///      The registry extends ERC-721; `agentId` is the token id, so `ownerOf`
///      is inherited rather than redeclared by the ERC. RISK_AND_MVP §1.4: both
///      owner and wallet are mutable, and either mutation must invalidate
///      outstanding credit.
///
///      `test/AbiConformance.t.sol` pins every selector below against the
///      literal signature string from the spec, so this file cannot drift.
interface IIdentityRegistry {
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    /// @notice Mint a new agent identity to `msg.sender`.
    function register(string calldata agentURI) external returns (uint256 agentId);

    /// @notice ERC-721 owner of the identity token (inherited by the registry).
    function ownerOf(uint256 agentId) external view returns (address owner);

    /// @notice Operational wallet authorised to act for the agent.
    ///         Returns address(0) when no wallet is bound — which is the state
    ///         an identity transfer leaves behind.
    function getAgentWallet(uint256 agentId) external view returns (address wallet);

    /// @notice Bind an operational wallet. The ERC requires the NEW wallet to
    ///         consent via `signature` before `deadline`, so a transferred
    ///         identity cannot silently keep (or steal) a wallet binding.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external;

    /// @notice Clear the wallet binding (owner side).
    function unsetAgentWallet(uint256 agentId) external;
}
