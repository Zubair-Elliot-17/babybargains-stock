import { z } from "zod";
import { resumeKeyFor, resumeKeyMatches } from "@/auth/session";
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
    input: z.object({ commandId: CommandId, resumeKey: z.string().min(1).max(100).optional() }),
    run: (c, s, ctx, input, session) => {
      if (!session.branchId) throw new Forbidden("Sign in again and pick a branch");
      const key = input.resumeKey;
      return openStocktake(c, s, ctx, {
        branchId: session.branchId, sid: session.sid, clerkLabel: clerkLabel(session.sid),
        resumeOk: key ? (st) => resumeKeyMatches(st._id, st.resumeNonce, key) : undefined,
      });
    },
    present: ({ resumeNonce, ...st }: Stocktake) => ({ ...st, resumeKey: resumeNonce ? resumeKeyFor(st._id, resumeNonce) : undefined }),
  });
}

function clerkLabel(sid: string) {
  return `Clerk ${sid.slice(0, 4).toUpperCase()}`;
}
