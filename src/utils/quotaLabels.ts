import type { DashboardLanguage } from "../localization/languages";

const MIN_MONTHLY_WINDOW_MINUTES = 28 * 24 * 60;

const MONTHLY_LABELS: Record<DashboardLanguage, string> = {
  en: "Monthly",
  zh: "每月",
  ja: "月次",
  es: "Mensual",
  de: "Monatlich",
  fr: "Mensuel",
  "pt-br": "Mensal",
  ru: "Месяц",
  ko: "월간",
  it: "Mensile",
  "zh-hant": "每月",
  tr: "Aylık",
  pl: "Miesięcznie",
  cs: "Měsíčně",
  ar: "شهري",
  vi: "Hàng tháng"
};

const MONTHLY_QUOTA_LABELS: Record<DashboardLanguage, string> = {
  en: "Monthly quota",
  zh: "每月配额",
  ja: "月次クォータ",
  es: "Cuota mensual",
  de: "Monatliches Kontingent",
  fr: "Quota mensuel",
  "pt-br": "Cota mensal",
  ru: "Месячная квота",
  ko: "월간 할당량",
  it: "Quota mensile",
  "zh-hant": "每月配額",
  tr: "Aylık kota",
  pl: "Limit miesięczny",
  cs: "Měsíční kvóta",
  ar: "الحصة الشهرية",
  vi: "Hạn mức hàng tháng"
};

export function isFreePlanType(planType?: string): boolean {
  return Boolean(planType?.trim().toLowerCase().includes("free"));
}

/** Normalize endpoint-specific plan aliases before persisting them. */
export function normalizePlanType(planType?: string): string | undefined {
  const raw = planType?.trim();
  if (!raw) {
    return undefined;
  }

  const normalized = raw.toLowerCase();
  if (normalized.includes("team") || normalized.includes("business")) {
    return "business";
  }

  return normalized;
}

export function isMonthlyQuotaWindow(planType?: string, windowMinutes?: number): boolean {
  return (
    isFreePlanType(planType) ||
    (typeof windowMinutes === "number" && Number.isFinite(windowMinutes) && windowMinutes >= MIN_MONTHLY_WINDOW_MINUTES)
  );
}

export function resolveLongQuotaLabel(
  planType: string | undefined,
  windowMinutes: number | undefined,
  language: DashboardLanguage,
  weeklyFallback: string,
  variant: "short" | "quota" = "short"
): string {
  if (!isMonthlyQuotaWindow(planType, windowMinutes)) {
    return weeklyFallback;
  }
  const labels = variant === "quota" ? MONTHLY_QUOTA_LABELS : MONTHLY_LABELS;
  return labels[language] ?? labels.en;
}
