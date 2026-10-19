export type RankingProvider = "bailian" | "jev";

export interface ISmartRankingConfig {
  enabled: boolean;
  provider: RankingProvider;
  endpoint: string;
  apiKey: string;
}

export interface ISmartRankingProviderConfig {
  endpoint: string;
  apiKey: string;
}

export type ISmartRankingProviders = Record<
  RankingProvider,
  ISmartRankingProviderConfig
>;

export interface ISmartRankingStatus {
  state: "off" | "unconfigured" | "waiting" | "ready" | "error";
  message: string;
  updatedAt?: number;
}

export interface ISmartRankingSettings {
  config: ISmartRankingConfig;
  providers: ISmartRankingProviders;
  status: ISmartRankingStatus;
}

export interface ISmartRankingTestResult {
  ok: boolean;
  message: string;
  elapsedMs?: number;
}

export const defaultSmartRankingProviders: ISmartRankingProviders = {
  bailian: {
    endpoint:
      "https://llm-7qn2t0pgxfebbeb9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
    apiKey: "",
  },
  jev: {
    endpoint: "https://api.typesafe.ai/v1/systemone",
    apiKey: "",
  },
};

export const defaultSmartRankingConfig: ISmartRankingConfig = {
  enabled: false,
  provider: "bailian",
  ...defaultSmartRankingProviders.bailian,
};

export function normalizeSmartRankingConfig(
  value: unknown
): ISmartRankingConfig {
  const config =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const provider = config.provider === "jev" ? "jev" : "bailian";
  return {
    enabled: config.enabled === true,
    provider,
    endpoint:
      typeof config.endpoint === "string"
        ? config.endpoint.trim()
        : defaultSmartRankingProviders[provider].endpoint,
    apiKey: typeof config.apiKey === "string" ? config.apiKey.trim() : "",
  };
}

export function normalizeSmartRankingProviders(
  value: unknown,
  config: ISmartRankingConfig,
  fallback: ISmartRankingProviders = defaultSmartRankingProviders
): ISmartRankingProviders {
  const saved =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  function normalize(provider: RankingProvider): ISmartRankingProviderConfig {
    const entry = saved[provider];
    const profile =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    return {
      endpoint:
        typeof profile.endpoint === "string"
          ? profile.endpoint.trim()
          : fallback[provider].endpoint,
      apiKey:
        typeof profile.apiKey === "string"
          ? profile.apiKey.trim()
          : fallback[provider].apiKey,
    };
  }
  const providers = { bailian: normalize("bailian"), jev: normalize("jev") };
  // The active config also migrates installations with only one saved key.
  providers[config.provider] = {
    endpoint: config.endpoint,
    apiKey: config.apiKey,
  };
  return providers;
}

export function isValidRankingProbabilitySum(
  probabilities: Record<string, number>,
  provider: RankingProvider
): boolean {
  const values = Object.values(probabilities);
  const sum = values.reduce((total, value) => total + value, 0);
  // Bailian can round each probability to two decimals, accumulating up to 0.005 per option.
  const isRoundedBailianResponse =
    provider === "bailian" &&
    values.every(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8
    );
  const tolerance = isRoundedBailianResponse
    ? Math.max(0.001, values.length * 0.005)
    : 0.001;
  return sum > 0 && Math.abs(sum - 1) <= tolerance + 1e-8;
}

export function getRankingPermissionOrigin(
  config: ISmartRankingConfig
): string {
  const invalidEndpoint = () =>
    new Error(
      "Use an official HTTPS System One endpoint for the selected provider."
    );
  let endpoint: URL;
  if (config.endpoint.length > 2048) {
    throw invalidEndpoint();
  }
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw invalidEndpoint();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    config.endpoint.includes("?") ||
    config.endpoint.includes("#")
  ) {
    throw invalidEndpoint();
  }

  if (config.provider === "jev") {
    if (
      endpoint.hostname !== "api.typesafe.ai" ||
      endpoint.pathname !== "/v1/systemone"
    ) {
      throw invalidEndpoint();
    }
  } else if (config.provider === "bailian") {
    const isDashscope =
      endpoint.hostname === "dashscope.aliyuncs.com" ||
      endpoint.hostname === "dashscope-intl.aliyuncs.com";
    const isWorkspace =
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(
        endpoint.hostname
      );
    if (
      (!isDashscope && !isWorkspace) ||
      endpoint.pathname !== "/compatible-mode/v1/systemone"
    ) {
      throw invalidEndpoint();
    }
  } else {
    throw invalidEndpoint();
  }
  return `${endpoint.origin}/*`;
}
