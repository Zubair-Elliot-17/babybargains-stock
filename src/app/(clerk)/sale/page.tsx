import { redirect } from "next/navigation";
import { cols } from "@/domain/collections";
import { currentSession } from "@/lib/command";
import { getDb } from "@/lib/db";
import { SaleScreen } from "@/components/count/SaleScreen";

export const metadata = { title: "Record sale · BabyBargains Stock" };

export default async function SalePage() {
  // A client navigation skips the layout's check, so the page checks the session itself.
  if ((await currentSession())?.role !== "clerk") redirect("/login");
  const products = await cols(await getDb()).products.find({}, { projection: { name: 1, price: 1 } }).sort({ name: 1 }).toArray();
  return <SaleScreen products={products.map((p) => ({ sku: p._id, name: p.name, price: p.price }))} />;
}
