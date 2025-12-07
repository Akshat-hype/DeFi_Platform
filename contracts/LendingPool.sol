// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPriceFeed {
    /// @notice Returns price * 100 in USD terms for the given symbol key
    function getPrice(string memory symbol) external view returns (uint256);
}

/**
 * @title LendingPool
 * @notice Collateral = sum of ALL user deposits converted to USD via price feed.
 *         Borrow limit = 70% of total collateral USD.
 *         Borrowed value = amount * price(token) / 100.
 *         Users can withdraw only if doing so does not break the collateral limit.
 *         Interest accrues linearly by time on principal at token's borrowRateWad (per year, WAD).
 */
contract LendingPool {
    uint256 constant WAD = 1e18;

    IPriceFeed public priceFeed;
    address public admin;

    /// @notice Borrow limit factor in %, e.g. 70 => 70% of collateral
    uint256 public borrowFactor = 70;

    struct TokenConfig {
        IERC20 token;
        string symbol;          // price feed key
        uint256 lendRateWad;    // kept for future; not applied in this minimal pool
        uint256 borrowRateWad;  // annual rate (WAD)
        uint256 totalDeposits;  // liquidity in pool (raw token units)
        bool enabled;
    }

    // iterable token set
    address[] public supportedTokens;

    // tokenAddr => TokenConfig
    mapping(address => TokenConfig) public configs;

    // user => token => deposited amount (raw units)
    mapping(address => mapping(address => uint256)) public deposits;

    struct Loan {
        uint256 principal;     // raw token units
        uint256 accInterest;   // raw token units
        uint256 lastAccrued;   // timestamp
    }

    // user => token => Loan
    mapping(address => mapping(address => Loan)) public loans;

    modifier onlyAdmin() {
        require(msg.sender == admin, "only admin");
        _;
    }

    constructor(address feed) {
        priceFeed = IPriceFeed(feed);
        admin = msg.sender;
    }

    // =========================================================
    // Admin / Token configuration
    // =========================================================

    /**
     * @dev Add/enable a token in the pool. Keep lendRateWad for future use.
     */
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
            totalDeposits: 0,
            enabled: true
        });
        supportedTokens.push(tokenAddr);
    }

    /**
     * @dev Seed liquidity from admin.
     */
    function adminDeposit(address tokenAddr, uint256 amt) external onlyAdmin {
        TokenConfig storage cfg = configs[tokenAddr];
        require(cfg.enabled, "token disabled");
        cfg.token.transferFrom(msg.sender, address(this), amt);
        cfg.totalDeposits += amt;
    }

    // =========================================================
    // User actions: deposit / withdraw
    // =========================================================

    /**
     * @notice Deposit token as liquidity. Also counts as collateral (USD-valued).
     */
    function deposit(address tokenAddr, uint256 amount) external {
        TokenConfig storage cfg = configs[tokenAddr];
        require(cfg.enabled, "token disabled");
        require(amount > 0, "zero");

        cfg.token.transferFrom(msg.sender, address(this), amount);

        deposits[msg.sender][tokenAddr] += amount;
        cfg.totalDeposits += amount;
    }

    /**
     * @notice Withdraw deposited token, only if after-withdraw collateral still supports outstanding loans.
     */
    function withdraw(address tokenAddr, uint256 amount) external {
        TokenConfig storage cfg = configs[tokenAddr];
        require(cfg.enabled, "token disabled");
        require(amount > 0, "zero");
        require(deposits[msg.sender][tokenAddr] >= amount, "not enough deposit");
        require(cfg.totalDeposits >= amount, "no liquidity");

        // Collateral safety check (in USD terms)
        uint256 beforeCollateralUSD = getUserCollateralUSD(msg.sender);

        uint256 p = priceFeed.getPrice(cfg.symbol); // price * 100
        uint256 withdrawUSD = (amount * p) / 100;

        require(withdrawUSD <= beforeCollateralUSD, "collateral underflow");
        uint256 afterCollateralUSD = beforeCollateralUSD - withdrawUSD;

        uint256 debtUSD = getUserTotalLoanUSD(msg.sender);
        uint256 afterLimitUSD = (afterCollateralUSD * borrowFactor) / 100;

        // Ensure after-withdrawal collateral still satisfies borrow limit
        require(debtUSD <= afterLimitUSD, "would break collateral limit");

        // State updates & transfer
        deposits[msg.sender][tokenAddr] -= amount;
        cfg.totalDeposits -= amount;
        cfg.token.transfer(msg.sender, amount);
    }

    // =========================================================
    // Collateral / Loan valuation helpers (USD)
    // =========================================================

    /**
     * @notice Sum of all user's deposits in USD (*100), by price feed.
     */
    function getUserCollateralUSD(address user) public view returns (uint256 totalUSD) {
        for (uint i = 0; i < supportedTokens.length; i++) {
            address tokenAddr = supportedTokens[i];
            TokenConfig storage cfg = configs[tokenAddr];

            uint256 bal = deposits[user][tokenAddr];
            if (bal == 0) continue;

            uint256 px = priceFeed.getPrice(cfg.symbol); // price * 100
            totalUSD += (bal * px) / 100;
        }
    }

    /**
     * @notice Sum of all user's loans (principal + accrued interest) in USD (*100).
     */
    function getUserTotalLoanUSD(address user) public view returns (uint256 totalUSD) {
        for (uint i = 0; i < supportedTokens.length; i++) {
            address tokenAddr = supportedTokens[i];
            Loan storage l = loans[user][tokenAddr];
            if (l.principal == 0 && l.accInterest == 0) continue;

            TokenConfig storage cfg = configs[tokenAddr];
            uint256 px = priceFeed.getPrice(cfg.symbol); // price * 100

            uint256 owed = l.principal + l.accInterest;
            totalUSD += (owed * px) / 100;
        }
    }

    /**
     * @notice Borrowing power in USD (*100).
     */
    function getBorrowLimitUSD(address user) public view returns (uint256) {
        return (getUserCollateralUSD(user) * borrowFactor) / 100;
    }

    /**
     * @notice Health factor (percentage, 100 = at limit). Returns max uint if no debt.
     */
    function getHealthFactor(address user) external view returns (uint256) {
        uint256 debt = getUserTotalLoanUSD(user);
        if (debt == 0) return type(uint256).max;
        uint256 limit = getBorrowLimitUSD(user);
        return (limit * 100) / debt;
    }

    // =========================================================
    // Interest accrual  (FIXED)
    // =========================================================

    function _accrueInterest(address borrower, address tokenAddr) internal {
        Loan storage loan = loans[borrower][tokenAddr];

        // If there is no principal, just set the anchor and return
        if (loan.principal == 0) {
            loan.lastAccrued = block.timestamp;
            return;
        }

        // Use prior anchor if any; otherwise start now
        uint256 last = loan.lastAccrued;
        if (last == 0) {
            last = block.timestamp;
        }

        // If called in the same block as anchor, skip
        if (block.timestamp <= last) {
            return;
        }

        uint256 elapsed = block.timestamp - last;
        TokenConfig storage cfg = configs[tokenAddr];
        uint256 secondsPerYear = 365 * 24 * 3600;

        // interest = principal * annualRate * elapsed / year (all in integer math)
        uint256 interest = (loan.principal * cfg.borrowRateWad / WAD) * elapsed / secondsPerYear;

        loan.accInterest += interest;
        loan.lastAccrued = block.timestamp;
    }

    // =========================================================
    // Borrow / Repay
    // =========================================================

    /**
     * @notice Borrow token if total borrow value stays within the user's borrow limit.
     */
    function borrow(address tokenAddr, uint256 amount) external {
        TokenConfig storage cfg = configs[tokenAddr];
        require(cfg.enabled, "token disabled");
        require(amount > 0, "zero borrow");
        require(cfg.totalDeposits >= amount, "no liquidity");

        _accrueInterest(msg.sender, tokenAddr);

        // USD valuation for requested borrow
        uint256 px = priceFeed.getPrice(cfg.symbol); // price * 100
        uint256 borrowUSD = (amount * px) / 100;

        // Check capacity: existing debt + new borrow <= limit
        uint256 currentDebtUSD = getUserTotalLoanUSD(msg.sender);
        uint256 limitUSD = getBorrowLimitUSD(msg.sender);
        require(currentDebtUSD + borrowUSD <= limitUSD, "insufficient collateral");

        // state changes
        loans[msg.sender][tokenAddr].principal += amount;
        loans[msg.sender][tokenAddr].lastAccrued = block.timestamp;

        cfg.totalDeposits -= amount;
        cfg.token.transfer(msg.sender, amount);
    }

    /**
     * @notice Repay owed amount in the borrowed token. Pays interest first, then principal.
     *         Any leftover is treated as a fresh deposit.
     */
    function repay(address tokenAddr, uint256 amount) external {
        require(amount > 0, "zero repay");

        Loan storage loan = loans[msg.sender][tokenAddr];
        require(loan.principal > 0 || loan.accInterest > 0, "no debt");

        TokenConfig storage cfg = configs[tokenAddr];

        _accrueInterest(msg.sender, tokenAddr);

        cfg.token.transferFrom(msg.sender, address(this), amount);

        // pay interest first
        if (amount >= loan.accInterest) {
            amount -= loan.accInterest;
            loan.accInterest = 0;
        } else {
            loan.accInterest -= amount;
            return;
        }

        // then principal
        if (amount >= loan.principal) {
            amount -= loan.principal;
            loan.principal = 0;
        } else {
            loan.principal -= amount;
            amount = 0;
        }

        // leftover becomes user's deposit (adds liquidity)
        if (amount > 0) {
            deposits[msg.sender][tokenAddr] += amount;
            configs[tokenAddr].totalDeposits += amount;
        }

        loan.lastAccrued = block.timestamp;
    }

    // =========================================================
    // Views
    // =========================================================

    function getDeposit(address user, address tokenAddr) external view returns (uint256) {
        return deposits[user][tokenAddr];
    }

    function getLoan(address user, address tokenAddr)
        external
        view
        returns (uint256 principal, uint256 interest, uint256 lastAccrued)
    {
        Loan storage l = loans[user][tokenAddr];
        return (l.principal, l.accInterest, l.lastAccrued);
    }

    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }
}
