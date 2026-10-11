import { z } from "zod";
import { approveStocktake } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommand(req, {
    name: "approveStocktake",
    role: "manager",
    actionClass: "general",
    input: z.object({ commandId: CommandId, acceptedKeys: z.array(z.string().max(260)).max(5000) }),
    run: (c, s, ctx, input) => approveStocktake(c, s, ctx, { stocktakeId: id, acceptedKeys: input.acceptedKeys }),
  });
}
