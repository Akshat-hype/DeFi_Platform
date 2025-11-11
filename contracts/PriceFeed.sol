// contracts/PriceFeed.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

contract PriceFeed {
    address public owner;
    mapping(string => uint256) public prices;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function updatePrice(string memory symbol, uint256 price) external onlyOwner {
        prices[symbol] = price;
    }

    function getPrice(string memory symbol) external view returns (uint256) {
        return prices[symbol];
    }
}
