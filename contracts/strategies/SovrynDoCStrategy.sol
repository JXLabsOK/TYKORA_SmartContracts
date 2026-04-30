// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { ISovrynIToken } from "../interfaces/ISovrynIToken.sol";

contract SovrynDoCStrategy is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------- errors ----------
    error OnlyVault();
    error ZeroAddress();
    error ZeroAmount();
    error UnderlyingMismatch(address expected, address actual);
    error InvalidTokenPrice();
    error MintFailed();
    error BurnFailed();
    error InsufficientUnderlying(uint256 requested, uint256 available);
    error RecoverNotAllowed();

    // ---------- events ----------
    event Deposited(uint256 underlyingAmount, uint256 iTokensReceived);
    event Withdrawn(
        uint256 underlyingAmount,
        uint256 iTokensBurned,
        uint256 underlyingRedeemed,
        address to
    );
    event WithdrawAll(uint256 underlyingAmount, uint256 iTokensBurned, address to);
    event Accrued(uint256 tokenPrice);
    event Recovered(address token, uint256 amount, address to);

    // ---------- immutables ----------
    address public immutable vault;
    IERC20 public immutable underlyingToken;
    ISovrynIToken public immutable iToken;

    /// @dev Sovryn iToken price is expected to be 1e18-scaled.    
    uint256 public constant PRICE_SCALE = 1e18;

    /// @dev Tykora does not use Sovryn Liquidity Mining in this strategy.
    bool public constant USE_LM = false;

    /// @notice Last observed token price, 1e18-scaled.
    uint256 public lastTokenPrice;

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address _vault, address _underlyingToken, address _iToken) {
        if (_vault == address(0) || _underlyingToken == address(0) || _iToken == address(0)) {
            revert ZeroAddress();
        }

        vault = _vault;
        underlyingToken = IERC20(_underlyingToken);
        iToken = ISovrynIToken(_iToken);

        // Ensure strategy is configured with matching underlying.
        address actualUnderlying = iToken.loanTokenAddress();
        if (actualUnderlying != _underlyingToken) {
            revert UnderlyingMismatch(_underlyingToken, actualUnderlying);
        }

        uint256 price = iToken.tokenPrice();
        if (price == 0) revert InvalidTokenPrice();

        lastTokenPrice = price;

        // Approve once to avoid per-deposit allowance costs.
        SafeERC20.forceApprove(underlyingToken, address(iToken), type(uint256).max);
    }

    function underlying() external view returns (address) {
        return address(underlyingToken);
    }

    function iTokenBalance() public view returns (uint256) {
        return iToken.balanceOf(address(this));
    }

    /// @notice Estimated underlying represented by held iTokens using lastTokenPrice.
    /// @dev Includes idle underlying that may remain after rounded withdrawals.
    function totalUnderlying() public view returns (uint256) {
        uint256 idle = underlyingToken.balanceOf(address(this));
        uint256 iBal = iToken.balanceOf(address(this));

        if (iBal == 0) return idle;

        uint256 price = lastTokenPrice;
        if (price == 0) return idle;

        return idle + Math.mulDiv(iBal, price, PRICE_SCALE);
    }

    /// @notice Live Sovryn accounting using assetBalanceOf.
    /// @dev Useful for UI, monitoring and keeper checks. This is not cached.
    function currentUnderlying() external view returns (uint256) {
        return underlyingToken.balanceOf(address(this)) + iToken.assetBalanceOf(address(this));
    }

    /// @notice Available liquidity from Sovryn plus idle DoC held by this strategy.
    function availableLiquidity() external view returns (uint256) {
        return underlyingToken.balanceOf(address(this)) + iToken.marketLiquidity();
    }

    /// @notice Estimated iTokens needed to withdraw an underlying amount using the last observed price.
    function previewBurnAmount(uint256 underlyingAmount) external view returns (uint256) {
        if (underlyingAmount == 0) return 0;

        uint256 price = lastTokenPrice;
        if (price == 0) return 0;

        return Math.mulDiv(underlyingAmount, PRICE_SCALE, price, Math.Rounding.Ceil);
    }

    /// @notice Updates lastTokenPrice from Sovryn.
    function accrue() external onlyVault nonReentrant returns (uint256 price) {
        price = iToken.tokenPrice();
        if (price == 0) revert InvalidTokenPrice();

        lastTokenPrice = price;

        emit Accrued(price);
    }

    function deposit(uint256 amount) external onlyVault nonReentrant returns (uint256 iTokensReceived) {
        if (amount == 0) revert ZeroAmount();

        uint256 iBefore = iToken.balanceOf(address(this));

        // Vault must approve this strategy, same pattern as TropykusDoCStrategy.
        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);

        iToken.mint(address(this), amount, USE_LM);

        uint256 iAfter = iToken.balanceOf(address(this));
        iTokensReceived = iAfter - iBefore;

        if (iTokensReceived == 0) revert MintFailed();

        uint256 price = iToken.tokenPrice();
        if (price == 0) revert InvalidTokenPrice();
        lastTokenPrice = price;

        emit Deposited(amount, iTokensReceived);
    }

    function withdrawUnderlying(uint256 amount, address to) external onlyVault nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 idleBefore = underlyingToken.balanceOf(address(this));
        uint256 iTokensBurned;
        uint256 underlyingRedeemed;

        if (idleBefore < amount) {
            uint256 needed = amount - idleBefore;

            uint256 price = iToken.tokenPrice();
            if (price == 0) revert InvalidTokenPrice();
            lastTokenPrice = price;

            iTokensBurned = Math.mulDiv(needed, PRICE_SCALE, price, Math.Rounding.Ceil);

            uint256 iBal = iToken.balanceOf(address(this));
            if (iTokensBurned > iBal) {
                iTokensBurned = iBal;
            }

            if (iTokensBurned == 0) {
                revert InsufficientUnderlying(amount, idleBefore);
            }

            uint256 underlyingBefore = underlyingToken.balanceOf(address(this));

            iToken.burn(address(this), iTokensBurned, USE_LM);

            uint256 underlyingAfter = underlyingToken.balanceOf(address(this));
            underlyingRedeemed = underlyingAfter - underlyingBefore;

            if (underlyingRedeemed == 0) revert BurnFailed();
        }

        uint256 available = underlyingToken.balanceOf(address(this));
        if (available < amount) {
            revert InsufficientUnderlying(amount, available);
        }

        underlyingToken.safeTransfer(to, amount);

        emit Withdrawn(amount, iTokensBurned, underlyingRedeemed, to);
    }
    
    function withdrawAll(address to) external onlyVault nonReentrant returns (uint256 underlyingOut) {
        if (to == address(0)) revert ZeroAddress();

        uint256 iBal = iToken.balanceOf(address(this));
        uint256 redeemed;

        if (iBal > 0) {
            uint256 underlyingBefore = underlyingToken.balanceOf(address(this));

            iToken.burn(address(this), iBal, USE_LM);

            uint256 underlyingAfter = underlyingToken.balanceOf(address(this));
            redeemed = underlyingAfter - underlyingBefore;
        }

        underlyingOut = underlyingToken.balanceOf(address(this));

        if (underlyingOut == 0 && iBal > 0) revert BurnFailed();

        if (underlyingOut > 0) {
            underlyingToken.safeTransfer(to, underlyingOut);
        }

        uint256 price = iToken.tokenPrice();
        if (price > 0) {
            lastTokenPrice = price;
        }

        emit WithdrawAll(underlyingOut, iBal, to);
    }

    function recoverERC20(address token, address to, uint256 amount) external onlyVault {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (token == address(underlyingToken) || token == address(iToken)) {
            revert RecoverNotAllowed();
        }

        IERC20(token).safeTransfer(to, amount);

        emit Recovered(token, amount, to);
    }
}