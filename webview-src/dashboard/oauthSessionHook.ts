import { useRef, useState } from "preact/hooks";
import type { DashboardDeviceOAuthGrant, DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { reduceOAuthActionResult, type OAuthModalState } from "./sessionModalState";
import { createActionRequestId } from "./host";

type ActionResult = Extract<DashboardHostMessage, { type: "dashboard:action-result" }>;
type DeviceSession = {
  id: string;
  requestId: string;
  openRequestId?: string;
  cancel?: { requestId: string; onCancelled?: () => void; result?: ActionResult };
};

export function useOAuthSessionModal(params: {
  sendAction: SendAction;
  showCopyFeedback: (key: string) => void;
}) {
  const [oauthState, setOauthState] = useState<OAuthModalState>({
    oauthFlowStarted: false,
    oauthCallbackUrl: ""
  });
  const [deviceActive, setDeviceActive] = useState(false);
  const [deviceGrant, setDeviceGrant] = useState<DashboardDeviceOAuthGrant>();
  const [deviceCancellation, setDeviceCancellation] = useState<"pending" | "finishing">();
  const [deviceBrowserFailed, setDeviceBrowserFailed] = useState(false);
  const device = useRef<DeviceSession>();

  const clearDevice = (): void => {
    device.current = undefined;
    setDeviceActive(false);
    setDeviceGrant(undefined);
    setDeviceCancellation(undefined);
    setDeviceBrowserFailed(false);
  };

  const cancelDevice = (onCancelled?: () => void): boolean => {
    const flow = device.current;
    if (!flow) {
      return false;
    }
    if (flow.cancel) {
      flow.cancel.onCancelled = onCancelled ?? flow.cancel.onCancelled;
    } else if (deviceCancellation !== "finishing") {
      const requestId = params.sendAction("cancelDeviceOAuthSession", undefined, { deviceSessionId: flow.id });
      flow.cancel = { requestId, onCancelled };
      setDeviceCancellation("pending");
    }
    return true;
  };

  const startDevice = (): void => {
    if (device.current) {
      return;
    }
    const id = createActionRequestId();
    device.current = { id, requestId: params.sendAction("prepareDeviceOAuthSession", undefined, { deviceSessionId: id }) };
    setDeviceActive(true);
    setOauthState((current) => ({ ...current, oauthError: undefined }));
  };

  const reset = (): void => {
    setOauthState({
      oauthSession: undefined,
      oauthFlowStarted: false,
      oauthCallbackUrl: "",
      oauthError: undefined
    });
  };

  const cancelSession = (): void => {
    clearDevice();
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

  const applyDeviceResult = (flow: DeviceSession, message: ActionResult): { handled: true; shouldCloseModal?: boolean } => {
    if (message.status === "failed") {
      clearDevice();
      setOauthState((current) => ({ ...current, oauthError: message.error, oauthFlowStarted: false }));
    } else if (message.action === "prepareDeviceOAuthSession" && message.payload?.deviceOAuthGrant) {
      setDeviceGrant(message.payload.deviceOAuthGrant);
      flow.requestId = params.sendAction("completeDeviceOAuthSession", undefined, { deviceSessionId: flow.id });
    } else if (message.action === "completeDeviceOAuthSession") {
      cancelSession();
      return { handled: true, shouldCloseModal: true };
    } else {
      cancelDevice();
    }
    return { handled: true };
  };

  const applyActionResult = (message: ActionResult): { handled: boolean; shouldCloseModal?: boolean } => {
    const flow = device.current;
    if (message.action === "prepareDeviceOAuthSession" || message.action === "completeDeviceOAuthSession") {
      if (flow?.requestId === message.requestId) {
        if (flow.cancel) {
          flow.cancel.result = message;
        } else {
          return applyDeviceResult(flow, message);
        }
      }
      return { handled: true };
    }
    if (message.action === "cancelDeviceOAuthSession") {
      const cancellation = flow?.cancel;
      if (flow && cancellation?.requestId === message.requestId) {
        flow.cancel = undefined;
        if (message.payload?.deviceOAuthCancellation === "cancelled") {
          clearDevice();
          cancellation.onCancelled?.();
        } else {
          setDeviceCancellation(message.status === "completed" ? "finishing" : undefined);
          if (message.status === "failed") {
            setOauthState((current) => ({ ...current, oauthError: message.error }));
          }
          if (cancellation.result) {
            return applyDeviceResult(flow, cancellation.result);
          }
        }
      }
      return { handled: true };
    }
    if (message.action === "openExternalUrl" && flow?.openRequestId === message.requestId) {
      flow.openRequestId = undefined;
      setDeviceBrowserFailed(message.status === "failed" || message.payload?.externalUrlOpened === false);
      return { handled: true };
    }
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
    deviceActive,
    deviceGrant,
    deviceCancellation,
    deviceBrowserFailed,
    startDevice,
    cancelDevice,
    openDevicePage: () => {
      if (device.current && deviceGrant) {
        device.current.openRequestId = params.sendAction("openExternalUrl", undefined, { url: deviceGrant.verificationUrl });
      }
    },
    copyDeviceCode: () => {
      if (deviceGrant) {
        params.sendAction("copyText", undefined, { text: deviceGrant.userCode });
        params.showCopyFeedback("device-code");
      }
    },
    copyDeviceLink: () => {
      if (deviceGrant) {
        params.sendAction("copyText", undefined, { text: deviceGrant.verificationUrl });
        params.showCopyFeedback("device-link");
      }
    },
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
