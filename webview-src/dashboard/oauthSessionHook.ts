import { useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { reduceOAuthActionResult, type OAuthModalState } from "./sessionModalState";

export function useOAuthSessionModal(params: {
  sendAction: SendAction;
  showCopyFeedback: (key: string) => void;
}) {
  const [oauthState, setOauthState] = useState<OAuthModalState>({
    oauthFlowStarted: false,
    oauthCallbackUrl: ""
  });

  const reset = (): void => {
    setOauthState({
      oauthSession: undefined,
      oauthFlowStarted: false,
      oauthCallbackUrl: "",
      oauthError: undefined
    });
  };

  const cancelSession = (): void => {
    if (oauthState.oauthSession) {
      params.sendAction("cancelOAuthSession", undefined, {
        oauthSessionId: oauthState.oauthSession.sessionId
      });
    }
    reset();
  };

  const handleCopyOauthLink = (): void => {
    if (!oauthState.oauthSession?.authUrl) {
      return;
    }
    setOauthState((current) => ({ ...current, oauthFlowStarted: true }));
    params.sendAction("copyText", undefined, { text: oauthState.oauthSession.authUrl });
    params.showCopyFeedback("oauth-link");
  };

  const handleStartOAuthAutoFlow = (): void => {
    if (!oauthState.oauthSession?.authUrl) {
      return;
    }
    setOauthState((current) => ({
      ...current,
      oauthFlowStarted: true,
      oauthError: undefined
    }));
    params.sendAction("startOAuthAutoFlow", undefined, {
      oauthSessionId: oauthState.oauthSession.sessionId
    });
  };

  const handleCompleteOAuth = (): void => {
    if (!oauthState.oauthSession) {
      return;
    }
    setOauthState((current) => ({
      ...current,
      oauthFlowStarted: true,
      oauthError: undefined
    }));
    params.sendAction("completeOAuthSession", undefined, {
      oauthSessionId: oauthState.oauthSession.sessionId,
      callbackUrl: oauthState.oauthCallbackUrl
    });
  };

  const applyActionResult = (
    message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>
  ): { handled: boolean; shouldCloseModal?: boolean } => {
    const reduced = reduceOAuthActionResult(oauthState, message);
    if (!reduced.handled) {
      return { handled: false };
    }
    setOauthState(reduced.next);
    return {
      handled: true,
      shouldCloseModal: reduced.shouldCloseModal
    };
  };

  return {
    oauthSession: oauthState.oauthSession,
    oauthCallbackUrl: oauthState.oauthCallbackUrl,
    oauthError: oauthState.oauthError,
    oauthFlowStarted: oauthState.oauthFlowStarted,
    cancelSession,
    reset,
    handleCopyOauthLink,
    handleStartOAuthAutoFlow,
    handleCompleteOAuth,
    applyActionResult,
    setOauthCallbackUrl: (value: string) => {
      setOauthState((current) => ({ ...current, oauthCallbackUrl: value }));
    }
  };
}
