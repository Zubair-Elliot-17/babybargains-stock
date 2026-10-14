import { describe, expect, it } from "vitest";
import { createCountQueue, getResumeKey, setResumeKey, sweepOld, type QueueDeps } from "@/components/count/countQueue";

// Queue rules without a browser: scripted fetch, Map-backed storage, instant backoff.

function memStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

type Reply = { status: number; body?: unknown } | "drop";
const ok = (counted: number) => ({ status: 200, body: { result: { counted, countedAt: "2026-10-14T09:00:00.000Z" } } });
const err = (status: number, code: string, message = code) => ({ status, body: { error: { code, message } } });

function setup(replies: Reply[], over: Partial<QueueDeps> = {}) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const storage = memStorage();
  let sleeps = 0;
  const deps: QueueDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      const r = replies.shift() ?? ok(0);
      if (r === "drop") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }) as typeof fetch,
    storage,
    session: memStorage(),
    random: () => 0.5,
    // Instant backoff, but park after many retries so an offline test can't spin forever.
    sleep: (_ms, wake) => (++sleeps > 20 ? new Promise((r) => wake.addEventListener("abort", () => r(), { once: true })) : Promise.resolve()),
    lock: null,
    ...over,
  };
  const q = createCountQueue("ST-1", deps);
  return { q, calls, storage, deps, lines: () => calls.filter((c) => c.url.endsWith("/lines")) };
}

let n = 0;
const line = (sku = "TOY", capturedAt = `2026-10-14T09:00:${String(n % 60).padStart(2, "0")}.000Z`) => ({
  lineId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, sku, counted: 1, mode: "replace" as const, capturedAt,
});
const settle = () => new Promise((r) => setTimeout(r, 0));
const idle = async (q: ReturnType<typeof setup>["q"]) => {
  for (let i = 0; i < 50 && (await settle(), true); i++) if (!["sending", "waiting", "server"].includes(q.snapshot().status)) return;
};

describe("count queue", () => {
  it("sends one line at a time in capture order and removes each on success", async () => {
    const { q, lines, storage } = setup([ok(3), ok(5)]);
    const b = line("B", "2026-10-14T09:00:02.000Z");
    const a = line("A", "2026-10-14T09:00:01.000Z");
    q.enqueue(b);
    const sentA = q.enqueue(a);
    await idle(q);
    expect(lines().map((c) => c.body.sku)).toEqual(["B", "A"]); // B was already in flight when A arrived
    expect(await sentA).toMatchObject({ lineId: a.lineId, counted: 5, line: expect.objectContaining({ sku: "A", counted: 1 }) });
    expect(storage.m.size).toBe(0);
    expect(q.snapshot()).toMatchObject({ items: [], status: "idle" });
  });

  it("pins the capture time at the first send so a resend has the same body", async () => {
    const { q, lines } = setup(["drop", ok(1)]);
    q.enqueue(line());
    await idle(q);
    expect(lines()).toHaveLength(2);
    expect(lines()[1].body).toEqual(lines()[0].body);
  });

  it("sends the capture time in the body and the send time in a header", async () => {
    const { q, lines } = setup([ok(1)]);
    q.enqueue(line());
    await idle(q);
    expect(lines()[0].body.capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(lines()[0].headers["x-sent-at"]).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("after a reload, sends lines from the earlier page life in capture order with their stored times", async () => {
    const { storage, deps } = setup([]);
    // Written by an earlier page life (no life/perf), in reverse order of capture.
    for (const [sku, at] of [["B", "2026-10-14T09:00:02.000Z"], ["A", "2026-10-14T09:00:01.000Z"]] as const) {
      const l = { ...line(sku, at), state: "pending" };
      storage.setItem(`bb-q:ST-1:${l.lineId}`, JSON.stringify(l));
    }
    const sent: string[] = [];
    const reloaded = createCountQueue("ST-1", { ...deps, fetch: (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      sent.push(`${b.sku}@${b.capturedAt}`);
      return new Response(JSON.stringify(ok(1).body), { status: 200 });
    }) as typeof fetch });
    expect(reloaded.snapshot().items.map((i) => i.sku)).toEqual(["A", "B"]);
    await reloaded.drain();
    expect(sent).toEqual(["A@2026-10-14T09:00:01.000Z", "B@2026-10-14T09:00:02.000Z"]);
    expect(storage.m.size).toBe(0);
  });

  it("the dead-spot switch survives a reload", () => {
    const { q, deps } = setup([], { lock: async () => {} });
    q.setDeadSpot(true);
    expect(createCountQueue("ST-1", deps).snapshot().deadSpot).toBe(true);
  });

  it("treats COMMAND_ID_REUSED as saved (a timed-out save that reached the server)", async () => {
    const { q, storage } = setup([err(409, "COMMAND_ID_REUSED")]);
    const l = line();
    const sent = q.enqueue(l);
    await idle(q);
    expect(await sent).toMatchObject({ lineId: l.lineId, counted: 1 });
    expect(storage.m.size).toBe(0);
  });

  it("keeps lines through dropped connections and 5xx, retries, and loses nothing enqueued mid-drain", async () => {
    const { q, lines, storage } = setup(["drop", err(503, "X"), ok(1), ok(2)]);
    q.enqueue(line("A"));
    q.enqueue(line("B")); // lands while A is retrying
    await idle(q);
    expect(lines().map((c) => c.body.sku)).toEqual(["A", "A", "A", "B"]);
    expect(storage.m.size).toBe(0);
  });

  it("says server problem after five straight 5xx, not 'waiting for signal'", async () => {
    const { q } = setup(Array.from({ length: 5 }, () => err(500, "INTERNAL")).concat(Array(30).fill(err(500, "INTERNAL"))));
    q.enqueue(line());
    await idle(q);
    expect(q.snapshot().status).toBe("server");
  });

  it("dead-spot switch fails sends without the network and drains when turned off", async () => {
    const { q, lines, deps } = setup([ok(1)]);
    q.setDeadSpot(true);
    q.enqueue(line());
    await idle(q);
    expect(lines()).toHaveLength(0);
    expect(q.snapshot()).toMatchObject({ status: "waiting", deadSpot: true });
    expect(deps.session!.getItem("bb-dead-spot")).toBe("1");
    q.setDeadSpot(false);
    await idle(q);
    expect(lines()).toHaveLength(1);
    expect(q.snapshot()).toMatchObject({ items: [], status: "idle" });
  });

  it("pauses on 403 with the server's message and resumes on kick", async () => {
    const { q, storage } = setup([err(403, "FORBIDDEN", "Sign in to continue"), ok(1)]);
    q.enqueue(line());
    await idle(q);
    expect(q.snapshot()).toMatchObject({ status: "signin", message: "Sign in to continue" });
    expect(storage.m.size).toBe(1);
    q.kick();
    await idle(q);
    expect(q.snapshot()).toMatchObject({ status: "idle", items: [] });
  });

  it("stops on STOCKTAKE_CLOSED, keeps the lines, and clears them on request", async () => {
    const { q, storage } = setup([err(409, "STOCKTAKE_CLOSED")]);
    q.enqueue(line());
    q.enqueue(line());
    await idle(q);
    expect(q.snapshot()).toMatchObject({ status: "closed" });
    expect(q.snapshot().items).toHaveLength(2);
    q.kick();
    expect(q.snapshot().status).toBe("closed");
    q.clear();
    expect(storage.m.size).toBe(0);
  });

  it("on STOCKTAKE_BUSY resumes with the stored key, stores the rotated key, and carries on", async () => {
    const { q, calls, storage } = setup([
      err(409, "STOCKTAKE_BUSY"),
      { status: 200, body: { result: { _id: "ST-1", resumeKey: "key-2" } } },
      ok(1),
    ]);
    setResumeKey(storage, "ST-1", "key-1");
    q.enqueue(line());
    await idle(q);
    expect(calls.map((c) => c.url)).toEqual(["/api/stocktakes/ST-1/lines", "/api/stocktakes", "/api/stocktakes/ST-1/lines"]);
    expect(calls[1].body.resume).toEqual({ stocktakeId: "ST-1", key: "key-1" });
    expect(getResumeKey(storage, "ST-1")).toBe("key-2");
    expect(q.snapshot()).toMatchObject({ status: "idle", items: [] });
  });

  it("stops with 'nokey' when no key is stored and 'busy' when the key is refused", async () => {
    const a = setup([err(409, "STOCKTAKE_BUSY")]);
    a.q.enqueue(line());
    await idle(a.q);
    expect(a.q.snapshot()).toMatchObject({ status: "nokey" });
    expect(a.q.snapshot().items).toHaveLength(1);

    const b = setup([err(409, "STOCKTAKE_BUSY"), err(409, "STOCKTAKE_BUSY")]);
    setResumeKey(b.storage, "ST-1", "old");
    b.q.enqueue(line());
    await idle(b.q);
    expect(b.q.snapshot()).toMatchObject({ status: "busy" });
  });

  it("parks a line the server rejects as invalid, sends the rest, and supports retry and discard", async () => {
    const { q, lines } = setup([err(400, "BATCH_REQUIRED", "Scan or pick the batch"), ok(1), ok(2)]);
    const bad = line("COT");
    q.enqueue(bad);
    q.enqueue(line("TOY"));
    await idle(q);
    expect(lines().map((c) => c.body.sku)).toEqual(["COT", "TOY"]);
    expect(q.snapshot().items).toEqual([expect.objectContaining({ lineId: bad.lineId, state: "failed", error: "Scan or pick the batch" })]);
    q.retry(bad.lineId);
    await idle(q);
    expect(q.snapshot().items).toEqual([]);

    const other = setup([err(400, "BATCH_MISMATCH")]);
    const x = line();
    other.q.enqueue(x);
    await idle(other.q);
    other.q.discard(x.lineId);
    expect(other.q.snapshot().items).toEqual([]);
  });

  it("works in memory when storage is unavailable and says so", async () => {
    const { q, lines } = setup([ok(1)], { storage: null });
    expect(q.snapshot().persistent).toBe(false);
    q.enqueue(line());
    await idle(q);
    expect(lines()).toHaveLength(1);
    expect(q.snapshot().items).toEqual([]);
  });

  it("does not send from a tab that can't take the lock", async () => {
    const { q, lines } = setup([ok(1)], { lock: async () => {} });
    q.enqueue(line());
    await idle(q);
    expect(lines()).toHaveLength(0);
    expect(q.snapshot().items).toHaveLength(1);
  });

  it("forget drops lines the server already holds", () => {
    const { q, deps } = setup([], { lock: async () => {} });
    const l = line();
    q.enqueue(l);
    q.forget([l.lineId]);
    expect(q.snapshot().items).toEqual([]);
    expect(deps.storage!.length).toBe(0);
  });
});

describe("backoff wake-up", () => {
  it("turning the dead-spot switch off wakes a backoff even after earlier interrupts", async () => {
    const sleeps: AbortSignal[] = [];
    const { q, lines } = setup([ok(1), ok(2), ok(3)], {
      // Real-like sleep: only an abort ends it early.
      sleep: (_ms, wake) => new Promise((r) => {
        sleeps.push(wake);
        if (wake.aborted) return r();
        wake.addEventListener("abort", () => r(), { once: true });
      }),
    });
    q.setDeadSpot(true);
    q.enqueue(line("A"));
    await settle();
    q.enqueue(line("B")); // interrupts the first backoff
    await settle();
    q.enqueue(line("C")); // and the next
    await settle();
    expect(sleeps.at(-1)!.aborted).toBe(false); // the current backoff can still be woken
    q.setDeadSpot(false);
    await idle(q);
    expect(lines().map((c) => c.body.sku)).toEqual(["A", "B", "C"]);
  });

  it("an unreadable 200 body still counts the line as sent and keeps draining", async () => {
    const { q, lines } = setup([{ status: 200, body: null as unknown as undefined }, ok(2)]);
    const a = line("A");
    const sent = q.enqueue(a);
    q.enqueue(line("B"));
    await idle(q);
    expect(await sent).toMatchObject({ lineId: a.lineId, counted: 1 });
    expect(lines()).toHaveLength(2);
    expect(q.snapshot().items).toEqual([]);
  });
});

describe("sweepOld", () => {
  it("removes queue and resume entries older than 14 days", () => {
    const s = memStorage();
    const now = Date.parse("2026-10-30T00:00:00Z");
    s.setItem("bb-q:ST-1:a", JSON.stringify({ capturedAt: "2026-10-01T00:00:00Z" }));
    s.setItem("bb-q:ST-2:b", JSON.stringify({ capturedAt: "2026-10-29T00:00:00Z" }));
    setResumeKey(s, "ST-1", "k", now - 15 * 86_400_000);
    setResumeKey(s, "ST-2", "k", now);
    s.setItem("bb-batch:X", "keep");
    sweepOld(s, now);
    expect([...s.m.keys()].sort()).toEqual(["bb-batch:X", "bb-q:ST-2:b", "bb-resume:ST-2"]);
  });
});
