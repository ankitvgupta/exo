/**
 * Strip markdown code fences from a JSON string.
 * Models sometimes wrap JSON responses in ```json ... ``` despite being told not to.
 */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  // Match ``` with any language tag (or none) at start, ``` at end
  const match = trimmed.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}
