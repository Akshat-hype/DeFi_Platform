const hre = require("hardhat");
const { ethers } = hre;

const DECIMALS = 18;

// Supply configuration (human units)
const SUPPLIES = {
  BTC: "1000",        // 1,000
  ETH: "100000",      // 100,000
  BNB: "500000",      // 500,000
  USDT: "10000000",   // 10,000,000
  SUI: "5000000"      // 5,000,000
};

function toUnits(n) {
  return ethers.utils.parseUnits(n, DECIMALS);
}

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const users = rest.slice(0, 10);
  console.log(`🚀 Deploying contracts with: ${deployer.address}`);

  // 1️⃣ Deploy PriceFeed
  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await PriceFeed.deploy();
  await priceFeed.deployed();
  console.log("✅ PriceFeed deployed:", priceFeed.address);

  // 2️⃣ Deploy InterestRateModel
  const IRM = await ethers.getContractFactory("InterestRateModel");
  const irm = await IRM.deploy();
  await irm.deployed();
  console.log("✅ InterestRateModel deployed:", irm.address);

  // 3️⃣ Deploy mock tokens
  const MockToken = await ethers.getContractFactory("MockToken");

  const btc = await MockToken.deploy("Bitcoin", "BTC", toUnits(SUPPLIES.BTC), deployer.address);
  const eth = await MockToken.deploy("Ethereum", "ETH", toUnits(SUPPLIES.ETH), deployer.address);
  const bnb = await MockToken.deploy("BNB", "BNB", toUnits(SUPPLIES.BNB), deployer.address);
  const usdt = await MockToken.deploy("Tether USD", "USDT", toUnits(SUPPLIES.USDT), deployer.address);
  const sui = await MockToken.deploy("Sui", "SUI", toUnits(SUPPLIES.SUI), deployer.address);

  await Promise.all([
    btc.deployed(),
    eth.deployed(),
    bnb.deployed(),
    usdt.deployed(),
    sui.deployed(),
  ]);

  console.log("✅ Tokens deployed:");
  console.table({
    BTC: btc.address,
    ETH: eth.address,
    BNB: bnb.address,
    USDT: usdt.address,
    SUI: sui.address,
  });

  // 4️⃣ Set deposit/withdraw fees per token
  // Base deposit/withdraw fees (in basis points)
  await (await irm.setFees(btc.address, 100, 300)).wait(); // 1% dep, 3% wdr
  await (await irm.setFees(eth.address, 300, 500)).wait(); // 3% dep, 5% wdr
  await (await irm.setFees(bnb.address, 200, 400)).wait(); // 2% dep, 4% wdr
  await (await irm.setFees(usdt.address, 500, 900)).wait(); // 5% dep, 9% wdr
  await (await irm.setFees(sui.address, 400, 1000)).wait(); // 4% dep, 10% wdr
  console.log("✅ Interest rates configured for all tokens");

  // 5️⃣ Deploy LendingPool
  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(irm.address, priceFeed.address);
  await pool.deployed();
  console.log("✅ LendingPool deployed:", pool.address);

  // 6️⃣ Link tokens to symbols (for oracle lookups)
  await (await pool.setTokenSymbol(btc.address, "bitcoin")).wait();
  await (await pool.setTokenSymbol(eth.address, "ethereum")).wait();
  await (await pool.setTokenSymbol(bnb.address, "binancecoin")).wait();
  await (await pool.setTokenSymbol(usdt.address, "tether")).wait();
  await (await pool.setTokenSymbol(sui.address, "sui"));
  console.log("✅ Token symbols linked to LendingPool");

  // 7️⃣ Seed pool with 10% supply, distribute 90% to users
  async function seedAndDistribute(token, supplyHuman) {
    const total = toUnits(supplyHuman);
    const tenPercent = total.div(10);
    const ninetyPercent = total.sub(tenPercent);
    const perUser = ninetyPercent.div(users.length);

    // Approve & deposit 10% to pool
    await (await token.approve(pool.address, tenPercent)).wait();
    await (await pool.deposit(token.address, tenPercent)).wait();

    // Distribute 90% among 10 users
    for (const u of users) {
      await (await token.transfer(u.address, perUser)).wait();
    }
  }

  await seedAndDistribute(btc, SUPPLIES.BTC);
  await seedAndDistribute(eth, SUPPLIES.ETH);
  await seedAndDistribute(bnb, SUPPLIES.BNB);
  await seedAndDistribute(usdt, SUPPLIES.USDT);
  await seedAndDistribute(sui, SUPPLIES.SUI);

  console.log("✅ Pool seeded (10%) and tokens distributed (90%)");

  // 📊 Final summary
  console.table({
    PriceFeed: priceFeed.address,
    InterestRateModel: irm.address,
    LendingPool: pool.address,
    BTC: btc.address,
    ETH: eth.address,
    BNB: bnb.address,
    USDT: usdt.address,
    SUI: sui.address,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
