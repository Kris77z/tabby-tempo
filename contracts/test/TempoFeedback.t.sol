// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InferCreditTestBase} from "./helpers/InferCreditTestBase.sol";
import {ERC8004Adapter} from "../src/ERC8004Adapter.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "../src/interfaces/IReputationRegistry.sol";
import {ICreditManager} from "../src/interfaces/ICreditManager.sol";

/// A real registry may require more gas than the original 500k callback budget.
contract StorageCostRegistry {
    uint256 public writes;

    function giveFeedback(uint256, int128, uint8, string calldata, string calldata, string calldata, string calldata, bytes32) external {
        require(gasleft() > 750_000, "REGISTRY_STORAGE_GAS");
        writes++;
    }
}

contract TempoFeedbackTest is InferCreditTestBase {
    function setUp() public override {
        vm.chainId(42431);
        super.setUp();
    }

    function test_TempoFeedbackCanReachARegistryAboveTheOriginalGasBound() public {
        StorageCostRegistry registry = new StorageCostRegistry();
        ERC8004Adapter tempo = new ERC8004Adapter(IIdentityRegistry(address(identity)), IReputationRegistry(address(registry)), address(this));
        tempo.setReporter(address(this), true);
        assertEq(tempo.feedbackGasLimit(), 4_000_000);
        assertTrue(tempo.reportFeedback(1, "repayment", 100, 0));
        assertEq(registry.writes(), 1);

        vm.chainId(31337);
        ERC8004Adapter original = new ERC8004Adapter(IIdentityRegistry(address(identity)), IReputationRegistry(address(registry)), address(this));
        original.setReporter(address(this), true);
        assertEq(original.feedbackGasLimit(), 500_000);
        assertFalse(original.reportFeedback(1, "repayment", 100, 0));
        assertEq(registry.writes(), 1);
        assertEq(tempo.feedbackGasLimit(), 4_000_000, "deployment fixes the budget");
    }

    function test_TempoExhaustedCallbacksStillPreserveRepaymentAndParkFeedback() public {
        _seedVault(VAULT_SEED);
        uint256 agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        _depositCash(agentId, agentOwner, DEMO_SEED_CASH);
        uint256 taskId = _createTask(poster, DEMO_REWARD);
        _acceptTask(taskId, agentId, agentWallet);
        _drawWithLoanDue(agentId, taskId, DEMO_QUOTE, 0.08 ether, TIER_C_FEE_BPS, TIER_C, block.timestamp + 1 hours, keccak256("tempo"));
        reputation.cheatSetOutOfGas(true);

        vm.prank(verifier);
        escrow.settle{gas: 12_000_000}(taskId, true);

        assertLoanStatus(taskId, ICreditManager.LoanStatus.Repaid, "funds survive bounded registry failure");
        assertEq(account.cash(agentId), DEMO_RESIDUE_1);
        assertTrue(escrow.pendingFeedback(taskId, FB_REPAYMENT));
        assertTrue(escrow.pendingFeedback(taskId, FB_TASK_SUCCESS));
    }
}
