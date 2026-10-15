import { z } from "zod";
import { clerkLabel } from "@/auth/session";
import { Forbidden } from "@/domain/errors";
import { joinStocktake } from "@/domain/ledger/write";
import { DeviceId } from "@/domain/schemas";
import { CommandId, handleCommand } from "@/lib/command";

// A clerk at the branch joins its OPEN stocktake from this phone (team counting).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommand(req, {
    target: id,
    name: "joinStocktake",
    role: "clerk",
    actionClass: "general",
    input: z.object({ commandId: CommandId, deviceId: DeviceId }),
    run: (c, s, ctx, input, session) => {
      if (!session.branchId) throw new Forbidden("Sign in again and pick a branch");
      return joinStocktake(c, s, ctx, { stocktakeId: id, branchId: session.branchId, sid: session.sid, clerkLabel: clerkLabel(session.sid), device: input.deviceId });
    },
  });
}
