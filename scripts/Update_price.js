const { ethers } = require("hardhat");

async function main() {
  const fetch = (await import("node-fetch")).default;

  const COINS = ["bitcoin", "ethereum", "tether", "binancecoin", "sui"];
  const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // <- replace with deployed address

  const abi = [
    "function updatePrice(string token, uint256 price) public",
    "function getPrice(string token) public view returns (uint256)",
  ];

  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const signer = provider.getSigner(0);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, signer);

  async function updatePrices() {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${COINS.join(",")}&vs_currencies=usd`;
      const res = await fetch(url);
      const data = await res.json();

      console.log("\n⏳ Fetching live prices at", new Date().toLocaleTimeString());
      console.log("Fetched data:", data);

      const usdtPrice = data["tether"]?.usd || 1;
      console.log(`🪙 Using USDT reference price = $${usdtPrice}`);

      for (const coin of COINS) {
        const val = data[coin];
        if (!val || typeof val.usd !== "number" || isNaN(val.usd)) {
          console.warn(`⚠️ Skipping ${coin} — invalid or missing price`);
          continue;
        }

        // Normalize to USDT price
        const priceInUsdt = val.usd / usdtPrice;
        const price = Math.round(priceInUsdt * 100); // keep 2 decimals precision

        const tx = await contract.updatePrice(coin, price);
        await tx.wait();

        console.log(`✅ Updated ${coin.toUpperCase()} = ${priceInUsdt.toFixed(4)} USDT`);
      }

      console.log("✅ All valid prices updated successfully!");
    } catch (err) {
      console.error("❌ Error updating prices:", err.message);
    }
  }

  await updatePrices();
  setInterval(updatePrices, 1 * 60 * 1000);
}

main();