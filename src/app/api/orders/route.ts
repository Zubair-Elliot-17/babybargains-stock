import { z } from "zod";
import { Id } from "@/domain/schemas";
import { createPurchaseOrder } from "@/domain/ledger/orders";
import { CommandId, handleCommand } from "@/lib/command";

const Input = z.object({
  commandId: CommandId,
  branchId: Id,
  supplierId: Id,
  lines: z.array(z.object({ sku: Id, qty: z.number().int().min(1).max(9999) })).min(1).max(200),
});

// Manager creates and sends a purchase order.
export async function POST(req: Request) {
  return handleCommand(req, {
    name: "createOrder",
    role: "manager",
    actionClass: "general",
    input: Input,
    run: (c, s, ctx, input) => createPurchaseOrder(c, s, ctx, input),
  });
}
