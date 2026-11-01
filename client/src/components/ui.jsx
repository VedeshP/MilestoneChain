import { useState } from "react";
import { sha256Hex, shortHash } from "../lib/chain";

const STATUS_TONE = {
  Pending: "gray",
  Submitted: "blue",
  Verified: "purple",
  Approved: "green",
  Disputed: "red",
  Refunded: "amber",
  Active: "green",
  Completed: "blue",
  Cancelled: "gray",
};

const STATUS_ICON = {
  Pending: "⏳",
  Submitted: "📤",
  Verified: "🔍",
  Approved: "✅",
  Disputed: "⚖️",
  Refunded: "↩️",
  Active: "●",
  Completed: "✔",
  Cancelled: "✕",
};

export function Pill({ status }) {
  return (
    <span className={`pill tone-${STATUS_TONE[status] || "gray"}`}>
      <span className="pill-icon">{STATUS_ICON[status]}</span>
      {status}
    </span>
  );
}

export function Hash({ value, label }) {
  const [copied, setCopied] = useState(false);
  const empty = !value || /^0x0+$/.test(value);
  return (
    <span
      className={`hash ${empty ? "hash-empty" : ""}`}
      title={empty ? "" : `${value}\nclick to copy`}
      onClick={() => {
        if (empty) return;
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {label && <span className="hash-label">{label}</span>}
      {copied ? "copied!" : shortHash(value)}
    </span>
  );
}

/**
 * Drop a file (or paste text such as a commit SHA) and get its SHA-256.
 * Calls onHash({ hash, name }) whenever the input changes.
 */
export function HashInput({ onHash, hint = "Drop the artifact file here" }) {
  const [mode, setMode] = useState("file");
  const [result, setResult] = useState(null);
  const [drag, setDrag] = useState(false);

  const handleFile = async (file) => {
    if (!file) return;
    const hash = await sha256Hex(file);
    const r = { hash, name: file.name, size: file.size };
    setResult(r);
    onHash(r);
  };

  const handleText = async (text) => {
    if (!text) {
      setResult(null);
      onHash(null);
      return;
    }
    const hash = await sha256Hex(text);
    const r = { hash, name: text.length > 40 ? text.slice(0, 40) + "…" : text };
    setResult(r);
    onHash(r);
  };

  return (
    <div className="hash-input">
      <div className="seg">
        <button type="button" className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>
          File
        </button>
        <button type="button" className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>
          Text / commit
        </button>
      </div>
      {mode === "file" ? (
        <label
          className={`drop ${drag ? "drag" : ""} ${result ? "has" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            handleFile(e.dataTransfer.files[0]);
          }}
        >
          <input type="file" hidden onChange={(e) => handleFile(e.target.files[0])} />
          {result ? (
            <>
              <strong>📦 {result.name}</strong>
              {result.size != null && <span className="muted"> · {(result.size / 1024).toFixed(1)} KB</span>}
            </>
          ) : (
            <span className="muted">{hint} — or click to browse</span>
          )}
        </label>
      ) : (
        <input placeholder="e.g. commit:9f3c2ab or any text" onChange={(e) => handleText(e.target.value)} />
      )}
      {result && (
        <div className="computed">
          SHA-256 <Hash value={result.hash} />
        </div>
      )}
    </div>
  );
}

export function Toasts({ items, dismiss }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon">{t.kind === "pending" ? <span className="spinner" /> : t.kind === "ok" ? "✓" : "!"}</span>
          <div>
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
