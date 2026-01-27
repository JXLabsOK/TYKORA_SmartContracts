// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IKToken {
    function mint(uint256 mintAmount) external returns (uint256);              // 0 = OK
    function redeem(uint256 redeemTokens) external returns (uint256);          // 0 = OK
    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);// 0 = OK

    function balanceOf(address owner) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);

    function exchangeRateCurrent() external returns (uint256);

    function underlying() external view returns (address);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}