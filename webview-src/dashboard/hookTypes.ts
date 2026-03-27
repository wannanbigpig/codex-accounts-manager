import type { DashboardActionName, DashboardClientMessage } from "../../src/domain/dashboard/types";
import type { AppAction } from "./state";

export type AppDispatch = (action: AppAction) => void;
export type DashboardActionPayload = Extract<DashboardClientMessage, { type: "dashboard:action" }>["payload"];
export type SendAction = (action: DashboardActionName, accountId?: string, payload?: DashboardActionPayload) => void;
