import { z } from "zod";
import { DomainError, Forbidden, InsufficientStock } from "@/domain/errors";
import { Id } from "@/domain/schemas";
import { recordSale } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

const Input = z.object({
  commandId: CommandId,
  lines: z.array(z.object({ sku: Id, qty: z.number().int().min(1).max(999) })).min(1).max(50),
});

// Clerk records a till sale at their session branch; stock leaves FIFO. One commandId per basket attempt.
export async function POST(req: Request) {
  return handleCommand(req, {
    name: "recordSale",
    role: "clerk",
    actionClass: "general",
    input: Input,
    precheck: (input) => {
      if (new Set(input.lines.map((l) => l.sku)).size !== input.lines.length) throw new DomainError("DUPLICATE_LINE", "Each product can appear once per sale", 400); // FIFO would allocate the same lots twice
    },
    run: async (c, s, ctx, input, session) => {
      if (!session.branchId) throw new Forbidden("Sign in again and pick a branch");
      try {
        return await recordSale(c, s, ctx, { branchId: session.branchId, lines: input.lines });
      } catch (err) {
        // Clerks count blind: say which lines are short, never how many the system holds.
        if (err instanceof InsufficientStock) {
          throw new DomainError("INSUFFICIENT_STOCK", "Not enough stock on record for the marked lines. Lower them or count the shelf", 409, err.lines.map((l) => ({ sku: l.sku })));
        }
        throw err;
      }
    },
  });
}
