"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DAY, foldMovements, startOfDay, timelineEvents, type CompactMovement, type EventKind } from "@/domain/ledger/fold";
import { AnimatedNumber } from "./AnimatedNumber";
import { QuarantineDialog } from "./QuarantineDialog";
import { count } from "@/lib/plural";
import styles from "./recall.module.css";

export interface RecallData {
  batchCode: string;
  supplierName: string;
  status: "ACTIVE" | "RECALLED";
  recalledAt: string | null;
  receivedAt: string;
  productName: string;
  variants: number;
  branches: Record<string, string>;
  movements: CompactMovement[];
  lastCountedAt: Record<string, string>;
  now: number;
}

const GLYPH: Record<EventKind, string> = { delivery: "●", transfer: "◆", stocktake: "■", recall: "✕" };
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function RecallScreen({ data }: { data: RecallData }) {
  const router = useRouter();
  const first = startOfDay(data.movements[0]?.at ?? data.now);
  const today = startOfDay(data.now);
  const maxDay = Math.max(0, Math.round((today - first) / DAY));
  const [day, setDay] = useState(maxDay);
  const [playing, setPlaying] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const isToday = day >= maxDay;
  const asOf = isToday ? Number.POSITIVE_INFINITY : first + day * DAY + DAY - 1;

  const recalledAt = data.recalledAt ? Date.parse(data.recalledAt) : undefined;
  const state = useMemo(() => foldMovements(data.movements, asOf, recalledAt), [data.movements, asOf, recalledAt]);
  const events = useMemo(() => timelineEvents(data.movements), [data.movements]);
  const eventDays = useMemo(() => [...new Set(events.map((e) => Math.round((e.day - first) / DAY)))].sort((a, b) => a - b), [events, first]);

  // Play sweeps 10 days per second.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setDay((d) => {
        if (d >= maxDay) {
          setPlaying(false);
          return maxDay;
        }
        return Math.min(maxDay, d + 1);
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, maxDay]);

  // Announce totals 500 ms after scrubbing stops.
  useEffect(() => {
    const t = setTimeout(() => {
      setAnnounce(`As of ${isToday ? "today" : fmtDay(first + day * DAY)}: ${state.totals.onHand} on shelf, ${state.totals.sold} sold, ${state.totals.quarantined} quarantined`);
    }, 500);
    return () => clearTimeout(t);
  }, [day, isToday, first, state.totals]);

  const jump = (dir: 1 | -1) => {
    const next = dir > 0 ? eventDays.find((d) => d > day) : [...eventDays].reverse().find((d) => d < day);
    setDay(next ?? (dir > 0 ? maxDay : 0));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      setDay((d) => Math.max(0, Math.min(maxDay, d + (e.key === "PageUp" ? 7 : -7))));
    }
  };

  // A branch's figure is "counted" only if nothing traded after its latest approved count.
  const lastTrade = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of data.movements) if (x.type !== "ADJUSTMENT") m.set(x.branchId, Math.max(m.get(x.branchId) ?? 0, x.at));
    return m;
  }, [data.movements]);
  const countedNow = (branchId: string) => {
    const iso = data.lastCountedAt[branchId];
    return iso ? (lastTrade.get(branchId) ?? 0) <= Date.parse(iso) : false;
  };

  const recalled = data.status === "RECALLED";
  const shelfLabel = Object.keys(data.lastCountedAt).length ? "On shelf (counted where dated)" : "On shelf (expected)";
  const rows = state.branches.filter((b) => b.received + b.transferredIn > 0);

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <div>
          <h1>
            Recall · <span className="mono">{data.batchCode}</span>
          </h1>
          <p className={styles.meta}>
            {data.productName} · <span className={`pill ${recalled ? "pill-recalled" : "pill-active"}`}>{recalled ? "RECALLED" : "ACTIVE"}</span> · {data.supplierName} · received {fmtShort(Date.parse(data.receivedAt))}
            {data.variants > 1 && ` · ${data.variants} variant SKUs`}
          </p>
        </div>
        <div className={styles.action}>
          {recalled ? (
            <button className="btn" disabled>Quarantined {data.recalledAt ? fmtShort(Date.parse(data.recalledAt)) : ""}</button>
          ) : isToday ? (
            <button className="btn btn-recall" onClick={() => setDialogOpen(true)}>Quarantine batch everywhere</button>
          ) : (
            <button className="btn" onClick={() => setDay(maxDay)}>Back to today to quarantine</button>
          )}
          {!recalled && isToday && (
            <span className={styles.actionHint}>
              Pulls {count(state.totals.onHand, "unit")} from {count(state.branches.filter((b) => b.onHand > 0).length, "branch", "branches")}
            </span>
          )}
        </div>
      </header>

      <dl className={styles.strip} aria-describedby="strip-legend">
        <Stat label="Received" value={state.totals.received} />
        <Stat label="Sold" sub="FIFO-attributed" value={state.totals.sold} estimated tip="Estimated: tills don't record batches, so sales are assigned oldest batch first." />
        <Stat label="On shelf" sub="expected" value={state.totals.onHand} estimated tip="Estimated from the ledger. Shown solid with a date once a batch-level stocktake confirms it." />
        <Stat
          label="Quarantined"
          sub={state.totals.found ? `includes ${state.totals.found} found in a stocktake` : undefined}
          value={state.totals.quarantined}
          tone={state.totals.quarantined ? "recall" : undefined}
        />
      </dl>
      <p id="strip-legend" className={styles.legend}>
        <span className="estimated">Dotted</span> = estimated from the ledger · solid = recorded or counted
      </p>
      <p className="sr-only" aria-live="polite">{announce}</p>

      <section className={styles.timeline} aria-label="Batch history">
        <div className={styles.timelineHead}>
          {!isToday && <span className={styles.chip}>Viewing {fmtDay(first + day * DAY)}</span>}
          <span className={styles.asOf}>As of {isToday ? "today" : fmtDay(first + day * DAY)}</span>
          <div className={styles.controls}>
            <button className="btn" onClick={() => jump(-1)} aria-label="Previous event">‹ Prev event</button>
            <button className="btn" onClick={() => jump(1)} aria-label="Next event">Next event ›</button>
            <button
              className="btn"
              onClick={() => {
                if (!playing && day >= maxDay) setDay(0);
                setPlaying((p) => !p);
              }}
              aria-pressed={playing}
            >
              {playing ? "Pause" : "Play"}
            </button>
          </div>
        </div>
        <div className={styles.track}>
          <div className={styles.ticks} aria-hidden>
            {events.map((e) => {
              const left = maxDay ? ((e.day - first) / DAY / maxDay) * 100 : 0;
              return (
                <span key={`${e.day}-${e.kind}`} className={`${styles.tick} ${styles[e.kind]}`} style={{ left: `${left}%` }} title={`${fmtDay(e.day)}: ${e.label}`}>
                  {GLYPH[e.kind]}
                </span>
              );
            })}
          </div>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={maxDay}
            step={1}
            value={day}
            onChange={(e) => {
              setPlaying(false);
              setDay(Number(e.target.value));
            }}
            onKeyDown={onKeyDown}
            aria-label="Replay date"
            aria-valuetext={fmtDay(first + day * DAY)}
          />
          <div className={styles.trackEnds}>
            <span>{fmtShort(first)}</span>
            <span>Today</span>
          </div>
        </div>
        <p className={styles.legend}>● delivery · ◆ transfer · ■ stocktake · ✕ quarantine · ←/→ 1 day, PgUp/PgDn 1 week</p>
      </section>

      <section aria-label="Branches">
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Branch</th>
              <th scope="col" className="num">Received</th>
              <th scope="col" className="num">Transferred</th>
              <th scope="col" className="num">Sold</th>
              <th scope="col" className="num">{shelfLabel}</th>
              <th scope="col" className="num">Quarantined</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const net = b.transferredIn - b.transferredOut;
              const counted = data.lastCountedAt[b.branchId];
              const solid = isToday && countedNow(b.branchId);
              return (
                <tr key={b.branchId}>
                  <th scope="row">{data.branches[b.branchId] ?? b.branchId}</th>
                  <td className="num" data-label="Received">{b.received}</td>
                  <td className="num" data-label="Transferred">{net > 0 ? `+${net}` : net}</td>
                  <td className="num" data-label="Sold"><span className="estimated" title="FIFO-attributed">{b.sold}</span><span className="sr-only"> estimated</span></td>
                  <td className="num" data-label="On shelf">
                    {solid ? b.onHand : <><span className="estimated" title="Expected from the ledger">{b.onHand}</span><span className="sr-only"> estimated</span></>}
                  </td>
                  <td className="num" data-label="Quarantined">
                    {b.quarantined || "–"}
                    {b.found > 0 && <span className={styles.found}> incl. {b.found} found</span>}
                  </td>
                  <td data-label="Status">{counted ? `counted ${fmtShort(Date.parse(counted))}${solid ? "" : " · trading since"}` : "expected"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className={styles.muted}>No branch had received this batch by {fmtDay(first + day * DAY)}.</p>}
      </section>

      {dialogOpen && (
        <QuarantineDialog
          batchCode={data.batchCode}
          units={state.totals.onHand}
          branches={state.branches.filter((b) => b.onHand > 0).length}
          branchNames={data.branches}
          onClose={(changed) => {
            setDialogOpen(false);
            if (changed) router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat(props: { label: string; value: number; sub?: string; estimated?: boolean; tip?: string; tone?: "recall" }) {
  return (
    <div className={styles.stat}>
      <dt>
        {props.label}
        {props.sub && <span className={styles.statSub}> {props.sub}</span>}
      </dt>
      <dd className={props.tone === "recall" ? styles.recallTone : undefined}>
        <span className={props.estimated ? "estimated" : undefined} title={props.tip}>
          <AnimatedNumber value={props.value} />
        </span>
        {props.estimated && <span className="sr-only"> estimated</span>}
      </dd>
    </div>
  );
}
