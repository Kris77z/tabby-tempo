// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReputationRegistry — ERC-8004 Reputation Registry (canonical subset)
/// @notice Declarations copied VERBATIM from the ERC-8004 specification.
///         Canonical deployment (ENGINEERING §3):
///         0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
/// @dev Source: https://eips.ethereum.org/EIPS/eip-8004
///
///      Two things InferCredit must respect and previously did not:
///
///      1. `value` is **int128**, not uint128 — feedback may be negative.
///      2. `getSummary` returns THREE values in the order
///         (count, summaryValue, summaryValueDecimals) and takes
///         `clientAddresses` as its SECOND argument, before the tags.
///
///      The ERC deliberately leaves the aggregation behind `summaryValue`
///      implementation-defined ("aggregated validation statistics"), so a
///      consumer MUST NOT assume it is a sum, nor an average. ENGINEERING §6.1's
///      InferScore only ever needs `count`, and
///      `test/Feedback.t.sol::test_InferScoreDependsOnCountOnlyNotOnSummaryValue`
///      pins that dependency so nobody later reaches for `summaryValue`.
///
///      §6.1 step 3 anti-Sybil rule: readers MUST pass
///      `clientAddresses = [address(erc8004Adapter)]`. Feedback written by any
///      other client is invisible to the score.
interface IReputationRegistry {
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(
        uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex
    );

    function getIdentityRegistry() external view returns (address identityRegistry);

    /// @notice Write one feedback entry attributed to `msg.sender` (the client).
    /// @param value Signed metric value, scaled by `valueDecimals`.
    /// @param tag1 Namespace. InferCredit always uses "infercredit".
    /// @param tag2 Metric. One of "repayment" | "task-success" | "default".
    /// @param endpoint Optional service endpoint the feedback refers to.
    /// @param feedbackURI Optional off-chain evidence document.
    /// @param feedbackHash Hash of that document, or bytes32(0).
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    /// @notice Aggregate feedback for `agentId` restricted to `clientAddresses`.
    /// @return count Number of matching, non-revoked feedback entries.
    /// @return summaryValue Registry-defined aggregate — see the note above.
    /// @return summaryValueDecimals Scale of `summaryValue`.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
}
