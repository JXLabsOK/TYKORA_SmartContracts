// SPDX-License-Identifier: MIT
//TYKO-08  -  2026 04 21
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockBlacklistERC20 is ERC20 {
    mapping(address => bool) public blocked;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && blocked[from]) revert("BLOCKED_FROM");
        if (to != address(0) && blocked[to]) revert("BLOCKED_TO");
        super._update(from, to, value);
    }
}
//TYKO-08  -  2026 04 21 END