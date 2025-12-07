// scripts/deploy.js
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // -------------------------------------------------------------
  // 1) Deploy PriceFeed
  // -------------------------------------------------------------
  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await PriceFeed.deploy();
  await priceFeed.deployed();
  console.log("PriceFeed deployed at:", priceFeed.address);

  // -------------------------------------------------------------
  // 2) Deploy ERC20 Tokens
  // -------------------------------------------------------------
  const ERC20Token = await ethers.getContractFactory("ERC20Token");

  const DECIMALS = ethers.BigNumber.from("10").pow(18);

  const tokenMeta = [
    { symbol: "BTC",  name: "Bitcoin Token", supply: "1000",     priceKey: "bitcoin" },
    { symbol: "ETH",  name: "Ethereum Token", supply: "100000",  priceKey: "ethereum" },
    { symbol: "USDT", name: "Tether Token",   supply: "10000000", priceKey: "tether" },
    { symbol: "BNB",  name: "Binance Token",  supply: "500000",  priceKey: "binancecoin" },
    { symbol: "SUI",  name: "Sui Token",      supply: "5000000", priceKey: "sui" },
  ];

  const deployedTokens = {};

  for (const t of tokenMeta) {
    const supply = ethers.BigNumber.from(t.supply).mul(DECIMALS);

    const token = await ERC20Token.deploy(t.name, t.symbol, supply);
    await token.deployed();

    deployedTokens[t.symbol] = token;

    console.log(`${t.symbol} deployed at ${token.address}`);
  }

  // -------------------------------------------------------------
  // 3) Deploy LendingPool
  // -------------------------------------------------------------
  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(priceFeed.address);
  await pool.deployed();

  console.log("LendingPool deployed at:", pool.address);

  // -------------------------------------------------------------
  // 4) Configure tokens inside pool (lendRateWad unused but needed)
  // -------------------------------------------------------------
  const baseRate = ethers.BigNumber.from("10000000000000000"); // 0.01 * 1e18 = 1% APR

  const ratios = {
    BTC: { lend: 1, borrow: 3 },
    ETH: { lend: 3, borrow: 5 },
    USDT: { lend: 5, borrow: 9 },
    BNB: { lend: 2, borrow: 4 },
    SUI: { lend: 4, borrow: 10 },
  };

  for (const t of tokenMeta) {
    const lendRate = baseRate.mul(ratios[t.symbol].lend);
    const borrowRate = baseRate.mul(ratios[t.symbol].borrow);

    await pool.addToken(
      deployedTokens[t.symbol].address,
      t.priceKey,
      lendRate,
      borrowRate
    );

    console.log(`Added token ${t.symbol} with priceKey=${t.priceKey}`);
  }

  // -------------------------------------------------------------
  // 5) Seed 10% initial liquidity to the pool
  // -------------------------------------------------------------
  for (const t of tokenMeta) {
    const token = deployedTokens[t.symbol];
    const supply = ethers.BigNumber.from(t.supply).mul(DECIMALS);
    const tenPct = supply.div(10); // 10% liquidity

    await token.approve(pool.address, tenPct);
    await pool.adminDeposit(token.address, tenPct);

    console.log(`Seeded liquidity: ${t.symbol} → ${tenPct.toString()}`);
  }

  // -------------------------------------------------------------
  // 6) Set initial price feed values (USD × 100)
  // -------------------------------------------------------------
  await priceFeed.updatePrice("bitcoin",      6000000);
  await priceFeed.updatePrice("ethereum",      300000);
  await priceFeed.updatePrice("tether",            100);
  await priceFeed.updatePrice("binancecoin",     40000);
  await priceFeed.updatePrice("sui",               200);

  console.log("Price feed initialized.");

  console.log("\n🎉 Deployment completed successfully!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
