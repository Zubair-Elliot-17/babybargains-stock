import { z } from "zod";
import { Forbidden } from "@/domain/errors";
import { openStocktake } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

// Start or resume the clerk's stocktake for their session branch.
export async function POST(req: Request) {
  return handleCommand(req, {
    name: "openStocktake",
    role: "clerk",
    actionClass: "general",
    input: z.object({ commandId: CommandId }),
    run: (c, s, ctx, _input, session) => {
      if (!session.branchId) throw new Forbidden("Sign in again and pick a branch");
      return openStocktake(c, s, ctx, { branchId: session.branchId, sid: session.sid, clerkLabel: clerkLabel(session.sid) });
    },
  });
}

function clerkLabel(sid: string) {
  return `Clerk ${sid.slice(0, 4).toUpperCase()}`;
}
