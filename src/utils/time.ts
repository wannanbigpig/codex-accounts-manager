import * as vscode from "vscode";

export function formatRelativeReset(epochSeconds?: number): string {
  if (!epochSeconds) {
    return isZh() ? "重置时间未知" : "unknown reset";
  }

  const deltaMs = epochSeconds * 1000 - Date.now();
  const abs = Math.abs(deltaMs);
  const minutes = Math.round(abs / 60000);
  const future = deltaMs >= 0;
  const lang = isZh() ? "zh" : "en";

  if (minutes < 60) {
    return formatRelative(minutes, "m", future, lang);
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return formatRelative(hours, "h", future, lang);
  }

  const days = Math.round(hours / 24);
  return formatRelative(days, "d", future, lang);
}

export function formatTimestamp(epochMs?: number): string {
  if (!epochMs) {
    return isZh() ? "从未" : "never";
  }
  return new Date(epochMs).toLocaleString();
}

function isZh(): boolean {
  return vscode.env.language.toLowerCase().startsWith("zh");
}

function formatRelative(
  value: number,
  unit: "m" | "h" | "d",
  future: boolean,
  lang: "zh" | "en"
): string {
  if (lang === "zh") {
    const label = unit === "m" ? "分钟" : unit === "h" ? "小时" : "天";
    return future ? `剩余${value}${label}` : `${value}${label}前`;
  }

  const suffix = future ? "left" : "ago";
  return `${value}${unit} ${suffix}`;
}
