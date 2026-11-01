import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MILESTONE_STATUS, PROJECT_STATUS, connect, eth, revertReason, short } from "./lib/chain";
import CreateProject from "./components/CreateProject";
import ProjectCard from "./components/ProjectCard";
import { Toasts } from "./components/ui";

// Ganache demo convention: account 0 deploys (platform owner), 1–3 play the roles
const DEMO_ROLES = ["Platform", "Client", "Developer", "Arbitrator"];
const ROLE_ICON = { Platform: "🏦", Client: "🧑‍💼", Developer: "👩‍💻", Arbitrator: "⚖️" };

export default function App() {
  const [mode, setMode] = useState(() => localStorage.getItem("mc-mode") || "ganache");
  const [conn, setConn] = useState(null);
  const [connError, setConnError] = useState("");
  const [me, setMe] = useState(null);
  const [projects, setProjects] = useState([]);
  const [stats, setStats] = useState({ escrow: 0n, platform: 0n, owner: null });
  const [balances, setBalances] = useState({});
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("mine");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const toastId = useRef(0);

  const people = useMemo(
    () =>
      (conn?.accounts || []).slice(0, mode === "ganache" ? 6 : undefined).map((address, i) => ({
        address,
        role: mode === "ganache" ? DEMO_ROLES[i] || `Account ${i}` : null,
      })),
    [conn, mode]
  );
  const nameOf = useCallback(
    (addr) => {
      const p = people.find((x) => x.address.toLowerCase() === addr?.toLowerCase());
      return p?.role ? `${ROLE_ICON[p.role] || ""} ${p.role}` : null;
    },
    [people]
  );

  // ── Connection ──────────────────────────────────────────────────────
  const doConnect = useCallback(async (m) => {
    setConnError("");
    try {
      const c = await connect(m);
      setConn(c);
      setMe((prev) => (c.accounts.includes(prev) ? prev : c.accounts[m === "ganache" ? 1 : 0]));
    } catch (e) {
      setConn(null);
      setConnError(e.message);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("mc-mode", mode);
    doConnect(mode);
  }, [mode, doConnect]);

  useEffect(() => {
    if (mode !== "metamask" || !window.ethereum) return;
    const onAccounts = (accs) => {
      setMe(accs[0]);
      setConn((c) => (c ? { ...c, accounts: accs } : c));
    };
    const onChain = () => doConnect("metamask");
    window.ethereum.on("accountsChanged", onAccounts);
    window.ethereum.on("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAccounts);
      window.ethereum.removeListener("chainChanged", onChain);
    };
  }, [mode, doConnect]);

  // ── Chain reads ─────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!conn) return;
    const { web3, contract, address } = conn;
    const m = contract.methods;
    const count = Number(await m.getProjectCount().call());
    const ids = Array.from({ length: count }, (_, i) => count - i); // newest first
    const list = await Promise.all(
      ids.map(async (id) => {
        const [pr, dp] = await Promise.all([m.getProject(id).call(), m.getDispute(id).call()]);
        const n = Number(pr.milestoneCount);
        const ms = await Promise.all(Array.from({ length: n }, (_, i) => m.getMilestone(id, i).call()));
        return {
          id,
          name: pr.name,
          description: pr.description,
          client: pr.client,
          developer: pr.developer,
          arbitrator: pr.arbitrator,
          totalAmount: BigInt(pr.totalAmount),
          releasedAmount: BigInt(pr.releasedAmount),
          refundedAmount: BigInt(pr.refundedAmount),
          milestoneCount: n,
          settledCount: Number(pr.settledCount),
          status: PROJECT_STATUS[Number(pr.status)],
          milestones: ms.map((x, i) => ({
            idx: i,
            description: x.description,
            amount: BigInt(x.amount),
            artifactHash: x.artifactHash,
            artifactName: x.artifactName,
            artifactType: Number(x.artifactType),
            isVerified: x.isVerified,
            clientHash: x.clientHash,
            status: MILESTONE_STATUS[Number(x.status)],
          })),
          dispute: {
            milestoneIndex: Number(dp.milestoneIndex),
            disputer: dp.disputer,
            respondent: dp.respondent,
            stake: BigInt(dp.stake),
            responded: dp.responded,
            deadline: Number(dp.deadline),
            reason: dp.reason,
            open: dp.open,
          },
        };
      })
    );
    const [escrow, platform, owner] = await Promise.all([
      web3.eth.getBalance(address),
      m.platformBalance().call(),
      m.owner().call(),
    ]);
    const addrs = [...new Set([...(conn.accounts || []).slice(0, 6), ...(me ? [me] : [])])];
    const bals = Object.fromEntries(await Promise.all(addrs.map(async (a) => [a.toLowerCase(), BigInt(await web3.eth.getBalance(a))])));
    setProjects(list);
    setStats({ escrow: BigInt(escrow), platform: BigInt(platform), owner });
    setBalances(bals);
  }, [conn, me]);

  useEffect(() => {
    refresh().catch((e) => setConnError(e.message));
    const t = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
      refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // ── Transactions ────────────────────────────────────────────────────
  const toast = (t) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, ...t }]);
    if (t.kind !== "pending") setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 5000);
    return id;
  };
  const dismiss = (id) => setToasts((ts) => ts.filter((x) => x.id !== id));

  const act = async (title, build, value) => {
    if (!conn || !me) return null;
    setBusy(true);
    const pending = toast({ kind: "pending", title, body: "Waiting for confirmation…" });
    try {
      const call = build(conn.contract);
      const opts = { from: me, ...(value ? { value: value.toString() } : {}) };
      // Estimate first: catches reverts with a readable reason and avoids Ganache's 90k default gas
      const gas = await call.estimateGas(opts);
      const receipt = await call.send({ ...opts, gas: ((BigInt(gas) * 12n) / 10n).toString() });
      dismiss(pending);
      toast({ kind: "ok", title, body: `Mined in block ${receipt.blockNumber}` });
      await refresh();
      return receipt;
    } catch (e) {
      dismiss(pending);
      toast({ kind: "err", title: `${title} failed`, body: revertReason(e) });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (name, desc, dev, arb, descs, amounts, total) => {
    const r = await act("Create project", (c) => c.methods.createProject(name, desc, dev, arb, descs, amounts), total);
    return !!r;
  };

  // ── Derived ─────────────────────────────────────────────────────────
  const involved = (p) => [p.client, p.developer, p.arbitrator].some((a) => a.toLowerCase() === me?.toLowerCase());
  const shown = projects.filter((p) =>
    filter === "mine" ? involved(p) : filter === "disputed" ? p.status === "Disputed" : true
  );
  const meRole = people.find((p) => p.address === me)?.role;
  const isOwner = stats.owner && me && stats.owner.toLowerCase() === me.toLowerCase();
  const disputedCount = projects.filter((p) => p.status === "Disputed").length;

  return (
    <div className="app">
      <div className="bg-glow" />
      <header className="topbar">
        <div className="brand">
          <div className="logo">⛓</div>
          <div>
            <div className="brand-name">MilestoneChain</div>
            <div className="brand-sub">Verifiable software escrow</div>
          </div>
        </div>

        <div className="topbar-right">
          <div className="seg">
            <button className={mode === "ganache" ? "on" : ""} onClick={() => setMode("ganache")}>
              Ganache
            </button>
            <button className={mode === "metamask" ? "on" : ""} onClick={() => setMode("metamask")}>
              MetaMask
            </button>
          </div>
          {conn && (
            <div className="net">
              <span className="live-dot" /> {short(conn.address)}
            </div>
          )}
        </div>
      </header>

      {connError && (
        <div className="banner">
          <b>Not connected.</b> {connError}
          <button className="btn ghost sm" onClick={() => doConnect(mode)}>
            Retry
          </button>
        </div>
      )}

      {conn && (
        <>
          {mode === "ganache" ? (
            <section className="role-switch">
              <span className="muted small">Acting as</span>
              <div className="role-cards">
                {people.slice(0, 4).map((p) => (
                  <button key={p.address} className={`role-card ${p.address === me ? "on" : ""}`} onClick={() => setMe(p.address)}>
                    <span className="role-icon">{ROLE_ICON[p.role]}</span>
                    <span className="role-text">
                      <b>{p.role}</b>
                      <span className="mono small">{short(p.address)}</span>
                    </span>
                    <span className="role-bal">{eth(balances[p.address.toLowerCase()], 3)} ETH</span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="role-switch">
              <span className="muted small">Connected as</span>
              <div className="role-cards">
                <div className="role-card on">
                  <span className="role-icon">🦊</span>
                  <span className="role-text">
                    <b>{short(me)}</b>
                    <span className="small muted">switch accounts in MetaMask</span>
                  </span>
                  <span className="role-bal">{eth(balances[me?.toLowerCase()], 3)} ETH</span>
                </div>
              </div>
            </section>
          )}

          <section className="stats">
            <Stat label="Held in escrow" value={`${eth(stats.escrow)} ETH`} sub="milestones + stakes + fees" />
            <Stat label="Platform fees" value={`${eth(stats.platform, 6)} ETH`} sub="0.5% per payout + slashed stakes">
              {isOwner && stats.platform > 0n && (
                <button className="btn ghost sm" onClick={() => act("Withdraw fees", (c) => c.methods.withdrawPlatformFees())}>
                  Withdraw
                </button>
              )}
            </Stat>
            <Stat label="Projects" value={projects.length} sub={`${projects.filter((p) => p.status === "Completed").length} completed`} />
            <Stat label="Open disputes" value={disputedCount} sub="5% stake each side" tone={disputedCount ? "red" : null} />
          </section>

          <main className="layout">
            <aside className="side">
              {(mode === "metamask" || meRole === "Client" || !meRole) && <CreateProject people={people} me={me} onCreate={createProject} busy={busy} />}
              {mode === "ganache" && meRole && meRole !== "Client" && (
                <div className="card hint">
                  <h2>{ROLE_ICON[meRole]} {meRole} view</h2>
                  <p className="muted">
                    {meRole === "Developer" && "Submit artifacts for your milestones. Their SHA-256 is registered on-chain so the client can verify exactly what you delivered."}
                    {meRole === "Arbitrator" && "Rule on disputes once both sides have staked. You earn 1% of the milestone, paid from the loser's slashed stake."}
                    {meRole === "Platform" && "The deployer collects 0.5% of every payout and the remainder of slashed stakes. Withdraw from the stats bar above."}
                  </p>
                  <button className="btn ghost sm" onClick={() => setMe(people[1]?.address)}>
                    Switch to Client to create a project
                  </button>
                </div>
              )}
              <FeeModel />
            </aside>

            <section className="feed">
              <div className="feed-head">
                <h2>Projects</h2>
                <div className="seg">
                  {[
                    ["mine", "Mine"],
                    ["all", "All"],
                    ["disputed", `Disputed${disputedCount ? ` (${disputedCount})` : ""}`],
                  ].map(([k, l]) => (
                    <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {shown.length === 0 && (
                <div className="empty card">
                  <div className="empty-icon">📭</div>
                  <div>{filter === "mine" ? "No projects involve this account yet." : "Nothing here yet."}</div>
                </div>
              )}
              {shown.map((p) => (
                <ProjectCard key={p.id} project={p} me={me} act={act} now={now} nameOf={nameOf} />
              ))}
            </section>
          </main>
        </>
      )}

      <Toasts items={toasts} dismiss={dismiss} />
    </div>
  );
}

function Stat({ label, value, sub, tone, children }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">
        <span className="muted small">{sub}</span>
        {children}
      </div>
    </div>
  );
}

function FeeModel() {
  return (
    <div className="card fees">
      <h2>Economics</h2>
      <div className="fee-line">
        <span className="fee-badge">0.5%</span>
        <span>Platform fee on every milestone payout</span>
      </div>
      <div className="fee-line">
        <span className="fee-badge">5%</span>
        <span>Stake to raise a dispute — the other side matches it to contest</span>
      </div>
      <div className="fee-line">
        <span className="fee-badge">1%</span>
        <span>Arbitrator fee, paid from the loser's slashed stake</span>
      </div>
      <div className="fee-line">
        <span className="fee-badge">4%</span>
        <span>Rest of the slashed stake goes to the platform</span>
      </div>
      <p className="muted small">Winner always gets their stake back. No response in time → disputer wins by default, nobody is slashed.</p>
    </div>
  );
}
