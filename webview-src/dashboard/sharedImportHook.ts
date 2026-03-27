import { useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { reduceSharedImportActionResult, type SharedImportState } from "./sessionModalState";

export function useSharedImportModal(params: {
  sendAction: SendAction;
  importJsonFileReadError: string;
}) {
  const [importJsonText, setImportJsonText] = useState("");
  const [importState, setImportState] = useState<SharedImportState>({});

  const clearImportFeedback = (): void => {
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

  const handlePreviewImport = (): void => {
    setImportState((current) => ({ ...current, importJsonError: undefined }));
    params.sendAction("previewImportSharedJson", undefined, {
      jsonText: importJsonText
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
