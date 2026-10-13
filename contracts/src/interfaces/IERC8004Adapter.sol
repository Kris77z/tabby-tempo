// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC8004Adapter — ENGINEERING §4.1
interface IERC8004Adapter {
    /// @dev Cached identity tuple. `version` starts at 1 on `enroll` and is
    ///      bumped by `reapprove`; a bump invalidates every outstanding
    ///      CreditAuthorization carrying the old `identityVersion` (I3).
    struct AgentSnapshot {
        address owner;
        address wallet;
        uint64 version;
    }

    event AgentEnrolled(uint256 indexed agentId, address owner, address wallet, uint64 version);
    event AgentReapproved(uint256 indexed agentId, address owner, address wallet, uint64 version);
    event FeedbackReported(uint256 indexed agentId, string tag2, int128 value, uint8 valueDecimals);
    event FeedbackReportFailed(uint256 indexed agentId, string tag2);

    error NotCreditManager(address caller);
    error NotReporter(address caller);
    error NotOwner(address caller);
    error AlreadyWired();
    error ZeroAddress();
    error AgentAlreadyEnrolled(uint256 agentId);
    error AgentNotEnrolled(uint256 agentId);

    /// @notice Live read of the canonical registry. Payment / credit wallet
    ///         checks MUST use this, never the snapshot (review r2 #2).
    function resolveAgent(uint256 agentId) external view returns (address owner, address wallet);

    /// @notice True when the live tuple differs from the snapshot.
    function identityChanged(uint256 agentId) external view returns (bool);

    /// @notice Snapshot version; 0 means "never enrolled".
    function snapshotVersion(uint256 agentId) external view returns (uint64);

    function snapshots(uint256 agentId) external view returns (address owner, address wallet, uint64 version);

    /// @notice First-time initialisation, version = 1. CreditManager only.
    function enroll(uint256 agentId) external;

    /// @notice The ONLY path that refreshes the snapshot and increments version.
    ///         CreditManager only (triggered by underwriter re-review).
    function reapprove(uint256 agentId) external;

    /// @notice Write reputation with tag1 = "infercredit". Reporters only
    ///         (TaskEscrow / CreditManager).
    /// @dev The adapter is the `msg.sender` the registry records as the
    ///      feedback client, which is what makes §6.1's
    ///      `clientAddresses = [adapter]` filter work. That attribution holds
    ///      wherever the try/catch sits — see TEST_PLAN G6. Returning a bool
    ///      (rather than letting the caller wrap this in its own try/catch) is
    ///      an implementation CHOICE made here so that the "reputation failure
    ///      never rolls back settlement" rule (review #5) is enforced in one
    ///      place instead of at every call site.
    /// @param value Signed, per the canonical ERC-8004 ABI (int128, not uint128).
    /// @return ok False when the canonical registry reverted or ran out of gas;
    ///         the caller records a pending-feedback entry instead of reverting.
    function reportFeedback(uint256 agentId, string calldata tag2, int128 value, uint8 valueDecimals)
        external
        returns (bool ok);
}
