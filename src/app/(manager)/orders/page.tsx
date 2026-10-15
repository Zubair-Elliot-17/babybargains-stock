import Link from "next/link";
import { requireManagerPage } from "@/auth/session";
import { cols } from "@/domain/collections";
import { listPurchaseOrders, suggestOrderLines } from "@/domain/ledger/orders";
import { getDb } from "@/lib/db";
import { when } from "@/lib/format";
import { NewOrder, OrderActions } from "@/components/manage/OrdersScreen";
import styles from "@/components/manage/manage.module.css";

export const metadata = { title: "Orders · BabyBargains Stock" };

const STATUS = { SENT: "Sent", PARTIAL: "Part received", RECEIVED: "Received", CANCELLED: "Cancelled" } as const;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ branch?: string; supplier?: string; created?: string }> }) {
  await requireManagerPage();
  const params = await searchParams;
  const db = await getDb();
  const c = cols(db);
  const [branches, suppliers, orders] = await Promise.all([
    c.branches.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray(),
    c.suppliers.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray(),
    listPurchaseOrders(db),
  ]);
  const branch = branches.find((b) => b._id === params.branch);
  const supplier = suppliers.find((s) => s._id === params.supplier);
  const [suggestions, catalogue] = branch && supplier
    ? await Promise.all([
        suggestOrderLines(db, branch._id, supplier._id),
        c.products.find({ supplierId: supplier._id }, { projection: { name: 1 } }).sort({ name: 1 }).toArray(),
      ])
    : [[], []];
  const open = orders.filter((o) => o.status === "SENT" || o.status === "PARTIAL").length;

  return (
    <>
      <h1>Orders{open ? ` · ${open} open` : ""}</h1>
      {orders.some((o) => o._id === params.created) && <p className="banner" role="status">Order {params.created} sent.</p>}

      <section className={styles.section} aria-labelledby="new-order">
        <h2 id="new-order">New order</h2>
        <form className={styles.filters} method="get">
          <label>
            Branch
            <select className="input" name="branch" defaultValue={branch?._id ?? ""} required>
              <option value="" disabled>Choose…</option>
              {branches.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
          </label>
          <label>
            Supplier
            <select className="input" name="supplier" defaultValue={supplier?._id ?? ""} required>
              <option value="" disabled>Choose…</option>
              {suppliers.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
            </select>
          </label>
          <button className="btn" type="submit">Suggest lines</button>
        </form>
        {branch && supplier && (
          <NewOrder
            key={`${branch._id}|${supplier._id}`}
            branchId={branch._id}
            supplierId={supplier._id}
            suggestions={suggestions}
            catalogue={catalogue.map((p) => ({ sku: p._id, name: p.name }))}
          />
        )}
      </section>

      <section className={styles.section} aria-labelledby="order-list">
        <h2 id="order-list">Recent orders</h2>
        {orders.length === 0 ? (
          <p className={styles.meta}>No orders yet. Orders placed in the demo are cleared at the nightly reset.</p>
        ) : (
          <div className={styles.scroll}>
            <table className="cards">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Branch</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Sent</th>
                  <th scope="col" className="num">Received</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const ordered = o.lines.reduce((n, l) => n + l.ordered, 0);
                  const received = o.lines.reduce((n, l) => n + l.received, 0);
                  return (
                    <tr key={o._id}>
                      <th scope="row" className="mono">{o._id}</th>
                      <td data-label="Branch">{o.branchName}</td>
                      <td data-label="Supplier">{o.supplierName}</td>
                      <td data-label="Sent">{when(o.sentAt)} UTC</td>
                      <td className="num" data-label="Received">{received} of {ordered}</td>
                      <td data-label="Status">{STATUS[o.status]}</td>
                      <td><OrderActions key={`${o._id}:${received}:${o.status}`} order={o} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className={styles.meta}><Link href="/analytics">Analytics</Link> shows overdue orders, lead time and fill rate. <Link href="/orders/price-list">Supplier price lists</Link> update product names and prices.</p>
    </>
  );
}
