// Every count-line save goes through this queue: one localStorage key per line, sent oldest first, one request
// in flight. Counts entered in a stockroom dead spot survive reload and send when the signal is back.
// Framework-free so the ordering and error rules are unit-tested (design: docs/designs/offline-count-queue.md).

export interface QueuedLine {
  lineId: string;
  sku: string;
  batchId?: string;
  counted: number;
  mode: "add" | "replace";
  capturedAt: string; // phone time at capture (ISO)
  state: "pending" | "failed";
  error?: string;
  life?: string; // page life that captured it, so a send in the same life can use the monotonic clock
  perf?: number; // performance.now() at capture
}

export type QueueStatus = "idle" | "sending" | "waiting" | "server" | "signin" | "closed" | "busy" | "nokey";

export interface QueueSnapshot {
  items: QueuedLine[]; // capture order
  status: QueueStatus;
  message?: string; // server text for signin
  persistent: boolean; // false when storage is unavailable: counts are lost if the tab closes
  deadSpot: boolean;
}

export interface SentResult {
  lineId: string;
  line: QueuedLine; // already removed from the queue when this is reported
  counted: number; // running count for the item after this line
  countedAt: string;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface QueueDeps {
  fetch: typeof fetch;
  storage: Store | null; // null → in-memory
  session: Pick<Storage, "getItem" | "setItem"> | null;
  random: () => number;
  sleep: (ms: number, wake: AbortSignal) => Promise<void>;
  lock: ((name: string, fn: () => Promise<void>) => Promise<void>) | null; // null → no other tabs to coordinate
}

const PREFIX = "bb-q:";
const RESUME = "bb-resume:";
const DEAD_SPOT = "bb-dead-spot";
const TIMEOUT_MS = 8_000;
const BASE_MS = 2_000;
const CAP_MS = 60_000;
const SERVER_TROUBLE = 5; // consecutive 5xx before the badge stops blaming the signal
const MAX_AGE_MS = 14 * 86_400_000;
const LIFE = Math.random().toString(36).slice(2);

const itemKey = (stocktakeId: string, lineId: string) => `${PREFIX}${stocktakeId}:${lineId}`;
const order = (a: QueuedLine, b: QueuedLine) => a.capturedAt.localeCompare(b.capturedAt) || a.lineId.localeCompare(b.lineId);

export function createCountQueue(stocktakeId: string, deps: QueueDeps) {
  const memory = new Map<string, string>();
  const store: Store = deps.storage ?? {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
    key: (i) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size;
    },
  };
  const listeners = new Set<() => void>();
  const waiters = new Map<string, (r: SentResult) => void>();
  const sentListeners = new Set<(r: SentResult) => void>();
  let status: QueueStatus = "idle";
  let message: string | undefined;
  let deadSpot = deps.session?.getItem(DEAD_SPOT) === "1";
  let draining = false;
  let attempt = 0;
  let serverErrors = 0;
  let wake = new AbortController();
  let snap: QueueSnapshot | null = null;

  function read(): QueuedLine[] {
    const prefix = `${PREFIX}${stocktakeId}:`;
    const raw = new Map<string, string>();
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(prefix)) raw.set(k, store.getItem(k)!);
    }
    for (const [k, v] of memory) if (k.startsWith(prefix)) raw.set(k, v); // quota overflow lives here
    const out: QueuedLine[] = [];
    for (const [k, v] of raw) {
      try {
        out.push(JSON.parse(v));
      } catch {
        store.removeItem(k); // corrupt entry: unreadable, so it cannot be sent
      }
    }
    return out.sort(order);
  }

  function changed() {
    snap = null;
    for (const fn of listeners) fn();
  }

  function snapshot(): QueueSnapshot {
    if (snap) return snap;
    const items = read();
    // Another tab may have sent the last line while this one only watched.
    const shown = !items.some((i) => i.state === "pending") && (status === "sending" || status === "waiting" || status === "server") ? "idle" : status;
    return (snap = { items, status: shown, message, persistent: deps.storage !== null, deadSpot });
  }

  function set(next: QueueStatus, msg?: string) {
    status = next;
    message = msg;
    changed();
  }

  function write(item: QueuedLine) {
    try {
      store.setItem(itemKey(stocktakeId, item.lineId), JSON.stringify(item));
    } catch {
      // Quota full: keep it in memory for this page life rather than lose it.
      memory.set(itemKey(stocktakeId, item.lineId), JSON.stringify(item));
    }
  }

  function remove(lineId: string) {
    store.removeItem(itemKey(stocktakeId, lineId));
    memory.delete(itemKey(stocktakeId, lineId));
  }

  async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
    if (deadSpot) throw new TypeError("Dead-spot demo: no signal");
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { res, body: await res.json().catch(() => null) };
  }

  async function send(item: QueuedLine) {
    // Within the page life that captured it, derive capture time from the monotonic clock (survives a phone clock
    // resync), then pin it so every resend has the same body and fingerprint.
    let capturedAt = item.capturedAt;
    if (item.life === LIFE && item.perf !== undefined) {
      capturedAt = new Date(Date.now() - (performance.now() - item.perf)).toISOString();
      write({ ...item, capturedAt, perf: undefined });
    }
    return post(
      `/api/stocktakes/${stocktakeId}/lines`,
      { commandId: item.lineId, sku: item.sku, batchId: item.batchId, counted: item.counted, mode: item.mode, capturedAt },
      { "x-sent-at": new Date().toISOString() },
    );
  }

  // Re-login gives a new session, so the server answers BUSY; the stored key takes the stocktake back at once.
  async function resume(): Promise<"ok" | "busy" | "nokey" | "retry"> {
    const key = getResumeKey(deps.storage, stocktakeId);
    if (!key) return "nokey";
    try {
      const { res, body } = await post("/api/stocktakes", { commandId: crypto.randomUUID(), resume: { stocktakeId, key } });
      if (res.ok && body?.result?._id === stocktakeId) {
        if (body.result.resumeKey) setResumeKey(deps.storage, stocktakeId, body.result.resumeKey);
        return "ok";
      }
      return res.status >= 500 || res.status === 429 ? "retry" : "busy";
    } catch {
      return "retry";
    }
  }

  async function backoff() {
    const delay = deps.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt++);
    await deps.sleep(delay, wake.signal);
  }

  async function loop() {
    for (;;) {
      const head = read().find((i) => i.state === "pending");
      if (!head) return set("idle");
      if (status !== "waiting" && status !== "server") set("sending");
      let outcome: Awaited<ReturnType<typeof send>> | null = null;
      try {
        outcome = await send(head);
      } catch {
        // dropped connection, timeout, or dead-spot demo
      }
      const { res, body } = outcome ?? {};
      const code: string | undefined = body?.error?.code;
      if (res && (res.ok || code === "COMMAND_ID_REUSED")) {
        // REUSED: the line id is only ever resent by this queue, so the server already holds this line.
        attempt = 0;
        serverErrors = 0;
        // REUSED carries no result, and a 200 body can be cut off: fall back to the line's own values.
        const r = res.ok ? body?.result : null;
        const result: SentResult = { lineId: head.lineId, line: head, counted: r?.counted ?? head.counted, countedAt: r?.countedAt ?? head.capturedAt };
        remove(head.lineId);
        waiters.get(head.lineId)?.(result);
        waiters.delete(head.lineId);
        for (const fn of sentListeners) fn(result);
        set("sending");
        continue;
      }
      if (!res || res.status >= 500 || res.status === 429) {
        if (res && res.status >= 500) serverErrors++;
        else if (!res) serverErrors = 0;
        set(serverErrors >= SERVER_TROUBLE ? "server" : "waiting");
        await backoff();
        continue;
      }
      if (res.status === 403) return set("signin", body?.error?.message);
      if (code === "STOCKTAKE_CLOSED") return set("closed");
      if (code === "STOCKTAKE_BUSY") {
        const r = await resume();
        if (r === "ok") continue;
        if (r === "retry") {
          set("waiting");
          await backoff();
          continue;
        }
        return set(r);
      }
      // Validation (BATCH_REQUIRED, …): park this line with the server's reason and keep sending the rest.
      // Each line carries its own capture time, so sending later lines first does not change fold order.
      write({ ...head, state: "failed", error: body?.error?.message ?? `Not saved (${res.status})` });
      changed();
    }
  }

  async function drain() {
    if (draining) {
      // Already running: cut the current backoff short, with a fresh signal for the next one.
      wake.abort();
      wake = new AbortController();
      return;
    }
    draining = true;
    try {
      if (deps.lock) await deps.lock(`bb-queue:${stocktakeId}`, loop);
      else await loop();
    } finally {
      draining = false;
      wake = new AbortController();
    }
  }

  function kick() {
    if (status === "closed") return;
    attempt = 0;
    if (status !== "idle") set(read().length ? "sending" : "idle");
    void drain();
  }

  return {
    snapshot,
    kick,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    onSent(fn: (r: SentResult) => void) {
      sentListeners.add(fn);
      return () => void sentListeners.delete(fn);
    },
    // Resolves when this line reaches the server (any page life; never rejects).
    enqueue(line: Omit<QueuedLine, "state" | "life" | "perf">): Promise<SentResult> {
      write({ ...line, state: "pending", life: LIFE, perf: performance.now() });
      const sent = new Promise<SentResult>((resolve) => waiters.set(line.lineId, resolve));
      if (status !== "busy" && status !== "nokey" && status !== "closed") status = "sending";
      changed();
      void drain();
      return sent;
    },
    drain,
    retry(lineId: string) {
      const item = read().find((i) => i.lineId === lineId);
      if (!item) return;
      write({ ...item, state: "pending", error: undefined });
      kick();
    },
    // Restart after a stop (sign-in, signal back, tab visible again): see kick().
    discard(lineId: string) {
      remove(lineId);
      waiters.delete(lineId);
      changed();
    },
    // Lines the server already holds (a timed-out save that arrived): drop the queued copy.
    forget(lineIds: Iterable<string>) {
      for (const id of lineIds) remove(id);
      changed();
    },
    clear() {
      for (const i of read()) remove(i.lineId);
      changed();
    },
    setDeadSpot(on: boolean) {
      deadSpot = on;
      try {
        deps.session?.setItem(DEAD_SPOT, on ? "1" : "0");
      } catch {
        // switch just won't survive a reload
      }
      changed();
      if (!on) kick();
    },
    // Another tab wrote to storage.
    refresh: changed,
  };
}

export type CountQueue = ReturnType<typeof createCountQueue>;

export function getResumeKey(storage: Store | null, stocktakeId: string): string | null {
  try {
    return JSON.parse(storage?.getItem(RESUME + stocktakeId) ?? "null")?.key ?? null;
  } catch {
    return null;
  }
}

export function setResumeKey(storage: Store | null, stocktakeId: string, key: string, now = Date.now()) {
  try {
    storage?.setItem(RESUME + stocktakeId, JSON.stringify({ key, at: now }));
  } catch {
    // no storage: a re-login will have to wait out the idle rule
  }
}

// Drops queue and resume entries older than 14 days (abandoned stocktakes).
export function sweepOld(storage: Store | null, now = Date.now()) {
  if (!storage) return;
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k?.startsWith(PREFIX) && !k?.startsWith(RESUME)) continue;
    try {
      const v = JSON.parse(storage.getItem(k!)!);
      const at = k!.startsWith(PREFIX) ? Date.parse(v.capturedAt) : v.at;
      if (!(now - at < MAX_AGE_MS)) stale.push(k!);
    } catch {
      stale.push(k!);
    }
  }
  for (const k of stale) storage.removeItem(k);
}

// Lines queued for a stocktake, read without starting a queue (e.g. the page of a stocktake already submitted).
export function queuedLines(storage: Store | null, stocktakeId: string): QueuedLine[] {
  if (!storage) return [];
  return createCountQueue(stocktakeId, { ...browserDeps(), storage, lock: null }).snapshot().items;
}

export function clearQueued(storage: Store | null, stocktakeId: string) {
  if (storage) createCountQueue(stocktakeId, { ...browserDeps(), storage, lock: null }).clear();
}

export function browserStorage(): Storage | null {
  try {
    const probe = "bb-probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function browserDeps(): QueueDeps {
  let session: Storage | null = null;
  try {
    session = sessionStorage;
  } catch {
    // blocked storage
  }
  return {
    fetch: (...a) => fetch(...a),
    storage: browserStorage(),
    session,
    random: Math.random,
    sleep: (ms, wake) =>
      new Promise((resolve) => {
        if (wake.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        wake.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      }),
    lock: typeof navigator !== "undefined" && navigator.locks
      ? async (name, fn) => void (await navigator.locks.request(name, { ifAvailable: true }, (held) => (held ? fn() : undefined)))
      : null,
  };
}
