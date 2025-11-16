const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LendingPool - deep tests", function () {
  let deployer, user1, user2;
  let PriceFeed, ERC20Token, LendingPool;
  let priceFeed, tokens, pool;
  const DECIMALS = 18;
  const WAD = ethers.BigNumber.from("10").pow(18);
  const secondsPerYear = 365 * 24 * 3600;

  const toWei = (n) => ethers.utils.parseUnits(n.toString(), DECIMALS);
  const fromWei = (bn) => ethers.utils.formatUnits(bn, DECIMALS);

  beforeEach(async () => {
    [deployer, user1, user2] = await ethers.getSigners();

    PriceFeed = await ethers.getContractFactory("PriceFeed");
    ERC20Token = await ethers.getContractFactory("ERC20Token");
    LendingPool = await ethers.getContractFactory("LendingPool");

    priceFeed = await PriceFeed.deploy();
    await priceFeed.deployed();

    tokens = {};
    tokens.BTC = await ERC20Token.deploy("BitcoinToken", "BTC", ethers.BigNumber.from("1000").mul(toWei(1)));
    tokens.ETH = await ERC20Token.deploy("EthereumToken", "ETH", ethers.BigNumber.from("100000").mul(toWei(1)));
    tokens.USDT = await ERC20Token.deploy("TetherToken", "USDT", ethers.BigNumber.from("10000000").mul(toWei(1)));
    tokens.BNB = await ERC20Token.deploy("BinanceToken", "BNB", ethers.BigNumber.from("500000").mul(toWei(1)));
    tokens.SUI = await ERC20Token.deploy("SuiToken", "SUI", ethers.BigNumber.from("5000000").mul(toWei(1)));

    await tokens.BTC.deployed();
    await tokens.ETH.deployed();
    await tokens.USDT.deployed();
    await tokens.BNB.deployed();
    await tokens.SUI.deployed();

    pool = await LendingPool.deploy(priceFeed.address);
    await pool.deployed();

    // Rates
    const ratios = {
      BTC: { lend: 1, borrow: 3 },
      ETH: { lend: 3, borrow: 5 },
      USDT: { lend: 5, borrow: 9 },
      BNB: { lend: 2, borrow: 4 },
      SUI: { lend: 4, borrow: 10 }
    };

    const baseRate = ethers.BigNumber.from("10000000000000000"); // 0.01 WAD

    for (const sym of Object.keys(ratios)) {
      const r = ratios[sym];

      const lendRateWad = baseRate.mul(r.lend);
      const borrowRateWad = baseRate.mul(r.borrow);

      let priceFeedKey;
      if (sym === "BTC") priceFeedKey = "bitcoin";
      if (sym === "ETH") priceFeedKey = "ethereum";
      if (sym === "USDT") priceFeedKey = "tether";
      if (sym === "BNB") priceFeedKey = "binancecoin";
      if (sym === "SUI") priceFeedKey = "sui";

      await pool.addToken(tokens[sym].address, priceFeedKey, lendRateWad, borrowRateWad);
    }

    await pool.setCollateral(tokens.USDT.address, "tether");

    // Seed initial liquidity: 10%
    for (const sym of Object.keys(tokens)) {
      const token = tokens[sym];
      const supply = await token.totalSupply();
      const tenPct = supply.div(10);

      await token.approve(pool.address, tenPct);
      await pool.adminDeposit(token.address, tenPct);
    }

    // Prices in USDT * 100
    await priceFeed.updatePrice("bitcoin", 6000000);   // 60000*100
    await priceFeed.updatePrice("ethereum", 300000);   // 3000*100
    await priceFeed.updatePrice("tether", 100);        // 1*100
    await priceFeed.updatePrice("binancecoin", 40000); // 400*100
    await priceFeed.updatePrice("sui", 200);           // 2*100
  });

  it("deploys properly and seeds 10% initial liquidity", async function () {
    for (const sym of Object.keys(tokens)) {
      const token = tokens[sym];
      const cfg = await pool.configs(token.address);
      const supply = await token.totalSupply();
      expect(cfg.totalDeposits).to.equal(supply.div(10));
    }
  });

  it("deposit increases user's deposit and decreases their token balance", async function () {
    const token = tokens.ETH;
    const amount = toWei("10");
    await token.transfer(user1.address, amount);

    await token.connect(user1).approve(pool.address, amount);
    await pool.connect(user1).deposit(token.address, amount);

    expect(await pool.getDeposit(user1.address, token.address)).to.equal(amount);
    expect(await token.balanceOf(user1.address)).to.equal(0);
  });

  it("withdraw returns funds and updates pool totals", async function () {
    const token = tokens.ETH;
    const amount = toWei("5");
    await token.transfer(user1.address, amount);

    await token.connect(user1).approve(pool.address, amount);
    await pool.connect(user1).deposit(token.address, amount);

    const withdrawAmt = toWei("3");
    await pool.connect(user1).withdraw(token.address, withdrawAmt);

    const remaining = amount.sub(withdrawAmt);
    expect(await pool.getDeposit(user1.address, token.address)).to.equal(remaining);
    expect(await token.balanceOf(user1.address)).to.equal(withdrawAmt);
  });

  it("borrow succeeds with sufficient collateral and reduces pool liquidity", async function () {
    const borrowToken = tokens.BTC;
    const borrowAmount = toWei("0.1");

    const price = await priceFeed.getPrice("bitcoin");
    const tokenValueUsdt = borrowAmount.mul(price).div(100);
    const requiredCollateral = tokenValueUsdt.mul(2);

    await tokens.USDT.transfer(user1.address, requiredCollateral);
    await tokens.USDT.connect(user1).approve(pool.address, requiredCollateral);

    const poolDepositsBefore = (await pool.configs(borrowToken.address)).totalDeposits;
    await pool.connect(user1).borrow(borrowToken.address, borrowAmount, requiredCollateral);

    const poolDepositsAfter = (await pool.configs(borrowToken.address)).totalDeposits;

    expect(poolDepositsAfter).to.equal(poolDepositsBefore.sub(borrowAmount));
    const loan = await pool.getLoan(user1.address, borrowToken.address);
    expect(loan.principal).to.equal(borrowAmount);
  });

  it("borrow fails when collateral insufficient", async function () {
    const borrowToken = tokens.ETH;
    const borrowAmount = toWei("1");

    const price = await priceFeed.getPrice("ethereum");
    const tokenValueUsdt = borrowAmount.mul(price).div(100);

    const requiredCollateral = tokenValueUsdt.mul(2);
    const insufficient = requiredCollateral.div(4);

    await tokens.USDT.transfer(user2.address, insufficient);
    await tokens.USDT.connect(user2).approve(pool.address, insufficient);

    await expect(
      pool.connect(user2).borrow(borrowToken.address, borrowAmount, insufficient)
    ).to.be.revertedWith("insufficient collateral");
  });

  it("interest accrues over time and repay pays interest first then principal", async function () {
    const borrowToken = tokens.SUI;
    const borrowAmount = toWei("100");

    const price = await priceFeed.getPrice("sui");
    const tokenValueUsdt = borrowAmount.mul(price).div(100);
    const requiredCollateral = tokenValueUsdt.mul(2);

    await tokens.USDT.transfer(user1.address, requiredCollateral);
    await tokens.USDT.connect(user1).approve(pool.address, requiredCollateral);

    await pool.connect(user1).borrow(borrowToken.address, borrowAmount, requiredCollateral);

    const thirtyDays = 30 * 24 * 3600;
    await ethers.provider.send("evm_increaseTime", [thirtyDays]);
    await ethers.provider.send("evm_mine", []);

    const tiny = ethers.BigNumber.from("1");
    await tokens.SUI.connect(user1).approve(pool.address, tiny);
    await pool.connect(user1).repay(borrowToken.address, tiny);

    const loan = await pool.getLoan(user1.address, borrowToken.address);
    const cfg = await pool.configs(borrowToken.address);

    const borrowRateWad = cfg.borrowRateWad;
    const interestPart = borrowAmount.mul(borrowRateWad).div(WAD);
    const expectedInterest = interestPart.mul(thirtyDays).div(secondsPerYear);

    const TOL = ethers.BigNumber.from("1000000000000"); // 1e12 tolerance

    if (expectedInterest.gt(tiny)) {
      const target = expectedInterest.sub(tiny);
      const diff = loan.accInterest.gt(target)
        ? loan.accInterest.sub(target)
        : target.sub(loan.accInterest);

      expect(diff.lte(TOL), `mismatch: expected ~${target}, got ${loan.accInterest}`).to.be.true;
      expect(loan.principal).to.equal(borrowAmount);
    } else {
      expect(loan.accInterest.lte(TOL)).to.be.true;
    }
  });

  it("repay full loan reduces principal to zero and consumes interest first", async function () {
    const borrowToken = tokens.BNB;
    const borrowAmount = toWei("10");

    const price = await priceFeed.getPrice("binancecoin");
    const tokenValueUsdt = borrowAmount.mul(price).div(100);
    const requiredCollateral = tokenValueUsdt.mul(2);

    await tokens.USDT.transfer(user1.address, requiredCollateral);
    await tokens.USDT.connect(user1).approve(pool.address, requiredCollateral);

    await pool.connect(user1).borrow(borrowToken.address, borrowAmount, requiredCollateral);

    const sevenDays = 7 * 24 * 3600;
    await ethers.provider.send("evm_increaseTime", [sevenDays]);
    await ethers.provider.send("evm_mine", []);

    const cfg = await pool.configs(borrowToken.address);
    const borrowRateWad = cfg.borrowRateWad;
    const interestPart = borrowAmount.mul(borrowRateWad).div(WAD);
    const expectedInterest = interestPart.mul(sevenDays).div(secondsPerYear);

    const SAFETY = ethers.BigNumber.from("10000000000000"); // 1e13
    const repayTotal = borrowAmount.add(expectedInterest).add(SAFETY);

    await tokens.BNB.transfer(user1.address, expectedInterest.add(SAFETY));
    await tokens.BNB.connect(user1).approve(pool.address, repayTotal);

    await pool.connect(user1).repay(borrowToken.address, repayTotal);

    let loan = await pool.getLoan(user1.address, borrowToken.address);

    expect(loan.principal).to.equal(0);

    if (loan.accInterest.gt(0) && loan.accInterest.lte(SAFETY)) {
      await tokens.BNB.transfer(user1.address, loan.accInterest);
      await tokens.BNB.connect(user1).approve(pool.address, loan.accInterest);
      await pool.connect(user1).repay(borrowToken.address, loan.accInterest);
      loan = await pool.getLoan(user1.address, borrowToken.address);
    }

    expect(loan.principal).to.equal(0);
    expect(loan.accInterest).to.equal(0);
  });

  it("non-admin cannot call adminDeposit", async function () {
    const token = tokens.ETH;
    const supply = await token.totalSupply();
    const tenPct = supply.div(10);

    await token.transfer(user1.address, tenPct);
    await token.connect(user1).approve(pool.address, tenPct);

    await expect(
      pool.connect(user1).adminDeposit(token.address, tenPct)
    ).to.be.revertedWith("only admin");
  });

  it("price feed changes can make borrow attempts revert", async function () {
    const borrowToken = tokens.BTC;
    const borrowAmount = toWei("0.5");

    const priceBefore = await priceFeed.getPrice("bitcoin");
    const tokenValueBefore = borrowAmount.mul(priceBefore).div(100);
    const requiredCollateralBefore = tokenValueBefore.mul(2);

    await tokens.USDT.transfer(user1.address, requiredCollateralBefore);
    await tokens.USDT.connect(user1).approve(pool.address, requiredCollateralBefore);
    await pool.connect(user1).borrow(borrowToken.address, borrowAmount, requiredCollateralBefore);

    const highPrice = priceBefore.mul(10);
    await priceFeed.updatePrice("bitcoin", highPrice);

    await tokens.USDT.transfer(user2.address, requiredCollateralBefore);
    await tokens.USDT.connect(user2).approve(pool.address, requiredCollateralBefore);

    await expect(
      pool.connect(user2).borrow(borrowToken.address, borrowAmount, requiredCollateralBefore)
    ).to.be.revertedWith("insufficient collateral");
  });

});
