import { z } from "zod";
import { submitStocktake } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommand(req, {
    name: "submitStocktake",
    role: "clerk",
    actionClass: "general",
    input: z.object({ commandId: CommandId, uncounted: z.enum(["zero", "leave"]) }),
    run: (c, s, ctx, input, session) => submitStocktake(c, s, ctx, { stocktakeId: id, sid: session.sid, uncounted: input.uncounted }),
  });
}
