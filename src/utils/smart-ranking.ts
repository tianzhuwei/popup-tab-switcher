export type RankingProvider = "bailian" | "jev";

export interface ISmartRankingConfig {
  enabled: boolean;
  provider: RankingProvider;
  endpoint: string;
  apiKey: string;
}

export interface ISmartRankingStatus {
  state: "off" | "unconfigured" | "waiting" | "ready" | "error";
  message: string;
  updatedAt?: number;
}

export interface ISmartRankingSettings {
  config: ISmartRankingConfig;
  status: ISmartRankingStatus;
}

export const defaultSmartRankingConfig: ISmartRankingConfig = {
  enabled: false,
  provider: "bailian",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/systemone",
  apiKey: "",
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
        : provider === "jev"
        ? "https://api.typesafe.ai/v1/systemone"
        : defaultSmartRankingConfig.endpoint,
    apiKey: typeof config.apiKey === "string" ? config.apiKey.trim() : "",
  };
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
