import { z } from "zod";
import { Id } from "@/domain/schemas";
import { applyPriceList } from "@/domain/ledger/catalogue";
import { NoteRef } from "@/domain/suppliers/deliveryNotes";
import { CommandId, handleCommand } from "@/lib/command";

const Input = z.object({
  commandId: CommandId,
  supplierId: Id,
  ref: NoteRef,
  items: z.array(z.object({ sku: Id, name: z.string().trim().min(1).max(120), price: z.number().int().min(1).max(10_000_000) })).min(1).max(500),
});

// Manager applies a supplier price list (read in the browser by its adapter) to that supplier's products.
export async function POST(req: Request) {
  return handleCommand(req, {
    name: "applyPriceList",
    role: "manager",
    actionClass: "general",
    input: Input,
    run: (c, s, ctx, input) => applyPriceList(c, s, ctx, { supplierId: input.supplierId, list: { ref: input.ref, items: input.items } }),
  });
}
