import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MILESTONE_STATUS, PROJECT_STATUS, connect, eth, revertReason, short } from "./lib/chain";
import CreateProject from "./components/CreateProject";
import ProjectCard from "./components/ProjectCard";
import { Toasts } from "./components/ui";

// Ganache demo convention: account 0 deploys (platform owner), 1–2 are the parties,
// 3–5 are the arbitrator panel (the migration registers them)
const DEMO_ROLES = ["Platform", "Client", "Developer", "Arbitrator 1", "Arbitrator 2", "Arbitrator 3"];
const roleIcon = (role) => (role?.startsWith("Arbitrator") ? "⚖️" : { Platform: "🏦", Client: "🧑‍💼", Developer: "👩‍💻" }[role] || "");

export default function App() {
  const [mode, setMode] = useState(() => localStorage.getItem("mc-mode") || "ganache");
  const [conn, setConn] = useState(null);
  const [connError, setConnError] = useState("");
  const [me, setMe] = useState(null);
  const [projects, setProjects] = useState([]);
  const [stats, setStats] = useState({ escrow: 0n, platform: 0n, owner: null });
  const [panel, setPanel] = useState([]); // [{ address, bond, openCases }]
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
      return p?.role ? `${roleIcon(p.role)} ${p.role}` : null;
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
        const [pr, raw] = await Promise.all([m.getProject(id).call(), m.getDispute(id).call()]);
        const dp = raw.arbitrators ? raw : raw[0]; // struct return
        const n = Number(pr.milestoneCount);
        const ms = await Promise.all(Array.from({ length: n }, (_, i) => m.getMilestone(id, i).call()));
        return {
          id,
          name: pr.name,
          description: pr.description,
          client: pr.client,
          developer: pr.developer,
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
            arbitrators: [...dp.arbitrators],
            votes: [...dp.votes].map(Number), // 0 none · 1 developer · 2 client
          },
        };
      })
    );
    const [escrow, platform, owner, panelAddrs] = await Promise.all([
      web3.eth.getBalance(address),
      m.platformBalance().call(),
      m.owner().call(),
      m.getPanel().call(),
    ]);
    const panelInfo = await Promise.all(
      panelAddrs.map(async (a) => ({
        address: a,
        bond: BigInt(await m.arbitratorBond(a).call()),
        openCases: Number(await m.openCases(a).call()),
      }))
    );
    const addrs = [...new Set([...(conn.accounts || []).slice(0, 6), ...(me ? [me] : [])])];
    const bals = Object.fromEntries(await Promise.all(addrs.map(async (a) => [a.toLowerCase(), BigInt(await web3.eth.getBalance(a))])));
    setProjects(list);
    setStats({ escrow: BigInt(escrow), platform: BigInt(platform), owner });
    setPanel(panelInfo);
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

  const createProject = async (name, desc, dev, descs, amounts, total) => {
    const r = await act("Create project", (c) => c.methods.createProject(name, desc, dev, descs, amounts), total);
    return !!r;
  };

  // ── Derived ─────────────────────────────────────────────────────────
  const involved = (p) =>
    [p.client, p.developer, ...p.dispute.arbitrators].some((a) => a.toLowerCase() === me?.toLowerCase());
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
                {people.slice(0, 6).map((p) => (
                  <button key={p.address} className={`role-card ${p.address === me ? "on" : ""}`} onClick={() => setMe(p.address)}>
                    <span className="role-icon">{roleIcon(p.role)}</span>
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
                  <h2>{roleIcon(meRole)} {meRole} view</h2>
                  <p className="muted">
                    {meRole === "Developer" && "Submit artifacts for your milestones. Their SHA-256 is registered on-chain so the client can verify exactly what you delivered."}
                    {meRole.startsWith("Arbitrator") && "Vote on disputes once both sides have staked. 2 matching votes decide. Vote with the majority to share the 1% fee; vote against it or miss the deadline and 0.1 ETH of your bond is slashed."}
                    {meRole === "Platform" && "The deployer collects 0.5% of every payout and the remainder of slashed stakes. Withdraw from the stats bar above."}
                  </p>
                  <button className="btn ghost sm" onClick={() => setMe(people[1]?.address)}>
                    Switch to Client to create a project
                  </button>
                </div>
              )}
              <ArbitratorPanel panel={panel} me={me} act={act} nameOf={nameOf} />
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
        <span>Arbitrator fee, paid from the loser's slashed stake and split between majority voters</span>
      </div>
      <div className="fee-line">
        <span className="fee-badge">4%</span>
        <span>Rest of the slashed stake goes to the platform</span>
      </div>
      <div className="fee-line">
        <span className="fee-badge">0.1</span>
        <span>ETH slashed from an arbitrator's bond for voting against the majority or not voting in time</span>
      </div>
      <p className="muted small">
        Winner always gets their stake back. No response in time → disputer wins by default. No 2-vote majority in time → respondent wins.
      </p>
    </div>
  );
}

function ArbitratorPanel({ panel, me, act, nameOf }) {
  const mine = panel.find((a) => a.address.toLowerCase() === me?.toLowerCase());
  return (
    <div className="card arb-panel">
      <div className="card-head">
        <h2>⚖️ Arbitrator panel</h2>
        <span className="muted">{panel.length}/3 seats · 1 ETH bond</span>
      </div>
      {panel.length === 0 && <p className="muted small">No arbitrators yet — disputes need a full panel of 3.</p>}
      {panel.map((a) => {
        const health = Number((a.bond * 100n) / 10n ** 18n); // % of the 1 ETH bond left
        return (
          <div key={a.address} className={`arb ${a.address === mine?.address ? "me" : ""}`}>
            <div className="arb-top">
              <span>{nameOf(a.address) || short(a.address)}</span>
              <span className="mono">{eth(a.bond, 2)} ETH</span>
            </div>
            <div className="bond-bar">
              <div style={{ width: `${health}%` }} className={health < 70 ? "low" : ""} />
            </div>
            {a.openCases > 0 && <span className="muted small">{a.openCases} open case{a.openCases > 1 ? "s" : ""}</span>}
          </div>
        );
      })}
      <p className="muted small">Removed automatically when the bond drops below 0.5 ETH.</p>
      {!mine && panel.length < 3 && me && (
        <button className="btn ghost sm" onClick={() => act("Join panel", (c) => c.methods.joinPanel(), 10n ** 18n)}>
          Join with 1 ETH bond
        </button>
      )}
      {mine && (
        <button
          className="btn ghost sm"
          disabled={mine.openCases > 0}
          title={mine.openCases > 0 ? "Finish your open disputes first" : ""}
          onClick={() => act("Leave panel", (c) => c.methods.leavePanel())}
        >
          Leave panel &amp; withdraw bond
        </button>
      )}
    </div>
  );
}
