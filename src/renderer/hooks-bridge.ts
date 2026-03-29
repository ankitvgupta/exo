/**
 * Bridge to avoid circular dependency between store/ and hooks/.
 * Re-exports specific functions that the store needs from hooks.
 */
export { clearPendingLabelUpdates } from "./hooks/useSyncBuffer";
