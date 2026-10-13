// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "../src/interfaces/IReputationRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

/// @title AbiConformance.t.sol — ERC-8004 ABI is pinned to the SPEC, not to us
/// @notice Codex review R1: a hand-written interface plus a mock built from the
///         same hand-written interface proves only that our system talks to
///         itself. On the real registry a wrong parameter list is a different
///         selector (silent failure that surfaces as "feedback stays pending
///         forever") and a wrong return arity is a decode revert.
///
///         Every assertion below derives the expected selector from the literal
///         signature STRING quoted from https://eips.ethereum.org/EIPS/eip-8004,
///         so these tests fail the moment our interface drifts from the ERC —
///         they cannot be satisfied by changing both sides together.
///
///         This offline suite checks the declared ABI and mock constraints.
///         Day-0 also verified the actual Monad testnet registries at block
///         67277702; see spike/Day0Canonical.t.sol and docs/day0-findings.md.
///         That fork is opt-in and does not add a network dependency here.
contract AbiConformanceTest is Test {
    address internal agentOwner = makeAddr("agentOwner");
    address internal agentWallet = makeAddr("agentWallet");
    /// @dev A third party, distinct from the agent's owner: the ERC forbids
    ///      self-attestation, and in InferCredit the reporter is the adapter.
    address internal reporter = makeAddr("reporter");

    // ---------------------------------------------------------------------
    // Identity Registry
    // ---------------------------------------------------------------------

    function test_IdentityRegistry_SelectorsMatchTheErc() public pure {
        assertEq(
            IIdentityRegistry.register.selector,
            bytes4(keccak256("register(string)")),
            "register(string) overload"
        );
        assertEq(IIdentityRegistry.ownerOf.selector, bytes4(keccak256("ownerOf(uint256)")), "ERC-721 ownerOf");
        assertEq(
            IIdentityRegistry.getAgentWallet.selector,
            bytes4(keccak256("getAgentWallet(uint256)")),
            "getAgentWallet"
        );
        assertEq(
            IIdentityRegistry.setAgentWallet.selector,
            bytes4(keccak256("setAgentWallet(uint256,address,uint256,bytes)")),
            "setAgentWallet MUST carry deadline + consent signature"
        );
        assertEq(
            IIdentityRegistry.unsetAgentWallet.selector,
            bytes4(keccak256("unsetAgentWallet(uint256)")),
            "unsetAgentWallet"
        );
    }

    /// The pre-review interface declared `setAgentWallet(uint256,address)`.
    /// That is a DIFFERENT function on chain; pin it as explicitly wrong so the
    /// regression cannot quietly return.
    function test_IdentityRegistry_TwoArgSetAgentWalletIsNotTheErc() public pure {
        assertTrue(
            IIdentityRegistry.setAgentWallet.selector != bytes4(keccak256("setAgentWallet(uint256,address)")),
            "the 2-arg form is not the ERC-8004 function"
        );
    }

    // ---------------------------------------------------------------------
    // Reputation Registry
    // ---------------------------------------------------------------------

    function test_ReputationRegistry_SelectorsMatchTheErc() public pure {
        assertEq(
            IReputationRegistry.giveFeedback.selector,
            bytes4(keccak256("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)")),
            "giveFeedback: 8 params, value is int128, tags come AFTER the value"
        );
        assertEq(
            IReputationRegistry.getSummary.selector,
            bytes4(keccak256("getSummary(uint256,address[],string,string)")),
            "getSummary: clientAddresses is the SECOND argument"
        );
        assertEq(
            IReputationRegistry.readFeedback.selector,
            bytes4(keccak256("readFeedback(uint256,address,uint64)")),
            "readFeedback"
        );
        assertEq(
            IReputationRegistry.getIdentityRegistry.selector,
            bytes4(keccak256("getIdentityRegistry()")),
            "getIdentityRegistry"
        );
    }

    /// The pre-review interface used a 5-parameter `giveFeedback` with a uint128
    /// value and the tags first. Pin the divergence.
    function test_ReputationRegistry_LegacyFiveArgFormIsNotTheErc() public pure {
        assertTrue(
            IReputationRegistry.giveFeedback.selector
                != bytes4(keccak256("giveFeedback(uint256,string,string,uint128,uint8)")),
            "the 5-arg uint128 form is not the ERC-8004 function"
        );
        assertTrue(
            IReputationRegistry.getSummary.selector
                != bytes4(keccak256("getSummary(uint256,string,string,address[])")),
            "tags-first getSummary is not the ERC-8004 function"
        );
    }

    /// @dev Codex R2 review D: the agent OWNER must not be the reporter. The ERC
    ///      forbids self-attestation, so a fixture where the test contract owns
    ///      the agent and reviews it would have been exercising behaviour the
    ///      canonical registry rejects. `owner` and `reporter` are now distinct,
    ///      and `test_ReputationRegistry_OwnerMayNotReviewItsOwnAgent` pins the
    ///      rejection.
    function _freshRegistries()
        internal
        returns (MockIdentityRegistry idn, MockReputationRegistry rep, uint256 agentId)
    {
        idn = new MockIdentityRegistry();
        rep = new MockReputationRegistry(address(idn));
        agentId = idn.registerFor(agentOwner, agentWallet);
    }

    /// A wrong return arity decodes to garbage or reverts. Encode the canonical
    /// 3-value return and confirm it decodes, and that a 2-value return does not
    /// satisfy the declared signature.
    function test_ReputationRegistry_GetSummaryReturnsThreeValues() public {
        (, MockReputationRegistry rep, uint256 agentId) = _freshRegistries();

        vm.prank(reporter);
        rep.giveFeedback(agentId, int128(100), 0, "infercredit", "repayment", "", "", bytes32(0));

        address[] memory clients = new address[](1);
        clients[0] = reporter;

        (bool ok, bytes memory data) = address(rep)
            .staticcall(
                abi.encodeWithSelector(
                    IReputationRegistry.getSummary.selector, agentId, clients, "infercredit", "repayment"
                )
            );
        assertTrue(ok, "canonical getSummary call must succeed");
        assertEq(data.length, 96, "three 32-byte words: count, summaryValue, summaryValueDecimals");

        (uint64 count, int128 summaryValue, uint8 decimals) = abi.decode(data, (uint64, int128, uint8));
        assertEq(count, 1, "one entry");
        assertEq(summaryValue, int128(100), "single entry: mean == the value itself");
        assertEq(decimals, 0, "decimals");
    }

    function test_ReputationRegistry_EmptyClientFilterCannotIncludeArbitraryReporters() public {
        (, MockReputationRegistry rep, uint256 agentId) = _freshRegistries();
        vm.prank(reporter);
        rep.giveFeedback(agentId, 100, 0, "infercredit", "repayment", "", "", bytes32(0));
        vm.expectRevert("clientAddresses required");
        rep.getSummary(agentId, new address[](0), "infercredit", "repayment");
        address[] memory clients = new address[](1);
        clients[0] = makeAddr("unrelated-reporter");
        (uint64 count,,) = rep.getSummary(agentId, clients, "infercredit", "repayment");
        assertEq(count, 0, "explicit client filter does not include the stored reporter");
        clients[0] = reporter;
        (count,,) = rep.getSummary(agentId, clients, "infercredit", "repayment");
        assertEq(count, 1);
    }

    /// `value` is signed in the ERC. A negative score must survive the round trip
    /// — the old uint128 declaration would have mangled it.
    /// Feedback indices are 1-based in the ERC (Codex R2 review D), so the first
    /// entry is read at index 1, not 0.
    function test_ReputationRegistry_ValueIsSignedAndSurvivesRoundTrip() public {
        (, MockReputationRegistry rep, uint256 agentId) = _freshRegistries();

        vm.prank(reporter);
        rep.giveFeedback(agentId, int128(-250), 2, "infercredit", "default", "", "", bytes32(0));

        (int128 value, uint8 decimals,,, bool revoked) = rep.readFeedback(agentId, reporter, 1);
        assertEq(value, int128(-250), "negative feedback must stay negative");
        assertEq(decimals, 2, "decimals preserved");
        assertFalse(revoked, "not revoked");
    }

    /// Index 0 is not a valid feedback index.
    function test_ReputationRegistry_FeedbackIndicesAreOneBased() public {
        (, MockReputationRegistry rep, uint256 agentId) = _freshRegistries();

        vm.prank(reporter);
        rep.giveFeedback(agentId, int128(100), 0, "infercredit", "repayment", "", "", bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(MockReputationRegistry.UnknownFeedback.selector, agentId, reporter, 0)
        );
        rep.readFeedback(agentId, reporter, 0);

        vm.prank(reporter);
        rep.giveFeedback(agentId, int128(80), 0, "infercredit", "repayment", "", "", bytes32(0));
        (int128 second,,,,) = rep.readFeedback(agentId, reporter, 2);
        assertEq(second, int128(80), "the second entry is index 2");
    }

    /// The ERC forbids the agent's owner from attesting to its own agent.
    function test_ReputationRegistry_OwnerMayNotReviewItsOwnAgent() public {
        (, MockReputationRegistry rep, uint256 agentId) = _freshRegistries();

        vm.prank(agentOwner);
        vm.expectRevert(
            abi.encodeWithSelector(MockReputationRegistry.SelfFeedbackForbidden.selector, agentId, agentOwner)
        );
        rep.giveFeedback(agentId, int128(100), 0, "infercredit", "repayment", "", "", bytes32(0));
    }

    /// Feedback about an agent that does not exist must be rejected.
    function test_ReputationRegistry_RejectsFeedbackForUnknownAgent() public {
        (MockIdentityRegistry idn, MockReputationRegistry rep,) = _freshRegistries();

        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(MockIdentityRegistry.NonexistentAgent.selector, uint256(999)));
        rep.giveFeedback(999, int128(100), 0, "infercredit", "repayment", "", "", bytes32(0));
        idn; // silence unused-variable lint
    }

    function test_ReputationRegistry_RejectsOversizedValueDecimals() public {
        (, MockReputationRegistry rep, uint256 agentId) = _freshRegistries();

        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(MockReputationRegistry.ValueDecimalsTooLarge.selector, uint8(19))
        );
        rep.giveFeedback(agentId, int128(100), 19, "infercredit", "repayment", "", "", bytes32(0));
    }
}
