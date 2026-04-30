// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract MockSovrynIToken is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable loanToken;
    uint256 public tokenPriceValue;

    bool public mintZero;
    bool public burnNoRedeem;

    uint256 public marketLiquidityValue;
    uint256 public supplyInterestRateValue;
    uint256 public totalAssetSupplyValue;
    uint256 public totalAssetBorrowValue;
    uint256 public transactionLimitValue;

    uint256 public constant PRICE_SCALE = 1e18;

    constructor(
        address _loanToken,
        string memory _name,
        string memory _symbol,
        uint256 _initialTokenPrice
    ) ERC20(_name, _symbol) {
        loanToken = IERC20(_loanToken);
        tokenPriceValue = _initialTokenPrice;
    }

    function loanTokenAddress() external view returns (address) {
        return address(loanToken);
    }

    function setTokenPrice(uint256 price) external {
        tokenPriceValue = price;
    }

    function setMintZero(bool enabled) external {
        mintZero = enabled;
    }

    function setBurnNoRedeem(bool enabled) external {
        burnNoRedeem = enabled;
    }

    function setMarketLiquidity(uint256 value) external {
        marketLiquidityValue = value;
    }

    function setSupplyInterestRate(uint256 value) external {
        supplyInterestRateValue = value;
    }

    function setTotals(uint256 supplyValue, uint256 borrowValue) external {
        totalAssetSupplyValue = supplyValue;
        totalAssetBorrowValue = borrowValue;
    }

    function setTransactionLimit(uint256 value) external {
        transactionLimitValue = value;
    }

    function tokenPrice() external view returns (uint256) {
        return tokenPriceValue;
    }

    function assetBalanceOf(address owner) external view returns (uint256) {
        return Math.mulDiv(balanceOf(owner), tokenPriceValue, PRICE_SCALE);
    }

    function marketLiquidity() external view returns (uint256) {
        if (marketLiquidityValue != 0) return marketLiquidityValue;
        return loanToken.balanceOf(address(this));
    }

    function supplyInterestRate() external view returns (uint256) {
        return supplyInterestRateValue;
    }

    function nextSupplyInterestRate(uint256) external view returns (uint256) {
        return supplyInterestRateValue;
    }

    function totalAssetSupply() external view returns (uint256) {
        return totalAssetSupplyValue;
    }

    function totalAssetBorrow() external view returns (uint256) {
        return totalAssetBorrowValue;
    }

    function transactionLimit(address) external view returns (uint256) {
        return transactionLimitValue;
    }

    function mint(
        address receiver,
        uint256 depositAmount,
        bool
    ) external returns (uint256 minted) {
        if (mintZero) return 0;

        require(tokenPriceValue != 0, "INVALID_PRICE");

        loanToken.safeTransferFrom(msg.sender, address(this), depositAmount);

        minted = Math.mulDiv(depositAmount, PRICE_SCALE, tokenPriceValue);

        if (minted > 0) {
            _mint(receiver, minted);
        }

        return minted;
    }

    function burn(
        address receiver,
        uint256 burnAmount,
        bool
    ) external returns (uint256 redeemed) {
        _burn(msg.sender, burnAmount);

        if (burnNoRedeem) return 0;

        require(tokenPriceValue != 0, "INVALID_PRICE");

        redeemed = Math.mulDiv(burnAmount, tokenPriceValue, PRICE_SCALE);

        if (redeemed > 0) {
            loanToken.safeTransfer(receiver, redeemed);
        }

        return redeemed;
    }
}