import { useState } from "react";
import Web3 from "web3";
import { eth, short } from "../lib/chain";

const blank = () => ({ desc: "", amount: "" });

export default function CreateProject({ people, me, onCreate, busy }) {
  const others = people.filter((p) => p.address.toLowerCase() !== me?.toLowerCase());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [developer, setDeveloper] = useState(people.find((p) => p.role === "Developer")?.address || "");
  const [rows, setRows] = useState([
    { desc: "Frontend UI", amount: "0.5" },
    { desc: "Backend API", amount: "0.5" },
  ]);
  const [error, setError] = useState("");

  let total = 0n;
  let amountsOk = true;
  for (const r of rows) {
    try {
      const w = BigInt(Web3.utils.toWei(r.amount || "0", "ether"));
      if (w <= 0n) amountsOk = false;
      total += w;
    } catch {
      amountsOk = false;
    }
  }

  const setRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError("Give the project a name.");
    if (!Web3.utils.isAddress(developer)) return setError("Developer address is invalid.");
    if (rows.some((r) => !r.desc.trim())) return setError("Every milestone needs a description.");
    if (!amountsOk) return setError("Every milestone needs a positive ETH amount.");
    const amounts = rows.map((r) => Web3.utils.toWei(r.amount, "ether"));
    const ok = await onCreate(name.trim(), description.trim(), developer, rows.map((r) => r.desc.trim()), amounts, total);
    if (ok) {
      setName("");
      setDescription("");
    }
  };

  return (
    <form className="card create" onSubmit={submit}>
      <div className="card-head">
        <h2>New project</h2>
        <span className="muted">You lock the full budget as the client</span>
      </div>

      <label className="field">
        <span>Project name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="E-Commerce App" />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Build a shopping site with cart and checkout" />
      </label>

      <datalist id="people">
        {others.map((p) => (
          <option key={p.address} value={p.address}>
            {p.role ? `${p.role} · ` : ""}
            {short(p.address)}
          </option>
        ))}
      </datalist>
      <label className="field">
        <span>Developer</span>
        <input list="people" value={developer} onChange={(e) => setDeveloper(e.target.value)} placeholder="0x…" spellCheck={false} />
      </label>
      <p className="muted small field-note">Disputes go to the 3-member arbitrator panel — no need to pick one.</p>

      <div className="ms-editor">
        <div className="ms-editor-head">
          <span>Milestones</span>
          <button type="button" className="btn ghost sm" onClick={() => setRows([...rows, blank()])}>
            + Add
          </button>
        </div>
        {rows.map((r, i) => (
          <div className="ms-row" key={i}>
            <span className="ms-idx">M{i}</span>
            <input value={r.desc} onChange={(e) => setRow(i, { desc: e.target.value })} placeholder="Deliverable" />
            <div className="eth-input">
              <input value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} placeholder="0.0" inputMode="decimal" />
              <span>ETH</span>
            </div>
            <button type="button" className="icon-btn" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))} title="Remove">
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="create-foot">
        <div>
          <div className="muted small">Locked in escrow</div>
          <div className="total">{amountsOk ? eth(total) : "—"} ETH</div>
        </div>
        <button className="btn primary" disabled={busy}>
          Lock funds &amp; create
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}
