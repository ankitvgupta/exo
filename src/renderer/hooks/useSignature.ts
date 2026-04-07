import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Config, Signature, IpcResponse } from "../../shared/types";

export function useSignature(accountId: string) {
  const [activeSignatureId, setActiveSignatureId] = useState<string | null>(null);
  const [hasUserChosen, setHasUserChosen] = useState(false);

  const { data: configData } = useQuery({
    queryKey: ["general-config"],
    queryFn: async () => {
      const result = (await window.api.settings.get()) as IpcResponse<Config>;
      if (result.success) {
        return result.data;
      }
      return null;
    },
  });

  const allSignatures = configData?.signatures ?? [];
  const showExoBranding = configData?.showExoBranding !== false;

  const availableSignatures = useMemo(
    () => allSignatures.filter((s: Signature) => !s.accountId || s.accountId === accountId),
    [allSignatures, accountId],
  );

  // Auto-select default signature on mount only (not after user explicitly changes selection)
  useEffect(() => {
    if (hasUserChosen || availableSignatures.length === 0) return;
    const accountDefault = availableSignatures.find(
      (s: Signature) => s.accountId === accountId && s.isDefault,
    );
    const globalDefault = availableSignatures.find((s: Signature) => !s.accountId && s.isDefault);
    const defaultSig = accountDefault ?? globalDefault;
    if (defaultSig) {
      setActiveSignatureId(defaultSig.id);
    }
  }, [availableSignatures, accountId, hasUserChosen]);

  const selectSignature = useCallback((id: string | null) => {
    setHasUserChosen(true);
    setActiveSignatureId(id);
  }, []);

  const activeSignature = availableSignatures.find((s: Signature) => s.id === activeSignatureId);

  const exoBrandingLine = showExoBranding
    ? `<div style="margin-top:12px;font-size:12px;color:#999;">Sent by <a href="https://exo.email" style="color:#999;">Exo</a></div>`
    : "";

  const signatureHtml = activeSignature?.bodyHtml
    ? `<div class="email-signature"><br><div>--</div>${activeSignature.bodyHtml}${exoBrandingLine}</div>`
    : exoBrandingLine
      ? `<div class="email-signature"><br><div>--</div>${exoBrandingLine}</div>`
      : "";

  return {
    activeSignatureId,
    setActiveSignatureId: selectSignature,
    availableSignatures,
    signatureHtml,
  };
}
