import { describe, expect, it } from "vitest";
import { SUPPLIERS } from "@/seed/catalogue";
import { DELIVERY_NOTE_ADAPTERS, readDeliveryNote } from "@/domain/suppliers/deliveryNotes";

const order = { _id: "PO-BRS-20261014-abc", lines: [{ sku: "COT-A", ordered: 4, received: 1 }, { sku: "COT-B", ordered: 2, received: 0 }] };
const due = order.lines.map((l) => ({ sku: l.sku, qty: l.ordered - l.received }));
const read = (adapter: string, json: unknown) => readDeliveryNote(adapter, JSON.stringify(json), order);

describe("delivery-note adapters", () => {
  it("cover every seeded supplier", () => {
    for (const s of SUPPLIERS) expect(DELIVERY_NOTE_ADAPTERS[s.adapter], s.adapter).toBeDefined();
  });

  it.each(Object.keys(DELIVERY_NOTE_ADAPTERS))("%s reads back its own sample note", (id) => {
    const r = read(id, DELIVERY_NOTE_ADAPTERS[id].example({ _id: order._id, lines: due }, "X1"));
    expect("note" in r && r.note).toMatchObject({ orderRef: order._id.toUpperCase(), lines: [{ sku: "COT-A", qty: 3 }, { sku: "COT-B", qty: 2 }] });
    if ("note" in r) {
      expect(r.note.noteId).toMatch(/X1/);
      for (const l of r.note.lines) expect(l.batchCode).toMatch(/^[A-Z0-9 ._/-]+$/); // passes the receive form's batch-code rule
    }
  });

  it.each(Object.keys(DELIVERY_NOTE_ADAPTERS))("%s refuses another supplier's format", (id) => {
    const other = Object.keys(DELIVERY_NOTE_ADAPTERS).find((x) => x !== id)!;
    expect(read(id, DELIVERY_NOTE_ADAPTERS[other].example({ _id: order._id, lines: due }, "X1"))).toMatchObject({ error: expect.stringMatching(/^Not a .* delivery note/) });
  });

  it("checks the note against the order", () => {
    const note = (lines: [string, number][], po = order._id) => ({ deliveryNote: "LO-9", purchaseOrder: po, items: lines.map(([code, quantity]) => ({ code, quantity, batch: "B-1" })) });
    expect(read("little-oak-v1", note([["COT-A", 1]], "PO-OTHER"))).toEqual({ error: `This note is for order PO-OTHER, not ${order._id}.` });
    expect(read("little-oak-v1", note([["COT-A", 1]], order._id.toUpperCase()))).toHaveProperty("note"); // refs compare upper-cased
    expect(read("little-oak-v1", note([]))).toMatchObject({ error: expect.stringContaining("items") });
    expect(read("little-oak-v1", note([["TOY-Z", 1]]))).toEqual({ error: "TOY-Z is on the note but not on this order." });
    expect(read("little-oak-v1", note([["COT-A", 1], ["COT-A", 1]]))).toEqual({ error: "COT-A appears twice on the note." });
    expect(read("little-oak-v1", note([["COT-A", 4]]))).toEqual({ error: "COT-A: the note says 4, but only 3 are still to arrive." });
    expect(read("little-oak-v1", note([["COT-B", 2]]))).toMatchObject({ note: { lines: [{ sku: "COT-B", qty: 2 }] } }); // a partial delivery is fine
  });

  it("explains bad files", () => {
    expect(readDeliveryNote("little-oak-v1", "{not json", order)).toMatchObject({ error: expect.stringMatching(/^Not a Little Oak JSON delivery note/) });
    expect(read("little-oak-v1", { deliveryNote: "LO-9", purchaseOrder: order._id, items: [{ code: "COT-A", quantity: -1, batch: "B" }] })).toMatchObject({ error: expect.stringContaining("items.0.quantity") });
    expect(read("snuggle-csvjson", { ref: "SN-1", po: order._id, rows: [["code", "qty", "batch"], ["COT-A", "1", "B"]] })).toMatchObject({ error: expect.stringContaining("Header row must be sku, qty, batch") });
    expect(read("snuggle-csvjson", { ref: "SN-1", po: order._id, rows: [["sku", "qty", "batch"], ["COT-A", "1"]] })).toMatchObject({ error: expect.stringContaining("Row 2 needs 3 values") });
    // Quantities are numbers, not things that happen to coerce to one.
    for (const quantity of [true, null, "3", "0x3", [2]]) {
      expect(read("little-oak-v1", { deliveryNote: "LO-9", purchaseOrder: order._id, items: [{ code: "COT-A", quantity, batch: "B" }] }), String(quantity)).toHaveProperty("error");
    }
    const csv = (rows: string[][]) => read("snuggle-csvjson", { ref: "SN-1", po: order._id, rows: [["sku", "qty", "batch"], ...rows] });
    expect(csv([["COT-A", "", "B"]])).toEqual({ error: "Couldn't read this Snuggle CSV-as-JSON note: Row 2, qty: a whole number." });
    expect(csv([["COT-A", "0x3", "B"]])).toMatchObject({ error: expect.stringContaining("Row 2, qty") });
    expect(csv([["COT-A", "2", "b-1"], ["", "", ""]])).toMatchObject({ note: { lines: [{ sku: "COT-A", qty: 2, batchCode: "B-1" }] } }); // blank trailing row skipped
    // Batch codes follow the house rule; references allow label characters only and compare upper-cased.
    expect(read("little-oak-v1", { deliveryNote: "LO-9", purchaseOrder: order._id, items: [{ code: "COT-A", quantity: 1, batch: "B\u200B1" }] })).toMatchObject({ error: expect.stringContaining("isn't a label code") });
    expect(read("little-oak-v1", { deliveryNote: "lo\u200B9", purchaseOrder: order._id, items: [{ code: "COT-A", quantity: 1, batch: "B" }] })).toMatchObject({ error: expect.stringContaining("deliveryNote") });
    expect(read("little-oak-v1", { deliveryNote: "lo-9", purchaseOrder: order._id, items: [{ code: "COT-A", quantity: 1, batch: "" }] })).toMatchObject({ note: { noteId: "LO-9", lines: [{ batchCode: "" }] } });
    expect(read("nobody-v1", {})).toEqual({ error: "This supplier has no delivery-note format yet. Enter the delivery by hand." });
  });
});
