import { z } from "zod";
import { Id } from "@/domain/schemas";
import { receivePurchaseOrder } from "@/domain/ledger/orders";
import { CommandId, handleCommand } from "@/lib/command";

const Input = z.object({
  commandId: CommandId,
  lines: z.array(z.object({ sku: Id, qty: z.number().int().min(0).max(9999), batchCode: z.string().max(40) })).min(1).max(200),
});

// Manager records a delivery against an order: each line lands in the batch named on its label.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommand(req, {
    target: id,
    name: "receiveOrder",
    role: "manager",
    actionClass: "general",
    input: Input,
    run: (c, s, ctx, input) => receivePurchaseOrder(c, s, ctx, { orderId: id, lines: input.lines }),
  });
}
