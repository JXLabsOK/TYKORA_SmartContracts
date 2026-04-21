// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IKToken } from "../interfaces/IKToken.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract TropykusDoCStrategy is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------- errors ----------
    error OnlyVault();
    error ZeroAddress();
    error ZeroAmount();
    error UnderlyingMismatch(address expected, address actual);
    error MintFailed(uint256 code);
    error RedeemFailed(uint256 code);
    error RedeemUnderlyingFailed(uint256 code);
    error RecoverNotAllowed();

    // ---------- events ----------
    event Deposited(uint256 underlyingAmount, uint256 kTokensReceived);
    event Withdrawn(uint256 underlyingAmount, address to);
    event WithdrawAll(uint256 underlyingAmount, address to);
    event Recovered(address token, uint256 amount, address to);

    // ---------- immutables ----------
    address public immutable vault;
    IERC20 public immutable underlying;
    IKToken public immutable kToken;

    /// @dev Tropykus confirmed exchangeRate is ALWAYS scaled by 1e18 across markets.
    uint256 public constant RATE_SCALE = 1e18;

    /// @notice last observed exchange rate (1e18 scaled)
    uint256 public lastExchangeRate;

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address _vault, address _underlying, address _kToken) {
        if (_vault == address(0) || _underlying == address(0) || _kToken == address(0)) revert ZeroAddress();

        vault = _vault;
        underlying = IERC20(_underlying);
        kToken = IKToken(_kToken);

        // Ensure strategy is configured with matching underlying
        address actualUnderlying = kToken.underlying();
        if (actualUnderlying != _underlying) revert UnderlyingMismatch(_underlying, actualUnderlying);

        // Initialize rate from stored (safe / no gas-heavy accrue)
        lastExchangeRate = kToken.exchangeRateStored();

        // Approve once (max) to avoid per-deposit allowance costs
        SafeERC20.forceApprove(underlying, address(kToken), type(uint256).max);
    }

    function kTokenBalance() public view returns (uint256) {
        return kToken.balanceOf(address(this));
    }

    /// @notice Estimated underlying represented by held kTokens using lastExchangeRate (1e18)
    function totalUnderlying() public view returns (uint256) {
        uint256 kBal = kToken.balanceOf(address(this));
        if (kBal == 0) return 0;

        uint256 rate = lastExchangeRate;
        if (rate == 0) {
            // fallback safety: should not happen, but avoids odd states
            rate = kToken.exchangeRateStored();
        }

        // Underlying = kTokenAmount * exchangeRate / 1e18
        return Math.mulDiv(kBal, rate, RATE_SCALE);
    }

    /// @notice Updates lastExchangeRate trying real-time accrue; falls back to stored
    function accrue() external onlyVault nonReentrant returns (uint256 rate) {
        // Some markets can revert in certain states; fallback to stored
        try kToken.exchangeRateCurrent() returns (uint256 r) {
            lastExchangeRate = r;
            return r;
        } catch {
            uint256 s = kToken.exchangeRateStored();
            lastExchangeRate = s;
            return s;
        }
    }

    function deposit(uint256 amount) external onlyVault nonReentrant returns (uint256 kTokensReceived) {
        if (amount == 0) revert ZeroAmount();

        uint256 kBefore = kToken.balanceOf(address(this));

        // Vault transfers underlying to strategy, then we mint kTokens
        underlying.safeTransferFrom(msg.sender, address(this), amount);

        uint256 code = kToken.mint(amount);
        if (code != 0) revert MintFailed(code);

        uint256 kAfter = kToken.balanceOf(address(this));
        kTokensReceived = kAfter - kBefore;

        emit Deposited(amount, kTokensReceived);
    }

    function withdrawUnderlying(uint256 amount, address to) external onlyVault nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 code = kToken.redeemUnderlying(amount);
        if (code != 0) revert RedeemUnderlyingFailed(code);

        underlying.safeTransfer(to, amount);
        emit Withdrawn(amount, to);
    }

    function withdrawAll(address to) external onlyVault nonReentrant returns (uint256 underlyingOut) {
        if (to == address(0)) revert ZeroAddress();

        uint256 kBal = kToken.balanceOf(address(this));
        if (kBal > 0) {
            uint256 code = kToken.redeem(kBal);
            if (code != 0) revert RedeemFailed(code);
        }

        underlyingOut = underlying.balanceOf(address(this));
        if (underlyingOut > 0) {
            underlying.safeTransfer(to, underlyingOut);
        }

        emit WithdrawAll(underlyingOut, to);
    }

    //TYKO-05  -  2026 04 21
    function recoverERC20(address token, address to, uint256 amount) external onlyVault {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(underlying) || token == address(kToken)) revert RecoverNotAllowed();
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransfer(to, amount);
        emit Recovered(token, amount, to);
    }
    //TYKO-05  -  2026 04 21 END
}