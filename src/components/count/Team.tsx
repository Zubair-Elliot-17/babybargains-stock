"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamMember } from "@/domain/ledger/write";
import { count } from "@/lib/plural";
import styles from "./count.module.css";

export type Member = Omit<TeamMember, "seenAt"> & { seenAt: string };
const HEARTBEAT_MS = 30_000;
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Team stocktakes (docs/designs/team-stocktakes.md): report this phone's queued counts and read the team's
// status. Beats every 30 s, and at once when a teammate's phone starts or stops holding counts, or says it's
// done (not on every save: heartbeats have their own small budget). Silent in the dead-spot demo, as a real
// dead spot would be. closed: the lead has submitted.
export function useTeam(stocktakeId: string, device: string | null, pending: number, deadSpot: boolean, done: boolean, lead: boolean) {
  const [team, setTeam] = useState<Member[]>([]);
  const [countedSkus, setCountedSkus] = useState<string[] | null>(null);
  const [closed, setClosed] = useState(false);
  const pendingNow = useRef(pending);
  useEffect(() => {
    pendingNow.current = pending;
  }, [pending]);
  const holding = !lead && pending > 0; // the lead's own queue is checked on its own screen

  useEffect(() => {
    if (!device || deadSpot || closed) return;
    const abort = new AbortController(); // an older beat must not land after a newer one
    const beat = async () => {
      try {
        const res = await fetch(`/api/stocktakes/${stocktakeId}/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: crypto.randomUUID(), deviceId: device, pending: pendingNow.current, done }),
          signal: abort.signal,
        });
        const body = await res.json().catch(() => null);
        if (res.ok) {
          setTeam(body.result.team);
          setCountedSkus(body.result.countedSkus);
        } else if (body?.error?.code === "STOCKTAKE_CLOSED") setClosed(true);
      } catch {
        // no signal (or superseded): the next beat tries again
      }
    };
    void beat();
    const t = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      abort.abort();
      clearInterval(t);
    };
  }, [stocktakeId, device, holding, deadSpot, done, closed]);
  return { team, closed, countedSkus };
}

const state = (m: Member) =>
  m.done ? "done" : m.pending > 0 ? `${count(m.pending, "count")} not sent yet` : m.waiting ? `not heard from since ${time(m.seenAt)}` : "counting";

export function TeamStatus({ team }: { team: Member[] }) {
  if (!team.length) return null;
  return (
    <section className={styles.team} aria-labelledby="team">
      <h2 id="team">Counting with you</h2>
      <ul>
        {team.map((m) => (
          <li key={m.clerkLabel} className={m.waiting ? styles.syncWarn : undefined}>{m.clerkLabel}: {state(m)}</li>
        ))}
      </ul>
    </section>
  );
}

export const waitingText = (waiting: Member[]) => waiting.map((m) => `${m.clerkLabel} (${state(m)})`).join(", ");
