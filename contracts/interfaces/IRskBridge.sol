// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRskBridge {
    function getBtcBlockchainBestChainHeight() external view returns (int256);
    function getBtcBlockchainBlockHeaderByHeight(uint256 height) external view returns (bytes memory);
}