// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPriceFeed {
    function getPrice(string memory symbol) external view returns (uint256);
}

contract LendingPool {
    IPriceFeed public priceFeed;
    address public admin;

    uint256 constant WAD = 1e18;

    struct TokenConfig {
        IERC20 token;
        string symbol;          // symbol key for price feed, e.g. "bitcoin"
        uint256 lendRateWad;    // annual lender rate (WAD, e.g. 0.01e18 for 1%)
        uint256 borrowRateWad;  // annual borrower rate (WAD)
        uint256 totalDeposits;  // token units (raw)
    }

    // maps token address => config
    mapping(address => TokenConfig) public configs;

    // user => token => deposit balance
    mapping(address => mapping(address => uint256)) public deposits;

    // Loans (simple per-borrower single loan per token for demo)
    struct Loan {
        uint256 principal;       // borrowed amount (raw token units)
        uint256 lastAccrued;     // timestamp interest last accrued
        uint256 accInterest;     // accumulated interest (raw token units)
    }
    // borrower => token => Loan
    mapping(address => mapping(address => Loan)) public loans;

    // collateral token used for borrowing (we'll use USDT)
    IERC20 public collateralToken;
    string public collateralSymbol;
    uint256 public collateralFactorWad; // e.g., 0.5e18 for 50%

    modifier onlyAdmin() {
        require(msg.sender == admin, "only admin");
        _;
    }

    constructor(address _priceFeed) {
        priceFeed = IPriceFeed(_priceFeed);
        admin = msg.sender;
        collateralFactorWad = 0.5e18; // 50%
    }

    // Admin: configure tokens
    function addToken(
        address tokenAddr,
        string memory symbol,
        uint256 lendRateWad,
        uint256 borrowRateWad
    ) external onlyAdmin {
        configs[tokenAddr] = TokenConfig({
            token: IERC20(tokenAddr),
            symbol: symbol,
            lendRateWad: lendRateWad,
            borrowRateWad: borrowRateWad,
            totalDeposits: 0
        });
    }

    // Set collateral token (USDT)
    function setCollateral(address tokenAddr, string memory symbol) external onlyAdmin {
        collateralToken = IERC20(tokenAddr);
        collateralSymbol = symbol;
    }

    // deposit (lend) tokens into pool
    function deposit(address tokenAddr, uint256 amount) external {
        require(amount > 0, "zero");
        TokenConfig storage cfg = configs[tokenAddr];
        require(address(cfg.token) != address(0), "token not supported");
        // transfer from user
        cfg.token.transferFrom(msg.sender, address(this), amount);
        deposits[msg.sender][tokenAddr] += amount;
        cfg.totalDeposits += amount;
    }

    // withdraw deposited tokens
    function withdraw(address tokenAddr, uint256 amount) external {
        require(amount > 0, "zero");
        require(deposits[msg.sender][tokenAddr] >= amount, "insufficient");
        TokenConfig storage cfg = configs[tokenAddr];
        // TODO: check pool liquidity
        deposits[msg.sender][tokenAddr] -= amount;
        cfg.totalDeposits -= amount;
        cfg.token.transfer(msg.sender, amount);
    }

    // Borrow tokenAddr by posting collateral in USDT (collateralToken)
    // collateralAmount supplied must be approved and transferred before calling
    function borrow(address tokenAddr, uint256 amount, uint256 collateralAmount) external {
        require(amount > 0, "zero borrow");
        TokenConfig storage cfg = configs[tokenAddr];
        require(address(cfg.token) != address(0), "token not supported");

        // Transfer collateral from borrower to contract
        collateralToken.transferFrom(msg.sender, address(this), collateralAmount);

        // compute collateral value in USDT via price feed (collateral is USDT so 1:1)
        // but we keep general form:
        uint256 collateralValueUsdt = collateralAmount; // USDT has 1e18 decimals? we'll assume raw units, be careful in frontend

        // Now compute maximum borrow allowed based on collateral factor
        // Need to value requested token in USDT: tokenPrice = priceFeed.getPrice(symbol) -> price is scaled by 100 (your fetcher)
        uint256 tokenPrice = priceFeed.getPrice(cfg.symbol); // e.g. priceInUSDT * 100
        require(tokenPrice > 0, "zero price");
        // convert requested amount to USDT value:
        // tokenValueUsdt = amount * tokenPrice / 100
        uint256 tokenValueUsdt = (amount * tokenPrice) / 100;

        // allowed = collateralValueUsdt * collateralFactor
        uint256 allowed = (collateralValueUsdt * collateralFactorWad) / WAD;

        require(tokenValueUsdt <= allowed, "insufficient collateral");

        // ensure pool has liquidity
        require(cfg.totalDeposits >= amount, "no liquidity");

        // create/update loan; accumulate interest before increasing principal
        _accrueInterest(msg.sender, tokenAddr);

        loans[msg.sender][tokenAddr].principal += amount;
        loans[msg.sender][tokenAddr].lastAccrued = block.timestamp;

        // transfer borrowed tokens to borrower
        cfg.token.transfer(msg.sender, amount);
        cfg.totalDeposits -= amount;
    }

    // repay borrowed token
    function repay(address tokenAddr, uint256 amount) external {
        require(amount > 0, "zero repay");
        Loan storage loan = loans[msg.sender][tokenAddr];
        require(loan.principal > 0 || loan.accInterest > 0, "no loan");
        // accrue first
        _accrueInterest(msg.sender, tokenAddr);

        // transfer token from borrower
        TokenConfig storage cfg = configs[tokenAddr];
        cfg.token.transferFrom(msg.sender, address(this), amount);

        // pay interest first
        if (amount >= loan.accInterest) {
            amount -= loan.accInterest;
            loan.accInterest = 0;
        } else {
            loan.accInterest -= amount;
            amount = 0;
        }

        // pay principal
        if (amount > 0) {
            if (amount >= loan.principal) {
                uint256 leftover = amount - loan.principal;
                loan.principal = 0;
                // any leftover becomes deposit to user
                deposits[msg.sender][tokenAddr] += leftover;
                cfg.totalDeposits += leftover;
            } else {
                loan.principal -= amount;
            }
        }

        loan.lastAccrued = block.timestamp;
    }

    // utility to accrue interest for a borrower/token
    function _accrueInterest(address borrower, address tokenAddr) internal {
        Loan storage loan = loans[borrower][tokenAddr];
        if (loan.principal == 0) {
            loan.lastAccrued = block.timestamp;
            return;
        }
        uint256 elapsed = block.timestamp - (loan.lastAccrued == 0 ? block.timestamp : loan.lastAccrued);
        if (elapsed == 0) return;

        TokenConfig storage cfg = configs[tokenAddr];
        // borrow rate annual WAD
        uint256 annualRate = cfg.borrowRateWad;
        // interest = principal * annualRate * elapsed / secondsPerYear
        uint256 secondsPerYear = 365 * 24 * 3600;
        // principal * annualRate gives WAD*raw -> need to scale by WAD
        uint256 interest = (loan.principal * annualRate / WAD) * elapsed / secondsPerYear;
        loan.accInterest += interest;
        loan.lastAccrued = block.timestamp;
    }

    // Admin can deposit initial liquidity on behalf of deployer if needed
    function adminDeposit(address tokenAddr, uint256 amount) external onlyAdmin {
        TokenConfig storage cfg = configs[tokenAddr];
        cfg.token.transferFrom(msg.sender, address(this), amount);
        cfg.totalDeposits += amount;
    }

    // helper getters
    function getDeposit(address user, address tokenAddr) external view returns (uint256) {
        return deposits[user][tokenAddr];
    }

    function getLoan(address user, address tokenAddr) external view returns (uint256 principal, uint256 accInterest, uint256 lastAccrued) {
        Loan storage l = loans[user][tokenAddr];
        return (l.principal, l.accInterest, l.lastAccrued);
    }
}
