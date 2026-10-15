import { z } from "zod";
import { clerkLabel, resumeKeyFor, resumeKeyMatches } from "@/auth/session";
import { Forbidden } from "@/domain/errors";
import { openStocktake } from "@/domain/ledger/write";
import type { Stocktake } from "@/domain/schemas";
import { CommandId, handleCommand } from "@/lib/command";

// Start or resume the clerk's stocktake for their session branch. A resume key skips only the idle wait:
// the role check and the session's own branch still decide which stocktake can be opened.
export async function POST(req: Request) {
  return handleCommand(req, {
    name: "openStocktake",
    role: "clerk",
    actionClass: "general",
    input: z.object({
      commandId: CommandId,
      resume: z.object({ stocktakeId: z.string().min(1).max(120), key: z.string().min(1).max(100) }).optional(),
    }),
    run: (c, s, ctx, input, session) => {
      if (!session.branchId) throw new Forbidden("Sign in again and pick a branch");
      const r = input.resume;
      return openStocktake(c, s, ctx, {
        branchId: session.branchId, sid: session.sid, clerkLabel: clerkLabel(session.sid),
        resume: r ? { stocktakeId: r.stocktakeId, ok: (st) => resumeKeyMatches(st._id, st.resumeNonce, r.key) } : undefined,
      });
    },
    // Teammates' sessions stay on the server.
    present: ({ resumeNonce, ...st }: Stocktake) => ({ ...st, participants: undefined, resumeKey: resumeNonce ? resumeKeyFor(st._id, resumeNonce) : undefined }),
  });
}

