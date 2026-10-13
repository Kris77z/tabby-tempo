// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentAccount,
    REASON_NOT_WHITELISTED,
    REASON_OVER_LIMIT,
    REASON_FROZEN,
    REASON_INVALID_AUTH,
    REASON_AUTH_CALLER_MISMATCH
} from "./interfaces/IAgentAccount.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {IERC8004Adapter} from "./interfaces/IERC8004Adapter.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

/// @title AgentAccount — ENGINEERING §4.3 (SpendPolicy + provider whitelist)
/// @notice P0 is a singleton with internal accounts (`mapping(agentId => …)`),
///         not a per-agent factory.
/// @dev Handles funding, policies, freezes, cash/credit payments, settlement
///      credits, liquidation debits and refund registration.
contract AgentAccount is IAgentAccount, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant DAY_LENGTH = 1 days;

    address public immutable settlementAsset;
    IERC8004Adapter public immutable adapter;

    address public owner;
    ICreditManager public creditManager;
    address public taskEscrow;

    mapping(uint256 agentId => uint256) internal _cash;
    mapping(uint256 agentId => Policy) internal _policies;
    /// @dev Stored separately from Policy so an agent owner rewriting its own
    ///      Policy can never clear it (review #9).
    mapping(uint256 agentId => bool) internal _protocolFrozen;
    mapping(address provider => bool) internal _providerWhitelist;
    mapping(bytes32 paymentId => PaymentRecord) internal _payments;
    mapping(bytes32 refundId => bool) internal _refundConsumed;
    /// @dev Rolling per-day credit spend, for Policy.maxDebtPerDay.
    mapping(uint256 agentId => mapping(uint256 day => uint256)) internal _debtSpentInDay;

    bool private _wired;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyCreditManager() {
        if (msg.sender != address(creditManager)) revert NotCreditManager(msg.sender);
        _;
    }

    /// @dev §4.3: creditCash is callable by TaskEscrow (settlement) AND
    ///      CreditManager (refund / recovery) — review r4 #4.
    modifier onlyProtocol() {
        if (msg.sender != address(creditManager) && msg.sender != taskEscrow) {
            revert NotProtocol(msg.sender);
        }
        _;
    }

    constructor(address settlementAsset_, IERC8004Adapter adapter_, address owner_) {
        settlementAsset = settlementAsset_;
        adapter = adapter_;
        owner = owner_;
    }

    // ---------------------------------------------------------------------
    // wiring / admin (implemented — plumbing only)
    // ---------------------------------------------------------------------

    function setProtocolContracts(ICreditManager creditManager_, address taskEscrow_) external onlyOwner {
        if (_wired) revert AlreadyWired();
        if (address(creditManager_) == address(0) || taskEscrow_ == address(0)) revert ZeroAddress();
        creditManager = creditManager_;
        taskEscrow = taskEscrow_;
        _wired = true;
    }

    /// @notice P0 whitelist = the protocol's own relay only (RISK_AND_MVP §1.1:
    ///         the real security boundary of purpose-bound credit is provider
    ///         admission, not the spend policy).
    function setProviderWhitelist(address provider, bool allowed) external onlyOwner {
        _providerWhitelist[provider] = allowed;
        emit ProviderWhitelisted(provider, allowed);
    }

    // ---------------------------------------------------------------------
    // owner surface
    // ---------------------------------------------------------------------

    /// Spec §4.3: agent owner tops up cash. Native mode: payable and
    /// `msg.value == amount`. ERC-20 mode: `msg.value == 0` + safeTransferFrom.
    function depositCash(uint256 agentId, uint256 amount) external payable nonReentrant {
        (address currentOwner,) = adapter.resolveAgent(agentId);
        if (msg.sender != currentOwner) revert NotAgentOwner(agentId, msg.sender);
        if (amount == 0) revert ZeroAmount();
        uint256 expectedValue = settlementAsset == address(0) ? amount : 0;
        if (msg.value != expectedValue) revert ValueMismatch(expectedValue, msg.value);
        if (settlementAsset != address(0)) {
            SafeTransferLib.safeTransferFrom(IERC20(settlementAsset), msg.sender, address(this), amount);
        }
        _cash[agentId] += amount;
        emit CashCredited(agentId, msg.sender, amount);
    }

    /// Spec §4.3: only the agent's CURRENT registry owner may set the policy.
    /// Writing a Policy MUST NOT touch `_protocolFrozen` (review #9).
    function setPolicy(uint256 agentId, Policy calldata p) external {
        (address currentOwner,) = adapter.resolveAgent(agentId);
        if (msg.sender != currentOwner) revert NotAgentOwner(agentId, msg.sender);
        _policies[agentId] = p;
        emit PolicySet(agentId, p);
    }

    // ---------------------------------------------------------------------
    // core spend entry point
    // ---------------------------------------------------------------------

    /// Spec §4.3, the single choke point for all three limit layers
    /// (RISK_AND_MVP §5.2：永远取三者最小值).
    ///
    /// Checks, each rejecting with SpendRejected(agentId, target, reason):
    ///   reason 1 — provider not whitelisted
    ///   reason 2 — over limit: credit needed > min(policy.maxDebtPerTx,
    ///              policy.maxDebtPerDay headroom, auth.principalCap,
    ///              CreditManager global headroom); or cash leg >
    ///              policy.maxCashPerTx
    ///   reason 3 — policy.ownerFrozen OR protocolFrozen[agentId]
    ///   reason 4 — authorization invalid (bad/absent signature, expired,
    ///              wrong task, consumed nonce) while credit is actually needed
    ///   reason 5 — auth.agentId != agentId (review #1: someone else's auth)
    ///
    /// Caller must be the agent's CURRENT registry wallet, read live from the
    /// adapter — never from the snapshot, and this applies to pure-cash
    /// payments too (review r2 #2).
    ///
    /// Effect: spends cash first, draws the shortfall via
    /// CreditManager.draw(auth, sig, shortfall), pays the provider atomically,
    /// writes payments[paymentId] = PaymentRecord{agentId, auth.taskId,
    /// fromCash, fromCredit, 0} and emits ProviderPaid.
    /// A pure-cash payment has taskId == 0 and MUST NOT touch the credit path.
    function payProvider(
        uint256 agentId,
        address provider,
        uint256 amount,
        bytes32 paymentId,
        ICreditManager.CreditAuthorization calldata auth,
        bytes calldata underwriterSig
    ) external nonReentrant {
        (, address wallet) = adapter.resolveAgent(agentId);
        if (wallet == address(0) || msg.sender != wallet) revert NotAgentWallet(agentId, msg.sender);
        if (!_providerWhitelist[provider]) revert SpendRejected(agentId, provider, REASON_NOT_WHITELISTED);
        if (_policies[agentId].ownerFrozen || _protocolFrozen[agentId]) {
            revert SpendRejected(agentId, provider, REASON_FROZEN);
        }
        if (amount == 0) revert ZeroAmount();
        if (_payments[paymentId].fromCash != 0 || _payments[paymentId].fromCredit != 0) {
            revert PaymentIdAlreadyUsed(paymentId);
        }
        uint256 fromCash = amount < _cash[agentId] ? amount : _cash[agentId];
        if (fromCash > _policies[agentId].maxCashPerTx) {
            revert SpendRejected(agentId, provider, REASON_OVER_LIMIT);
        }
        uint256 fromCredit = amount - fromCash;
        uint256 taskId;
        if (fromCredit != 0) {
            uint256 day = _checkCreditPolicy(agentId, provider, fromCredit, auth, underwriterSig);
            _debtSpentInDay[agentId][day] += fromCredit;
            taskId = auth.taskId;
        }
        _cash[agentId] -= fromCash;
        _payments[paymentId] = PaymentRecord(agentId, taskId, fromCash, fromCredit, 0);
        if (fromCredit != 0) creditManager.draw(auth, underwriterSig, fromCredit);
        SafeTransferLib.payOut(settlementAsset, provider, amount);
        emit ProviderPaid(agentId, provider, paymentId, fromCash, fromCredit);
    }

    function _checkCreditPolicy(
        uint256 agentId,
        address provider,
        uint256 fromCredit,
        ICreditManager.CreditAuthorization calldata auth,
        bytes calldata underwriterSig
    ) private view returns (uint256 day) {
        if (auth.taskId == 0 || underwriterSig.length != 65) {
            revert SpendRejected(agentId, provider, REASON_INVALID_AUTH);
        }
        if (auth.agentId != agentId) revert SpendRejected(agentId, provider, REASON_AUTH_CALLER_MISMATCH);
        Policy memory p = _policies[agentId];
        if (fromCredit > p.maxDebtPerTx || fromCredit > auth.principalCap) {
            revert SpendRejected(agentId, provider, REASON_OVER_LIMIT);
        }
        day = block.timestamp / DAY_LENGTH;
        uint256 spent = _debtSpentInDay[agentId][day];
        if (spent > p.maxDebtPerDay || fromCredit > p.maxDebtPerDay - spent) {
            revert SpendRejected(agentId, provider, REASON_OVER_LIMIT);
        }
        uint256 cap = creditManager.maxTotalOutstanding();
        uint256 used = creditManager.totalOutstanding();
        uint256 debt = fromCredit + fromCredit * auth.feeBps / BPS_DENOMINATOR;
        if (used > cap || debt > cap - used) revert SpendRejected(agentId, provider, REASON_OVER_LIMIT);
        cap = creditManager.maxDrawPerEpoch();
        used = creditManager.drawnInEpoch(day); // Manager epochs and policy days are both one day.
        if (used > cap || fromCredit > cap - used) {
            revert SpendRejected(agentId, provider, REASON_OVER_LIMIT);
        }
    }

    // ---------------------------------------------------------------------
    // protocol surface
    // ---------------------------------------------------------------------

    /// Spec §4.3 / §4.6: TaskEscrow (settlement residue) or CreditManager
    /// (refund and recovery). Funds arrive with the call.
    function creditCash(uint256 agentId, uint256 amount) external payable onlyProtocol nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 expectedValue = settlementAsset == address(0) ? amount : 0;
        if (msg.value != expectedValue) revert ValueMismatch(expectedValue, msg.value);
        _cash[agentId] += amount;
        if (settlementAsset != address(0)) {
            SafeTransferLib.safeTransferFrom(IERC20(settlementAsset), msg.sender, address(this), amount);
        }
        emit CashCredited(agentId, msg.sender, amount);
    }

    /// Spec §4.3: protocol-level debit for the liquidation waterfall. Takes
    /// min(cash[agentId], maxAmount), is NOT blocked by ownerFrozen or by any
    /// policy limit, and pushes the debited funds to the CreditManager.
    function debitForLiquidation(uint256 agentId, uint256 maxAmount)
        external
        onlyCreditManager
        nonReentrant
        returns (uint256 debited)
    {
        debited = _cash[agentId] < maxAmount ? _cash[agentId] : maxAmount;
        _cash[agentId] -= debited;
        SafeTransferLib.payOut(settlementAsset, msg.sender, debited);
        emit CashDebitedForLiquidation(agentId, debited);
    }

    /// Spec: consumes `refundId` (single use) and adds `amount` to
    /// payments[paymentId].refundedAmount, rejecting if the cumulative total
    /// would exceed fromCash + fromCredit. Returns the record as it stood
    /// BEFORE this refund plus the pro-rata cash/credit split of `amount`.
    /// See SPEC GAP G3 in IAgentAccount / TEST_PLAN.md sec 3.
    function registerRefund(bytes32 paymentId, bytes32 refundId, uint256 amount)
        external
        onlyCreditManager
        returns (PaymentRecord memory record, uint256 cashShare, uint256 creditShare)
    {
        if (amount == 0) revert ZeroAmount();
        record = _payments[paymentId];
        uint256 total = record.fromCash + record.fromCredit;
        if (total == 0) revert UnknownPayment(paymentId);
        if (_refundConsumed[refundId]) revert RefundIdAlreadyUsed(refundId);
        uint256 remaining = total - record.refundedAmount;
        if (amount > remaining) revert RefundExceedsPayment(paymentId, amount, remaining);
        uint256 cumulative = record.refundedAmount + amount;
        cashShare = cumulative * record.fromCash / total - record.refundedAmount * record.fromCash / total;
        creditShare = amount - cashShare;
        _refundConsumed[refundId] = true;
        _payments[paymentId].refundedAmount = cumulative;
        emit RefundRegistered(paymentId, refundId, amount);
    }

    /// Spec §4.3: protocol freeze bit, writable only by CreditManager/guardian.
    function setProtocolFrozen(uint256 agentId, bool frozen) external onlyCreditManager {
        _protocolFrozen[agentId] = frozen;
        emit ProtocolFrozenSet(agentId, frozen);
    }

    // ---------------------------------------------------------------------
    // views (implemented: pure storage reads)
    // ---------------------------------------------------------------------

    function cash(uint256 agentId) external view returns (uint256) {
        return _cash[agentId];
    }

    function policies(uint256 agentId) external view returns (uint256, uint256, uint256, bool) {
        Policy memory p = _policies[agentId];
        return (p.maxCashPerTx, p.maxDebtPerTx, p.maxDebtPerDay, p.ownerFrozen);
    }

    function getPolicy(uint256 agentId) external view returns (Policy memory) {
        return _policies[agentId];
    }

    function protocolFrozen(uint256 agentId) external view returns (bool) {
        return _protocolFrozen[agentId];
    }

    function providerWhitelist(address provider) external view returns (bool) {
        return _providerWhitelist[provider];
    }

    function payments(bytes32 paymentId) external view returns (uint256, uint256, uint256, uint256, uint256) {
        PaymentRecord memory r = _payments[paymentId];
        return (r.agentId, r.taskId, r.fromCash, r.fromCredit, r.refundedAmount);
    }

    function getPayment(bytes32 paymentId) external view returns (PaymentRecord memory) {
        return _payments[paymentId];
    }

    function refundConsumed(bytes32 refundId) external view returns (bool) {
        return _refundConsumed[refundId];
    }

    function debtSpentInDay(uint256 agentId, uint256 day) external view returns (uint256) {
        return _debtSpentInDay[agentId][day];
    }

    function currentDay() external view returns (uint256) {
        return block.timestamp / DAY_LENGTH;
    }

    receive() external payable {}
}
