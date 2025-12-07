
const { ethers } = require("hardhat");

async function main() {
    const walletToFund = "0x69efcaf137bbf96a55c83cef686c26417125cd0d";

    const [deployer] = await ethers.getSigners();

    console.log("Funding wallet:", walletToFund);
    console.log("Deployer:", deployer.address);

    // Replace these with your actual deployed token addresses
    const tokens = {
        BTC: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
        ETH: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
        USDT: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
        BNB: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
        SUI: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707"
    };

    const ERC20 = await ethers.getContractFactory("ERC20Token");

    for (const symbol of Object.keys(tokens)) {
        const tokenAddress = tokens[symbol];
        const token = await ERC20.attach(tokenAddress);

        const amount = ethers.utils.parseUnits("10", 18); // give 1000 tokens

        console.log(`Sending 1000 ${symbol} → ${walletToFund}`);
        await token.transfer(walletToFund, amount);
    }

    console.log("Done! Wallet has test tokens.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
