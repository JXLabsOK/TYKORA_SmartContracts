// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockKToken is ERC20 {
    IERC20 public immutable underlyingToken;

    // Tropykus-style exchange rate, scaled by 1e18
    uint256 public exchangeRate; // 1e18 scaled
    uint256 public constant RATE_SCALE = 1e18;

    bool public revertExchangeRateCurrent;

    uint256 public mintCode;
    uint256 public redeemCode;
    uint256 public redeemUnderlyingCode;

    // (optional) for UI/APY reads
    uint256 public supplyRatePerBlock;

    uint8 private immutable _dec;

    constructor(
        address underlying_,
        string memory name_,
        string memory symbol_,
        uint8 kTokenDecimals_,
        uint256 initialExchangeRate_
    ) ERC20(name_, symbol_) {
        require(underlying_ != address(0), "ZERO_UNDERLYING");
        underlyingToken = IERC20(underlying_);
        _dec = kTokenDecimals_;
        exchangeRate = initialExchangeRate_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function underlying() external view returns (address) {
        return address(underlyingToken);
    }

    function exchangeRateStored() external view returns (uint256) {
        return exchangeRate;
    }

    function exchangeRateCurrent() external returns (uint256) {
        if (revertExchangeRateCurrent) revert("EXCHANGE_RATE_CURRENT_REVERT");
        return exchangeRate;
    }

    function setExchangeRate(uint256 newRate) external {
        exchangeRate = newRate;
    }

    function setRevertExchangeRateCurrent(bool v) external {
        revertExchangeRateCurrent = v;
    }

    function setReturnCodes(uint256 mintCode_, uint256 redeemCode_, uint256 redeemUnderlyingCode_) external {
        mintCode = mintCode_;
        redeemCode = redeemCode_;
        redeemUnderlyingCode = redeemUnderlyingCode_;
    }

    function setSupplyRatePerBlock(uint256 v) external {
        supplyRatePerBlock = v;
    }

    /// @dev Mint kTokens by depositing underlying.
    /// kOut = amount * 1e18 / exchangeRate
    function mint(uint256 amount) external returns (uint256) {
        if (mintCode != 0) return mintCode;

        require(underlyingToken.transferFrom(msg.sender, address(this), amount), "UNDERLYING_TRANSFER_FROM_FAIL");
        uint256 kOut = (amount * RATE_SCALE) / exchangeRate;
        _mint(msg.sender, kOut);

        return 0;
    }

    /// @dev Redeem by burning kTokens and returning underlying.
    /// underlyingOut = kAmount * exchangeRate / 1e18
    function redeem(uint256 kAmount) external returns (uint256) {
        if (redeemCode != 0) return redeemCode;

        _burn(msg.sender, kAmount);

        uint256 underlyingOut = (kAmount * exchangeRate) / RATE_SCALE;
        require(underlyingToken.transfer(msg.sender, underlyingOut), "UNDERLYING_TRANSFER_FAIL");

        return 0;
    }

    function redeemUnderlying(uint256 amount) external returns (uint256) {
        if (redeemUnderlyingCode != 0) return redeemUnderlyingCode;

        uint256 kBurn = (amount * RATE_SCALE) / exchangeRate;
        _burn(msg.sender, kBurn);

        require(underlyingToken.transfer(msg.sender, amount), "UNDERLYING_TRANSFER_FAIL");
        return 0;
    }
}