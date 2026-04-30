// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISovrynIToken is IERC20 {
    function loanTokenAddress() external view returns (address);

    function mint(
        address receiver,
        uint256 depositAmount,
        bool useLM
    ) external returns (uint256 minted);

    function burn(
        address receiver,
        uint256 burnAmount,
        bool useLM
    ) external returns (uint256 redeemed);

    function tokenPrice() external view returns (uint256);

    function assetBalanceOf(address owner) external view returns (uint256);

    function marketLiquidity() external view returns (uint256);

    function supplyInterestRate() external view returns (uint256);

    function nextSupplyInterestRate(uint256 supplyAmount) external view returns (uint256);

    function totalAssetSupply() external view returns (uint256);

    function totalAssetBorrow() external view returns (uint256);

    function transactionLimit(address token) external view returns (uint256);
}