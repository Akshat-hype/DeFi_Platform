import React, { useEffect, useMemo, useState } from "react";
import "./App.css";

import {
  BrowserProvider,
  Contract,
  parseUnits,
  formatUnits,
} from "ethers";

import LendingPoolABI from "./abis/LendingPool.json";
import ERC20ABI from "./abis/ERC20Token.json";

/* ----------------- HARDHAT-LOCAL CONFIG ----------------- */
const POOL_ADDRESS = "0x67baFF31318638F497f4c4894Cd73918563942c8";

const TOKENS = {
  BTC: "0x4f42528B7bF8Da96516bECb22c1c6f53a8Ac7312",
ETH: "0x8f119cd256a0FfFeed643E830ADCD9767a1d517F",
USDT: "0xe14058B1c3def306e2cb37535647A04De03Db092",
BNB: "0x74ef2B06A1D2035C33244A4a263FF00B84504865",
SUI: "0xF5b81Fe0B6F378f9E6A3fb6A6cD1921FCeA11799",
};

const tokenOptions = Object.keys(TOKENS);
const format = (v) => {
  try {
    return formatUnits(v ?? 0n, 18);
  } catch {
    return "0";
  }
};

export default function App() {
  const [provider, setProvider] = useState();
  const [signer, setSigner] = useState();
  const [account, setAccount] = useState();

  const [selectedToken, setSelectedToken] = useState("BTC");
  const [amount, setAmount] = useState("");
  const [collateralInput, setCollateralInput] = useState("100");

  const [balances, setBalances] = useState({});
  const [poolLiquidity, setPoolLiquidity] = useState({});

  const [collateralUSD, setCollateralUSD] = useState("0");
  const [borrowLimitUSD, setBorrowLimitUSD] = useState("0");

  const [loans, setLoans] = useState({});

  const pool = useMemo(() => {
    if (!signer) return null;
    return new Contract(POOL_ADDRESS, LendingPoolABI.abi, signer);
  }, [signer]);

  /* ---------------- INIT PROVIDER ---------------- */
  useEffect(() => {
    if (!window.ethereum) return;
    const setup = async () => {
      const prov = new BrowserProvider(window.ethereum);
      setProvider(prov);
    };
    setup();
  }, []);

  /* ---------------- CONNECT ---------------- */
  async function connect() {
    const acc = await provider.send("eth_requestAccounts", []);
    setAccount(acc[0]);
    setSigner(await provider.getSigner());
    await refreshAll();
  }

  /* ---------------- AUTO REFRESH ---------------- */
  useEffect(() => {
    if (!signer || !account) return;
    const id = setInterval(() => refreshAll(), 5000);
    return () => clearInterval(id);
  }, [signer, account]);

  /* ---------------- MASTER REFRESH ---------------- */
  async function refreshAll() {
    await Promise.all([
      loadBalances(),
      loadPoolLiquidity(),
      loadCollateralData(),
      loadLoans(),
    ]);
  }

  /* ---------------- BALANCES ---------------- */
  async function loadBalances() {
    const map = {};
    for (const sym of tokenOptions) {
      const token = new Contract(TOKENS[sym], ERC20ABI.abi, signer);
      const bal = await token.balanceOf(account);
      map[sym] = format(bal);
    }
    setBalances(map);
  }

  /* ---------------- POOL LIQUIDITY ---------------- */
  async function loadPoolLiquidity() {
    const map = {};
    for (const sym of tokenOptions) {
      const cfg = await pool.configs(TOKENS[sym]);
      map[sym] = format(cfg.totalDeposits);
    }
    setPoolLiquidity(map);
  }

  /* ---------------- COLLATERAL + LIMIT ---------------- */
  async function loadCollateralData() {
    const col = await pool.getUserCollateralUSD(account);
    const lim = await pool.getBorrowLimitUSD(account); // already includes factor

    setCollateralUSD(format(col));
    setBorrowLimitUSD(format(lim));
  }

  /* ---------------- LOANS ---------------- */
  async function loadLoans() {
    const map = {};
    for (const sym of tokenOptions) {
      const loan = await pool.getLoan(account, TOKENS[sym]);
      map[sym] = {
        principal: format(loan[0]),
        interest: format(loan[1]),
      };
    }
    setLoans(map);
  }

  /* ---------------- ACTIONS ---------------- */
  async function lend() {
    if (!amount) return alert("Enter amount.");
    const tokenAddr = TOKENS[selectedToken];
    const amt = parseUnits(amount, 18);

    const token = new Contract(tokenAddr, ERC20ABI.abi, signer);

    await token.approve(POOL_ADDRESS, amt);
    await pool.deposit(tokenAddr, amt);

    alert("Deposit Successful");
    await refreshAll();
  }

  async function borrow() {
    if (!amount) return alert("Enter amount.");
    const tokenAddr = TOKENS[selectedToken];
    const amt = parseUnits(amount, 18);

    try {
      await pool.borrow(tokenAddr, amt);
      alert("Borrow Successful");
      await refreshAll();
    } catch (e) {
      alert(e?.reason || e?.message);
    }
  }

  async function repay() {
    if (!amount) return alert("Enter amount.");
    const tokenAddr = TOKENS[selectedToken];
    const amt = parseUnits(amount, 18);

    const token = new Contract(tokenAddr, ERC20ABI.abi, signer);

    await token.approve(POOL_ADDRESS, amt);
    await pool.repay(tokenAddr, amt);

    alert("Repay Successful");
    await refreshAll();
  }

  async function withdraw() {
    if (!amount) return alert("Enter amount.");
    const tokenAddr = TOKENS[selectedToken];
    const amt = parseUnits(amount, 18);

    try {
      await pool.withdraw(tokenAddr, amt);
      alert("Withdraw successful");
      await refreshAll();
    } catch (e) {
      alert(e?.reason || e?.message || "Withdraw failed");
    }
  }

  return (
    <div className="app-wrapper">

      <div className="header">
        <h1 className="title">💠 DeFi Lending Platform</h1>
        {!account ? (
          <button className="connect-btn" onClick={connect}>Connect Wallet</button>
        ) : (
          <div className="connected">{account}</div>
        )}
      </div>

      {/* BALANCES */}
      <div className="card">
        <h2>Your Balances</h2>
        <div className="balance-grid">
          {tokenOptions.map((sym) => (
            <div key={sym} className="balance-box">
              <span>{sym}</span>
              <span>{balances[sym] || "0"}</span>
            </div>
          ))}
        </div>
      </div>

      {/* LIQUIDITY */}
      <div className="card">
        <h2>Pool Liquidity</h2>
        <div className="balance-grid">
          {tokenOptions.map((sym) => (
            <div key={sym} className="balance-box">
              <span>{sym}</span>
              <span>{poolLiquidity[sym] || "0"}</span>
            </div>
          ))}
        </div>
      </div>

      {/* COLLATERAL */}
      <div className="card">
        <h2>Your Collateral (USD)</h2>
        <p>{collateralUSD}</p>

        <h2>Borrow Limit (70%)</h2>
        <p>{borrowLimitUSD}</p>
      </div>

      {/* LOANS */}
      <div className="card">
        <h2>Your Loans</h2>
        <div className="balance-grid">
          {tokenOptions.map((sym) => (
            <div key={sym} className="balance-box">
              <span>{sym}</span>
              <span>P: {loans[sym]?.principal} <br />I: {loans[sym]?.interest}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ACTIONS */}
      <div className="card">
        <h2>Actions</h2>

        <label>Select Token</label>
        <select value={selectedToken} onChange={(e) => setSelectedToken(e.target.value)}>
          {tokenOptions.map((t) => <option key={t}>{t}</option>)}
        </select>

        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" />

        <div className="button-row">
          <button onClick={lend}>Lend</button>
          <button onClick={borrow}>Borrow</button>
        </div>

        <div className="button-row">
          <button onClick={repay}>Repay</button>
          <button onClick={withdraw}>Withdraw</button>
        </div>
      </div>

    </div>
  );
}
