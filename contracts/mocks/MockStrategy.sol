// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IStrategy } from "../interfaces/IStrategy.sol";

contract MockStrategy is IStrategy, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable vault;
    IERC20 public immutable u;

    modifier onlyVault() {
        require(msg.sender == vault, "ONLY_VAULT");
        _;
    }

    constructor(address _vault, address _underlying) {
        vault = _vault;
        u = IERC20(_underlying);
    }

    function underlying() external view returns (address) {
        return address(u);
    }

    function deposit(uint256 amount) external onlyVault nonReentrant returns (uint256) {
        if (amount == 0) return 0;
        u.safeTransferFrom(msg.sender, address(this), amount);
        return amount;
    }

    function withdrawUnderlying(uint256 amount, address to) external onlyVault nonReentrant {
        u.safeTransfer(to, amount);
    }

    function withdrawAll(address to) external onlyVault nonReentrant returns (uint256) {
        uint256 bal = u.balanceOf(address(this));
        if (bal > 0) u.safeTransfer(to, bal);
        return bal;
    }

    function totalUnderlying() external view returns (uint256) {
        return u.balanceOf(address(this));
    }

    function accrue() external onlyVault returns (uint256) {
        return 0;
    }
}