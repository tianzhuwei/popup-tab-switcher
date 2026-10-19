import {
  getRankingPermissionOrigin,
  ISmartRankingTestResult,
  normalizeSmartRankingConfig,
} from "../../utils/smart-ranking";
import { requestTabRanking } from "./model-client";

let testing = false;

/** A connection probe uses only the draft and synthetic data, never saved state. */
export async function testSmartRankingConfig(
  value: unknown
): Promise<ISmartRankingTestResult> {
  if (testing) {
    return { ok: false, message: "A connection test is already running." };
  }
  testing = true;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const config = normalizeSmartRankingConfig(value);
    const origin = getRankingPermissionOrigin(config);
    if (!config.apiKey) throw new Error("Enter an API Key first.");
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      throw new Error("Grant access to the selected provider before testing.");
    }
    if (controller.signal.aborted)
      throw new Error("Connection test timed out.");
    await requestTabRanking(
      config,
      {
        current: { title: "Example home", domain: "example.com" },
        recentVisits: [],
        candidates: [
          {
            id: "tab_1",
            title: "Example documentation",
            domain: "example.com",
          },
        ],
      },
      { tab_1: "Switch to the example documentation tab." },
      controller.signal
    );
    if (controller.signal.aborted)
      throw new Error("Connection test timed out.");
    return {
      ok: true,
      message:
        "The provider returned a valid model response. Settings were not saved.",
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: controller.signal.aborted
        ? "Connection test timed out. Try again later."
        : error instanceof Error
        ? error.message
        : "Could not test the smart ranking connection.",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    testing = false;
  }
}
