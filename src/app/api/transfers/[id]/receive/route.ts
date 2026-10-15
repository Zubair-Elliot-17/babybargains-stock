import { z } from "zod";
import { receiveTransfer } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

// A clerk at the receiving branch confirms a dispatched transfer has arrived.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommand(req, {
    target: id,
    name: "receiveTransfer",
    role: "clerk",
    actionClass: "general",
    input: z.object({ commandId: CommandId }),
    run: (c, s, ctx, _input, session) => receiveTransfer(c, s, ctx, { transferId: id, branchId: session.branchId! }),
  });
}
