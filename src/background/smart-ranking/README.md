# Smart ranking

This module prepares optional predictions in the background. The popup reads a
cached snapshot when it opens. On a cache miss the list appears immediately in
visit order, then requests a priority prediction. A matching result may update
the current opening once, before further keyboard, pointer or scroll interaction
locks both its order and probabilities. Closed or replaced openings ignore late
results. The selected tab is preserved by ID and reordered rows use a short
transform animation (skipped for reduced motion).

- `policy.ts`: public-page eligibility, the 20-tab shortlist, context features,
  and promotion rules. This is the main place to change ranking behavior.
- `model-client.ts`: System One requests, provider authentication/model names,
  and strict response validation. No SDK or generated-text parsing is needed.
- `index.ts`: local domain-usage statistics, scheduling, configuration, bounded
  session cache, and request cancellation. Visits are recorded on activation,
  independently of model requests. Background prefetches wait for a 1.5 second
  dwell, are at least ten seconds apart, and ignore title-only changes (cache
  signatures use tab IDs and domains, not titles). An explicit popup miss skips
  those delays and shares matching in-flight work; the popup waits at most two
  seconds, while the request keeps running to warm the cache. Requests time out
  after eight seconds. Authentication/configuration errors pause requests until
  settings change; rate limits back off exponentially (1 to 30 minutes); other
  failures back off one minute. Prefetches stop after 300 requests per day and
  all requests after 500.
- `../../utils/smart-ranking.ts`: configuration types and official endpoint
  validation shared with the settings page.

Only candidates with a probability of at least 15% are promoted, sorted by
descending probability, into the first reorderable slots; equal probabilities
retain most-recently-used order. Other predicted tabs keep visit order. Pinned
tabs, the current tab, the previously used tab, and tabs without predictions
(such as local or private pages) keep their original positions. Domain
statistics decay with a two-week half-life. When the current page is private,
ranking still runs with a placeholder current page. Predictions assume the user has opened the tab switcher
and is ready to select one of the supplied candidate tabs. The displayed
percentages are model probabilities among those candidates, renormalized when a
provider omits zero-probability candidates or rounds values; they are not
measured prediction accuracy or renormalized over the visible rows. Unknown
response keys (such as a removed `other` option) are ignored.

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
