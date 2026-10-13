// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {IAgentAccount} from "./interfaces/IAgentAccount.sol";
import {ITaskEscrow} from "./interfaces/ITaskEscrow.sol";
import {IERC8004Adapter} from "./interfaces/IERC8004Adapter.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

/// @title CreditManager — ENGINEERING §4.2 (v5.3)
/// @notice Protocol treasury vault, backstop, guardian identity controls and
///         task-bound credit, repayment, liquidation and refunds.
contract CreditManager is ICreditManager, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // EIP-712 (§4.2: name="InferCredit", version="1", chainId, verifyingContract)
    // ---------------------------------------------------------------------

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "CreditAuthorization(uint256 agentId,uint256 taskId,uint256 principalCap,uint16 feeBps,uint8 riskTier,uint64 identityVersion,uint256 authDeadline,uint256 loanDueAt,uint256 nonce,bytes32 evidenceHash)"
    );

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant _NAME_HASH = keccak256("InferCredit");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    uint256 private constant _SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    // ---------------------------------------------------------------------
    // configuration
    // ---------------------------------------------------------------------

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice address(0) = native settlement, otherwise the ERC-20 (ENGINEERING §3).
    address public immutable settlementAsset;
    IERC8004Adapter public immutable adapter;

    /// @notice Underwriter EIP-712 signer (RISK_AND_MVP §1.3: systemic single point).
    address public underwriter;
    address public treasury;
    address public guardian;
    address public relayRefunder;
    address public owner;

    IAgentAccount public agentAccount;
    ITaskEscrow public taskEscrow;

    /// @notice Max loan-to-escrow ratio used by I6.
    uint16 public immutable MAX_LTV_BPS;
    /// @notice Grace period after `loanDueAt` before a loan may be liquidated.
    uint256 public immutable GRACE;
    /// @notice Epoch length for `maxDrawPerEpoch` (§4.2: epoch = 1 day).
    uint256 public constant EPOCH_LENGTH = 1 days;

    // ---- global limits (RISK_AND_MVP §1.3「一行不能省」) ----
    uint256 public maxTotalOutstanding;
    uint256 public maxDrawPerEpoch;
    bool public drawPaused;
    mapping(uint256 epoch => uint256) internal _drawnInEpoch;

    // ---- vault ----
    /// @notice Lendable balance. `backstopTotal` is booked separately and is
    ///         NEVER counted as lendable (§4.2).
    uint256 public vaultBalance;
    uint256 public backstopTotal;
    uint256 public totalOutstanding;

    mapping(uint256 agentId => uint256) internal _backstop;
    mapping(uint256 agentId => bool) internal _protocolFrozen;
    mapping(uint256 taskId => TaskLoan) internal _loans;
    /// @dev Outstanding loan.fee will decrease on repayment/refund. Preserve
    ///      its original amount for cumulative refund accounting; the original
    ///      principal is already retained in PaymentRecord.fromCredit.
    mapping(uint256 taskId => uint256) internal _originalFee;
    /// @dev Actual fees received through repay and not yet returned by refunds.
    ///      Forgiven fees must never be treated as collected or paid to cash.
    mapping(uint256 taskId => uint256) internal _collectedFee;
    mapping(uint256 taskId => LiquidationRecord) internal _liquidations;
    /// @dev How much of each recorded burden has ALREADY been paid back by
    ///      `processRefund`. Kept separate so the original burden record stays
    ///      intact for audit while the per-layer cap still shrinks as it is
    ///      consumed (TEST_PLAN F11, Codex ruling: do not destroy the original).
    mapping(uint256 taskId => LiquidationRecord) internal _recovered;
    mapping(uint256 agentId => mapping(uint256 nonce => bool)) internal _usedNonces;

    /// @notice Protocol-owned truth for the underwriter (§6.1 step 2): reputation
    ///         is only a mirror. `repaymentCount` counts ONLY full repayments via
    ///         the success path; a ClosedByRefund or a fully-recovered
    ///         liquidation must never increment it.
    mapping(uint256 agentId => uint256) internal _repaymentCount;
    mapping(uint256 agentId => uint256) internal _defaultCount;
    /// @dev Defaulted and not sent means pending. Both liquidation entry points
    ///      own this state here; neither calls back into Escrow to report it.
    mapping(uint256 taskId => bool) internal _defaultFeedbackSent;

    bool private _wired;

    // ---------------------------------------------------------------------
    // modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury(msg.sender);
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        _;
    }

    modifier onlyAgentAccount() {
        if (msg.sender != address(agentAccount)) revert NotAgentAccount(msg.sender);
        _;
    }

    modifier onlyTaskEscrow() {
        if (msg.sender != address(taskEscrow)) revert NotTaskEscrow(msg.sender);
        _;
    }

    modifier onlyRelayRefunder() {
        if (msg.sender != relayRefunder) revert NotRelayRefunder(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // construction / wiring (implemented)
    // ---------------------------------------------------------------------

    struct Config {
        address settlementAsset;
        IERC8004Adapter adapter;
        address underwriter;
        address treasury;
        address guardian;
        address relayRefunder;
        address owner;
        uint16 maxLtvBps;
        uint256 grace;
    }

    constructor(Config memory c) {
        if (address(c.adapter) == address(0)) revert ZeroAddress();
        if (c.underwriter == address(0)) revert ZeroAddress();
        settlementAsset = c.settlementAsset;
        adapter = c.adapter;
        underwriter = c.underwriter;
        treasury = c.treasury;
        guardian = c.guardian;
        relayRefunder = c.relayRefunder;
        owner = c.owner;
        MAX_LTV_BPS = c.maxLtvBps;
        GRACE = c.grace;

        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    function setProtocolContracts(IAgentAccount agentAccount_, ITaskEscrow taskEscrow_) external onlyOwner {
        if (_wired) revert AlreadyWired();
        if (address(agentAccount_) == address(0) || address(taskEscrow_) == address(0)) {
            revert ZeroAddress();
        }
        agentAccount = agentAccount_;
        taskEscrow = taskEscrow_;
        _wired = true;
    }

    function setGlobalLimits(uint256 maxTotalOutstanding_, uint256 maxDrawPerEpoch_) external onlyOwner {
        maxTotalOutstanding = maxTotalOutstanding_;
        maxDrawPerEpoch = maxDrawPerEpoch_;
        emit GlobalLimitsSet(maxTotalOutstanding_, maxDrawPerEpoch_);
    }

    /// @notice Guardian kill switch (RISK_AND_MVP §1.3).
    function setDrawPaused(bool paused) external onlyGuardian {
        drawPaused = paused;
        emit DrawPausedSet(paused);
    }

    // ---------------------------------------------------------------------
    // EIP-712 helpers (implemented: wire format, not protocol logic)
    // ---------------------------------------------------------------------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function hashAuthorization(CreditAuthorization calldata auth) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                auth.agentId,
                auth.taskId,
                auth.principalCap,
                auth.feeBps,
                auth.riskTier,
                auth.identityVersion,
                auth.authDeadline,
                auth.loanDueAt,
                auth.nonce,
                auth.evidenceHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    // ---------------------------------------------------------------------
    // vault
    // ---------------------------------------------------------------------

    /// Spec §4.2: treasury only (P0 has no public LP). Native mode requires
    /// `msg.value == amount`; ERC-20 mode requires `msg.value == 0` +
    /// safeTransferFrom. Increases `vaultBalance`.
    function deposit(uint256 amount) external payable onlyTreasury nonReentrant {
        _receiveFunds(amount);
        vaultBalance += amount;
        emit Deposited(msg.sender, amount);
    }

    /// Spec §4.2: treasury only. MUST NOT be able to withdraw backstop funds
    /// (backstop is booked separately and never counts as lendable).
    function withdraw(uint256 amount) external onlyTreasury nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > vaultBalance) revert InsufficientLiquidity(amount, vaultBalance);
        vaultBalance -= amount;
        SafeTransferLib.payOut(settlementAsset, treasury, amount);
        emit Withdrawn(treasury, amount);
    }

    /// Spec §4.2: owner backstop per agent. Native/ERC-20 pairing as above.
    /// Credited to `backstop[agentId]` and `backstopTotal`, never to vaultBalance.
    /// TEST_PLAN F5: P0 has NO automatic top-up. A consumed backstop is refilled
    /// only by an explicit `fundBackstop` call or by a Defaulted recovery; the
    /// "3. 补足 backstop" step of the §4.4 success waterfall is a no-op in P0
    /// because its target level is undefined.
    function fundBackstop(uint256 agentId, uint256 amount) external payable nonReentrant {
        _receiveFunds(amount);
        _backstop[agentId] += amount;
        backstopTotal += amount;
        emit BackstopFunded(agentId, amount);
    }

    function _receiveFunds(uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 expectedValue = settlementAsset == address(0) ? amount : 0;
        if (msg.value != expectedValue) revert ValueMismatch(expectedValue, msg.value);
        if (settlementAsset != address(0)) {
            SafeTransferLib.safeTransferFrom(IERC20(settlementAsset), msg.sender, address(this), amount);
        }
    }

    // ---------------------------------------------------------------------
    // credit
    // ---------------------------------------------------------------------

    /// Spec §4.2 + §4.5. AgentAccount only. Each invariant has its own error;
    /// precedence for multiple simultaneous violations is not specified.
    ///   I1 !drawPaused && !protocolFrozen[agentId]
    ///   I2 EIP-712 signature by `underwriter`; nonce unused; now <= authDeadline
    ///   I3 !adapter.identityChanged(agentId) AND
    ///      adapter.snapshotVersion(agentId) == auth.identityVersion
    ///   I4 task exists; status == Assigned; task.agentId == auth.agentId;
    ///      now < task.deadline
    ///   I5 loans[taskId].status == None (one draw per task; nonce AND taskId
    ///      are both consumed)
    ///   I6 amount <= auth.principalCap AND
    ///      principalCap * (10_000 + feeBps) / 10_000
    ///        <= taskEscrow.payableEscrow(taskId) * MAX_LTV_BPS / 10_000
    ///      where payableEscrow = reward - reward * task.protocolFeeBps / 10_000
    ///      and `task.protocolFeeBps` is the rate SNAPSHOTTED when the task was
    ///      created (TEST_PLAN R5) — never the live global rate, or a later rate
    ///      change would retroactively break an already-underwritten loan.
    ///   I7 totalOutstanding + debt <= maxTotalOutstanding AND
    ///      drawnInEpoch[epoch] + amount <= maxDrawPerEpoch
    /// Then: books TaskLoan{principal: amount, fee: amount*feeBps/10_000},
    /// status = Active, pushes `amount` to the AgentAccount, emits LoanOpened.
    function draw(CreditAuthorization calldata auth, bytes calldata underwriterSig, uint256 amount)
        external
        onlyAgentAccount
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (drawPaused) revert DrawPaused();
        if (_protocolFrozen[auth.agentId]) revert AgentIsFrozen(auth.agentId);
        if (!_validSignature(hashAuthorization(auth), underwriterSig)) revert BadSignature();
        if (_usedNonces[auth.agentId][auth.nonce]) revert NonceAlreadyUsed(auth.agentId, auth.nonce);
        if (block.timestamp > auth.authDeadline) revert AuthExpired(auth.authDeadline, block.timestamp);
        if (adapter.identityChanged(auth.agentId)) revert IdentityChanged(auth.agentId);
        uint64 version = adapter.snapshotVersion(auth.agentId);
        if (version != auth.identityVersion) {
            revert IdentityVersionMismatch(auth.agentId, version, auth.identityVersion);
        }
        ITaskEscrow.Task memory task = taskEscrow.getTask(auth.taskId);
        if (task.status != ITaskEscrow.TaskStatus.Assigned) revert TaskNotAssigned(auth.taskId);
        if (task.agentId != auth.agentId) revert TaskAgentMismatch(auth.taskId, task.agentId, auth.agentId);
        if (block.timestamp >= task.deadline) revert TaskDeadlinePassed(auth.taskId, task.deadline);
        if (_loans[auth.taskId].status != LoanStatus.None) revert LoanAlreadyExists(auth.taskId);
        if (amount > auth.principalCap) revert AmountExceedsPrincipalCap(amount, auth.principalCap);
        uint256 capDebt = auth.principalCap * (BPS_DENOMINATOR + auth.feeBps) / BPS_DENOMINATOR;
        uint256 maxDebt = taskEscrow.payableEscrow(auth.taskId) * MAX_LTV_BPS / BPS_DENOMINATOR;
        if (capDebt > maxDebt) revert DebtExceedsEscrowLtv(capDebt, maxDebt);

        uint256 fee = amount * auth.feeBps / BPS_DENOMINATOR;
        uint256 attemptedOutstanding = totalOutstanding + amount + fee;
        if (attemptedOutstanding > maxTotalOutstanding) {
            revert TotalOutstandingCapExceeded(attemptedOutstanding, maxTotalOutstanding);
        }
        uint256 epoch = block.timestamp / EPOCH_LENGTH;
        uint256 attemptedEpochDraw = _drawnInEpoch[epoch] + amount;
        if (attemptedEpochDraw > maxDrawPerEpoch) {
            revert EpochDrawCapExceeded(attemptedEpochDraw, maxDrawPerEpoch);
        }
        if (amount > vaultBalance) revert InsufficientLiquidity(amount, vaultBalance);

        _usedNonces[auth.agentId][auth.nonce] = true;
        _loans[auth.taskId] = TaskLoan(auth.agentId, amount, fee, auth.loanDueAt, LoanStatus.Active);
        _originalFee[auth.taskId] = fee;
        totalOutstanding = attemptedOutstanding;
        _drawnInEpoch[epoch] = attemptedEpochDraw;
        vaultBalance -= amount;
        SafeTransferLib.payOut(settlementAsset, address(agentAccount), amount);
        emit LoanOpened(auth.taskId, auth.agentId, amount, auth.riskTier);
    }

    function _validSignature(bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > _SECP256K1_HALF_ORDER || (v != 27 && v != 28)) return false;
        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == underwriter;
    }

    /// Spec §4.2: TaskEscrow only, success path only. Order: fee first, then
    /// principal. `applied < totalDebt` leaves the loan Active (partial repayment);
    /// full repayment sets Repaid and increments repaymentCount[agentId].
    /// TEST_PLAN F8: when the amount handed over exceeds the outstanding debt,
    /// the Manager keeps ONLY `applied` and returns the surplus to the Escrow in
    /// the same call, so the Escrow can continue its waterfall. Tests assert
    /// this against the contracts' real asset balances, not just `vaultBalance`.
    /// The liquidation path NEVER routes through here — its terminal state is
    /// always Defaulted (review r2 #5).
    function repay(uint256 taskId, uint256 amount)
        external
        payable
        onlyTaskEscrow
        nonReentrant
        returns (uint256 applied, uint256 remaining)
    {
        TaskLoan storage loan = _loans[taskId];
        if (loan.status != LoanStatus.Active) revert LoanNotActive(taskId);
        _receiveFunds(amount);
        uint256 debt = loan.principal + loan.fee;
        applied = amount < debt ? amount : debt;
        uint256 feePaid = applied < loan.fee ? applied : loan.fee;
        uint256 principalPaid = applied - feePaid;
        loan.fee -= feePaid;
        loan.principal -= principalPaid;
        _collectedFee[taskId] += feePaid;
        totalOutstanding -= applied;
        vaultBalance += applied;
        remaining = debt - applied;
        if (remaining == 0) {
            loan.status = LoanStatus.Repaid;
            _repaymentCount[loan.agentId] += 1;
        }
        SafeTransferLib.payOut(settlementAsset, msg.sender, amount - applied);
        emit LoanRepaid(taskId, principalPaid, feePaid);
    }

    /// Spec §4.2 (push path, review r4 #3/#4): TaskEscrow only. The escrow has
    /// already terminated the task and zeroed its balance; the full escrow
    /// arrives with this call. In ERC-20 mode the Escrow approves exactly this
    /// task's escrow; the unchanged two-argument ABI uses that allowance as the
    /// amount, consumes it fully, and never queries the Escrow during the push.
    function liquidateWithEscrow(uint256 taskId, address poster)
        external
        payable
        onlyTaskEscrow
        nonReentrant
    {
        if (_loans[taskId].status != LoanStatus.Active) revert LoanNotActive(taskId);
        uint256 amount = msg.value;
        if (settlementAsset != address(0)) {
            if (msg.value != 0) revert ValueMismatch(0, msg.value);
            amount = IERC20(settlementAsset).allowance(msg.sender, address(this));
            if (amount != 0) {
                SafeTransferLib.safeTransferFrom(IERC20(settlementAsset), msg.sender, address(this), amount);
            }
        }
        _liquidate(taskId, amount, poster);
    }

    /// Spec §4.2 (pull path, review r4 #3): permissionless. Requires an Active
    /// loan AND at least one of:
    ///   block.timestamp > loanDueAt + GRACE      (loan overdue)
    ///   block.timestamp > task.deadline          (task expired)
    /// Pulls escrow via taskEscrow.releaseForLiquidation (which must not call
    /// back), then delegates to the same _liquidate.
    function liquidateExpiredLoan(uint256 taskId) external nonReentrant {
        TaskLoan memory loan = _loans[taskId];
        if (loan.status != LoanStatus.Active) revert LoanNotActive(taskId);
        uint256 deadline = taskEscrow.getTask(taskId).deadline;
        if (
            block.timestamp <= deadline
                && (block.timestamp <= loan.loanDueAt || block.timestamp - loan.loanDueAt <= GRACE)
        ) {
            revert LoanNotLiquidatable(taskId, loan.loanDueAt, deadline);
        }
        (uint256 amount, address poster) = taskEscrow.releaseForLiquidation(taskId);
        _liquidate(taskId, amount, poster);
    }

    /// Spec §4.2 (review r2 #4 / r2 #5 / r4 #1). Waterfall, in this order:
    ///   1. agent cash via agentAccount.debitForLiquidation (protocol-level,
    ///      NOT blocked by ownerFrozen or policy limits)
    ///   2. escrow slash, capped at the remaining debt
    ///   3. backstop[agentId]
    ///   4. remainder = LP loss; any UNUSED escrow is refunded to the poster
    ///      in the same transaction
    /// Always: loan.status = Defaulted, agent protocol-frozen, "default"
    /// feedback written — even when loss == 0 (fact of default != actual loss).
    /// Per-party actual burden is written to liquidations[taskId] and is the
    /// per-layer cap for the later recovery in processRefund.
    function _liquidate(uint256 taskId, uint256 escrowFunds, address poster) internal {
        TaskLoan storage loan = _loans[taskId];
        uint256 debt = loan.principal + loan.fee;
        uint256 agentId = loan.agentId;
        loan.principal = 0;
        loan.fee = 0;
        loan.status = LoanStatus.Defaulted;
        totalOutstanding -= debt;
        _defaultCount[agentId] += 1;
        _protocolFrozen[agentId] = true;
        agentAccount.setProtocolFrozen(agentId, true);

        uint256 cashUsed = agentAccount.debitForLiquidation(agentId, debt);
        uint256 remaining = debt - cashUsed;
        uint256 escrowSlashed = escrowFunds < remaining ? escrowFunds : remaining;
        remaining -= escrowSlashed;
        uint256 backstopUsed = _backstop[agentId] < remaining ? _backstop[agentId] : remaining;
        remaining -= backstopUsed;
        _backstop[agentId] -= backstopUsed;
        backstopTotal -= backstopUsed;
        vaultBalance += cashUsed + escrowSlashed + backstopUsed;
        _liquidations[taskId] = LiquidationRecord(cashUsed, escrowSlashed, backstopUsed, remaining, poster);
        SafeTransferLib.payOut(settlementAsset, poster, escrowFunds - escrowSlashed);
        emit LoanDefaulted(taskId, remaining, escrowSlashed, cashUsed, backstopUsed);
        emit AgentFrozen(agentId, address(this));
        _reportDefaultFeedback(taskId);
    }

    function retryDefaultFeedback(uint256 taskId) external nonReentrant returns (bool) {
        if (!pendingDefaultFeedback(taskId)) revert NoPendingDefaultFeedback(taskId);
        return _reportDefaultFeedback(taskId);
    }

    function _reportDefaultFeedback(uint256 taskId) private returns (bool) {
        bool sent = adapter.reportFeedback(_loans[taskId].agentId, "default", 100, 0);
        _defaultFeedbackSent[taskId] = sent;
        return sent;
    }

    function pendingDefaultFeedback(uint256 taskId) public view returns (bool) {
        return _loans[taskId].status == LoanStatus.Defaulted && !_defaultFeedbackSent[taskId];
    }

    function defaultFeedbackSent(uint256 taskId) external view returns (bool) {
        return _defaultFeedbackSent[taskId];
    }

    // ---------------------------------------------------------------------
    // refunds
    // ---------------------------------------------------------------------

    /// Spec §4.2 v5.3 (r5 #1 + r4 #1/#2 + r3 #3). relayRefunder only.
    ///   - Native: msg.value == amount. ERC-20: msg.value == 0 + safeTransferFrom.
    ///   - `refundId` is single-use (replay guard); retries carry the same id.
    ///   - Cumulative refundedAmount must never exceed fromCash + fromCredit.
    ///   - The refund is split by the ORIGINAL fromCash/fromCredit ratio of the
    ///     PaymentRecord.
    /// Branch on loans[record.taskId].status:
    ///   Active + full refund  → wipe principal, forgive uncollected fee (any
    ///                           already-collected fee returns to agent cash),
    ///                           status = ClosedByRefund, never liquidatable
    ///   Active + partial      → reduce remaining principal and fee pro rata;
    ///                           zero debt closes even if the payment is only
    ///                           partially refunded (including rounding boundaries)
    ///   Repaid                → the whole refund goes to agent cash; NEVER
    ///                           re-credited against already-settled principal
    ///   Defaulted             → recovery in reverse burden order, each layer
    ///                           capped by liquidations[taskId] MINUS what
    ///                           recoveredOf(taskId) already returned to it:
    ///                           LP loss → backstop → poster escrow → agent cash
    ///                           (TEST_PLAN F11: instalment refunds must not
    ///                           refill the same layer twice)
    ///   ClosedByRefund        → all new refund funds to cash; return only this
    ///                           instalment's additional proportional collected fee
    ///   None (pure cash, taskId == 0) → straight to cash[record.agentId]
    /// Never increments repaymentCount; never writes "repayment" feedback.
    function processRefund(bytes32 paymentId, uint256 amount, bytes32 refundId)
        external
        payable
        onlyRelayRefunder
        nonReentrant
    {
        (IAgentAccount.PaymentRecord memory record,, uint256 creditShare) =
            agentAccount.registerRefund(paymentId, refundId, amount);
        _receiveFunds(amount); // A failed receipt also rolls back the registration.
        TaskLoan storage loan = _loans[record.taskId];
        uint256 debtReduced;
        uint256 toCash;
        if (loan.status == LoanStatus.Defaulted) {
            toCash = _recoverRefund(record.taskId, amount);
        } else if (loan.status == LoanStatus.Active) {
            uint256 principalReduced = creditShare < loan.principal ? creditShare : loan.principal;
            loan.principal -= principalReduced;
            uint256 feeRelief = _refundFeeEntitlement(record, amount);
            uint256 feeForgiven = feeRelief < loan.fee ? feeRelief : loan.fee;
            loan.fee -= feeForgiven;
            vaultBalance += principalReduced;
            uint256 feeReturned = _returnCollectedFee(record.taskId, feeRelief - feeForgiven);
            debtReduced = principalReduced + feeForgiven;
            totalOutstanding -= debtReduced;
            toCash = amount - principalReduced + feeReturned;
            if (loan.principal + loan.fee == 0) {
                loan.status = LoanStatus.ClosedByRefund;
                emit LoanClosedByRefund(record.taskId, principalReduced, feeForgiven);
            }
        } else {
            toCash = amount;
            if (loan.status == LoanStatus.ClosedByRefund) {
                toCash += _returnCollectedFee(record.taskId, _refundFeeEntitlement(record, amount));
            }
        }
        _creditCash(record.agentId, toCash);
        emit RefundProcessed(paymentId, refundId, amount, debtReduced, toCash);
    }

    function _refundFeeEntitlement(IAgentAccount.PaymentRecord memory record, uint256 amount)
        private
        view
        returns (uint256)
    {
        uint256 total = record.fromCash + record.fromCredit;
        uint256 fee = _originalFee[record.taskId];
        return fee * (record.refundedAmount + amount) / total - fee * record.refundedAmount / total;
    }

    function _returnCollectedFee(uint256 taskId, uint256 entitlement) private returns (uint256 returned) {
        returned = entitlement < _collectedFee[taskId] ? entitlement : _collectedFee[taskId];
        _collectedFee[taskId] -= returned;
        vaultBalance -= returned;
    }

    function _recoverRefund(uint256 taskId, uint256 amount) private returns (uint256 toCash) {
        LiquidationRecord memory burden = _liquidations[taskId];
        LiquidationRecord storage recovered = _recovered[taskId];
        uint256 remaining = amount;
        uint256 cap = burden.lpLoss - recovered.lpLoss;
        uint256 toLp = remaining < cap ? remaining : cap;
        remaining -= toLp;
        recovered.lpLoss += toLp;
        vaultBalance += toLp;
        cap = burden.backstopUsed - recovered.backstopUsed;
        uint256 toBackstop = remaining < cap ? remaining : cap;
        remaining -= toBackstop;
        recovered.backstopUsed += toBackstop;
        _backstop[_loans[taskId].agentId] += toBackstop;
        backstopTotal += toBackstop;
        cap = burden.escrowSlashed - recovered.escrowSlashed;
        uint256 toPoster = remaining < cap ? remaining : cap;
        remaining -= toPoster;
        recovered.escrowSlashed += toPoster;
        recovered.poster = burden.poster;
        cap = burden.cashUsed - recovered.cashUsed;
        recovered.cashUsed += remaining < cap ? remaining : cap;
        toCash = remaining;
        SafeTransferLib.payOut(settlementAsset, burden.poster, toPoster);
        emit RecoveryDistributed(taskId, toLp, toBackstop, toPoster, toCash);
    }

    function _creditCash(uint256 agentId, uint256 amount) private {
        if (amount == 0) return;
        if (settlementAsset != address(0)) {
            SafeTransferLib.safeApprove(IERC20(settlementAsset), address(agentAccount), amount);
        }
        agentAccount.creditCash{value: settlementAsset == address(0) ? amount : 0}(agentId, amount);
    }

    // ---------------------------------------------------------------------
    // identity / freeze
    // ---------------------------------------------------------------------

    /// Spec §4.2: guardian, or automatic on detected identity change.
    /// Owner-side `ownerFrozen` can never clear this flag (review #9).
    function freezeAgent(uint256 agentId) external nonReentrant {
        if (msg.sender != guardian && !adapter.identityChanged(agentId)) revert NotGuardian(msg.sender);
        _protocolFrozen[agentId] = true;
        agentAccount.setProtocolFrozen(agentId, true);
        emit AgentFrozen(agentId, msg.sender);
    }

    /// Guardian-only unfreeze. Not named in §4.2 but implied by
    /// "发现变更即自动冻结信用，要求重新 underwrite" (RISK_AND_MVP §1.4): without
    /// it a frozen agent could never be re-approved. SPEC GAP G4 (TEST_PLAN §3).
    /// MUST NOT touch `defaultCount` or any loan's terminal state — a manual
    /// unfreeze is an operational decision, never a rewrite of credit history,
    /// and it does not by itself refresh the identity snapshot (that is
    /// `reapproveAgent`'s job).
    function unfreezeAgent(uint256 agentId) external onlyGuardian nonReentrant {
        _protocolFrozen[agentId] = false;
        agentAccount.setProtocolFrozen(agentId, false);
        emit AgentUnfrozen(agentId, msg.sender);
    }

    /// Spec §4.1: the underwriter's re-review path; the only way to refresh the
    /// adapter snapshot. Bumping the version invalidates every old authorization.
    function reapproveAgent(uint256 agentId) external onlyGuardian {
        adapter.reapprove(agentId);
    }

    /// Spec §4.1: first enrolment (tx0 in §5).
    function enrollAgent(uint256 agentId) external onlyGuardian {
        adapter.enroll(agentId);
    }

    // ---------------------------------------------------------------------
    // views (implemented: pure storage reads)
    // ---------------------------------------------------------------------

    function loans(uint256 taskId) external view returns (uint256, uint256, uint256, uint256, LoanStatus) {
        TaskLoan memory l = _loans[taskId];
        return (l.agentId, l.principal, l.fee, l.loanDueAt, l.status);
    }

    function getLoan(uint256 taskId) external view returns (TaskLoan memory) {
        return _loans[taskId];
    }

    function liquidations(uint256 taskId)
        external
        view
        returns (uint256, uint256, uint256, uint256, address)
    {
        LiquidationRecord memory r = _liquidations[taskId];
        return (r.cashUsed, r.escrowSlashed, r.backstopUsed, r.lpLoss, r.poster);
    }

    function getLiquidation(uint256 taskId) external view returns (LiquidationRecord memory) {
        return _liquidations[taskId];
    }

    /// @notice Cumulative recovery already paid back to each burden layer.
    ///         `getLiquidation` keeps the untouched original burden.
    function getRecovered(uint256 taskId) external view returns (LiquidationRecord memory) {
        return _recovered[taskId];
    }

    function backstop(uint256 agentId) external view returns (uint256) {
        return _backstop[agentId];
    }

    function protocolFrozen(uint256 agentId) external view returns (bool) {
        return _protocolFrozen[agentId];
    }

    function drawnInEpoch(uint256 epoch) external view returns (uint256) {
        return _drawnInEpoch[epoch];
    }

    function currentEpoch() external view returns (uint256) {
        return block.timestamp / EPOCH_LENGTH;
    }

    function usedNonces(uint256 agentId, uint256 nonce) external view returns (bool) {
        return _usedNonces[agentId][nonce];
    }

    function repaymentCount(uint256 agentId) external view returns (uint256) {
        return _repaymentCount[agentId];
    }

    function defaultCount(uint256 agentId) external view returns (uint256) {
        return _defaultCount[agentId];
    }

    /// @notice Total debt still owed on a task loan (principal + fee).
    function debtOf(uint256 taskId) external view returns (uint256) {
        TaskLoan memory l = _loans[taskId];
        return l.principal + l.fee;
    }

    receive() external payable {}
}
