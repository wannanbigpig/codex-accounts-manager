export interface CodexTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
}

export interface CodexQuotaSummary {
  hourlyPercentage: number;
  hourlyResetTime?: number;
  hourlyWindowMinutes?: number;
  hourlyWindowPresent?: boolean;
  weeklyPercentage: number;
  weeklyResetTime?: number;
  weeklyWindowMinutes?: number;
  weeklyWindowPresent?: boolean;
  codeReviewPercentage: number;
  codeReviewResetTime?: number;
  codeReviewWindowMinutes?: number;
  codeReviewWindowPresent?: boolean;
  rawData?: unknown;
}

export interface CodexQuotaErrorInfo {
  code?: string;
  message: string;
  timestamp: number;
}

export interface CodexAccountRecord {
  id: string;
  email: string;
  userId?: string;
  authProvider?: string;
  planType?: string;
  accountId?: string;
  organizationId?: string;
  accountName?: string;
  accountStructure?: string;
  isActive: boolean;
  showInStatusBar?: boolean;
  lastQuotaAt?: number;
  quotaSummary?: CodexQuotaSummary;
  quotaError?: CodexQuotaErrorInfo;
  createdAt: number;
  updatedAt: number;
}

export interface CodexAccountsIndex {
  currentAccountId?: string;
  accounts: CodexAccountRecord[];
}

export interface CodexAuthFile {
  OPENAI_API_KEY: string | null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface DecodedAuthClaims {
  email?: string;
  userId?: string;
  authProvider?: string;
  planType?: string;
  accountId?: string;
  organizationId?: string;
  organizations?: Array<{ id?: string; title?: string }>;
}

export interface UsageWindowInfo {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

export interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: UsageWindowInfo;
    secondary_window?: UsageWindowInfo;
  };
  code_review_rate_limit?: {
    primary_window?: UsageWindowInfo;
    secondary_window?: UsageWindowInfo;
  };
}
