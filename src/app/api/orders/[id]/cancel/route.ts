import { z } from "zod";
import { cancelPurchaseOrder } from "@/domain/ledger/orders";
import { CommandId, handleCommand } from "@/lib/command";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommand(req, {
    target: id,
    name: "cancelOrder",
    role: "manager",
    actionClass: "general",
    input: z.object({ commandId: CommandId }),
    run: (c, s, ctx) => cancelPurchaseOrder(c, s, ctx, { orderId: id }),
  });
}
