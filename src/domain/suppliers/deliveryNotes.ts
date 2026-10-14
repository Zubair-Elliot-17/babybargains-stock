import { z } from "zod";

// One small adapter per supplier delivery-note format (suppliers.adapter). Pure and client-safe: the
// Orders screen parses a note in the browser to fill the receive form, which the manager checks and
// records through the normal receive command.

export interface DeliveryNote {
  noteId: string; // the supplier's own reference; an order refuses the same note twice
  orderRef: string;
  lines: { sku: string; qty: number; batchCode: string }[];
}

interface Adapter {
  label: string; // the format, in words, for the screen
  parse(json: unknown): DeliveryNote;
  example(order: { _id: string; lines: { sku: string; qty: number }[] }, ref: string): unknown;
}

const Ref = z.string().trim().min(1).max(60);
const Sku = z.string().trim().min(1).max(80);
const Qty = z.coerce.number().int().min(0).max(9999);
const Code = z.string().trim().max(60);

const littleOak = z.object({ deliveryNote: Ref, purchaseOrder: Ref, items: z.array(z.object({ code: Sku, quantity: Qty, batch: Code })).min(1).max(200) });
const roam = z.object({ shipment: z.object({ id: Ref, poReference: Ref, packages: z.array(z.object({ sku: Sku, units: Qty, lot: Code })).min(1).max(200) }) });
const safesound = z.object({ note_no: Ref, po_number: Ref, lines: z.array(z.object({ product_sku: Sku, qty_shipped: Qty, batch_no: Code })).min(1).max(200) });
const snuggle = z.object({ ref: Ref, po: Ref, rows: z.array(z.array(z.string().max(80))).min(2).max(201) }); // CSV as JSON: header row first
const wonder = z.object({ id: Ref, order: z.object({ ref: Ref }), contents: z.array(z.object({ item: z.object({ sku: Sku }), count: Qty, batchCode: Code })).min(1).max(200) });

const SNUGGLE_HEADER = ["sku", "qty", "batch"];

export const DELIVERY_NOTE_ADAPTERS: Record<string, Adapter> = {
  "little-oak-v1": {
    label: "Little Oak JSON",
    parse: (j) => {
      const n = littleOak.parse(j);
      return { noteId: n.deliveryNote, orderRef: n.purchaseOrder, lines: n.items.map((i) => ({ sku: i.code, qty: i.quantity, batchCode: i.batch })) };
    },
    example: (o, ref) => ({ deliveryNote: `LO-${ref}`, purchaseOrder: o._id, items: o.lines.map((l) => ({ code: l.sku, quantity: l.qty, batch: `LO-${ref}` })) }),
  },
  "roam-v2": {
    label: "Roam shipment JSON v2",
    parse: (j) => {
      const { shipment: s } = roam.parse(j);
      return { noteId: s.id, orderRef: s.poReference, lines: s.packages.map((p) => ({ sku: p.sku, qty: p.units, batchCode: p.lot })) };
    },
    example: (o, ref) => ({ shipment: { id: `RS-${ref}`, poReference: o._id, packages: o.lines.map((l) => ({ sku: l.sku, units: l.qty, lot: `R${ref}` })) } }),
  },
  "safesound-v1": {
    label: "SafeSound JSON",
    parse: (j) => {
      const n = safesound.parse(j);
      return { noteId: n.note_no, orderRef: n.po_number, lines: n.lines.map((l) => ({ sku: l.product_sku, qty: l.qty_shipped, batchCode: l.batch_no })) };
    },
    example: (o, ref) => ({ note_no: `SS-${ref}`, po_number: o._id, lines: o.lines.map((l) => ({ product_sku: l.sku, qty_shipped: l.qty, batch_no: `SS/${ref}` })) }),
  },
  "snuggle-csvjson": {
    label: "Snuggle CSV-as-JSON",
    parse: (j) => {
      const n = snuggle.parse(j);
      const [header, ...rows] = n.rows;
      if (header.map((h) => h.trim().toLowerCase()).join() !== SNUGGLE_HEADER.join()) throw new Error(`Header row must be ${SNUGGLE_HEADER.join(", ")}`);
      return {
        noteId: n.ref,
        orderRef: n.po,
        lines: rows.map((r, i) => {
          if (r.length !== 3) throw new Error(`Row ${i + 2} needs 3 values`);
          return { sku: Sku.parse(r[0]), qty: Qty.parse(r[1]), batchCode: Code.parse(r[2]) };
        }),
      };
    },
    example: (o, ref) => ({ ref: `SN-${ref}`, po: o._id, rows: [SNUGGLE_HEADER, ...o.lines.map((l) => [l.sku, String(l.qty), `SN${ref}`])] }),
  },
  "wonder-v1": {
    label: "Wonder Toys JSON",
    parse: (j) => {
      const n = wonder.parse(j);
      return { noteId: n.id, orderRef: n.order.ref, lines: n.contents.map((c) => ({ sku: c.item.sku, qty: c.count, batchCode: c.batchCode })) };
    },
    example: (o, ref) => ({ id: `WT-${ref}`, order: { ref: o._id }, contents: o.lines.map((l) => ({ item: { sku: l.sku }, count: l.qty, batchCode: `WT-${ref}` })) }),
  },
};

// Text of a note file -> the note, or a message saying what is wrong with it, checked against the order.
export function readDeliveryNote(
  adapterId: string,
  text: string,
  order: { _id: string; lines: { sku: string; ordered: number; received: number }[] },
): { note: DeliveryNote } | { error: string } {
  const adapter = DELIVERY_NOTE_ADAPTERS[adapterId];
  if (!adapter) return { error: "This supplier has no delivery-note format yet. Enter the delivery by hand." };
  let note: DeliveryNote;
  try {
    note = adapter.parse(JSON.parse(text));
  } catch (e) {
    const detail = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".") || "note"}: ${i.message}`).slice(0, 3).join("; ") : (e as Error).message;
    return { error: `Not a ${adapter.label} delivery note (${detail}).` };
  }
  if (note.orderRef !== order._id) return { error: `This note is for order ${note.orderRef}, not ${order._id}.` };
  const seen = new Set<string>();
  for (const l of note.lines) {
    const line = order.lines.find((x) => x.sku === l.sku);
    if (!line) return { error: `${l.sku} is on the note but not on this order.` };
    if (seen.has(l.sku)) return { error: `${l.sku} appears twice on the note.` };
    seen.add(l.sku);
    if (l.qty > line.ordered - line.received) return { error: `${l.sku}: the note says ${l.qty}, but only ${line.ordered - line.received} are still to arrive.` };
  }
  return { note };
}
