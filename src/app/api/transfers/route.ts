import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { Id } from "@/domain/schemas";
import { acceptTransferSuggestion } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

const Input = z.object({
  commandId: CommandId,
  sku: Id,
  fromBranchId: Id,
  toBranchId: Id,
  qty: z.number().int().min(1).max(9999),
});

// Manager accepts a transfer suggestion; the server re-checks it before posting.
export async function POST(req: Request) {
  return handleCommand(req, {
    name: "acceptTransfer",
    role: "manager",
    actionClass: "general",
    input: Input,
    precheck: (input) => {
      if (input.fromBranchId === input.toBranchId) throw new DomainError("SAME_BRANCH", "Pick two different branches", 400);
    },
    run: (c, s, ctx, input) => acceptTransferSuggestion(c, s, ctx, input),
  });
}
