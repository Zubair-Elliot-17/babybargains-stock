import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { findRecall, recentRecalls, suggestBatchCodes } from "@/domain/ledger/read";
import { getDb } from "@/lib/db";
import { RecallScreen, type RecallData } from "@/components/recall/RecallScreen";
import styles from "@/components/recall/recall.module.css";

export const metadata = { title: "Recall · BabyBargains Stock" };

async function load(batch: string) {
  const db = await getDb();
  const view = await findRecall(db, batch);
  if (view) return { view, now: Date.now() }; // request time anchors "today" on the slider
  const [suggestions, recent] = await Promise.all([suggestBatchCodes(db, batch), recentRecalls(db)]);
  return { suggestions, recent };
}

export default async function RecallPage({ searchParams }: { searchParams: Promise<{ batch?: string }> }) {
  await requireManagerPage();
  const batch = (await searchParams).batch?.trim();
  if (!batch) {
    const recent = await recentRecalls(await getDb());
    return (
      <>
        <h1>Recall</h1>
        <SearchForm />
        <RecentRecalls recent={recent} />
      </>
    );
  }

  let loaded: Awaited<ReturnType<typeof load>>;
  try {
    loaded = await load(batch);
  } catch {
    return (
      <>
        <h1>Recall</h1>
        <SearchForm value={batch} />
        <p className="banner banner-error" role="alert">
          Couldn&apos;t load. <Link href={`/recall?batch=${encodeURIComponent(batch)}`}>Retry</Link>
        </p>
      </>
    );
  }

  if (!loaded.view) {
    return (
      <>
        <h1>Recall</h1>
        <SearchForm value={batch} />
        <p className="banner" role="status">
          No batch <span className="mono">{batch.toUpperCase()}</span> found.
          {loaded.suggestions!.length > 0 && (
            <>
              {" "}Did you mean{" "}
              {loaded.suggestions!.map((s, i) => (
                <span key={s}>
                  {i > 0 && ", "}
                  <Link className="mono" href={`/recall?batch=${s}`}>{s}</Link>
                </span>
              ))}
              ?
            </>
          )}
        </p>
        <RecentRecalls recent={loaded.recent!} />
      </>
    );
  }

  const v = loaded.view;
  const data: RecallData = {
    batchCode: v.batchCode,
    supplierName: v.supplierName,
    status: v.batches.every((b) => b.status === "RECALLED") ? "RECALLED" : "ACTIVE",
    recalledAt: v.batches.map((b) => b.recalledAt?.toISOString()).filter(Boolean).sort().at(-1) ?? null,
    receivedAt: v.batches.map((b) => b.receivedAt.toISOString()).sort()[0],
    productName: commonName(v.products.map((p) => p.name)),
    variants: v.products.length,
    branches: Object.fromEntries(v.branches.map((b) => [b._id, b.name])),
    movements: v.movements,
    lastCountedAt: v.lastCountedAt,
    now: loaded.now!,
  };
  return (
    <>
      <SearchForm value={v.batchCode} compact />
      <RecallScreen data={data} />
    </>
  );
}

// "Dreamtime Cot 120 · Oak" + "Dreamtime Cot 120 · White" → "Dreamtime Cot 120 (all variants)".
function commonName(names: string[]): string {
  const base = names[0]?.split(" · ")[0] ?? "";
  return names.length > 1 ? `${base} (all variants)` : (names[0] ?? base);
}

function SearchForm({ value, compact }: { value?: string; compact?: boolean }) {
  return (
    <form className={compact ? styles.searchCompact : styles.search} action="/recall" method="get" role="search">
      <label htmlFor="batch">Batch code</label>
      <div className={styles.searchRow}>
        <input id="batch" name="batch" className="input mono" defaultValue={value} placeholder="e.g. B-4471" autoComplete="off" required maxLength={40} />
        <button className="btn btn-primary" type="submit">Find batch</button>
      </div>
    </form>
  );
}

function RecentRecalls({ recent }: { recent: { batchCode: string; recalledAt: Date }[] }) {
  return (
    <section>
      <h2>Recent recalls</h2>
      {recent.length === 0 ? (
        <p className={styles.muted}>No batches have been recalled. Try the example batch <Link className="mono" href="/recall?batch=B-4471">B-4471</Link>.</p>
      ) : (
        <ul className={styles.recent}>
          {recent.map((r) => (
            <li key={r.batchCode}>
              <Link className="mono" href={`/recall?batch=${r.batchCode}`}>{r.batchCode}</Link>{" "}
              <span className={styles.muted}>quarantined {r.recalledAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
            </li>
          ))}
          <li>
            <Link className="mono" href="/recall?batch=B-4471">B-4471</Link> <span className={styles.muted}>example active batch</span>
          </li>
        </ul>
      )}
    </section>
  );
}
