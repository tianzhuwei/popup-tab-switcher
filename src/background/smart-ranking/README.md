# Smart ranking

This module prepares optional predictions in the background. The popup reads a
cached snapshot when it opens; completed requests never push a new order into an
open popup. Without a matching prediction, the original visit order is used.

- `policy.ts`: public-page eligibility, the 20-tab shortlist, context features,
  and promotion rules. This is the main place to change ranking behavior.
- `model-client.ts`: System One requests, provider authentication/model names,
  and strict response validation. No SDK or generated-text parsing is needed.
- `index.ts`: local domain-usage statistics, scheduling, configuration, bounded
  session cache, and request cancellation. Requests are debounced, at least ten
  seconds apart, and time out after eight seconds; failures back off one minute.
- `../../utils/smart-ranking.ts`: configuration types and official endpoint
  validation shared with the settings page.

Ordinary candidates with valid predictions are sorted by descending probability,
regardless of confidence. Equal probabilities, including zeros, retain their
most-recently-used order. Pinned tabs, the current tab, and the previously used tab
keep their original positions. Visible tabs without predictions follow the ranked
candidates in visit order. Predictions assume the user has opened the tab switcher
and is ready to select one of the supplied candidate tabs. The displayed
percentages are raw model probabilities among those candidates; they are not
measured prediction accuracy or renormalized over the visible rows. Cached
predictions containing the removed `other` option are discarded on loading.

Only ordinary non-incognito HTTP(S) pages with public-looking DNS hostnames are
eligible. Local names, IP addresses and common intranet suffixes are excluded;
this cannot identify every private site that uses a public-looking domain.
Requests include bounded titles, domains, recent visits and domain-level usage
counts, without URL paths/query strings, screenshots or page bodies. Usage is
bounded to 100 domains and cleared when disabled. API keys stay in trusted local
extension storage and are excluded from popup models and message logging.

Jev uses `jev-latest`; Bailian uses `decision-model-preview`. Both use System One
Choice payloads and answer probabilities, but keys are provider-specific.
Jev and Bailian workspace endpoints use Bearer authentication. Bailian's shared
Dashscope inference gateway uses the raw key, following its tuning guide.

References:

- https://docs.typesafe.ai/introduction/quickstart
- https://help.aliyun.com/zh/model-studio/decision-model-api
- https://help.aliyun.com/zh/model-studio/decision-model-tuning-guide

No live model-quality or latency measurements are implied by the initial policy.
