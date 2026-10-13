export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export function demand(condition: unknown, message: string, status = 400, code = 'INVALID'): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
