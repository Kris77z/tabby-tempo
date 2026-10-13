// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputationRegistry} from "../../src/interfaces/IReputationRegistry.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @notice Test double for the canonical ERC-8004 Reputation Registry.
/// @dev Implements the canonical ABI exactly (8-parameter `giveFeedback`,
///      3-value `getSummary` with `clientAddresses` second). `int128 value`
///      matters: feedback may be negative.
///
///      `summaryValue` aggregation is left implementation-defined by the ERC.
///      This mock returns the arithmetic MEAN and exposes
///      `cheatSetSummaryMode` so a test can flip it to SUM — any protocol code
///      that silently depends on one or the other will then break, which is the
///      point. InferCredit must only ever consume `count`.
///
///      Canonical semantics enforced here (Codex R2 review D):
///      - the agent must EXIST (the identity registry's `ownerOf` reverts otherwise);
///      - the agent's OWNER may not review its own agent — self-attestation is
///        forbidden by the ERC, and allowing it would let a conformance test
///        "pass" against behaviour the real registry rejects;
///      - `valueDecimals` is capped at 18;
///      - `getSummary` requires an explicit, nonempty client filter;
///      - feedback indices are **1-based** externally (the ERC numbers them from
///        1); the internal array stays 0-based and the two are converted here.
///
///      NOT modelled (explicitly out of scope, listed so nobody mistakes silence
///      for coverage): approved-operator exclusion (this mock has no ERC-721
///      approval surface), feedback authorisation/allow-lists, and the real
///      registry's own `summaryValue` aggregation.
///
///      Failure injection for review #5 (reputation never rolls back money):
///      - `cheatSetFailing(true)`  → `giveFeedback` reverts.
///      - `cheatSetOutOfGas(true)` → it burns every forwarded wei of gas, the
///        failure mode a naive `try/catch` does not survive.
contract MockReputationRegistry is IReputationRegistry {
    enum SummaryMode {
        Mean,
        Sum
    }

    struct Entry {
        address client;
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
        bool revoked;
    }

    Entry[] internal _entries;
    /// @dev agentId => client => indices into `_entries`, mirroring the ERC's
    ///      per-(agent, client) feedback indexing used by `readFeedback`.
    mapping(uint256 => mapping(address => uint256[])) internal _byAgentClient;

    address public immutable identityRegistry;

    bool public failing;
    bool public outOfGas;
    SummaryMode public summaryMode = SummaryMode.Mean;

    error InjectedFailure();
    error UnknownFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex);
    /// @dev The ERC forbids the agent's owner (or an approved operator) from
    ///      giving that agent feedback.
    error SelfFeedbackForbidden(uint256 agentId, address clientAddress);
    error ValueDecimalsTooLarge(uint8 valueDecimals);

    constructor(address identityRegistry_) {
        identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return identityRegistry;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (outOfGas) {
            uint256 i;
            while (true) {
                unchecked {
                    ++i;
                }
                assembly {
                    mstore(0, i)
                }
            }
        }
        if (failing) revert InjectedFailure();

        // canonical preconditions (Codex R2 review D)
        if (valueDecimals > 18) revert ValueDecimalsTooLarge(valueDecimals);
        // reverts for a nonexistent agent, which is also required by the ERC
        if (IIdentityRegistry(identityRegistry).ownerOf(agentId) == msg.sender) {
            revert SelfFeedbackForbidden(agentId, msg.sender);
        }

        // externally 1-based, internally 0-based
        uint64 feedbackIndex = uint64(_byAgentClient[agentId][msg.sender].length) + 1;
        _byAgentClient[agentId][msg.sender].push(_entries.length);
        _entries.push(
            Entry(
                msg.sender,
                agentId,
                value,
                valueDecimals,
                tag1,
                tag2,
                endpoint,
                feedbackURI,
                feedbackHash,
                false
            )
        );
        // emitted from a helper: the 11-field canonical event does not fit in
        // the stack alongside eight calldata parameters
        _emitNewFeedback(agentId, feedbackIndex, _entries[_entries.length - 1]);
    }

    function _emitNewFeedback(uint256 agentId, uint64 feedbackIndex, Entry storage e) private {
        emit NewFeedback(
            agentId,
            e.client,
            feedbackIndex,
            e.value,
            e.valueDecimals,
            e.tag1,
            e.tag1,
            e.tag2,
            e.endpoint,
            e.feedbackURI,
            e.feedbackHash
        );
    }

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        require(clientAddresses.length != 0, "clientAddresses required");
        bytes32 h1 = keccak256(bytes(tag1));
        bytes32 h2 = keccak256(bytes(tag2));
        int256 total;
        for (uint256 i; i < _entries.length; i++) {
            Entry storage e = _entries[i];
            if (e.revoked) continue;
            if (e.agentId != agentId) continue;
            if (keccak256(bytes(e.tag1)) != h1) continue;
            if (keccak256(bytes(e.tag2)) != h2) continue;
            if (!_isClient(clientAddresses, e.client)) continue; // §6.1 anti-Sybil filter
            count++;
            total += int256(e.value);
            summaryValueDecimals = e.valueDecimals;
        }
        if (count == 0) return (0, 0, 0);
        summaryValue =
            summaryMode == SummaryMode.Mean ? int128(total / int256(uint256(count))) : int128(total);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        uint256[] storage idx = _byAgentClient[agentId][clientAddress];
        if (feedbackIndex == 0 || feedbackIndex > idx.length) {
            revert UnknownFeedback(agentId, clientAddress, feedbackIndex);
        }
        Entry storage e = _entries[idx[feedbackIndex - 1]];
        return (e.value, e.valueDecimals, e.tag1, e.tag2, e.revoked);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        uint256[] storage idx = _byAgentClient[agentId][msg.sender];
        if (feedbackIndex == 0 || feedbackIndex > idx.length) {
            revert UnknownFeedback(agentId, msg.sender, feedbackIndex);
        }
        _entries[idx[feedbackIndex - 1]].revoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    // ---- test helpers ----

    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    function entryAt(uint256 i) external view returns (Entry memory) {
        return _entries[i];
    }

    /// @notice Count entries matching (agentId, tag2) regardless of client.
    function countFor(uint256 agentId, string memory tag2) external view returns (uint256 n) {
        bytes32 h2 = keccak256(bytes(tag2));
        for (uint256 i; i < _entries.length; i++) {
            if (_entries[i].agentId == agentId && keccak256(bytes(_entries[i].tag2)) == h2) n++;
        }
    }

    function cheatSetFailing(bool v) external {
        failing = v;
    }

    function cheatSetOutOfGas(bool v) external {
        outOfGas = v;
    }

    /// @notice Flip the (ERC-undefined) aggregation of `summaryValue`.
    function cheatSetSummaryMode(SummaryMode m) external {
        summaryMode = m;
    }

    function _isClient(address[] calldata clients, address who) private pure returns (bool) {
        for (uint256 i; i < clients.length; i++) {
            if (clients[i] == who) return true;
        }
        return false;
    }
}
