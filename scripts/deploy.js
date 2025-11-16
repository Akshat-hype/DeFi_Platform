// scripts/deploy.js
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // 1) Deploy PriceFeed
  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await PriceFeed.deploy();
  await priceFeed.deployed();
  console.log("PriceFeed:", priceFeed.address);

  // 2) Deploy ERC20 tokens (supply scaled to 18 decimals)
  const ERC20Token = await ethers.getContractFactory("ERC20Token");

  const decimals = ethers.BigNumber.from("10").pow("18");
  const tokensToDeploy = [
    { name: "BitcoinToken", symbol: "BTC", supply: "1000" },
    { name: "EthereumToken", symbol: "ETH", supply: "100000" },
    { name: "TetherToken", symbol: "USDT", supply: "10000000" },
    { name: "BinanceToken", symbol: "BNB", supply: "500000" },
    { name: "SuiToken", symbol: "SUI", supply: "5000000" },
  ];

  const deployed = {};
  for (const t of tokensToDeploy) {
    const supply = ethers.BigNumber.from(t.supply).mul(decimals);
    const token = await ERC20Token.deploy(t.name, t.symbol, supply);
    await token.deployed();
    console.log(`${t.symbol} deployed at ${token.address}, supply ${t.supply}`);
    deployed[t.symbol] = token;
  }

  // 3) Deploy LendingPool
  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(priceFeed.address);
  await pool.deployed();
  console.log("LendingPool:", pool.address);

  // 4) Configure tokens in pool with rates derived from ratios
  // Ratios you specified: (lend:borrow)
  const ratios = {
    BTC: { lend: 1, borrow: 3 },
    ETH: { lend: 3, borrow: 5 },
    USDT: { lend: 5, borrow: 9 },
    BNB: { lend: 2, borrow: 4 },
    SUI: { lend: 4, borrow: 10 }
  };

  // base rate = 1% (you can change)
  const baseRate = ethers.BigNumber.from("10000000000000000"); 
// = 0.01 * 1e18 = 1e16 (WAD representation)

for (const sym of Object.keys(ratios)) {
  const r = ratios[sym];

  const lendRateWad = baseRate.mul(r.lend);
  const borrowRateWad = baseRate.mul(r.borrow);

  await pool.addToken(
    deployed[sym].address,
    sym.toLowerCase(),
    lendRateWad,
    borrowRateWad
  );

  console.log(`Configured ${sym} - lendRateWad: ${lendRateWad.toString()}, borrowRateWad: ${borrowRateWad.toString()}`);
}


  // set collateral token to USDT
  await (await pool.setCollateral(deployed["USDT"].address, "tether")).wait();
  console.log("Set collateral token -> USDT");

  // 5) Transfer 10% of each token supply to pool as initial liquidity
  for (const t of tokensToDeploy) {
    const token = deployed[t.symbol];
    const supply = ethers.BigNumber.from(t.supply).mul(decimals);
    const tenPct = supply.div(10);
    // approve and adminDeposit (pool expects admin transferFrom in adminDeposit)
    // pool.adminDeposit requires admin (deployer) to have approved
    await token.approve(pool.address, tenPct);
    const tx = await pool.adminDeposit(token.address, tenPct);
    await tx.wait();
    console.log(`Transferred 10% of ${t.symbol} (${tenPct.toString()}) to pool.`);
  }

  console.log("Deployment finished.");
}

main().catch((e) => { console.error(e); process.exit(1); });
