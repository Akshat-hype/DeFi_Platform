const { expect } = require("chai");
const { ethers } = require("hardhat");

const DECIMALS = 18;
const toUnits = (n) => ethers.utils.parseUnits(n, DECIMALS);
const fromUnits = (n) => parseFloat(ethers.utils.formatUnits(n, DECIMALS));

describe("Borrowing flow (LTV-based)", function () {
  let deployer, user1, user2;
  let PriceFeed, IRM, Pool, BTC, ETH, USDT;

  beforeEach(async function () {
    [deployer, user1, user2] = await ethers.getSigners();

    // Deploy PriceFeed
    const PF = await ethers.getContractFactory("PriceFeed");
    PriceFeed = await PF.deploy();
    await PriceFeed.deployed();

    // Deploy IRM
    const IRMFactory = await ethers.getContractFactory("InterestRateModel");
    IRM = await IRMFactory.deploy();
    await IRM.deployed();

    // Deploy Mock tokens (distribute all to deployer initially)
    const Mock = await ethers.getContractFactory("MockToken");
    BTC = await Mock.deploy("Bitcoin", "BTC", toUnits("1000"), deployer.address);
    ETH = await Mock.deploy("Ethereum", "ETH", toUnits("100000"), deployer.address);
    USDT = await Mock.deploy("Tether USD", "USDT", toUnits("10000000"), deployer.address);

    await Promise.all([BTC.deployed(), ETH.deployed(), USDT.deployed()]);

    // Deploy LendingPool
    const PoolFactory = await ethers.getContractFactory("LendingPool");
    Pool = await PoolFactory.deploy(IRM.address, PriceFeed.address);
    await Pool.deployed();

    // Configure fees (same as earlier)
    await IRM.setFees(BTC.address, 100, 300); // 1% dep, 3% wdr
    await IRM.setFees(ETH.address, 300, 500);
    await IRM.setFees(USDT.address, 500, 900);

    // Link tokens to pool
    await Pool.setTokenSymbol(BTC.address, "bitcoin");
    await Pool.setTokenSymbol(ETH.address, "ethereum");
    await Pool.setTokenSymbol(USDT.address, "tether");

    // Seed pool: transfer some tokens to pool (simulate seed/deployer deposit)
    // We'll transfer 1000 USDT to pool to ensure liquidity for borrowing
    await USDT.transfer(Pool.address, toUnits("1000"));

    // Transfer collateral to user1 for testing: 1 BTC
    await BTC.transfer(user1.address, toUnits("1"));

    // Set oracle prices (price * 100)
    // BTC = $100,000 -> stored as 100000 * 100 = 10,000,000
    await PriceFeed.updatePrice("bitcoin", 10000000);
    // USDT = $1 -> 100
    await PriceFeed.updatePrice("tether", 100);
  });

  it("deposit collateral then borrow up to 70% LTV", async function () {
    // user1 deposits 1 BTC
    await BTC.connect(user1).approve(Pool.address, toUnits("1"));
    await Pool.connect(user1).deposit(BTC.address, toUnits("1"));

    // check credited amount (1% deposit fee => credited 0.99)
    const credited = await Pool.userBalances(user1.address, BTC.address);
    expect(fromUnits(credited)).to.be.closeTo(0.99, 0.0001);

    // compute total collateral USD cents
    const collateralUsdCents = await Pool.getTotalUserValueUSD(user1.address);
    // collateralUsdCents should equal 0.99 * 100000 * 100 => $99,000 -> 9,900,000 cents
    expect(collateralUsdCents.toString()).to.equal("9900000");

    // max borrow in cents = 70% => 6,930,000 cents -> $69,300
    const maxBorrowCents = collateralUsdCents.mul(7000).div(10000);

    // Borrow: request exactly maxBorrow in USDT (convert cents to token units)
    // Since USDT priceCents = 100 (1.00 * 100), token amount needed (in 1e18) is:
    // amountTokens = maxBorrowCents * 1e18 / priceCents
    const amountTokens = maxBorrowCents.mul(ethers.constants.WeiPerEther).div(100);
    // sanity: formatUnits
    const amountTokensReadable = ethers.utils.formatUnits(amountTokens, 18);

    // user1 borrows
    await expect(Pool.connect(user1).borrow(USDT.address, amountTokens))
      .to.emit(Pool, "Borrowed");

    // verify userBorrows recorded
    const debt = await Pool.userBorrows(user1.address, USDT.address);
    expect(fromUnits(debt)).to.be.closeTo(parseFloat(amountTokensReadable), 0.0001);

    // try to borrow 1 more USDT => should revert due to exceeding LTV
    await expect(
      Pool.connect(user1).borrow(USDT.address, toUnits("1"))
    ).to.be.revertedWith("EXCEEDS_BORROW_LIMIT");
  });

  it("repay debt reduces userBorrows and increases pool liquidity", async function () {
    // deposit 1 BTC and borrow a smaller amount
    await BTC.connect(user1).approve(Pool.address, toUnits("1"));
    await Pool.connect(user1).deposit(BTC.address, toUnits("1"));

    const collateralUsdCents = await Pool.getTotalUserValueUSD(user1.address);
    const maxBorrowCents = collateralUsdCents.mul(7000).div(10000);
    const amountTokens = maxBorrowCents.mul(ethers.constants.WeiPerEther).div(100);

    // borrow half of maxBorrow
    const half = amountTokens.div(2);
    await Pool.connect(user1).borrow(USDT.address, half);

    // repay a portion
    // first user must have USDT to repay. For test, transfer USDT to user1 from deployer
    await USDT.transfer(user1.address, half);

    // approve and repay
    await USDT.connect(user1).approve(Pool.address, half);
    await expect(Pool.connect(user1).repay(USDT.address, half))
      .to.emit(Pool, "Repaid");

    // debt should be zero
    const remaining = await Pool.userBorrows(user1.address, USDT.address);
    expect(remaining.toString()).to.equal("0");

    // pool liquidity should have increased by the repaid amount
    const poolBal = await USDT.balanceOf(Pool.address);
    expect(fromUnits(poolBal)).to.be.greaterThan(0);
  });
});
