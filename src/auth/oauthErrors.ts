export function isOAuthDeviceLimit(...values: unknown[]): boolean {
  return values.some((value) => typeof value === "string" && /^Device limit reached\.?$/i.test(value.trim()));
}

export function describeOAuthRejection(error: string | null, description: string | null): string | undefined {
  if (isOAuthDeviceLimit(description)) {
    return "Device limit reached";
  }
  if (error === "access_denied") {
    return "OAuth authorization was denied";
  }
  return error ? "OAuth authorization failed" : undefined;
}
