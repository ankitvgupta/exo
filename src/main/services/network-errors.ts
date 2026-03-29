/**
 * Detect transient network errors that should trigger retry/queuing
 * rather than permanent failure.
 */
export function isNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    (error as Record<string, unknown>)?.code === "ENOTFOUND" ||
    (error as Record<string, unknown>)?.code === "ETIMEDOUT" ||
    (error as Record<string, unknown>)?.code === "ECONNREFUSED" ||
    (error as Record<string, unknown>)?.code === "ECONNRESET"
  );
}
