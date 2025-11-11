// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amt) external returns (bool);
    function transfer(address to, uint256 amt) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IInterestRateModel {
    function getFees(address token) external view returns (uint256 depBps, uint256 wdrBps);
}

interface IPriceFeed {
    // returns price * 100 (two decimals) in USDT terms
    function getPrice(string memory symbol) external view returns (uint256);
}

contract LendingPool {
    IInterestRateModel public irm;
    IPriceFeed public priceFeed;
    address public owner;

    // token => symbol string for oracle lookup
    mapping(address => string) public tokenSymbol;

    // bookkeeping arrays to iterate tokens
    address[] public supportedTokens;

    // accounting: user deposited balances (credited after deposit fee)
    mapping(address => mapping(address => uint256)) public userBalances;

    // accounting: user borrows per token
    mapping(address => mapping(address => uint256)) public userBorrows;

    // constants
    uint256 public constant SCALE = 1e18;
    uint256 public constant LTV_BPS = 7000; // 70% LTV

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    event Deposited(address indexed user, address indexed token, uint256 amount, uint256 fee, uint256 credited);
    event Withdrawn(address indexed user, address indexed token, uint256 amount, uint256 fee, uint256 paidOut);
    event Borrowed(address indexed user, address indexed token, uint256 amount, uint256 usdCents);
    event Repaid(address indexed user, address indexed token, uint256 amount);

    constructor(IInterestRateModel _irm, IPriceFeed _pf) {
        irm = _irm;
        priceFeed = _pf;
        owner = msg.sender;
    }

    function setTokenSymbol(address token, string calldata symbol) external onlyOwner {
        // if not previously added, add to supportedTokens for enumeration
        if (bytes(tokenSymbol[token]).length == 0) {
            supportedTokens.push(token);
        }
        tokenSymbol[token] = symbol;
    }

    // deposit: user must approve token amount to pool first
    function deposit(address token, uint256 amount) external {
        require(amount > 0, "AMT_ZERO");
        (uint256 depBps, ) = irm.getFees(token);
        uint256 fee = (amount * depBps) / 10000;
        uint256 credited = amount - fee;

        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "TRANSFER_FAIL");

        userBalances[msg.sender][token] += credited;

        emit Deposited(msg.sender, token, amount, fee, credited);
    }

    function withdraw(address token, uint256 amount) external {
        require(amount > 0, "AMT_ZERO");
        uint256 bal = userBalances[msg.sender][token];
        require(bal >= amount, "INSUFFICIENT_BAL");

        (, uint256 wdrBps) = irm.getFees(token);
        uint256 fee = (amount * wdrBps) / 10000;
        uint256 sendOut = amount - fee;

        userBalances[msg.sender][token] = bal - amount;

        require(IERC20(token).transfer(msg.sender, sendOut), "SEND_FAIL");

        emit Withdrawn(msg.sender, token, amount, fee, sendOut);
    }

    // ===== Borrowing logic =====

    /// @notice Borrow `amount` of `token` if user has sufficient collateral (LTV)
    function borrow(address token, uint256 amount) external {
        require(amount > 0, "AMT_ZERO");
        require(bytes(tokenSymbol[token]).length > 0, "TOKEN_UNSUPPORTED");

        // compute user's total collateral value in USD cents (price *100)
        uint256 totalCollateralUsdCents = getTotalUserValueUSD(msg.sender);

        // maximum allowed to borrow in USD cents
        uint256 maxBorrowUsdCents = (totalCollateralUsdCents * LTV_BPS) / 10000;

        // compute currently borrowed value in USD cents
        uint256 currentBorrowedUsdCents = getTotalBorrowedValueUSD(msg.sender);

        // compute this requested borrow's USD cents
        string memory sym = tokenSymbol[token];
        uint256 priceCents = priceFeed.getPrice(sym); // price * 100
        uint256 borrowUsdCents = (amount * priceCents) / SCALE;

        require(currentBorrowedUsdCents + borrowUsdCents <= maxBorrowUsdCents, "EXCEEDS_BORROW_LIMIT");

        // transfer the token to borrower (pool must have liquidity)
        require(IERC20(token).transfer(msg.sender, amount), "TRANSFER_FAIL");

        // record the borrow
        userBorrows[msg.sender][token] += amount;

        emit Borrowed(msg.sender, token, amount, borrowUsdCents);
    }

    /// @notice Repay `amount` of borrowed `token`
    function repay(address token, uint256 amount) external {
        require(amount > 0, "AMT_ZERO");
        uint256 debt = userBorrows[msg.sender][token];
        require(debt > 0, "NO_DEBT");

        uint256 pay = amount > debt ? debt : amount;

        require(IERC20(token).transferFrom(msg.sender, address(this), pay), "TRANSFER_FAIL");

        userBorrows[msg.sender][token] = debt - pay;

        emit Repaid(msg.sender, token, pay);
    }

    // ===== Views & Helpers =====

    // returns price *100 for given token (requires tokenSymbol set)
    function priceFor(address token) public view returns (uint256) {
        string memory sym = tokenSymbol[token];
        require(bytes(sym).length > 0, "UNLISTED");
        return priceFeed.getPrice(sym);
    }

    // total USD cents value of a specific user's deposits across all supported tokens
    function getTotalUserValueUSD(address user) public view returns (uint256 totalUsdCents) {
        uint256 len = supportedTokens.length;
        for (uint256 i = 0; i < len; i++) {
            address t = supportedTokens[i];
            uint256 bal = userBalances[user][t];
            if (bal == 0) continue;
            uint256 priceCents = priceFeed.getPrice(tokenSymbol[t]); // price *100
            // bal (1e18) * priceCents -> scaled by 1e18, divide to get cents
            totalUsdCents += (bal * priceCents) / SCALE;
        }
    }

    // total USD cents value of a user's borrows across all tokens
    function getTotalBorrowedValueUSD(address user) public view returns (uint256 borrowedUsdCents) {
        uint256 len = supportedTokens.length;
        for (uint256 i = 0; i < len; i++) {
            address t = supportedTokens[i];
            uint256 debt = userBorrows[user][t];
            if (debt == 0) continue;
            uint256 priceCents = priceFeed.getPrice(tokenSymbol[t]);
            borrowedUsdCents += (debt * priceCents) / SCALE;
        }
    }

    // pool liquidity for a token
    function getPoolLiquidity(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // simple helper to fetch list of supported tokens
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }
}
