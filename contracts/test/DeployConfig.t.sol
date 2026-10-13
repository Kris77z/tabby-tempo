// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

contract DeployConfigHarness is Deploy {
    function readBasisPoints() external view returns (uint16 ltv, uint16 fee) {
        Params memory p = _readParams(address(1));
        return (p.maxLtvBps, p.protocolFeeBps);
    }

    function readParams() external view returns (Params memory) {
        return _readParams(address(this));
    }

    function preflight(Params memory p) external view {
        _preflight(p);
    }

    function deployConfigured() external returns (Deployment memory d) {
        Params memory p = _readParams(address(this));
        _preflight(p);
        d = _deploy(p);
        _wire(p, d);
    }
}

contract DeployConfigTest is Test {
    address private constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    /// Save and restore only the public configuration fields changed here.
    /// No private key or dotenv file is read, and each test starts explicitly.
    modifier isolatedEnvironment() {
        string[10] memory keys = [
            "UNDERWRITER",
            "VERIFIER",
            "RELAY_REFUNDER",
            "SETTLEMENT_ASSET",
            "IDENTITY_REGISTRY",
            "REPUTATION_REGISTRY",
            "MAX_TOTAL_OUTSTANDING",
            "MAX_DRAW_PER_EPOCH",
            "MAX_LTV_BPS",
            "PROTOCOL_FEE_BPS"
        ];
        string[10] memory previous;
        for (uint256 i; i < keys.length; i++) {
            previous[i] = vm.envOr(keys[i], string(""));
        }
        _resetConfiguration();
        _;
        for (uint256 i; i < keys.length; i++) {
            vm.setEnv(keys[i], previous[i]);
        }
    }

    function _resetConfiguration() private {
        vm.setEnv("UNDERWRITER", vm.toString(address(2)));
        vm.setEnv("VERIFIER", vm.toString(address(3)));
        vm.setEnv("RELAY_REFUNDER", vm.toString(address(4)));
        vm.setEnv("SETTLEMENT_ASSET", vm.toString(address(0)));
        vm.setEnv("IDENTITY_REGISTRY", "");
        vm.setEnv("REPUTATION_REGISTRY", "");
        vm.setEnv("MAX_TOTAL_OUTSTANDING", "");
        vm.setEnv("MAX_DRAW_PER_EPOCH", "");
        vm.setEnv("MAX_LTV_BPS", "8000");
        vm.setEnv("PROTOCOL_FEE_BPS", "0");
        vm.chainId(10143);
    }

    // vm.setEnv changes the process environment: run these related scenarios
    // sequentially in one test, so Foundry's parallel workers cannot race them.
    function test_DeploymentChecksBpsBeforeNarrowingAndRejectsHarnessLeverage() public isolatedEnvironment {
        _checkBasisPoints();
        _resetConfiguration();
        _checkRegistryDefaultsOverridesAndUnknownNetworks();
        _resetConfiguration();
        _checkNativeDefaultsAndExplicitUSDCUnitsReachTheDeployedManager();
        _resetConfiguration();
        _checkPreflightRejectsMissingCodeOrWrongIdentityAndAcceptsAConnectedPair();
        _resetConfiguration();
        _checkTempoRequiresAnExplicitSettlementAssetAndRegistryPair();
    }

    function _checkTempoRequiresAnExplicitSettlementAssetAndRegistryPair() private {
        DeployConfigHarness deploy = new DeployConfigHarness();
        vm.chainId(42431);
        vm.expectRevert(Deploy.TempoSettlementAssetRequired.selector);
        deploy.readParams();
        vm.setEnv("SETTLEMENT_ASSET", vm.toString(address(0x20C0000000000000000000000000000000000000)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.RegistryDefaultsUnavailable.selector, uint256(42431)));
        deploy.readParams();
        MockIdentityRegistry identity = new MockIdentityRegistry();
        MockReputationRegistry reputation = new MockReputationRegistry(address(identity));
        vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(identity)));
        vm.setEnv("REPUTATION_REGISTRY", vm.toString(address(reputation)));
        vm.setEnv("MAX_TOTAL_OUTSTANDING", "50000000");
        vm.setEnv("MAX_DRAW_PER_EPOCH", "20000000");
        Deploy.Deployment memory d = deploy.deployConfigured();
        assertEq(d.manager.settlementAsset(), address(0x20C0000000000000000000000000000000000000));
        assertEq(d.adapter.feedbackGasLimit(), 4_000_000);
    }

    function _checkBasisPoints() private {
        DeployConfigHarness deploy = new DeployConfigHarness();
        (uint16 ltv, uint16 fee) = deploy.readBasisPoints();
        assertEq(ltv, 8_000);
        assertEq(fee, 0);

        uint256[3] memory invalid = [uint256(10_001), 20_000, 65_536];
        for (uint256 i; i < invalid.length; i++) {
            vm.setEnv("MAX_LTV_BPS", vm.toString(invalid[i]));
            vm.expectRevert(abi.encodeWithSelector(Deploy.InvalidBasisPoints.selector, invalid[i]));
            deploy.readBasisPoints();
            vm.setEnv("MAX_LTV_BPS", "8000");
            vm.setEnv("PROTOCOL_FEE_BPS", vm.toString(invalid[i]));
            vm.expectRevert(abi.encodeWithSelector(Deploy.InvalidBasisPoints.selector, invalid[i]));
            deploy.readBasisPoints();
            vm.setEnv("PROTOCOL_FEE_BPS", "0");
        }
        vm.setEnv("MAX_LTV_BPS", "10000");
        vm.setEnv("PROTOCOL_FEE_BPS", "10000");
        (ltv, fee) = deploy.readBasisPoints();
        assertEq(ltv, 10_000);
        assertEq(fee, 10_000);
    }

    function _checkRegistryDefaultsOverridesAndUnknownNetworks() private {
        DeployConfigHarness deploy = new DeployConfigHarness();
        Deploy.Params memory p = deploy.readParams();
        assertEq(p.identityRegistry, 0x8004A818BFB912233c491871b3d84c89A494BD9e);
        assertEq(p.reputationRegistry, 0x8004B663056A597Dffe9eCcC1965A193B7388713);
        vm.chainId(143);
        p = deploy.readParams();
        assertEq(p.identityRegistry, 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
        assertEq(p.reputationRegistry, 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63);

        uint256[3] memory chains = [uint256(10143), 143, 31337];
        for (uint256 i; i < chains.length; i++) {
            vm.chainId(chains[i]);
            vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(10)));
            vm.setEnv("REPUTATION_REGISTRY", "");
            vm.expectRevert(Deploy.IncompleteRegistryPair.selector);
            deploy.readParams();
            vm.setEnv("IDENTITY_REGISTRY", "");
            vm.setEnv("REPUTATION_REGISTRY", vm.toString(address(11)));
            vm.expectRevert(Deploy.IncompleteRegistryPair.selector);
            deploy.readParams();
            vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(10)));
            p = deploy.readParams();
            assertEq(p.identityRegistry, address(10));
            assertEq(p.reputationRegistry, address(11));
        }

        vm.setEnv("IDENTITY_REGISTRY", "");
        vm.setEnv("REPUTATION_REGISTRY", "");
        vm.expectRevert(abi.encodeWithSelector(Deploy.RegistryDefaultsUnavailable.selector, uint256(31337)));
        deploy.readParams();
        vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(10)));
        vm.setEnv("REPUTATION_REGISTRY", vm.toString(address(11)));
        p = deploy.readParams();
        assertEq(p.identityRegistry, address(10));
        assertEq(p.reputationRegistry, address(11));
        vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(0)));
        vm.expectRevert(Deploy.ZeroRegistryAddress.selector);
        deploy.readParams();
        vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(10)));
        vm.setEnv("REPUTATION_REGISTRY", vm.toString(address(0)));
        vm.expectRevert(Deploy.ZeroRegistryAddress.selector);
        deploy.readParams();
    }

    function _checkNativeDefaultsAndExplicitUSDCUnitsReachTheDeployedManager() private {
        DeployConfigHarness deploy = new DeployConfigHarness();
        Deploy.Params memory p = deploy.readParams();
        assertEq(p.maxTotalOutstanding, 50 ether);
        assertEq(p.maxDrawPerEpoch, 20 ether);
        vm.setEnv("SETTLEMENT_ASSET", vm.toString(USDC));
        vm.expectRevert(Deploy.MissingERC20Limits.selector);
        deploy.readParams();
        vm.setEnv("MAX_TOTAL_OUTSTANDING", "50000000");
        vm.expectRevert(Deploy.MissingERC20Limits.selector);
        deploy.readParams();
        vm.setEnv("MAX_TOTAL_OUTSTANDING", "");
        vm.setEnv("MAX_DRAW_PER_EPOCH", "20000000");
        vm.expectRevert(Deploy.MissingERC20Limits.selector);
        deploy.readParams();
        vm.setEnv("MAX_TOTAL_OUTSTANDING", "50000000");
        MockIdentityRegistry identity = new MockIdentityRegistry();
        MockReputationRegistry reputation = new MockReputationRegistry(address(identity));
        vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(identity)));
        vm.setEnv("REPUTATION_REGISTRY", vm.toString(address(reputation)));
        Deploy.Deployment memory d = deploy.deployConfigured();
        assertEq(d.manager.settlementAsset(), USDC);
        assertEq(d.manager.maxTotalOutstanding(), 50_000_000);
        assertEq(d.manager.maxDrawPerEpoch(), 20_000_000);
        assertEq(d.account.settlementAsset(), USDC);
        assertEq(d.escrow.settlementAsset(), USDC);
    }

    function _checkPreflightRejectsMissingCodeOrWrongIdentityAndAcceptsAConnectedPair() private {
        DeployConfigHarness deploy = new DeployConfigHarness();
        Deploy.Params memory p = deploy.readParams();
        p.identityRegistry = makeAddr("missing-identity");
        p.reputationRegistry = makeAddr("missing-reputation");
        vm.expectRevert(abi.encodeWithSelector(Deploy.RegistryHasNoCode.selector, p.identityRegistry));
        deploy.preflight(p);
        MockIdentityRegistry identity = new MockIdentityRegistry();
        p.identityRegistry = address(identity);
        vm.expectRevert(abi.encodeWithSelector(Deploy.RegistryHasNoCode.selector, p.reputationRegistry));
        deploy.preflight(p);
        MockReputationRegistry wrong = new MockReputationRegistry(address(123));
        p.reputationRegistry = address(wrong);
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.RegistryIdentityMismatch.selector, address(identity), address(123))
        );
        deploy.preflight(p);
        MockReputationRegistry correct = new MockReputationRegistry(address(identity));
        p.reputationRegistry = address(correct);
        deploy.preflight(p);
    }
}
