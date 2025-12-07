const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LendingPool – Deep Tests (Final Stable Version)", function () {

  let deployer, user1, user2;
  let priceFeed, pool;
  let tokens = {};

  const WAD = ethers.constants.WeiPerEther;
  const secondsPerYear = ethers.BigNumber.from(365 * 24 * 3600);

  const toWei = (n) => ethers.utils.parseUnits(n.toString(), 18);

  beforeEach(async () => {

    [deployer, user1, user2] = await ethers.getSigners();

    const PriceFeed = await ethers.getContractFactory("PriceFeed");
    const ERC20Token = await ethers.getContractFactory("ERC20Token");
    const LendingPool = await ethers.getContractFactory("LendingPool");

    priceFeed = await PriceFeed.deploy();
    await priceFeed.deployed();

    // Deploy tokens
    tokens.BTC  = await ERC20Token.deploy("Bitcoin", "BTC",  toWei(1000));
    tokens.ETH  = await ERC20Token.deploy("Ethereum", "ETH", toWei(100000));
    tokens.USDT = await ERC20Token.deploy("Tether", "USDT",  toWei(10000000));
    tokens.BNB  = await ERC20Token.deploy("BNB", "BNB",      toWei(500000));
    tokens.SUI  = await ERC20Token.deploy("Sui", "SUI",      toWei(5000000));

    for (const t of Object.values(tokens)) await t.deployed();

    pool = await LendingPool.deploy(priceFeed.address);
    await pool.deployed();

    // Map for priceFeed keys
    const feedKey = {
      BTC: "bitcoin",
      ETH: "ethereum",
      USDT: "tether",
      BNB: "binancecoin",
      SUI: "sui",
    };

    const ratios = {
      BTC: { lend: 1, borrow: 3 },
      ETH: { lend: 3, borrow: 5 },
      USDT: { lend: 5, borrow: 9 },
      BNB: { lend: 2, borrow: 4 },
      SUI: { lend: 4, borrow: 10 },
    };

    const baseRate = ethers.BigNumber.from("10000000000000000");

    for (const sym of Object.keys(ratios)) {
      await pool.addToken(
        tokens[sym].address,
        feedKey[sym],
        baseRate.mul(ratios[sym].lend),
        baseRate.mul(ratios[sym].borrow)
      );
    }

    // Seed liquidity
    for (const sym of Object.keys(tokens)) {
      const t = tokens[sym];
      const supply = await t.totalSupply();
      const tenPct = supply.div(10);
      await t.approve(pool.address, tenPct);
      await pool.adminDeposit(t.address, tenPct);
    }

    // PriceFeed values (USD * 100)
    await priceFeed.updatePrice("bitcoin",     6000000);
    await priceFeed.updatePrice("ethereum",     300000);
    await priceFeed.updatePrice("tether",           100);
    await priceFeed.updatePrice("binancecoin",    40000);
    await priceFeed.updatePrice("sui",              200);
  });

  // ------------------- TEST CASES ----------------------

  it("deploys properly and seeds liquidity", async () => {
    for (const sym of Object.keys(tokens)) {
      const token = tokens[sym];
      const cfg = await pool.configs(token.address);
      const supply = await token.totalSupply();
      expect(cfg.totalDeposits).to.equal(supply.div(10));
    }
  });

  it("deposit increases balances", async () => {
    const token = tokens.ETH;
    const amt = toWei(10);

    await token.transfer(user1.address, amt);
    await token.connect(user1).approve(pool.address, amt);

    await pool.connect(user1).deposit(token.address, amt);

    expect(await pool.getDeposit(user1.address, token.address)).to.equal(amt);
    expect(await token.balanceOf(user1.address)).to.equal(0);
  });

  it("withdraw works", async () => {
    const token = tokens.ETH;
    const amt = toWei(5);

    await token.transfer(user1.address, amt);
    await token.connect(user1).approve(pool.address, amt);

    await pool.connect(user1).deposit(token.address, amt);

    const w = toWei(3);
    await pool.connect(user1).withdraw(token.address, w);

    expect(await pool.getDeposit(user1.address, token.address))
      .to.equal(amt.sub(w));

    expect(await token.balanceOf(user1.address)).to.equal(w);
  });

  it("borrow succeeds with enough collateral", async () => {
    await tokens.USDT.transfer(user1.address, toWei(50000));
    await tokens.USDT.connect(user1).approve(pool.address, toWei(50000));
    await pool.connect(user1).deposit(tokens.USDT.address, toWei(50000));

    const token = tokens.BTC;
    const amt = toWei(0.1);

    const before = (await pool.configs(token.address)).totalDeposits;

    await pool.connect(user1).borrow(token.address, amt);

    const after = (await pool.configs(token.address)).totalDeposits;

    expect(after).to.equal(before.sub(amt));
  });

  it("borrow fails if collateral insufficient", async () => {
    await tokens.USDT.transfer(user2.address, toWei(1));
    await tokens.USDT.connect(user2).approve(pool.address, toWei(1));
    await pool.connect(user2).deposit(tokens.USDT.address, toWei(1));

    const token = tokens.ETH;
    const amt = toWei(1);

    await expect(
      pool.connect(user2).borrow(token.address, amt)
    ).to.be.revertedWith("insufficient collateral");
  });

  // ---------------- FIXED INTEREST TEST ----------------
  // Repay LESS than accrued interest so interest remains > 0 after repay.
  it("interest accrues & small repayment reduces interest first", async () => {
    const token = tokens.SUI;
    const amt = toWei(100);

    // Add collateral (big enough)
    await tokens.USDT.transfer(user1.address, toWei(50000));
    await tokens.USDT.connect(user1).approve(pool.address, toWei(50000));
    await pool.connect(user1).deposit(tokens.USDT.address, toWei(50000));

    await pool.connect(user1).borrow(token.address, amt);

    // Move 30 days
    const thirtyDays = 30 * 24 * 3600;
    await ethers.provider.send("evm_increaseTime", [thirtyDays]);
    await ethers.provider.send("evm_mine", []);

    // Compute expected interest so we repay LESS than it
    const cfg = await pool.configs(token.address);
    const expectedInterest =
      amt.mul(cfg.borrowRateWad).div(WAD)
         .mul(thirtyDays).div(secondsPerYear);

    // Choose repay = half of expected interest (at least 1e12 wei to avoid zero)
    let repayAmt = expectedInterest.div(2);
    const minDust = ethers.BigNumber.from("1000000000000"); // 1e12
    if (repayAmt.lt(minDust)) repayAmt = minDust;

    // Fund & approve repay
    await token.transfer(user1.address, repayAmt);
    await token.connect(user1).approve(pool.address, repayAmt);

    // Repay less than accrued interest → interest should remain > 0
    await pool.connect(user1).repay(token.address, repayAmt);

    const loanAfter = await pool.getLoan(user1.address, token.address);
    const principalAfter = loanAfter[0];
    const interestAfter  = loanAfter[1];

    // interest accrued and not fully cleared
    expect(interestAfter).to.be.gt(0);
    expect(interestAfter).to.be.lt(expectedInterest);

    // principal should remain equal to original (we only paid interest)
    expect(principalAfter).to.equal(amt);
  });

  // ---------------- FULL REPAY TEST --------------------

  it("full repayment clears loan", async () => {
    const token = tokens.BNB;
    const amt = toWei(10);

    await tokens.USDT.transfer(user1.address, toWei(20000));
    await tokens.USDT.connect(user1).approve(pool.address, toWei(20000));
    await pool.connect(user1).deposit(tokens.USDT.address, toWei(20000));

    await pool.connect(user1).borrow(token.address, amt);

    // Move 7 days
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);

    const cfg = await pool.configs(token.address);

    const expectedInterest =
      amt.mul(cfg.borrowRateWad).div(WAD)
         .mul(7 * 24 * 3600).div(secondsPerYear);

    const repayAmount = amt.add(expectedInterest).add(toWei(1));

    await token.transfer(user1.address, repayAmount);
    await token.connect(user1).approve(pool.address, repayAmount);

    await pool.connect(user1).repay(token.address, repayAmount);

    const loan = await pool.getLoan(user1.address, token.address);

    const principal = loan[0];
    const interest  = loan[1];

    expect(principal).to.equal(0);
    expect(interest).to.equal(0);
  });

  it("non-admin cannot adminDeposit", async () => {
    const token = tokens.ETH;
    const tenPct = (await token.totalSupply()).div(10);

    await token.transfer(user1.address, tenPct);
    await token.connect(user1).approve(pool.address, tenPct);

    await expect(
      pool.connect(user1).adminDeposit(token.address, tenPct)
    ).to.be.revertedWith("only admin");
  });

  it("price spike blocks borrowing", async () => {
    await tokens.USDT.transfer(user1.address, toWei(50000));
    await tokens.USDT.connect(user1).approve(pool.address, toWei(50000));
    await pool.connect(user1).deposit(tokens.USDT.address, toWei(50000));

    const token = tokens.BTC;
    const amt = toWei(0.5);

    await pool.connect(user1).borrow(token.address, amt);

    const price = await priceFeed.getPrice("bitcoin");
    await priceFeed.updatePrice("bitcoin", price.mul(10));

    await tokens.USDT.transfer(user2.address, toWei(50000));
    await tokens.USDT.connect(user2).approve(pool.address, toWei(50000));
    await pool.connect(user2).deposit(tokens.USDT.address, toWei(50000));

    await expect(
      pool.connect(user2).borrow(token.address, amt)
    ).to.be.revertedWith("insufficient collateral");
  });

});
