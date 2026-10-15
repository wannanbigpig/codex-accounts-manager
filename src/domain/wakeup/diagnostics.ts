import { APIError } from "../../core/errors";
import type { WakeupErrorStage } from "./types";

export function sanitizeWakeupText(text: string, limit = 500): string {
  return text.replace(/Bearer\s+\S+|\beyJ[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, limit);
}

export class WakeupRequestError extends APIError {
  constructor(
    message: string,
    readonly stage: WakeupErrorStage,
    statusCode?: number
  ) {
    super(message, { statusCode });
    this.name = "WakeupRequestError";
    Object.setPrototypeOf(this, WakeupRequestError.prototype);
  }
}

export function wakeupFailure(error: unknown): { errorStage: WakeupErrorStage; httpStatus?: number } {
  if (error instanceof WakeupRequestError) {
    return { errorStage: error.stage, httpStatus: error.statusCode };
  }
  return { errorStage: "auth", httpStatus: error instanceof APIError ? error.statusCode : undefined };
}
