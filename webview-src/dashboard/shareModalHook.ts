import { useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";

export function useShareModal(params: {
  sendAction: SendAction;
  showCopyFeedback: (key: string) => void;
}) {
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareModalJson, setShareModalJson] = useState("");
  const [sharePreviewExpanded, setSharePreviewExpanded] = useState(false);

  const handleCopyShareJson = (): void => {
    params.sendAction("copyText", undefined, { text: shareModalJson });
    params.showCopyFeedback("share-json");
  };

  const handleDownloadShareJson = (filename: string, text: string): void => {
    params.sendAction("downloadJsonFile", undefined, { filename, text });
  };

  const applyActionResult = (message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>): boolean => {
    if (message.status === "failed") {
      return false;
    }
    if (message.action === "shareTokens" && message.payload?.sharedJson) {
      setShareModalJson(message.payload.sharedJson);
      setSharePreviewExpanded(false);
      setShareModalOpen(true);
      return true;
    }
    return false;
  };

  const handleEscape = (): boolean => {
    if (!shareModalOpen) {
      return false;
    }
    setShareModalOpen(false);
    return true;
  };

  return {
    shareModalOpen,
    shareModalJson,
    sharePreviewExpanded,
    handleCopyShareJson,
    handleDownloadShareJson,
    applyActionResult,
    handleEscape,
    closeShareModal: () => setShareModalOpen(false),
    toggleSharePreview: () => setSharePreviewExpanded((current) => !current)
  };
}
