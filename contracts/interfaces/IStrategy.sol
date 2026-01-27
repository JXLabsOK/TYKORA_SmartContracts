// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IStrategy {
    function underlying() external view returns (address);

    function deposit(uint256 amount) external returns (uint256);
    function withdrawUnderlying(uint256 amount, address to) external;
    function withdrawAll(address to) external returns (uint256);

    function totalUnderlying() external view returns (uint256);
    
    function accrue() external returns (uint256);
}