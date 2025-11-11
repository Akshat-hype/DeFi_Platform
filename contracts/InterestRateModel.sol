// contracts/InterestRateModel.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

contract InterestRateModel {
    address public owner;

    struct Fees {
        uint256 depositFeeBps;    // e.g. 100 = 1%
        uint256 withdrawFeeBps;   // e.g. 300 = 3%
    }

    mapping(address => Fees) public tokenFees;

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setFees(
        address token,
        uint256 depBps,
        uint256 wdrBps
    ) external onlyOwner {
        tokenFees[token] = Fees(depBps, wdrBps);
    }

    function getFees(address token) external view returns (uint256 depBps, uint256 wdrBps) {
        Fees memory f = tokenFees[token];
        return (f.depositFeeBps, f.withdrawFeeBps);
    }
}
