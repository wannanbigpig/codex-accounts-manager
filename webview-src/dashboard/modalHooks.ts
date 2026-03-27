import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { AppDispatch, SendAction } from "./hookTypes";
import { useCopyFeedback } from "./copyFeedbackHook";
import { useAccountSessionModal } from "./accountSessionModalHook";
import { useShareModal } from "./shareModalHook";

export function useDashboardModals(params: {
  dispatch: AppDispatch;
  sendAction: SendAction;
  importJsonFileReadError: string;
}) {
  const feedback = useCopyFeedback();
  const accountModal = useAccountSessionModal({
    sendAction: params.sendAction,
    importJsonFileReadError: params.importJsonFileReadError,
    showCopyFeedback: feedback.showCopyFeedback
  });
  const shareModal = useShareModal({
    sendAction: params.sendAction,
    showCopyFeedback: feedback.showCopyFeedback
  });

  const handleHostMessage = (message: DashboardHostMessage): void => {
    switch (message.type) {
      case "dashboard:snapshot":
        params.dispatch({ type: "snapshot", snapshot: message.state });
        return;
      case "dashboard:action-result":
        params.dispatch({ type: "resolve-action", requestId: message.requestId });
        if (accountModal.applyActionResult(message)) {
          return;
        }
        shareModal.applyActionResult(message);
        return;
      default:
        return;
    }
  };

  const handleEscape = (completeOAuthPending: boolean): boolean => {
    if (shareModal.handleEscape()) {
      return true;
    }
    if (accountModal.confirmCancelOauthOpen) {
      accountModal.closeConfirmCancelOauth();
      return true;
    }
    if (accountModal.handleEscape(completeOAuthPending)) {
      return true;
    }
    params.dispatch({ type: "close-settings" });
    return true;
  };

  return {
    ...accountModal,
    ...shareModal,
    copyFeedbackKey: feedback.copyFeedbackKey,
    handleHostMessage,
    handleEscape
  };
}
