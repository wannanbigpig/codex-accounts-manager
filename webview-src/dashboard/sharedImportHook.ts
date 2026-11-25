import { useRef, useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { reduceSharedImportActionResult, type SharedImportState } from "./sessionModalState";

export function useSharedImportModal(params: {
  sendAction: SendAction;
  importJsonFileReadError: string;
}) {
  const [importJsonText, setImportJsonText] = useState("");
  const [importState, setImportState] = useState<SharedImportState>({});
  const pendingPreview = useRef<string>();

  const clearImportFeedback = (): void => {
    pendingPreview.current = undefined;
    setImportState({});
  };

  const handleImportFileSelected = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      clearImportFeedback();
      setImportJsonText(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      setImportState((current) => ({
        ...current,
        importJsonError: params.importJsonFileReadError
      }));
    };
    reader.readAsText(file);
  };

  const handleImportTextChange = (value: string): void => {
    setImportJsonText(value);
    clearImportFeedback();
  };

  const handlePreviewImport = (probeImportIndexes?: number[]): void => {
    setImportState((current) => ({ ...current, importJsonError: undefined }));
    pendingPreview.current = params.sendAction("previewImportSharedJson", undefined, {
      jsonText: importJsonText,
      probeImportIndexes
    });
  };

  const handleSubmitImport = (recoveryMode: boolean): void => {
    setImportState((current) => ({ ...current, importJsonError: undefined }));
    params.sendAction("importSharedJson", undefined, {
      jsonText: importJsonText,
      recoveryMode
    });
  };

  const applyActionResult = (
    message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>
  ): boolean => {
    if (message.action === "previewImportSharedJson") {
      if (pendingPreview.current !== message.requestId) {
        return true;
      }
      pendingPreview.current = undefined;
    }
    const reduced = reduceSharedImportActionResult(importState, message);
    if (!reduced.handled) {
      return false;
    }
    setImportState(reduced.next);
    return true;
  };

  return {
    importJsonText,
    importJsonError: importState.importJsonError,
    importPreview: importState.importPreview,
    importResult: importState.importResult,
    clearImportFeedback,
    handleImportFileSelected,
    handleImportTextChange,
    handlePreviewImport,
    handleSubmitImport,
    applyActionResult
  };
}
