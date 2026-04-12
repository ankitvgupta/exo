import { ScheduleSendButton } from "./ScheduleSendButton";
import type { Signature } from "../../shared/types";

interface ComposeToolbarProps {
  onSend: () => void;
  onScheduleSend: (scheduledAt: number) => void;
  onPickFiles: () => void;
  isSending: boolean;
  isScheduling: boolean;
  canSend: boolean;
  activeSignatureId: string | null;
  onSignatureChange: (id: string | null) => void;
  availableSignatures: Signature[];
}

export function ComposeToolbar({
  onSend,
  onScheduleSend,
  onPickFiles,
  isSending,
  isScheduling,
  canSend,
  activeSignatureId,
  onSignatureChange,
  availableSignatures,
}: ComposeToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 pt-2 border-t exo-border-subtle/30">
      <button
        onClick={onSend}
        disabled={isSending || isScheduling || !canSend}
        className="px-3 py-1.5 bg-[var(--exo-accent)] text-white text-sm font-medium rounded hover:bg-[var(--exo-accent-strong)] disabled:opacity-50 transition-colors"
        data-testid="inline-compose-send"
      >
        {isSending ? "Sending..." : "Send"}
      </button>
      <ScheduleSendButton
        onSchedule={onScheduleSend}
        disabled={isScheduling || isSending || !canSend}
      />
      <button
        onClick={onPickFiles}
        className="p-1.5 exo-text-muted hover:text-[var(--exo-text-primary)] hover:bg-[var(--exo-bg-surface-hover)] rounded transition-colors"
        title="Attach file"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"
          />
        </svg>
      </button>
      <span className="text-xs exo-text-muted">Cmd+Enter to send</span>
      {availableSignatures.length > 0 && (
        <select
          value={activeSignatureId ?? ""}
          onChange={(e) => onSignatureChange(e.target.value || null)}
          className="ml-auto text-sm border exo-border-strong rounded px-2 py-1.5 bg-[var(--exo-bg-elevated)] exo-text-secondary"
        >
          <option value="">No signature</option>
          {availableSignatures.map((sig) => (
            <option key={sig.id} value={sig.id}>
              {sig.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
