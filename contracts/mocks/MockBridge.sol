// SPDX-License-Identifier: MIT
// TYKO-03 -  2026 04 21
pragma solidity ^0.8.20;

contract MockBridge {
    int256 private _bestHeight;
    mapping(uint256 => bytes) private _headers;

    constructor() {
        _bestHeight = 1000;
    }

    function setBestHeight(int256 h) external {
        _bestHeight = h;
    }

    function setHeader(uint256 height, bytes calldata header) external {
        _headers[height] = header;
    }

    function getBtcBlockchainBestChainHeight() external view returns (int256) {
        return _bestHeight;
    }

    function getBtcBlockchainBlockHeaderByHeight(uint256 height) external view returns (bytes memory) {
        return _headers[height];
    }
}
// TYKO-03 -  2026 04 21 END