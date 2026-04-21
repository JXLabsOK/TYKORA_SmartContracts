// SPDX-License-Identifier: MIT
//TYKO-05  -  2026 04 21
pragma solidity ^0.8.20;

interface IRecoverableStrategy {
    function recoverERC20(address token, address to, uint256 amount) external;
}
//TYKO-05  -  2026 04 21 END