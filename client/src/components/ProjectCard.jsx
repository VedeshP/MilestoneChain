import { useState } from "react";
import {
  ARTIFACT_TYPES,
  ARBITRATOR_FEE_BPS,
  PLATFORM_FEE_BPS,
  STAKE_BPS,
  eth,
  pct,
  short,
} from "../lib/chain";
import { Hash, HashInput, Pill } from "./ui";

const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

export default function ProjectCard({ project: p, me, act, now, nameOf }) {
  const [open, setOpen] = useState(p.status === "Active" || p.status === "Disputed");
  const isClient = same(me, p.client);
  const isDev = same(me, p.developer);
  const isArb = same(me, p.arbitrator);
  const myRole = isClient ? "Client" : isDev ? "Developer" : isArb ? "Arbitrator" : null;

  const locked = p.totalAmount - p.releasedAmount - p.refundedAmount;
  const progress = Number(p.settledCount) / Number(p.milestoneCount);
  const canRefund =
    isClient &&
    p.status === "Active" &&
    p.milestones.some((m) => m.status === "Pending") &&
    !p.milestones.some((m) => m.status === "Submitted" || m.status === "Verified");

  return (
    <article className={`card project ${p.status === "Disputed" ? "is-disputed" : ""}`}>
      <header className="project-head" onClick={() => setOpen(!open)}>
        <div className="project-title">
          <span className="project-id">#{p.id}</span>
          <h3>{p.name}</h3>
          <Pill status={p.status} />
          {myRole && <span className={`you you-${myRole.toLowerCase()}`}>you: {myRole}</span>}
        </div>
        <div className="project-amounts">
          <div>
            <span className="muted small">Locked</span>
            <strong>{eth(locked)} ETH</strong>
          </div>
          <div>
            <span className="muted small">Total</span>
            <strong>{eth(p.totalAmount)} ETH</strong>
          </div>
          <span className={`chev ${open ? "up" : ""}`}>⌄</span>
        </div>
      </header>

      <div className="progress">
        <div style={{ width: `${progress * 100}%` }} />
      </div>

      {open && (
        <div className="project-body">
          {p.description && <p className="desc">{p.description}</p>}
          <div className="parties">
            <Party role="Client" addr={p.client} me={me} nameOf={nameOf} />
            <Party role="Developer" addr={p.developer} me={me} nameOf={nameOf} />
            <Party role="Arbitrator" addr={p.arbitrator} me={me} nameOf={nameOf} />
          </div>

          {p.dispute.open && (
            <DisputePanel p={p} me={me} act={act} now={now} isArb={isArb} nameOf={nameOf} />
          )}

          <div className="milestones">
            {p.milestones.map((m) => (
              <MilestoneRow key={m.idx} p={p} m={m} isClient={isClient} isDev={isDev} act={act} />
            ))}
          </div>

          {canRefund && (
            <div className="refund-bar">
              <span className="muted">
                Cancel the project and get every <b>pending</b> milestone back — no fee charged.
              </span>
              <button
                className="btn danger ghost sm"
                onClick={() => act("Cancel & refund", (c) => c.methods.refundClient(p.id))}
              >
                Cancel &amp; refund
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Party({ role, addr, me, nameOf }) {
  return (
    <div className={`party ${same(me, addr) ? "me" : ""}`}>
      <span className="muted small">{role}</span>
      <span className="mono">{nameOf(addr) || short(addr)}</span>
    </div>
  );
}

function MilestoneRow({ p, m, isClient, isDev, act }) {
  const [panel, setPanel] = useState(null); // "submit" | "verify" | "dispute"
  const [artifact, setArtifact] = useState(null);
  const [artifactName, setArtifactName] = useState("");
  const [artifactType, setArtifactType] = useState(1);
  const [verifyResult, setVerifyResult] = useState(null);
  const [reason, setReason] = useState("");

  const active = p.status === "Active";
  const stake = pct(m.amount, STAKE_BPS);
  const fee = pct(m.amount, PLATFORM_FEE_BPS);
  const mismatch = m.status === "Submitted" && m.clientHash && !/^0x0+$/.test(m.clientHash) && m.clientHash !== m.artifactHash;

  const toggle = (name) => setPanel(panel === name ? null : name);

  const doSubmit = async () => {
    const r = await act("Submit artifact", (c) =>
      c.methods.submitMilestone(p.id, m.idx, artifact.hash, artifactName || artifact.name, artifactType)
    );
    if (r) setPanel(null);
  };

  const doVerify = async () => {
    const r = await act("Verify deliverable", (c) => c.methods.verifyDeliverable(p.id, m.idx, artifact.hash));
    if (r) {
      const ev = r.events?.DeliverableVerified?.returnValues;
      setVerifyResult(ev ? Boolean(ev.hashMatched) : null);
    }
  };

  const doDispute = async () => {
    const r = await act("Raise dispute", (c) => c.methods.raiseDispute(p.id, m.idx, reason), stake);
    if (r) setPanel(null);
  };

  return (
    <div className={`ms ms-${m.status.toLowerCase()}`}>
      <div className="ms-main">
        <div className="ms-left">
          <span className="ms-dot" />
          <div>
            <div className="ms-title">
              <span className="ms-idx">M{m.idx}</span> {m.description}
            </div>
            {m.artifactName && (
              <div className="ms-artifact">
                <span className="tag">{ARTIFACT_TYPES[m.artifactType]}</span>
                <span className="mono">{m.artifactName}</span>
                <Hash value={m.artifactHash} label="dev" />
                {m.clientHash && !/^0x0+$/.test(m.clientHash) && (
                  <Hash value={m.clientHash} label={m.clientHash === m.artifactHash ? "client ✓" : "client ✗"} />
                )}
              </div>
            )}
          </div>
        </div>
        <div className="ms-right">
          <strong>{eth(m.amount)} ETH</strong>
          <Pill status={m.status} />
        </div>
      </div>

      {active && (
        <div className="ms-actions">
          {isDev && m.status === "Pending" && (
            <button className="btn primary sm" onClick={() => toggle("submit")}>
              📤 Submit deliverable
            </button>
          )}
          {isClient && m.status === "Submitted" && (
            <button className="btn primary sm" onClick={() => toggle("verify")}>
              🔍 Verify file
            </button>
          )}
          {isClient && m.status === "Verified" && (
            <button
              className="btn success sm"
              onClick={() => act("Approve & release", (c) => c.methods.approveMilestone(p.id, m.idx))}
            >
              ✅ Approve · dev gets {eth(m.amount - fee)} ETH
            </button>
          )}
          {(isClient || isDev) && m.status === "Submitted" && (
            <button className={`btn sm ${mismatch ? "danger" : "ghost"}`} onClick={() => toggle("dispute")}>
              🚩 Raise dispute
            </button>
          )}
          {isDev && m.status === "Submitted" && <span className="muted small">Waiting for the client to verify…</span>}
          {isClient && m.status === "Pending" && <span className="muted small">Waiting for the developer to deliver…</span>}
        </div>
      )}

      {panel === "submit" && (
        <div className="ms-panel">
          <HashInput onHash={setArtifact} hint="Drop the build / ZIP you are delivering" />
          <div className="grid2">
            <label className="field">
              <span>Artifact name</span>
              <input value={artifactName} onChange={(e) => setArtifactName(e.target.value)} placeholder={artifact?.name || "app-v1.0.zip"} />
            </label>
            <label className="field">
              <span>Artifact type</span>
              <select value={artifactType} onChange={(e) => setArtifactType(Number(e.target.value))}>
                {ARTIFACT_TYPES.map((t, i) => (
                  <option key={t} value={i}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="btn primary" disabled={!artifact} onClick={doSubmit}>
            Register hash on-chain
          </button>
        </div>
      )}

      {panel === "verify" && (
        <div className="ms-panel">
          <p className="muted small">
            Hash the file you <b>received</b>. The contract compares it with the developer's registered hash.
          </p>
          <HashInput
            onHash={(r) => {
              setArtifact(r);
              setVerifyResult(null);
            }}
            hint="Drop the file you received"
          />
          {artifact && (
            <div className={`preview-match ${artifact.hash === m.artifactHash ? "ok" : "bad"}`}>
              Local preview: {artifact.hash === m.artifactHash ? "hashes match" : "hashes differ"}
            </div>
          )}
          <button className="btn primary" disabled={!artifact} onClick={doVerify}>
            Verify on-chain
          </button>
          {verifyResult === true && <div className="verdict ok">✅ ARTIFACT VERIFIED — hash matches. You can approve now.</div>}
          {verifyResult === false && (
            <div className="verdict bad">❌ HASH MISMATCH — the artifact may have been tampered with. Raise a dispute.</div>
          )}
        </div>
      )}

      {panel === "dispute" && (
        <div className="ms-panel">
          <label className="field">
            <span>Reason</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={isClient ? "Hash mismatch — artifact was modified" : "Client refuses to verify a genuine delivery"}
            />
          </label>
          <div className="stake-note">
            <div>
              <b>Stake {eth(stake, 6)} ETH</b> (5%)
            </div>
            <div className="muted small">
              Returned if you win. If you lose it is slashed: {eth(pct(m.amount, ARBITRATOR_FEE_BPS), 6)} ETH to the arbitrator, the rest to the
              platform. If the other side doesn't counter-stake in time, you win by default.
            </div>
          </div>
          <button className="btn danger" disabled={!reason.trim()} onClick={doDispute}>
            Stake &amp; raise dispute
          </button>
        </div>
      )}
    </div>
  );
}

function DisputePanel({ p, me, act, now, isArb, nameOf }) {
  const d = p.dispute;
  const m = p.milestones[d.milestoneIndex];
  const left = d.deadline - now;
  const isDisputer = same(me, d.disputer);
  const isRespondent = same(me, d.respondent);
  const disputerIsClient = same(d.disputer, p.client);

  const fee = pct(m.amount, PLATFORM_FEE_BPS);
  const arbFee = pct(m.amount, ARBITRATOR_FEE_BPS);
  const net = m.amount - fee;

  const outcome = (favorDeveloper) => {
    const winner = favorDeveloper ? "Developer" : "Client";
    const disputerWins = favorDeveloper !== disputerIsClient;
    return (
      <div className="outcome">
        <div className="outcome-head">
          {favorDeveloper ? "Developer wins" : "Client wins"}
          <span className={`tag ${disputerWins ? "tone-green" : "tone-red"}`}>{disputerWins ? "disputer right" : "disputer wrong"}</span>
        </div>
        <Row k={`${winner} receives milestone`} v={`${eth(net, 6)} ETH`} />
        <Row k={`${winner} stake returned`} v={`${eth(d.stake, 6)} ETH`} />
        <Row k={`${favorDeveloper ? "Client" : "Developer"} stake slashed`} v={`−${eth(d.stake, 6)} ETH`} bad />
        <Row k="→ Arbitrator fee (1%)" v={`${eth(arbFee, 6)} ETH`} />
        <Row k="→ Platform (slash rest + 0.5%)" v={`${eth(d.stake - arbFee + fee, 6)} ETH`} />
        {isArb && d.responded && (
          <button
            className={`btn ${favorDeveloper ? "primary" : "success"} block`}
            onClick={() => act(`Rule for ${winner}`, (c) => c.methods.resolveDispute(p.id, favorDeveloper))}
          >
            ⚖️ Rule for {winner}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="dispute">
      <div className="dispute-head">
        <div>
          <div className="dispute-title">⚖️ Dispute on M{d.milestoneIndex}</div>
          <div className="muted small">
            Raised by <b>{nameOf(d.disputer) || short(d.disputer)}</b> · “{d.reason}”
          </div>
        </div>
        <div className="dispute-clock">
          {d.responded ? (
            <span className="tag tone-purple">Both sides staked · awaiting arbitrator</span>
          ) : left > 0 ? (
            <span className="tag tone-amber">
              Respondent has {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} to counter-stake
            </span>
          ) : (
            <span className="tag tone-red">Response window closed — default win available</span>
          )}
        </div>
      </div>

      <div className="evidence">
        <Hash value={m.artifactHash} label="registered" />
        <Hash value={m.clientHash} label="client checked" />
        <span className="muted small">Stake per side: {eth(d.stake, 6)} ETH</span>
      </div>

      {isRespondent && !d.responded && left > 0 && (
        <div className="callout">
          <span>
            You're the respondent. Match the stake of <b>{eth(d.stake, 6)} ETH</b> to contest, or the disputer wins by default.
          </span>
          <button className="btn danger sm" onClick={() => act("Counter-stake", (c) => c.methods.respondToDispute(p.id), d.stake)}>
            Counter-stake
          </button>
        </div>
      )}
      {isDisputer && !d.responded && left <= 0 && (
        <div className="callout">
          <span>The other side never contested. Claim the milestone and your stake back.</span>
          <button className="btn success sm" onClick={() => act("Claim default win", (c) => c.methods.claimDefault(p.id))}>
            Claim default win
          </button>
        </div>
      )}

      <div className="outcomes">
        {outcome(true)}
        {outcome(false)}
      </div>
      {isArb && !d.responded && <div className="muted small">You can rule once the respondent counter-stakes.</div>}
    </div>
  );
}

const Row = ({ k, v, bad }) => (
  <div className={`row ${bad ? "bad" : ""}`}>
    <span>{k}</span>
    <span className="mono">{v}</span>
  </div>
);
