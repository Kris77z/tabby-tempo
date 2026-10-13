// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC8004Adapter} from "../src/ERC8004Adapter.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "../src/interfaces/IReputationRegistry.sol";

interface IDay0Identity is IIdentityRegistry {
    function transferFrom(address from, address to, uint256 agentId) external;
    function approve(address operator, uint256 agentId) external;
}

/// @dev Opt-in only: this directory is outside Foundry's default `test` path.
/// Run with FOUNDRY_TEST=spike and an explicit --fork-url/--fork-block-number.
/// vm.prank/vm.sign mutate only Foundry's local fork; this test never broadcasts.
contract Day0CanonicalTest is Test {
    IDay0Identity private constant IDENTITY = IDay0Identity(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IReputationRegistry private constant REPUTATION =
        IReputationRegistry(0x8004B663056A597Dffe9eCcC1965A193B7388713);

    // Public, synthetic fixture key. Never use a real account key in this test.
    uint256 private constant WALLET_KEY = 0x80040001;

    function test_CanonicalRegistrationWalletTransferAndAdapterFeedback() public {
        assertEq(block.chainid, 10143, "explicit Monad testnet fork required");
        assertGt(address(IDENTITY).code.length, 0, "identity code missing");
        assertGt(address(REPUTATION).code.length, 0, "reputation code missing");
        assertEq(REPUTATION.getIdentityRegistry(), address(IDENTITY));
        emit log_named_uint("fork block", block.number);

        address agentOwner = makeAddr("day0-owner");
        address newOwner = makeAddr("day0-new-owner");
        address wallet = vm.addr(WALLET_KEY);
        vm.prank(agentOwner);
        uint256 agentId = IDENTITY.register("ipfs://infercredit-day0-local-fork");
        emit log_named_uint("local fork agentId", agentId);
        assertEq(IDENTITY.ownerOf(agentId), agentOwner);
        assertEq(IDENTITY.getAgentWallet(agentId), agentOwner, "registration defaults wallet to owner");

        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory oldOwnerSignature = _walletSignature(agentId, wallet, agentOwner, deadline);
        vm.prank(agentOwner);
        IDENTITY.setAgentWallet(agentId, wallet, deadline, oldOwnerSignature);
        assertEq(IDENTITY.getAgentWallet(agentId), wallet);

        ERC8004Adapter adapter = new ERC8004Adapter(IDENTITY, REPUTATION, address(this));
        adapter.setCreditManager(address(this));
        adapter.enroll(agentId);
        assertFalse(adapter.identityChanged(agentId));
        vm.prank(agentOwner);
        IDENTITY.transferFrom(agentOwner, newOwner, agentId);
        assertEq(IDENTITY.ownerOf(agentId), newOwner);
        assertEq(IDENTITY.getAgentWallet(agentId), address(0), "transfer clears wallet");
        assertTrue(adapter.identityChanged(agentId));

        vm.prank(newOwner);
        vm.expectRevert("invalid wallet sig");
        IDENTITY.setAgentWallet(agentId, wallet, deadline, oldOwnerSignature);
        bytes memory newOwnerSignature = _walletSignature(agentId, wallet, newOwner, deadline);
        vm.prank(newOwner);
        IDENTITY.setAgentWallet(agentId, wallet, deadline, newOwnerSignature);
        adapter.reapprove(agentId);
        assertFalse(adapter.identityChanged(agentId));
        assertEq(adapter.snapshotVersion(agentId), 2);

        _assertFeedback(agentId, adapter, newOwner);
    }

    function _assertFeedback(uint256 agentId, ERC8004Adapter adapter, address newOwner) private {
        // Both actual owner and an approved operator must be rejected by the
        // canonical registry, while the independently owned Adapter may write.
        vm.prank(newOwner);
        vm.expectRevert("Self-feedback not allowed");
        _feedback(agentId, 999);
        address operator = makeAddr("day0-approved-operator");
        vm.prank(newOwner);
        IDENTITY.approve(operator, agentId);
        vm.prank(operator);
        vm.expectRevert("Self-feedback not allowed");
        _feedback(agentId, 999);
        assertTrue(adapter.reportFeedback(agentId, "repayment", 100, 0), "real registry write failed");

        vm.expectRevert("index must be > 0");
        REPUTATION.readFeedback(agentId, address(adapter), 0);
        (int128 value, uint8 decimals, string memory tag1, string memory tag2, bool revoked) =
            REPUTATION.readFeedback(agentId, address(adapter), 1);
        assertEq(int256(value), 100);
        assertEq(decimals, 0);
        assertEq(tag1, "infercredit");
        assertEq(tag2, "repayment");
        assertFalse(revoked);

        address externalReporter = makeAddr("day0-external-reporter");
        vm.prank(externalReporter);
        _feedback(agentId, 999);
        address[] memory clients = new address[](1);
        clients[0] = address(adapter);
        (uint64 count, int128 summary, uint8 summaryDecimals) =
            REPUTATION.getSummary(agentId, clients, "infercredit", "repayment");
        assertEq(count, 1, "external reporter cannot inflate Adapter-filtered count");
        assertEq(int256(summary), 100);
        assertEq(summaryDecimals, 0);
        clients[0] = externalReporter;
        (count, summary,) = REPUTATION.getSummary(agentId, clients, "infercredit", "repayment");
        assertEq(count, 1);
        assertEq(int256(summary), 999);
        vm.expectRevert("clientAddresses required");
        REPUTATION.getSummary(agentId, new address[](0), "infercredit", "repayment");
    }

    function _walletSignature(uint256 agentId, address wallet, address agentOwner, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(IDENTITY)
            )
        );
        bytes32 body = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                agentId,
                wallet,
                agentOwner,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(WALLET_KEY, keccak256(abi.encodePacked("\x19\x01", domain, body)));
        return abi.encodePacked(r, s, v);
    }

    function _feedback(uint256 agentId, int128 value) private {
        REPUTATION.giveFeedback(agentId, value, 0, "infercredit", "repayment", "", "", bytes32(0));
    }
}
