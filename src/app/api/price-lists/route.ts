import { z } from "zod";
import { Id } from "@/domain/schemas";
import { applyPriceList } from "@/domain/ledger/catalogue";
import { MAX_NEW_PRODUCTS, NewProduct, Pence, ProductName } from "@/domain/suppliers/catalogue";
import { NoteRef } from "@/domain/suppliers/deliveryNotes";
import { CommandId, handleCommand } from "@/lib/command";

const Input = z.object({
  commandId: CommandId,
  supplierId: Id,
  ref: NoteRef,
  items: z
    .array(z.object({ sku: Id, name: ProductName, price: Pence }))
    .min(1)
    .max(500)
    .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, "each product once"),
  add: z.array(NewProduct).max(MAX_NEW_PRODUCTS).optional(), // listed products we don't stock, set up by the manager
});

// Manager applies a supplier price list (read in the browser by its adapter) to that supplier's products.
export async function POST(req: Request) {
  return handleCommand(req, {
    name: "applyPriceList",
    role: "manager",
    actionClass: "catalogue",
    input: Input,
    run: (c, s, ctx, input) => applyPriceList(c, s, ctx, { supplierId: input.supplierId, list: { ref: input.ref, items: input.items }, add: input.add }),
  });
}
