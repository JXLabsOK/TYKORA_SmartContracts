// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IStrategy } from "../interfaces/IStrategy.sol";
import { IRskBridge } from "../interfaces/IRskBridge.sol";
//TYKO-05  -  2026 04 21
import { IRecoverableStrategy } from "../interfaces/IRecoverableStrategy.sol";
//TYKO-05  -  2026 04 21 END
contract PrizeVault is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------- errors ----------
    error ZeroAddress();
    error ZeroAmount();
    error StrategyAlreadySet();
    error StrategyNotSet();
    error StrategyUnderlyingMismatch(address expected, address actual);

    error InvalidBps();
    error VaultLocked();
    error DrawNotEnded(uint256 nowTs, uint256 endTs);
    error InvalidDraw();
    error InvalidDrawState();

    error RandomnessNotReady(uint256 targetHeight);
    error InvalidBtcHeight(int256 height);
    error EmergencyDelayNotPassed(uint256 nowTs, uint256 unlockTs);
    error BridgeNotSet();
    error EmergencyModeEnabled();
    error EmergencyModeDisabled();//TYKO-02  -  2026 04 20
    error FenwickRepairInProgress();
    //TYKO-01  -  2026 04 20
    error InvalidMinHoldForEligibility();
    //TYKO-01  -  2026 04 20 END
    //TYKO-03  -  2026 04 21
    error ManualAwardDisabled();
    //TYKO-03  -  2026 04 21 END
    // ---------- events ----------
    event StrategySet(address indexed strategy);
    event Deposited(address indexed user, uint256 amountUnderlying);
    event Withdrawn(address indexed user, uint256 amountUnderlying);

    event TreasurySet(address indexed treasury);

    event DrawClosed(
        uint256 indexed drawId,
        uint64 startedAt,
        uint64 closedAt,
        uint256 btcTargetHeight,
        uint256 totalYield,
        uint256 prize,
        uint256 treasuryFee,
        uint256 keeperTip,
        uint256 tickets,
        address indexed caller
    );

    event DrawAwarded(
        uint256 indexed drawId,
        bytes32 seed,
        uint8 winnersCount,
        address winner1,
        address winner2,
        address winner3,
        address indexed caller
    );

    event DrawClaimed(
        uint256 indexed drawId,
        uint8 winnersCount,
        address winner1,
        address winner2,
        address winner3,
        uint256 prize1,
        uint256 prize2,
        uint256 prize3,
        uint256 treasuryFee,
        uint256 keeperTip,
        address indexed claimer
    );

    event DrawCancelled(
        uint256 indexed drawId,
        uint64 closedAt,
        uint64 cancelledAt,
        uint256 rolledBackToStrategy,
        address indexed caller
    );

    event PrizeOwed(address indexed winner, uint256 amount);
    event PrizeClaimed(address indexed winner, uint256 amount);
    event EmergencyModeSet(bool enabled, address indexed caller);

    event FenwickRepairStarted(uint256 n);
    event FenwickRepairProgress(uint8 phase, uint256 nextIndex);
    event FenwickRepairFinished(uint256 totalTicketsAfter);
    event LastDepositAtUpdated(address indexed user, uint64 ts);
    event NoTicketsSet(address indexed account, bool enabled);

    // ---------- config ----------
    IERC20 public immutable underlying;
    IStrategy public strategy; // set once

    uint32 public immutable btcConfirmations;

    address public treasury;

    uint16 public immutable treasuryBps; // 900 = 9%
    uint16 public immutable keeperBps;   // 100 = 1%
    uint64 public immutable drawPeriod;  // seconds, e.g. 7 days

    uint64 public immutable emergencyDelay;

    IRskBridge public immutable bridge;

    // ---------- eligibility cooldown (V1) ----------
    uint64 public immutable minHoldForEligibility; // e.g. 24 hours
    mapping(address => uint64) public lastDepositAt;

    // ---------- Sponsors ----------
    mapping(address => bool) public noTickets; // true => deposit but do NOT participate in the draw

    // ---------- accounting ----------
    uint256 public totalPrincipal;

    // ---------- locking ----------
    bool public isLocked;

    // ---------- emergency ----------
    bool public emergencyMode;

    // ---------- fenwick repair ----------
    enum FenwickRepairPhase { NONE, INIT, BUILD }
    FenwickRepairPhase public fenwickRepairPhase;
    uint256 public fenwickRepairIndex;

    // ---------- draw state ----------
    enum DrawStatus { OPEN, CLOSED, AWARDED, CLAIMED }
    uint8 internal constant NUM_WINNERS = 3;

    struct DrawInfo {
        DrawStatus status;
        uint64 startedAt;
        uint64 closedAt;
        uint64 awardedAt;
        uint64 claimedAt;

        bytes32 seed;

        address winner;

        uint256 tickets;     // snapshot tickets at close
        uint256 totalYield;
        uint256 prize;       // total prize to distribute to winners (after fees)
        uint256 treasuryFee;
        uint256 keeperTip;

        address awarder;
        address claimer;

        uint256 btcTargetHeight;
        bytes32 btcHash;
        
        uint8 winnersCount;            // 0..3
        address[3] winners;            // ordered: 1st, 2nd, 3rd
        uint256[3] winnerPrizes;       // ordered amounts (sum == prize)
        address treasuryRecipient;     // snapshot treasury at close
    }
    //TYKO-01  -  2026 04 20
    /// @dev Ticket segment representation in the original cumulative ticket space.
    struct Segment {
        uint256 start;
        uint256 len; // segment is [start, start + len)
    }
    //TYKO-01  -  2026 04 20 END

    uint256 public currentDrawId;
    uint64 public currentDrawStart;

    mapping(uint256 => DrawInfo) public draws;

    // fallback owed amounts (in underlying)
    mapping(address => uint256) public prizeOwed;

    // ---------- Fenwick Tree (Sum Tree) ----------
    uint256[] private _fenwick;   // BIT sums
    uint256[] private _weights;   // weight at index
    address[] private _idxToUser; // index -> user
    uint256[] private _freeIdx;   // reusable indexes
    mapping(address => uint256) public indexOf; // user -> index (0 = none)

    modifier whenNotLocked() {
        if (isLocked) revert VaultLocked();
        _;
    }
        
    modifier whenNotRepairingOrEmergency() {
        if (fenwickRepairPhase != FenwickRepairPhase.NONE) revert FenwickRepairInProgress();
        if (emergencyMode) revert EmergencyModeEnabled();//TYKO-02  -  2026 04 20
        _;
    }

    constructor(
        address _underlying,
        string memory _shareName,
        string memory _shareSymbol,
        address _owner,
        address _treasury,
        uint64 _drawPeriodSeconds,
        uint64 _minHoldForEligibilitySeconds,
        uint16 _treasuryBps,
        uint16 _keeperBps,
        uint32 _btcConfirmations,
        uint64 _emergencyDelaySeconds,
        address _bridge
    ) ERC20(_shareName, _shareSymbol) Ownable(_owner) {
        if (_underlying == address(0) || _owner == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_drawPeriodSeconds == 0) revert InvalidBps();
        //TYKO-01  -  2026 04 20
        if (_minHoldForEligibilitySeconds == 0 || _minHoldForEligibilitySeconds > _drawPeriodSeconds) {
            revert InvalidMinHoldForEligibility();
        }
        //TYKO-01  -  2026 04 20 END
        if (uint256(_treasuryBps) + uint256(_keeperBps) > 10_000) revert InvalidBps();
        if (_emergencyDelaySeconds == 0) revert InvalidBps();

        underlying = IERC20(_underlying);
        treasury = _treasury;

        drawPeriod = _drawPeriodSeconds;
        minHoldForEligibility = _minHoldForEligibilitySeconds;
        treasuryBps = _treasuryBps;
        keeperBps = _keeperBps;

        currentDrawId = 1;
        currentDrawStart = uint64(block.timestamp);

        // init BIT arrays with dummy element at index 0
        _fenwick.push(0);
        _weights.push(0);
        _idxToUser.push(address(0));

        // init first draw
        draws[currentDrawId].status = DrawStatus.OPEN;
        draws[currentDrawId].startedAt = currentDrawStart;

        btcConfirmations = _btcConfirmations;
        emergencyDelay = _emergencyDelaySeconds;

        bridge = IRskBridge(_bridge);
    }

    // ---------- non-transferable shares ----------
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            revert("NON_TRANSFERABLE");
        }

        super._update(from, to, value);

        // AIRBAG: if emergency is enabled, DO NOT touch Fenwick/weights.
        if (emergencyMode) return;

        // If we are repairing Fenwick, do not sync weights mid-repair (would invalidate rebuild).
        if (fenwickRepairPhase != FenwickRepairPhase.NONE) return;

        // sync weights after balances updated (mint/burn)
        if (from == address(0) && to != address(0)) {
            _syncWeight(to);
        } else if (to == address(0) && from != address(0)) {
            _syncWeight(from);
        }
    }

    // ---------- admin ----------
    function setStrategy(address _strategy) external onlyOwner {
        if (_strategy == address(0)) revert ZeroAddress();
        if (address(strategy) != address(0)) revert StrategyAlreadySet();

        IStrategy s = IStrategy(_strategy);
        address actual = s.underlying();
        if (actual != address(underlying)) revert StrategyUnderlyingMismatch(address(underlying), actual);

        strategy = s;

        // Approve once (max) to avoid per-deposit allowance SSTORE costs
        SafeERC20.forceApprove(underlying, _strategy, type(uint256).max);

        emit StrategySet(_strategy);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    function setEmergencyMode(bool enabled) external onlyOwner {
        emergencyMode = enabled;
        emit EmergencyModeSet(enabled, msg.sender);
    }

    // ---------- views ----------
    function drawEndTimestamp() public view returns (uint256) {
        return uint256(currentDrawStart) + uint256(drawPeriod);
    }

    function totalAssets() public view returns (uint256) {
        uint256 idle = underlying.balanceOf(address(this));
        if (address(strategy) == address(0)) return idle;
        return idle + strategy.totalUnderlying();
    }

    function currentYield() public view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets <= totalPrincipal) return 0;
        return assets - totalPrincipal;
    }

    function totalTickets() public view returns (uint256) {
        uint256 n = _fenwick.length;
        if (n <= 1) return 0;
        return _fenwickSum(n - 1);
    }
    
    function getWinners(uint256 drawId)
        external
        view
        returns (uint8 winnersCount, address[3] memory winners, uint256[3] memory winnerPrizes)
    {
        DrawInfo storage d = draws[drawId];
        return (d.winnersCount, d.winners, d.winnerPrizes);
    }

    function setNoTickets(address account, bool enabled)
        external
        onlyOwner
        whenNotRepairingOrEmergency
    {
        if (account == address(0)) revert ZeroAddress();
        if (isLocked) revert VaultLocked();

        if (noTickets[account] == enabled) return;
        noTickets[account] = enabled;

        // Resync Fenwick:
        // - if enabled => weight 0 (removes it from the tree)
        // - if disabled => weight = balance (adds it to the tree if it has shares)
        if (enabled) {
            _setWeight(account, 0);
        } else {
            //TYKO-01  -  2026 04 20
            uint64 ts = uint64(block.timestamp);
            lastDepositAt[account] = ts;
            emit LastDepositAtUpdated(account, ts);
            //TYKO-01  -  2026 04 20 END
            _syncWeight(account);
        }

        emit NoTicketsSet(account, enabled);
    }

    // ---------- user flows ----------
    function deposit(uint256 amount) external nonReentrant whenNotLocked whenNotRepairingOrEmergency{ //TYKO-02  -  2026 04 20
        if (amount == 0) revert ZeroAmount();
        if (address(strategy) == address(0)) revert StrategyNotSet();

        underlying.safeTransferFrom(msg.sender, address(this), amount);

        // No per-deposit approve: allowance is set once in setStrategy()
        strategy.deposit(amount);

        totalPrincipal += amount;
        _mint(msg.sender, amount);

        if (!noTickets[msg.sender]) {//TYKO-01  -  2026 04 20
            uint64 ts = uint64(block.timestamp);
            lastDepositAt[msg.sender] = ts;
            emit LastDepositAtUpdated(msg.sender, ts);
        }

        emit Deposited(msg.sender, amount);
    }
    
    function withdraw(uint256 amount) public nonReentrant whenNotLocked whenNotRepairingOrEmergency {
        if (amount == 0) revert ZeroAmount();
        if (address(strategy) == address(0)) revert StrategyNotSet();

        _burn(msg.sender, amount);
        totalPrincipal -= amount;

        strategy.withdrawUnderlying(amount, msg.sender);

        emit Withdrawn(msg.sender, amount);
    }

    function withdrawAll() external whenNotLocked whenNotRepairingOrEmergency {

        withdraw(balanceOf(msg.sender));
    }

    // fallback claim (only if transfer failed in claimDraw)
    function claimOwed() external nonReentrant whenNotLocked {
        uint256 amt = prizeOwed[msg.sender];
        if (amt == 0) return;

        // Effects first
        prizeOwed[msg.sender] = 0;

        // If vault has not enough idle (e.g. emergencyCancelDraw rolled everything into strategy),
        // pull the missing amount from the strategy.
        uint256 idle = underlying.balanceOf(address(this));
        if (idle < amt) {
            if (address(strategy) == address(0)) revert StrategyNotSet();
            strategy.withdrawUnderlying(amt - idle, address(this));
        }

        underlying.safeTransfer(msg.sender, amt);
        emit PrizeClaimed(msg.sender, amt);
    }

    // ---------- DRAW: close -> award -> claim ----------

    /// @notice Close current draw, compute yield + fees, and (if needed) lock vault until award+claim.    
    function closeDraw() external nonReentrant whenNotRepairingOrEmergency { //TYKO-02  -  2026 04 20
        if (address(strategy) == address(0)) revert StrategyNotSet();

        uint256 endTs = drawEndTimestamp();
        if (block.timestamp < endTs) revert DrawNotEnded(block.timestamp, endTs);

        uint256 drawId = currentDrawId;
        DrawInfo storage d = draws[drawId];
        if (d.status != DrawStatus.OPEN) revert InvalidDrawState();

        // refresh exchange rate so totalAssets/yield is accurate
        strategy.accrue();

        uint256 assets = totalAssets();
        uint256 principal = totalPrincipal;
        uint256 y = assets > principal ? (assets - principal) : 0;

        uint256 tickets = totalTickets();
        uint64 now64 = uint64(block.timestamp);

        // minimal writes (gas): only what's needed for this draw lifecycle
        d.closedAt = now64;
        d.totalYield = y;
        d.tickets = tickets;
        d.treasuryRecipient = treasury;

        // If no yield OR no participants: finalize immediately and carry yield forward
        if (y == 0 || tickets == 0) {
            d.prize = 0;
            d.treasuryFee = 0;
            d.keeperTip = 0;
            d.btcTargetHeight = 0;

            d.status = DrawStatus.CLAIMED;
            d.claimedAt = now64;
            d.claimer = msg.sender;

            emit DrawClosed(drawId, d.startedAt, d.closedAt, 0, y, 0, 0, 0, tickets, msg.sender);

            _startNextDraw();
            return;
        }

        uint256 treasFee = (y * uint256(treasuryBps)) / 10_000;
        uint256 keepTip  = (y * uint256(keeperBps)) / 10_000;
        uint256 prize    = y - treasFee - keepTip;

        d.prize = prize;
        d.treasuryFee = treasFee;
        d.keeperTip = keepTip;

        // btc target only needed if we will lock & award
        uint256 btcTarget = 0;
        if (address(bridge) != address(0)) {
            uint256 best = _bestBtcHeight();
            btcTarget = best + uint256(btcConfirmations);
        }
        d.btcTargetHeight = btcTarget;

        // Reserve payout in vault (pull from strategy if needed)
        uint256 payout = prize + treasFee + keepTip;
        uint256 idle = underlying.balanceOf(address(this));
        if (idle < payout) {
            strategy.withdrawUnderlying(payout - idle, address(this));
        }

        isLocked = true;
        d.status = DrawStatus.CLOSED;

        emit DrawClosed(drawId, d.startedAt, d.closedAt, btcTarget, y, prize, treasFee, keepTip, tickets, msg.sender);
    }
    
    function awardDrawFromBtc(uint256 drawId) external nonReentrant whenNotRepairingOrEmergency{ //TYKO-02  -  2026 04 20
        if (drawId != currentDrawId) revert InvalidDraw();

        DrawInfo storage d = draws[drawId];

        if (d.status != DrawStatus.CLOSED) revert InvalidDrawState();
        if (!isLocked) revert InvalidDrawState();

        // TYKO-03
        // Bridge must be configured.
        // Tests/local deployments may set bridge=0 and use awardDrawManual.
        // Production deployments should configure a real bridge and use awardDrawFromBtc.
        if (address(bridge) == address(0) || d.btcTargetHeight == 0) revert BridgeNotSet();

        bytes memory header = bridge.getBtcBlockchainBlockHeaderByHeight(d.btcTargetHeight);
        if (header.length == 0) revert RandomnessNotReady(d.btcTargetHeight);

        bytes32 btcHash = _doubleSha256(header);
        bytes32 seed = keccak256(abi.encodePacked(btcHash, address(this), drawId));

        d.btcHash = btcHash;
        d.seed = seed;

        _awardWithSeed(d, seed);

        d.awardedAt = uint64(block.timestamp);
        d.awarder = msg.sender;
        d.status = DrawStatus.AWARDED;

        emit DrawAwarded(drawId, seed, d.winnersCount, d.winners[0], d.winners[1], d.winners[2], msg.sender);
    }
    
    function awardDrawManual(uint256 drawId, bytes32 seed) external onlyOwner nonReentrant whenNotRepairingOrEmergency{ //TYKO-02  -  2026 04 20
        // TYKO-03 -  2026 04 21        
        if (address(bridge) != address(0)) revert ManualAwardDisabled();
        // TYKO-03 -  2026 04 21 END
        if (drawId != currentDrawId) revert InvalidDraw();
        DrawInfo storage d = draws[drawId];
        if (d.status != DrawStatus.CLOSED) revert InvalidDrawState();
        if (!isLocked) revert InvalidDrawState();

        d.seed = seed;

        _awardWithSeed(d, seed);

        d.awardedAt = uint64(block.timestamp);
        d.awarder = msg.sender;
        d.status = DrawStatus.AWARDED;

        emit DrawAwarded(drawId, seed, d.winnersCount, d.winners[0], d.winners[1], d.winners[2], msg.sender);
    }

    /// @notice Claim the draw: pays keeper tip to caller, treasury fee to treasury, and prizes to 1..3 winners (fallback to owed).
    function claimDraw(uint256 drawId) external nonReentrant whenNotRepairingOrEmergency{ //TYKO-02  -  2026 04 20
        if (drawId != currentDrawId) revert InvalidDraw();
        DrawInfo storage d = draws[drawId];
        if (d.status != DrawStatus.AWARDED) revert InvalidDrawState();
        if (!isLocked) revert InvalidDrawState();

        uint256 prizeTotal = d.prize;
        uint256 treasFee = d.treasuryFee;
        uint256 keepTip = d.keeperTip;

        uint256 payout = prizeTotal + treasFee + keepTip;
        if (payout > 0) {
            uint256 idle = underlying.balanceOf(address(this));
            if (idle < payout) {
                // safety net: if somehow not fully reserved, pull remaining from strategy
                strategy.withdrawUnderlying(payout - idle, address(this));
            }
        }

        if (keepTip > 0) underlying.safeTransfer(msg.sender, keepTip);
        //TYKO-08  -  2026 04 21
        address treas = d.treasuryRecipient;
        if (treasFee > 0) {
            if (!_tryTransferERC20(address(underlying), treas, treasFee)) {
                prizeOwed[treas] += treasFee;
                emit PrizeOwed(treas, treasFee);
            }
        }
        //TYKO-08  -  2026 04 21 END

        uint8 wc = d.winnersCount;
        for (uint8 i = 0; i < wc; i++) {
            address w = d.winners[i];
            uint256 amt = d.winnerPrizes[i];
            if (amt == 0 || w == address(0)) continue;

            if (!_tryTransferERC20(address(underlying), w, amt)) {
                prizeOwed[w] += amt;
                emit PrizeOwed(w, amt);
            }
        }

        d.claimedAt = uint64(block.timestamp);
        d.claimer = msg.sender;
        d.status = DrawStatus.CLAIMED;

        emit DrawClaimed(
            drawId,
            d.winnersCount,
            d.winners[0],
            d.winners[1],
            d.winners[2],
            d.winnerPrizes[0],
            d.winnerPrizes[1],
            d.winnerPrizes[2],
            treasFee,
            keepTip,
            msg.sender
        );

        // unlock and start next draw
        isLocked = false;
        _startNextDraw();
    }

    function _startNextDraw() internal {
        currentDrawId += 1;
        currentDrawStart = uint64(block.timestamp);

        DrawInfo storage nd = draws[currentDrawId];
        nd.status = DrawStatus.OPEN;
        nd.startedAt = currentDrawStart;
    }

    // =========================
    // Multi-winner internals
    // =========================
    function _awardWithSeed(DrawInfo storage d, bytes32 seed) internal {
        // Use snapshot only: while locked, weights/tickets shouldn't change.
        uint256 t = d.tickets;
        //TYKO-01  -  2026 04 20
        uint64 scheduledEnd = d.startedAt + drawPeriod;
        uint64 cutoff = scheduledEnd - minHoldForEligibility;
        //TYKO-01  -  2026 04 20 END

        (address[3] memory winners, uint8 count) = _pickWinnersDistinct(seed, t, cutoff);

        d.winnersCount = count;
        d.winners = winners;

        // keep legacy field as "winner #1"
        d.winner = (count > 0) ? winners[0] : address(0);

        // compute 50/30/20 (or renormalized for 2 winners, or 100% for 1)
        d.winnerPrizes = _splitPrize503020(d.prize, count);
    }

    //TYKO-01  -  2026 04 20
    /// @dev Pick exactly up to 3 distinct eligible winners without rebuilding the Fenwick tree.
    /// Segment-exclusion sampling:
    /// - When an ineligible/invalid/duplicate address is hit, we exclude its entire ticket segment
    ///   [prefix(idx-1), prefix(idx)) from the sampling space.
    /// - We then sample uniformly over the remaining space and map back to the original space.
    ///
    /// Note: this function will return < 3 winners only if it cannot find enough eligible distinct
    /// winners within the attempt bounds (or if fewer than 3 eligible holders exist in practice).
    function _pickWinnersDistinct(
        bytes32 seed,
        uint256 tickets,
        uint64 cutoff        
    ) internal view returns (address[3] memory winners, uint8 count) {
        if (tickets == 0) return (winners, 0);

        uint256 len = _idxToUser.length;
        if (len <= 1) return (winners, 0); // only dummy slot

        // Excluded ticket segments in the original ticket space [0, tickets).
        // IMPORTANT: this must be an actual memory array, not just the struct name.
        uint256 maxExcluded = 64; // increase if you expect many exclusions in a single draw
        Segment[] memory excluded = new Segment[](maxExcluded);
        uint256 excludedCount = 0;

        uint256 remaining = tickets;

        for (uint8 i = 0; i < NUM_WINNERS; ) {
            if (remaining == 0) break;

            // Try until we find a valid winner for this slot.
            for (uint16 a = 0; a < 1024; ) {
                // Sample uniformly over the remaining (non-excluded) ticket space.
                uint256 y = uint256(keccak256(abi.encodePacked(seed, i, a))) % remaining;

                // Map y into the original ticket space [0, tickets) by skipping excluded segments.
                uint256 x = _mapToOriginal(y, excluded, excludedCount);

                uint256 idx = _fenwickFindByCumulative(x);
                if (idx == 0 || idx >= len) {
                    unchecked { ++a; }
                    continue;
                }

                address w = _idxToUser[idx];
                uint256 wgt = _weights[idx];

                // Safety checks (should not happen in a consistent Fenwick tree, but keep as guardrails).
                if (w == address(0) || wgt == 0) {
                    unchecked { ++a; }
                    continue;
                }

                // Cooldown + sponsor eligibility check
                if (!_isEligibleWinner(w, cutoff)) {
                    (uint256 segStart, uint256 segLen) = _segmentForIndex(idx, wgt);

                    uint256 prevCount = excludedCount;
                    excludedCount = _insertSegmentSorted(excluded, excludedCount, segStart, segLen);

                    // Only shrink remaining if we successfully inserted (buffer not full / not duplicate).
                    if (excludedCount != prevCount) {
                        remaining -= segLen;
                    }

                    unchecked { ++a; }
                    continue;
                }

                // Distinct check (also exclude duplicates to avoid re-hitting them).
                if (count != 0) {
                    if (w == winners[0] || (count > 1 && w == winners[1])) {
                        (uint256 segStart2, uint256 segLen2) = _segmentForIndex(idx, wgt);

                        uint256 prevCount2 = excludedCount;
                        excludedCount = _insertSegmentSorted(excluded, excludedCount, segStart2, segLen2);

                        if (excludedCount != prevCount2) {
                            remaining -= segLen2;
                        }

                        unchecked { ++a; }
                        continue;
                    }
                }

                // Valid distinct winner found.
                winners[count] = w;
                unchecked { ++count; }

                // Exclude winner segment to enforce sampling without replacement.
                (uint256 segStart3, uint256 segLen3) = _segmentForIndex(idx, wgt);

                uint256 prevCount3 = excludedCount;
                excludedCount = _insertSegmentSorted(excluded, excludedCount, segStart3, segLen3);

                if (excludedCount != prevCount3) {
                    remaining -= segLen3;
                }

                // Move to next winner slot.
                break;
            }

            // If we failed to fill this winner slot, stop.
            if (count < i + 1) break;

            unchecked { ++i; }
        }

        return (winners, count);
    }    

    /// @dev Compute the ticket segment for a given Fenwick index.
    /// @param idx Fenwick/user index.
    /// @param wgt The weight at idx (_weights[idx]) to avoid a redundant SLOAD.
    function _segmentForIndex(uint256 idx, uint256 wgt) internal view returns (uint256 start, uint256 segLen) {
        // prefix(idx-1) gives the segment start.
        start = _fenwickSum(idx - 1);
        segLen = wgt; // weights map 1:1 to ticket-length in cumulative space
    }

    /// @dev Map a uniform y in [0, remaining) to x in [0, total) by skipping excluded segments.
    /// Excluded segments must be sorted by start ascending and non-overlapping.
    function _mapToOriginal(
        uint256 y,
        Segment[] memory excluded,
        uint256 excludedCount
    ) internal pure returns (uint256 x) {
        x = y;

        for (uint256 j = 0; j < excludedCount; ) {
            if (x >= excluded[j].start) {
                x += excluded[j].len;
                unchecked { ++j; }
            } else {
                break;
            }
        }

        return x;
    }

    /// @dev Insert a segment into the excluded list while keeping it sorted by start.
    /// If the buffer is full or the segment is already present, it will be ignored.
    function _insertSegmentSorted(
        Segment[] memory excluded,
        uint256 excludedCount,
        uint256 start,
        uint256 segLen
    ) internal pure returns (uint256 newCount) {
        if (segLen == 0) return excludedCount;
        if (excludedCount >= excluded.length) return excludedCount;

        // Avoid inserting duplicates (same start => same user segment).
        for (uint256 k = 0; k < excludedCount; ) {
            if (excluded[k].start == start) return excludedCount;
            unchecked { ++k; }
        }

        Segment memory s = Segment({ start: start, len: segLen });

        // Insertion sort (small N expected).
        uint256 i = excludedCount;
        while (i > 0) {
            Segment memory prev = excluded[i - 1];
            if (prev.start <= s.start) break;
            excluded[i] = prev;
            unchecked { --i; }
        }
        excluded[i] = s;

        return excludedCount + 1;
    }

    /// @dev Eligibility rules:
    /// - noTickets => always ineligible
    /// - must have non-zero shares at award time (note: this reflects *current* shares; no per-user snapshot)
    function _isEligibleWinner(address w, uint64 cutoff) internal view returns (bool) {
        if (noTickets[w]) return false;
        if (balanceOf(w) == 0) return false;

        uint64 ld = lastDepositAt[w];
        if (ld == 0) return false;

        return ld <= cutoff;
    }
    //TYKO-01  -  2026 04 20 END

    /// @dev Split prize with 50/30/20 when 3 winners.
    /// If 2 winners: renormalize 50:30 => 5/8 and 3/8.
    /// If 1 winner: 100%.
    /// Remainders are handled by giving leftover to prize1 to ensure sum == prize.
    function _splitPrize503020(uint256 prize, uint8 wCount)
        internal
        pure
        returns (uint256[3] memory parts)
    {
        if (wCount == 0 || prize == 0) return parts;

        if (wCount == 1) {
            parts[0] = prize;
            return parts;
        }

        if (wCount == 2) {
            // 5/8 and 3/8 (ratio 50:30)
            uint256 p1 = (prize * 5) / 8;
            uint256 p2 = prize - p1;
            parts[0] = p1;
            parts[1] = p2;
            return parts;
        }

        // wCount >= 3 => 50/30/20
        uint256 p1_ = (prize * 5000) / 10_000;
        uint256 p2_ = (prize * 3000) / 10_000;
        uint256 p3_ = prize - p1_ - p2_; // includes remainder, effectively ~20%

        parts[0] = p1_;
        parts[1] = p2_;
        parts[2] = p3_;
        return parts;
    }

    // ---------- Fenwick internals ----------
    function _syncWeight(address user) internal {
        uint256 newW = noTickets[user] ? 0 : balanceOf(user);
        _setWeight(user, newW);
    }  

    function _setWeight(address user, uint256 newW) internal {
        uint256 idx = indexOf[user];

        if (idx == 0) {
            if (newW == 0) return;
            idx = _allocateIndex(user);
        }

        uint256 oldW = _weights[idx];
        if (oldW == newW) return;

        _weights[idx] = newW;

        if (newW > oldW) {
            unchecked {
                _fenwickAdd(idx, newW - oldW);
            }
        } else {
            _fenwickSub(idx, oldW - newW);
        }

        if (newW == 0) {
            // free index for reuse
            indexOf[user] = 0;
            _idxToUser[idx] = address(0);
            _freeIdx.push(idx);
        }
    }

    function _allocateIndex(address user) internal returns (uint256 idx) {
        uint256 nFree = _freeIdx.length;

        if (nFree != 0) {
            idx = _freeIdx[nFree - 1];
            _freeIdx.pop();
            _idxToUser[idx] = user;
            // _weights[idx] debería estar en 0 al haber sido liberado.
        } else {
            // 1-based; el index 0 es dummy
            idx = _idxToUser.length;

            _idxToUser.push(user);
            _weights.push(0);
            _fenwick.push(0);

            // ---- FIX: mantener la invariante del Fenwick al expandir ----
            // fenwick[idx] debe ser sum(idx - lsb(idx) + 1 .. idx)
            // Como weight[idx] todavía es 0, equivale a:
            // prefix(idx-1) - prefix(idx - lsb(idx))
            uint256 lsb = idx & (~idx + 1);
            _fenwick[idx] = _fenwickSum(idx - 1) - _fenwickSum(idx - lsb);
        }

        indexOf[user] = idx;
        return idx;
    }

    function _fenwickAdd(uint256 idx, uint256 delta) internal {
        if (delta == 0) return;

        uint256 n = _fenwick.length;
        while (idx < n) {
            unchecked {
                _fenwick[idx] += delta;
                idx += (idx & (~idx + 1));
            }
        }
    }

    function _fenwickSub(uint256 idx, uint256 delta) internal {
        if (delta == 0) return;

        uint256 n = _fenwick.length;
        while (idx < n) {
            // keep checked subtraction to fail-fast if Fenwick got corrupted
            _fenwick[idx] -= delta;
            unchecked {
                idx += (idx & (~idx + 1));
            }
        }
    }

    function _fenwickSum(uint256 idx) internal view returns (uint256 s) {
        while (idx != 0) {
            s += _fenwick[idx];
            idx &= (idx - 1);
        }
    }

    /// @dev returns index where prefixSum(index) > r (r ideally in [0, total-1]).
    /// If r is out-of-range due to inconsistency, it may return n+1; callers must guard.
    function _fenwickFindByCumulative(uint256 r) internal view returns (uint256 idx) {
        uint256 nPlus = _fenwick.length;
        if (nPlus <= 1) return 0;

        uint256 n = nPlus - 1;

        uint256 bit = 1;
        // find highest power of two <= n
        while (bit <= n) {
            bit <<= 1;
        }
        bit >>= 1;

        uint256 sum = 0;
        idx = 0;

        while (bit > 0) {
            uint256 next = idx + bit;
            if (next <= n) {
                uint256 nextSum = sum + _fenwick[next];
                if (nextSum <= r) {
                    idx = next;
                    sum = nextSum;
                }
            }
            bit >>= 1;
        }

        unchecked {
            return idx + 1; // may be n+1 if r >= total
        }
    }

    // ---------- ERC20 try-transfer (non-reverting) ----------
    function _tryTransferERC20(address token, address to, uint256 amount) internal returns (bool ok) {
        //TYKO-07  -  2026 04 21
        // Consistent with OpenZeppelin SafeERC20 behavior:
        // if target has no code, treat as failed transfer.
        if (token.code.length == 0) return false;

        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));

        if (!success) return false;
        if (data.length == 0) return true;
        if (data.length == 32) return abi.decode(data, (bool));
        return false;
        //TYKO-07  -  2026 04 21 END
    }

    function _bestBtcHeight() internal view returns (uint256) {
        int256 h = bridge.getBtcBlockchainBestChainHeight();
        if (h <= 0) revert InvalidBtcHeight(h);
        return uint256(h);
    }

    function _doubleSha256(bytes memory b) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(b)));
    }
    
    function emergencyCancelDraw(uint256 drawId) external onlyOwner nonReentrant {
        //TYKO-02  -  2026 04 20
        if (fenwickRepairPhase != FenwickRepairPhase.NONE) revert FenwickRepairInProgress();
        if (!emergencyMode) revert EmergencyModeDisabled();
        //TYKO-02  -  2026 04 20 END

        if (drawId != currentDrawId) revert InvalidDraw();
        DrawInfo storage d = draws[drawId];

        if (d.status != DrawStatus.CLOSED && d.status != DrawStatus.AWARDED) revert InvalidDrawState();
        if (!isLocked) revert InvalidDrawState();
        if (address(strategy) == address(0)) revert StrategyNotSet();

        // If already awarded, we count the emergency delay from awardedAt; otherwise from closedAt.
        uint64 baseTs = (d.status == DrawStatus.AWARDED) ? d.awardedAt : d.closedAt;

        uint256 unlockTs = uint256(baseTs) + uint256(emergencyDelay);
        if (block.timestamp < unlockTs) revert EmergencyDelayNotPassed(block.timestamp, unlockTs);

        // Roll idle funds back into strategy so yield carries over to the next draw
        uint256 idle = underlying.balanceOf(address(this));
        uint256 rolled = 0;

        if (idle > 0) {
            strategy.deposit(idle);
            rolled = idle;
        }

        d.claimedAt = uint64(block.timestamp);
        d.claimer = msg.sender;
        d.status = DrawStatus.CLAIMED;

        emit DrawCancelled(drawId, d.closedAt, d.claimedAt, rolled, msg.sender);

        isLocked = false;
        _startNextDraw();
    }

    function startFenwickRepair() external onlyOwner {
        if (isLocked) revert VaultLocked();
        if (fenwickRepairPhase != FenwickRepairPhase.NONE) revert FenwickRepairInProgress();

        uint256 nPlus = _fenwick.length;
        if (nPlus <= 1) {
            // nothing to repair
            return;
        }

        fenwickRepairPhase = FenwickRepairPhase.INIT;
        fenwickRepairIndex = 1;

        emit FenwickRepairStarted(nPlus - 1);
    }

    /// @notice Continue repairing Fenwick in chunks. Call multiple times until phase becomes NONE.
    /// @param steps number of indices to process in this call.
    function continueFenwickRepair(uint256 steps) external onlyOwner {
        if (fenwickRepairPhase == FenwickRepairPhase.NONE) return;

        uint256 n = _fenwick.length - 1;
        uint256 i = fenwickRepairIndex;
        if (i == 0) i = 1;

        if (steps == 0) steps = 1;

        if (fenwickRepairPhase == FenwickRepairPhase.INIT) {
            uint256 end = i + steps;
            if (end > n + 1) end = n + 1;

            // Phase INIT: set fenwick[i] = current balance of user at idx, and sync _weights[i]
            for (; i < end; ) {
                address u = _idxToUser[i];                
                uint256 w = (u == address(0)) ? 0 : (noTickets[u] ? 0 : balanceOf(u));

                _weights[i] = w;
                _fenwick[i] = w;

                unchecked { ++i; }
            }

            fenwickRepairIndex = i;
            emit FenwickRepairProgress(uint8(FenwickRepairPhase.INIT), i);

            if (i > n) {
                fenwickRepairPhase = FenwickRepairPhase.BUILD;
                fenwickRepairIndex = 1;
                emit FenwickRepairProgress(uint8(FenwickRepairPhase.BUILD), 1);
            }

            return;
        }

        if (fenwickRepairPhase == FenwickRepairPhase.BUILD) {
            uint256 end = i + steps;
            if (end > n + 1) end = n + 1;

            // Phase BUILD: propagate sums
            for (; i < end; ) {
                uint256 lsb = i & (~i + 1);
                uint256 j = i + lsb;
                if (j <= n) {
                    _fenwick[j] += _fenwick[i];
                }
                unchecked { ++i; }
            }

            fenwickRepairIndex = i;
            emit FenwickRepairProgress(uint8(FenwickRepairPhase.BUILD), i);

            if (i > n) {
                fenwickRepairPhase = FenwickRepairPhase.NONE;
                fenwickRepairIndex = 0;
                emit FenwickRepairFinished(totalTickets());
            }
        }
    }

    function eligibleForDraw(address user, uint256 drawId) external view returns (bool) {
        if (noTickets[user]) return false;
        if (drawId == 0 || drawId > currentDrawId) return false;

        DrawInfo storage d = draws[drawId];
        if (d.startedAt == 0) return false;//TYKO-01  -  2026 04 20

        if (balanceOf(user) == 0) return false;

        //TYKO-01  -  2026 04 20
        uint64 scheduledEnd = d.startedAt + drawPeriod;
        uint64 cutoff = scheduledEnd - minHoldForEligibility;
        //TYKO-01  -  2026 04 20 END

        uint64 ld = lastDepositAt[user];
        //TYKO-01  -  2026 04 20
        if (ld == 0) return false;

        return ld <= cutoff;
        //TYKO-01  -  2026 04 20 END
    }

    //TYKO-05  -  2026 04 21
    function recoverStrategyERC20(address token, address to, uint256 amount) external onlyOwner {
        if (address(strategy) == address(0)) revert StrategyNotSet();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        IRecoverableStrategy(address(strategy)).recoverERC20(token, to, amount);
    }
    //TYKO-05  -  2026 04 21
}