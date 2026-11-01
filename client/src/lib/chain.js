import Web3 from "web3";
import artifact from "../contracts/MilestoneEscrow.json";

export const GANACHE_URL = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:7545";

export const PROJECT_STATUS = ["Active", "Completed", "Disputed", "Cancelled"];
export const MILESTONE_STATUS = ["Pending", "Submitted", "Verified", "Approved", "Disputed", "Refunded"];
export const ARTIFACT_TYPES = ["Build Output", "ZIP Archive", "Commit Hash", "Docker Image", "Other"];

// Fee model (mirrors the contract constants, in basis points)
export const BPS = 10_000n;
export const PLATFORM_FEE_BPS = 50n;
export const ARBITRATOR_FEE_BPS = 100n;
export const STAKE_BPS = 500n;
export const pct = (amount, bps) => (amount * bps) / BPS;

/**
 * Connects either through MetaMask (window.ethereum) or straight to Ganache,
 * whose accounts are unlocked — handy for demos since you can switch roles
 * with one click instead of switching MetaMask accounts.
 */
export async function connect(mode) {
  let web3;
  let accounts;
  if (mode === "metamask") {
    if (!window.ethereum) throw new Error("MetaMask not detected — use Ganache mode or install MetaMask.");
    web3 = new Web3(window.ethereum);
    accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  } else {
    web3 = new Web3(new Web3.providers.HttpProvider(GANACHE_URL));
    accounts = await web3.eth.getAccounts();
  }

  const networkId = String(await web3.eth.net.getId());
  const deployed = artifact.networks[networkId];
  if (!deployed) {
    throw new Error(
      `Contract not deployed on network ${networkId}. Run "npm run migrate" with Ganache running` +
        (mode === "metamask" ? " and point MetaMask at http://127.0.0.1:7545 (chain ID 1337)." : ".")
    );
  }
  const contract = new web3.eth.Contract(artifact.abi, deployed.address);
  return { web3, accounts, contract, address: deployed.address };
}

export async function sha256Hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : await data.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return "0x" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pulls the contract's require() message out of web3/MetaMask's nested error shapes. */
export function revertReason(err) {
  const seen = new Set();
  const walk = (e) => {
    if (!e || typeof e !== "object" || seen.has(e)) return null;
    seen.add(e);
    for (const key of ["message", "reason"]) {
      const m = typeof e[key] === "string" && e[key].match(/MilestoneChain: ([^"\\]+)/);
      if (m) return m[1];
    }
    for (const key of ["innerError", "cause", "data", "error"]) {
      const r = walk(e[key]);
      if (r) return r;
    }
    return null;
  };
  const msg = walk(err) || err?.innerError?.message || err?.message || "Transaction failed";
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const shortHash = (h) => (h && !/^0x0+$/.test(h) ? `${h.slice(0, 10)}…${h.slice(-8)}` : "—");

export function eth(wei, digits = 4) {
  const n = Number(Web3.utils.fromWei(BigInt(wei ?? 0), "ether"));
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}
