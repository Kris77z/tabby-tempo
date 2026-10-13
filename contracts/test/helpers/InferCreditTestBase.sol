// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {ERC8004Adapter} from "../../src/ERC8004Adapter.sol";
import {CreditManager} from "../../src/CreditManager.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {TaskEscrow} from "../../src/TaskEscrow.sol";

import {ICreditManager} from "../../src/interfaces/ICreditManager.sol";
import {IAgentAccount} from "../../src/interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "../../src/interfaces/ITaskEscrow.sol";
import {IERC8004Adapter} from "../../src/interfaces/IERC8004Adapter.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "../../src/interfaces/IReputationRegistry.sol";

import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../mocks/MockReputationRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title InferCreditTestBase
/// @notice Shared fixture for the InferCredit suite.
///
/// Every assertion in this suite is written against the CORRECT implementation
/// described by ENGINEERING §4. The contracts under test are skeletons whose
/// bodies `revert("NotImplemented")`, so the suite is expected to be fully red;
/// that is the TDD contract, not a bug. Nothing here asserts "NotImplemented".
///
/// Settlement asset (ENGINEERING §3): the base fixture runs NATIVE mode
/// (`settlementAsset == address(0)`). `Erc20Mode.t.sol` flips `_useErc20()` to
/// true and re-runs the pairing-sensitive paths.
abstract contract InferCreditTestBase is Test {
    // ---------------------------------------------------------------------
    // actors
    // ---------------------------------------------------------------------

    uint256 internal constant UNDERWRITER_PK = 0xA11CE;
    uint256 internal constant ROGUE_PK = 0xBADBAD;
    uint256 internal constant AGENT_WALLET_PK = 0xB0B;
    uint256 internal constant AGENT_WALLET2_PK = 0xB0B2;
    uint256 internal constant OTHER_AGENT_WALLET_PK = 0xC0FFEE;

    address internal underwriter = vm.addr(UNDERWRITER_PK);
    address internal rogueSigner = vm.addr(ROGUE_PK);
    address internal agentWallet = vm.addr(AGENT_WALLET_PK);
    address internal agentWallet2 = vm.addr(AGENT_WALLET2_PK);
    address internal otherAgentWallet = vm.addr(OTHER_AGENT_WALLET_PK);

    address internal deployer = makeAddr("deployer");
    address internal treasury = makeAddr("treasury");
    address internal guardian = makeAddr("guardian");
    address internal verifier = makeAddr("verifier");
    address internal relayRefunder = makeAddr("relayRefunder");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal poster = makeAddr("poster");
    address internal poster2 = makeAddr("poster2");
    address internal agentOwner = makeAddr("agentOwner");
    address internal otherAgentOwner = makeAddr("otherAgentOwner");
    address internal provider = makeAddr("providerRelay");
    address internal evilProvider = makeAddr("evilProvider");
    address internal stranger = makeAddr("stranger");

    // ---------------------------------------------------------------------
    // system under test
    // ---------------------------------------------------------------------

    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockERC20 internal token; // only deployed in ERC-20 mode

    ERC8004Adapter internal adapter;
    CreditManager internal manager;
    AgentAccount internal account;
    TaskEscrow internal escrow;

    address internal settlementAsset;

    // ---------------------------------------------------------------------
    // parameters (ENGINEERING §4.5 / §6.1)
    // ---------------------------------------------------------------------

    uint16 internal constant MAX_LTV_BPS = 8_000;
    uint256 internal constant GRACE = 1 hours;
    uint256 internal constant EPOCH_LENGTH = 1 days;
    uint256 internal constant BPS = 10_000;

    /// @dev The demo economics of §6.1 net out exactly only with a zero protocol
    ///      fee (0.15 − 0.092 = 0.058). Tests that need a non-zero fee raise it
    ///      explicitly via `_setProtocolFee`.
    uint16 internal constant DEFAULT_PROTOCOL_FEE_BPS = 0;

    uint256 internal constant VAULT_SEED = 100 ether;
    uint256 internal constant MAX_TOTAL_OUTSTANDING = 50 ether;
    uint256 internal constant MAX_DRAW_PER_EPOCH = 20 ether;

    /// Tier table (§6.1 step 4 / RISK_AND_MVP §2).
    uint16 internal constant TIER_A_FEE_BPS = 300;
    uint16 internal constant TIER_B_FEE_BPS = 800;
    uint16 internal constant TIER_C_FEE_BPS = 1_500;
    uint8 internal constant TIER_A = 1;
    uint8 internal constant TIER_B = 2;
    uint8 internal constant TIER_C = 3;

    /// Demo three-order economics (§6.1「余额准备」paragraph).
    uint256 internal constant DEMO_REWARD = 0.15 ether;
    uint256 internal constant DEMO_QUOTE = 0.12 ether;
    uint256 internal constant DEMO_SEED_CASH = 0.04 ether;
    uint256 internal constant DEMO_DEBT_1 = 0.092 ether; // 0.08 principal @1500bps
    uint256 internal constant DEMO_RESIDUE_1 = 0.058 ether;
    uint256 internal constant DEMO_RESIDUE_2 = 0.0787 ether;
    uint256 internal constant DEMO_RESIDUE_3 = 0.105396 ether;

    uint256 internal constant DEFAULT_TASK_DURATION = 7 days;

    uint256 internal nextNonce = 1;

    /// @dev Cached in setUp. Calling `escrow.FEEDBACK_*()` inline inside a test
    ///      argument list would consume the pending `vm.prank` / `vm.expectRevert`
    ///      before the function under test is even reached (Codex review R3), so
    ///      these are read exactly once, here.
    uint8 internal FB_TASK_SUCCESS;
    uint8 internal FB_REPAYMENT;
    uint8 internal FB_DEFAULT;

    // ---------------------------------------------------------------------
    // setup
    // ---------------------------------------------------------------------

    /// @dev Override in the ERC-20 suite.
    function _useErc20() internal pure virtual returns (bool) {
        return false;
    }

    /// @dev Override to build a deliberately over-levered deployment.
    ///      At MAX_LTV_BPS <= 10_000 the I6 bound guarantees the escrow alone
    ///      always covers the debt, which makes waterfall layers 3 (backstop)
    ///      and 4 (LP loss) structurally unreachable — see SPEC FINDING F6 in
    ///      contracts/TEST_PLAN.md. `LiquidationOverLeveredTest` raises this so
    ///      those layers can still be pinned down by tests.
    function _maxLtvBps() internal pure virtual returns (uint16) {
        return MAX_LTV_BPS;
    }

    function setUp() public virtual {
        vm.warp(1_700_000_000);

        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry(address(identity));

        if (_useErc20()) {
            token = new MockERC20("Mock USD", "mUSD", 18);
            settlementAsset = address(token);
        } else {
            settlementAsset = address(0);
        }

        vm.startPrank(deployer);
        adapter = new ERC8004Adapter(
            IIdentityRegistry(address(identity)), IReputationRegistry(address(reputation)), deployer
        );

        manager = new CreditManager(
            CreditManager.Config({
                settlementAsset: settlementAsset,
                adapter: IERC8004Adapter(address(adapter)),
                underwriter: underwriter,
                treasury: treasury,
                guardian: guardian,
                relayRefunder: relayRefunder,
                owner: deployer,
                maxLtvBps: _maxLtvBps(),
                grace: GRACE
            })
        );

        account = new AgentAccount(settlementAsset, IERC8004Adapter(address(adapter)), deployer);

        escrow = new TaskEscrow(
            settlementAsset,
            IERC8004Adapter(address(adapter)),
            verifier,
            feeRecipient,
            DEFAULT_PROTOCOL_FEE_BPS,
            deployer
        );

        manager.setProtocolContracts(IAgentAccount(address(account)), ITaskEscrow(address(escrow)));
        account.setProtocolContracts(ICreditManager(address(manager)), address(escrow));
        escrow.setProtocolContracts(ICreditManager(address(manager)), IAgentAccount(address(account)));

        adapter.setCreditManager(address(manager));
        adapter.setReporter(address(escrow), true);

        manager.setGlobalLimits(MAX_TOTAL_OUTSTANDING, MAX_DRAW_PER_EPOCH);
        account.setProviderWhitelist(provider, true);
        vm.stopPrank();

        FB_TASK_SUCCESS = escrow.FEEDBACK_TASK_SUCCESS();
        FB_REPAYMENT = escrow.FEEDBACK_REPAYMENT();
        FB_DEFAULT = escrow.FEEDBACK_DEFAULT();

        _fund(treasury, 1_000 ether);
        _fund(poster, 1_000 ether);
        _fund(poster2, 1_000 ether);
        _fund(agentOwner, 1_000 ether);
        _fund(otherAgentOwner, 1_000 ether);
        _fund(relayRefunder, 1_000 ether);
        _fund(stranger, 1_000 ether);
        vm.deal(agentWallet, 10 ether); // gas only
        vm.deal(otherAgentWallet, 10 ether);
    }

    // ---------------------------------------------------------------------
    // settlement-asset helpers (ENGINEERING §3: native / ERC-20 pairing)
    // ---------------------------------------------------------------------

    function _fund(address who, uint256 amount) internal {
        if (_useErc20()) {
            token.mint(who, amount);
            vm.deal(who, 10 ether); // gas
        } else {
            vm.deal(who, amount);
        }
    }

    /// @notice msg.value to attach for an inbound transfer of `amount`.
    function _val(uint256 amount) internal view returns (uint256) {
        return _useErc20() ? 0 : amount;
    }

    function _balanceOf(address who) internal view returns (uint256) {
        return _useErc20() ? token.balanceOf(who) : who.balance;
    }

    function _approve(address who, address spender, uint256 amount) internal {
        if (!_useErc20()) return;
        vm.prank(who);
        token.approve(spender, amount);
    }

    // ---------------------------------------------------------------------
    // scenario builders
    // ---------------------------------------------------------------------

    /// @notice Register an agent in the mock registry and enroll it (tx0, §5).
    function _registerAgent(address owner_, address wallet_) internal returns (uint256 agentId) {
        agentId = identity.registerFor(owner_, wallet_);
    }

    function _enroll(uint256 agentId) internal {
        vm.prank(guardian);
        manager.enrollAgent(agentId);
    }

    function _registerAndEnroll(address owner_, address wallet_) internal returns (uint256 agentId) {
        agentId = _registerAgent(owner_, wallet_);
        _enroll(agentId);
    }

    function _seedVault(uint256 amount) internal {
        _approve(treasury, address(manager), amount);
        vm.prank(treasury);
        manager.deposit{value: _val(amount)}(amount);
    }

    function _depositCash(uint256 agentId, address owner_, uint256 amount) internal {
        _approve(owner_, address(account), amount);
        vm.prank(owner_);
        account.depositCash{value: _val(amount)}(agentId, amount);
    }

    function _fundBackstop(uint256 agentId, address funder, uint256 amount) internal {
        _approve(funder, address(manager), amount);
        vm.prank(funder);
        manager.fundBackstop{value: _val(amount)}(agentId, amount);
    }

    function _setPermissivePolicy(uint256 agentId, address owner_) internal {
        vm.prank(owner_);
        account.setPolicy(
            agentId,
            IAgentAccount.Policy({
                maxCashPerTx: type(uint256).max,
                maxDebtPerTx: type(uint256).max,
                maxDebtPerDay: type(uint256).max,
                ownerFrozen: false
            })
        );
    }

    function _setPolicy(
        uint256 agentId,
        address owner_,
        uint256 maxCashPerTx,
        uint256 maxDebtPerTx,
        uint256 maxDebtPerDay,
        bool ownerFrozen
    ) internal {
        vm.prank(owner_);
        account.setPolicy(
            agentId,
            IAgentAccount.Policy({
                maxCashPerTx: maxCashPerTx,
                maxDebtPerTx: maxDebtPerTx,
                maxDebtPerDay: maxDebtPerDay,
                ownerFrozen: ownerFrozen
            })
        );
    }

    function _createTask(address poster_, uint256 reward, uint256 duration)
        internal
        returns (uint256 taskId)
    {
        _approve(poster_, address(escrow), reward);
        vm.prank(poster_);
        taskId = escrow.createTask{value: _val(reward)}(reward, block.timestamp + duration);
    }

    function _createTask(address poster_, uint256 reward) internal returns (uint256) {
        return _createTask(poster_, reward, DEFAULT_TASK_DURATION);
    }

    function _acceptTask(uint256 taskId, uint256 agentId, address wallet_) internal {
        vm.prank(wallet_);
        escrow.acceptTask(taskId, agentId);
    }

    function _setProtocolFee(uint16 bps) internal {
        vm.prank(deployer);
        escrow.setProtocolFeeBps(bps);
    }

    // ---------------------------------------------------------------------
    // EIP-712 (§4.2 domain: name="InferCredit", version="1")
    // ---------------------------------------------------------------------

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev Recomputed here independently of the contract so that a divergence
    ///      between the two is itself a test failure (§7 Week 2: this seam is
    ///      the most likely place to break).
    bytes32 internal constant AUTH_TYPEHASH = keccak256(
        "CreditAuthorization(uint256 agentId,uint256 taskId,uint256 principalCap,uint16 feeBps,uint8 riskTier,uint64 identityVersion,uint256 authDeadline,uint256 loanDueAt,uint256 nonce,bytes32 evidenceHash)"
    );

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("InferCredit"),
                keccak256("1"),
                block.chainid,
                address(manager)
            )
        );
    }

    function _hashAuth(ICreditManager.CreditAuthorization memory a) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                AUTH_TYPEHASH,
                a.agentId,
                a.taskId,
                a.principalCap,
                a.feeBps,
                a.riskTier,
                a.identityVersion,
                a.authDeadline,
                a.loanDueAt,
                a.nonce,
                a.evidenceHash
            )
        );
        return keccak256(abi.encodePacked(hex"1901", _domainSeparator(), structHash));
    }

    function _sign(uint256 pk, ICreditManager.CreditAuthorization memory a)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _hashAuth(a));
        return abi.encodePacked(r, s, v);
    }

    function _signAuth(ICreditManager.CreditAuthorization memory a) internal view returns (bytes memory) {
        return _sign(UNDERWRITER_PK, a);
    }

    /// @notice Build an authorization with sane defaults (§6.1 step 6:
    ///         authDeadline = now + 30min, loanDueAt = now + 24h).
    function _auth(uint256 agentId, uint256 taskId, uint256 principalCap, uint16 feeBps, uint8 tier)
        internal
        returns (ICreditManager.CreditAuthorization memory a)
    {
        a = ICreditManager.CreditAuthorization({
            agentId: agentId,
            taskId: taskId,
            principalCap: principalCap,
            feeBps: feeBps,
            riskTier: tier,
            identityVersion: adapter.snapshotVersion(agentId),
            authDeadline: block.timestamp + 30 minutes,
            loanDueAt: block.timestamp + 24 hours,
            nonce: nextNonce++,
            evidenceHash: keccak256(abi.encodePacked("evidence", agentId, taskId))
        });
    }

    /// @notice An empty authorization — the "pure cash payment" case (§4.3).
    function _emptyAuth() internal pure returns (ICreditManager.CreditAuthorization memory a) {
        a = ICreditManager.CreditAuthorization({
            agentId: 0,
            taskId: 0,
            principalCap: 0,
            feeBps: 0,
            riskTier: 0,
            identityVersion: 0,
            authDeadline: 0,
            loanDueAt: 0,
            nonce: 0,
            evidenceHash: bytes32(0)
        });
    }

    // ---------------------------------------------------------------------
    // composite flows
    // ---------------------------------------------------------------------

    struct Scenario {
        uint256 agentId;
        uint256 taskId;
        uint256 principal;
        uint256 fee;
        bytes32 paymentId;
    }

    /// @notice register → enroll → policy → seed cash → create task → accept.
    function _standardSetup(uint256 reward, uint256 seedCash)
        internal
        returns (uint256 agentId, uint256 taskId)
    {
        _seedVault(VAULT_SEED);
        agentId = _registerAndEnroll(agentOwner, agentWallet);
        _setPermissivePolicy(agentId, agentOwner);
        if (seedCash > 0) _depositCash(agentId, agentOwner, seedCash);
        taskId = _createTask(poster, reward);
        _acceptTask(taskId, agentId, agentWallet);
    }

    /// @notice The full tx3: pay a provider `amount`, cash first then credit.
    function _payProvider(
        uint256 agentId,
        uint256 amount,
        bytes32 paymentId,
        ICreditManager.CreditAuthorization memory a,
        bytes memory sig,
        address wallet_
    ) internal {
        vm.prank(wallet_);
        account.payProvider(agentId, provider, amount, paymentId, a, sig);
    }

    /// @notice register → task → accept → authorize → payProvider, returning the
    ///         loan parameters the assertions need.
    function _openLoan(uint256 reward, uint256 seedCash, uint256 quote, uint16 feeBps, uint8 tier)
        internal
        returns (Scenario memory s)
    {
        (s.agentId, s.taskId) = _standardSetup(reward, seedCash);
        s.principal = quote > seedCash ? quote - seedCash : 0;
        s.fee = (s.principal * feeBps) / BPS;
        s.paymentId = keccak256(abi.encodePacked("payment", s.taskId));

        ICreditManager.CreditAuthorization memory a = _auth(s.agentId, s.taskId, s.principal, feeBps, tier);
        _payProvider(s.agentId, quote, s.paymentId, a, _signAuth(a), agentWallet);
    }

    /// @notice Call `CreditManager.draw` directly, impersonating the AgentAccount.
    /// @dev `draw` is `onlyAgentAccount`, so this is the only way to unit-test the
    ///      I1–I7 requires in isolation from the AgentAccount's own SpendPolicy
    ///      layer. See SPEC QUESTION Q1 in contracts/TEST_PLAN.md: the two layers
    ///      overlap on I6's `amount <= principalCap` and on I7's global caps, and
    ///      the CreditManager keeps them as defence in depth.
    function _drawDirect(ICreditManager.CreditAuthorization memory a, bytes memory sig, uint256 amount)
        internal
    {
        vm.prank(address(account));
        manager.draw(a, sig, amount);
    }

    /// @notice Draw with an explicit `loanDueAt`, for the two-deadline tests
    ///         (§4.2 review r4 #3). The underwriter guarantees
    ///         `loanDueAt <= task.deadline`, so the only reachable edge is the
    ///         GRACE window between the two.
    function _drawWithLoanDue(
        uint256 agentId,
        uint256 taskId,
        uint256 quote,
        uint256 principalCap,
        uint16 feeBps,
        uint8 tier,
        uint256 loanDueAt,
        bytes32 paymentId
    ) internal {
        ICreditManager.CreditAuthorization memory a = _auth(agentId, taskId, principalCap, feeBps, tier);
        a.loanDueAt = loanDueAt;
        _payProvider(agentId, quote, paymentId, a, _signAuth(a), agentWallet);
    }

    /// @notice The canonical demo order 1: reward 0.15, cash 0.04, quote 0.12,
    ///         Tier C (1500 bps) → principal 0.08, fee 0.012, debt 0.092.
    function _demoOrderOne() internal returns (Scenario memory s) {
        s = _openLoan(DEMO_REWARD, DEMO_SEED_CASH, DEMO_QUOTE, TIER_C_FEE_BPS, TIER_C);
    }

    // ---------------------------------------------------------------------
    // assertion helpers
    // ---------------------------------------------------------------------

    function _loanStatus(uint256 taskId) internal view returns (ICreditManager.LoanStatus) {
        return manager.getLoan(taskId).status;
    }

    function _taskStatus(uint256 taskId) internal view returns (ITaskEscrow.TaskStatus) {
        return escrow.getTask(taskId).status;
    }

    function assertLoanStatus(uint256 taskId, ICreditManager.LoanStatus expected, string memory why)
        internal
        view
    {
        assertEq(uint8(_loanStatus(taskId)), uint8(expected), why);
    }

    function assertTaskStatus(uint256 taskId, ITaskEscrow.TaskStatus expected, string memory why)
        internal
        view
    {
        assertEq(uint8(_taskStatus(taskId)), uint8(expected), why);
    }

    /// @notice Reputation entries written by the adapter only (§6.1 anti-Sybil).
    /// @dev Canonical ABI: getSummary(agentId, clientAddresses, tag1, tag2)
    ///      returns (count, summaryValue, summaryValueDecimals). InferCredit
    ///      consumes ONLY `count` — `summaryValue`'s aggregation is left
    ///      implementation-defined by ERC-8004.
    function _feedbackCount(uint256 agentId, string memory tag2) internal view returns (uint64) {
        address[] memory clients = new address[](1);
        clients[0] = address(adapter);
        (uint64 count,,) = reputation.getSummary(agentId, clients, "infercredit", tag2);
        return count;
    }

    /// @notice Sign the ERC-8004 wallet-binding consent for `newWallet`.
    ///         The real registry requires the NEW wallet to agree before
    ///         `deadline`, so a rebinding test cannot skip this.
    function _bindWallet(uint256 agentId, address owner_, uint256 walletPk, uint256 deadline) internal {
        address newWallet = vm.addr(walletPk);
        bytes32 digest = identity.walletBindingDigest(agentId, newWallet, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, digest);
        vm.prank(owner_);
        identity.setAgentWallet(agentId, newWallet, deadline, abi.encodePacked(r, s, v));
    }
}
