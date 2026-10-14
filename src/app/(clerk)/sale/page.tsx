import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";
import { SaleScreen } from "@/components/count/SaleScreen";

export const metadata = { title: "Record sale · BabyBargains Stock" };

export default async function SalePage() {
  const products = await cols(await getDb()).products.find({}, { projection: { name: 1, price: 1 } }).sort({ name: 1 }).toArray();
  return <SaleScreen products={products.map((p) => ({ sku: p._id, name: p.name, price: p.price }))} />;
}
