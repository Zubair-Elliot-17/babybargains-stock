import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { when } from "@/lib/format";
import { PriceListImport } from "@/components/manage/PriceListScreen";
import styles from "@/components/manage/manage.module.css";

export const metadata = { title: "Price lists · BabyBargains Stock" };

export default async function PriceListPage({ searchParams }: { searchParams: Promise<{ supplier?: string }> }) {
  await requireManagerPage();
  const params = await searchParams;
  const c = cols(await getDb());
  const suppliers = await c.suppliers.find({}).sort({ name: 1 }).toArray();
  const supplier = suppliers.find((s) => s._id === params.supplier);
  const [products, applied] = supplier
    ? await Promise.all([
        c.products.find({ supplierId: supplier._id }, { projection: { name: 1, price: 1 } }).sort({ name: 1 }).toArray(),
        c.catalogueImports.find({ supplierId: supplier._id }).sort({ appliedAt: -1 }).limit(10).toArray(),
      ])
    : [[], []];

  return (
    <>
      <p><Link href="/orders">← Orders</Link></p>
      <h1>Supplier price lists</h1>
      <p className={styles.meta}>A supplier&apos;s price list updates the names and prices of its products. Preview it, then apply it. Demo changes are undone at the nightly reset.</p>
      <form className={styles.filters} method="get">
        <label>
          Supplier
          <select className="input" name="supplier" defaultValue={supplier?._id ?? ""} required>
            <option value="" disabled>Choose…</option>
            {suppliers.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
          </select>
        </label>
        <button className="btn" type="submit">Choose</button>
      </form>
      {supplier && (
        <>
          <PriceListImport
            key={supplier._id}
            supplierId={supplier._id}
            supplierName={supplier.name}
            adapter={supplier.adapter}
            products={products.map((p) => ({ sku: p._id, name: p.name, price: p.price }))}
          />
          {applied.length > 0 && (
            <section className={styles.section} aria-labelledby="applied">
              <h2 id="applied">Applied price lists</h2>
              <ul>
                {applied.map((a) => (
                  <li key={a._id}><span className="mono">{a.ref}</span> · {when(a.appliedAt)} UTC · {a.changes.length} product{a.changes.length === 1 ? "" : "s"} changed</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
