import { count as plural } from "@/lib/plural";
import type { QueueSnapshot } from "./countQueue";
import styles from "./count.module.css";

// Footer status line text for the count queue (design 1A); kept apart from CountScreen so every state has a test.
export function syncText(snap: QueueSnapshot): { text: string; tone: "ok" | "warn" } {
  const pending = snap.items.filter((i) => i.state === "pending").length;
  const failed = snap.items.length - pending;
  const n = plural(pending, "count");
  const base = ((): string => {
    switch (snap.status) {
      // 403 is usually an expired session; any other reason the server gives is shown as is.
      case "signin": return snap.message && snap.message !== "Sign in to continue" ? `${snap.message}. ${n} kept` : `Sign in to send ${n}`;
      case "closed": return `Stocktake already submitted: ${n} not sent. Show them to your manager`;
      case "busy": return `Being counted on another device: ${n} kept on this phone`;
      case "nokey": return `Can't resume on this phone yet: ${n} kept. Join the team from Count, wait 2 hours idle, or ask a manager`;
      case "server": return `Server problem, ${n} kept, retrying`;
      case "waiting": return `${n} waiting for signal`;
      case "sending": return pending ? `Sending ${n}…` : "";
      default: return "";
    }
  })();
  const parts = [snap.deadSpot ? "Dead-spot demo on" : "", base, failed ? `${failed} not saved, see above` : ""].filter(Boolean);
  if (!pending && !failed) return { text: [snap.deadSpot ? "Dead-spot demo on" : "", "All counts saved"].filter(Boolean).join(" · "), tone: "ok" };
  return { text: parts.join(" · "), tone: "warn" };
}

// What a screen reader hears: only changes of state, not every count sent (design 7A).
export function syncAnnouncement(snap: QueueSnapshot): string {
  if (!snap.items.some((i) => i.state === "pending")) return snap.items.length ? "" : "All counts saved";
  return { idle: "", sending: "Sending counts", waiting: "Counts waiting for signal", server: "Server problem, counts kept",
    signin: "Sending paused: sign in", closed: "Stocktake already submitted", busy: "Sending stopped: counted on another device",
    nokey: "Sending stopped: can't resume on this phone" }[snap.status];
}

export function SyncBadge({ snap, id }: { snap: QueueSnapshot; id: string }) {
  const { text, tone } = syncText(snap);
  return (
    <p id={id} className={tone === "ok" ? styles.sync : `${styles.sync} ${styles.syncWarn}`}>{text}</p>
  );
}
