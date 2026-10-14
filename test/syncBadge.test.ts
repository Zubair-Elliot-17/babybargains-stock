import { describe, expect, it } from "vitest";
import type { QueueSnapshot, QueuedLine } from "@/components/count/countQueue";
import { syncAnnouncement, syncText } from "@/components/count/SyncBadge";

const item = (state: QueuedLine["state"] = "pending"): QueuedLine => ({ lineId: Math.random().toString(), sku: "S", counted: 1, mode: "replace", capturedAt: "2026-10-14T09:00:00Z", state });
const snap = (over: Partial<QueueSnapshot>): QueueSnapshot => ({ items: [], status: "idle", persistent: true, deadSpot: false, ...over });

describe("sync status text", () => {
  it.each([
    [snap({}), "All counts saved", "ok"],
    [snap({ items: [item(), item(), item()], status: "waiting" }), "3 counts waiting for signal", "warn"],
    [snap({ items: [item()], status: "sending" }), "Sending 1 count…", "warn"],
    [snap({ items: [item(), item()], status: "server" }), "Server problem, 2 counts kept, retrying", "warn"],
    [snap({ items: [item()], status: "signin", message: "Sign in to continue" }), "Sign in to send 1 count", "warn"],
    [snap({ items: [item()], status: "signin", message: "Not allowed for this role" }), "Not allowed for this role. 1 count kept", "warn"],
    [snap({ items: [item()], status: "closed" }), "Stocktake already submitted: 1 count not sent. Show them to your manager", "warn"],
    [snap({ items: [item()], status: "busy" }), "Being counted on another device: 1 count kept on this phone", "warn"],
    [snap({ items: [item()], status: "nokey" }), "Can't resume on this phone yet: 1 count kept. Wait 2 hours idle or ask a manager", "warn"],
    [snap({ items: [item("failed"), item("failed")] }), "2 not saved, see above", "warn"],
    [snap({ items: [item()], status: "waiting", deadSpot: true }), "Dead-spot demo on · 1 count waiting for signal", "warn"],
    [snap({ deadSpot: true }), "Dead-spot demo on · All counts saved", "ok"],
  ] as const)("%#: %s", (s, text, tone) => {
    expect(syncText(s)).toEqual({ text, tone });
  });

  it("announces state changes, not each count", () => {
    expect(syncAnnouncement(snap({ items: [item(), item()], status: "sending" }))).toBe("Sending counts");
    expect(syncAnnouncement(snap({ items: [item()], status: "sending" }))).toBe("Sending counts");
    expect(syncAnnouncement(snap({}))).toBe("All counts saved");
    expect(syncAnnouncement(snap({ items: [item("failed")] }))).toBe("");
  });
});
