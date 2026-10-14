"use client";

import { useState, useSyncExternalStore } from "react";
import { browserStorage, clearQueued, queuedLines, type QueuedLine } from "./countQueue";
import styles from "./count.module.css";

const NONE: QueuedLine[] = [];
let cache: { id: string; lines: QueuedLine[] } | null = null;
const read = (id: string) => {
  if (cache?.id !== id) cache = { id, lines: queuedLines(browserStorage(), id) };
  return cache.lines;
};

// Counts still on this phone for a stocktake that was submitted before they could be sent.
export function UnsentCounts({ stocktakeId, names }: { stocktakeId: string; names: Record<string, string> }) {
  const [cleared, setCleared] = useState(false);
  const lines = useSyncExternalStore(noop, () => read(stocktakeId), () => NONE);
  if (cleared || !lines.length) return null;
  return (
    <section className="banner" aria-label="Counts not sent">
      <p>Stocktake already submitted: these counts never reached it. Show them to your manager.</p>
      <ul>
        {lines.map((l) => (
          <li key={l.lineId}>{names[l.sku] ?? l.sku} {l.mode === "add" ? "+" : "×"} {l.counted}</li>
        ))}
      </ul>
      <button
        className={`btn ${styles.bigButton}`}
        onClick={() => {
          if (!confirm("Remove these counts from this phone?")) return;
          clearQueued(browserStorage(), stocktakeId);
          cache = null;
          setCleared(true);
        }}
      >
        Clear
      </button>
    </section>
  );
}

const noop = () => () => {};
