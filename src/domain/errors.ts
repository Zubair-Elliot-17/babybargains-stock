// Domain errors carry a stable code so routes can map them to user-facing messages.

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export interface ShortLine {
  branchId: string;
  sku: string;
  requested: number;
  available: number;
}

export class InsufficientStock extends DomainError {
  constructor(public readonly lines: ShortLine[]) {
    const first = lines[0];
    super(
      "INSUFFICIENT_STOCK",
      `System shows only ${first.available} of ${first.sku} in stock`,
      409,
      lines,
    );
  }
}

export class NotFound extends DomainError {
  constructor(message: string) {
    super("NOT_FOUND", message, 404);
  }
}

export class RateLimited extends DomainError {
  constructor(public readonly retryAt: Date) {
    super("RATE_LIMITED", `Limit reached. Next action available ${retryAt.toISOString()}`, 429, { retryAt });
  }
}

export class Forbidden extends DomainError {
  constructor(message = "Not allowed for this role") {
    super("FORBIDDEN", message, 403);
  }
}

export class SameBranch extends DomainError {
  constructor() {
    super("SAME_BRANCH", "Pick two different branches", 400);
  }
}
