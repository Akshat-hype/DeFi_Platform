import React, { useState, useEffect } from "react";
import { BrowserProvider, Contract, parseUnits } from "ethers";
import LendingPoolABI from "./abis/LendingPool.json";
import ERC20ABI from "./abis/ERC20Token.json";

const POOL_ADDRESS = "YOUR_POOL_ADDRESS_HERE";

const TOKENS = {
  BTC: "BTC_TOKEN_ADDRESS",
  ETH: "ETH_TOKEN_ADDRESS",
  USDT: "USDT_TOKEN_ADDRESS",
  BNB: "BNB_TOKEN_ADDRESS",
  SUI: "SUI_TOKEN_ADDRESS"
};

function App() {
  const [provider, setProvider] = useState();
  const [signer, setSigner] = useState();
  const [account, setAccount] = useState();

  useEffect(() => {
    if (window.ethereum) {
      const prov = new BrowserProvider(window.ethereum);
      setProvider(prov);
    }
  }, []);

  async function connect() {
    if (!provider) return alert("MetaMask not found!");

    const acc = await provider.send("eth_requestAccounts", []);
    setAccount(acc[0]);

    const signer = await provider.getSigner();
    setSigner(signer);
  }

  async function deposit(tokenSymbol, amount) {
    if (!signer) return alert("Connect wallet first");

    const tokenAddr = TOKENS[tokenSymbol];
    const amt = parseUnits(amount.toString(), 18);

    const token = new Contract(tokenAddr, ERC20ABI.abi, signer);
    const pool = new Contract(POOL_ADDRESS, LendingPoolABI.abi, signer);

    await token.approve(POOL_ADDRESS, amt);
    await pool.deposit(tokenAddr, amt);

    alert(`Deposited ${amount} ${tokenSymbol}`);
  }

  async function borrow(tokenSymbol, amount, collateralAmount) {
    const tokenAddr = TOKENS[tokenSymbol];
    const amt = parseUnits(amount.toString(), 18);
    const colAmt = parseUnits(collateralAmount.toString(), 18);

    const usdt = new Contract(TOKENS.USDT, ERC20ABI.abi, signer);
    const pool = new Contract(POOL_ADDRESS, LendingPoolABI.abi, signer);

    await usdt.approve(POOL_ADDRESS, colAmt);
    await pool.borrow(tokenAddr, amt, colAmt);

    alert("Borrow successful!");
  }

  return (
    <div style={{ padding: 20 }}>
      <h2>DeFi Lending Platform</h2>

      {!account ? (
        <button onClick={connect}>Connect MetaMask</button>
      ) : (
        <div>Connected: {account}</div>
      )}

      <hr />

      <h3>Deposit</h3>
      <button onClick={() => deposit("BTC", "0.1")}>Deposit 0.1 BTC</button>

      <h3>Borrow</h3>
      <button onClick={() => borrow("BTC", "0.01", "100")}>
        Borrow 0.01 BTC with 100 USDT
      </button>
    </div>
  );
}

export default App;
