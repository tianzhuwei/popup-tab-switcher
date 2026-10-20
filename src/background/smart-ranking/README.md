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
- `tab-relations.ts`: bounded session-only opening ancestry, per-tab page visits,
  bidirectional switch counts, navigation resets, and Chrome tab replacement.
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

All predicted ordinary candidates are sorted by descending probability into
the reorderable slots; equal probabilities, including zeros, retain
most-recently-used order. Pinned tabs, the current tab, the previously used tab, and tabs without predictions
(such as local or private pages) keep their original positions. Domain
and tab statistics decay with a two-week half-life. Before a new visit is counted,
existing visit and transition counts are decayed to that same timestamp, so
returning to a domain does not restore the weight of old history.
When the current page is private,
ranking still runs with a placeholder current page. Predictions assume the user has opened the tab switcher
and is ready to select one of the supplied candidate tabs. The displayed
percentages are model probabilities among those candidates, renormalized when a
provider omits zero-probability candidates or rounds values; they are not
measured prediction accuracy or renormalized over the visible rows. Unknown
response keys (such as a removed `other` option) are ignored.

Only ordinary non-incognito HTTP(S) pages with public-looking DNS hostnames are
eligible. Local names, IP addresses and common intranet suffixes are excluded;
this cannot identify every private site that uses a public-looking domain.
Requests include bounded titles, domains, recent visits, domain/tab usage
counts and opening relationships, without URL paths/query strings, screenshots
or page bodies. Usage is
bounded to 100 domains and cleared when disabled. API keys stay in trusted local
extension storage and are excluded from popup models and message logging.

Jev uses `jev-latest`; Bailian uses `decision-model-preview`. Both use System One
Choice payloads and answer probabilities, but keys are provider-specific.
Jev and Bailian workspace endpoints use Bearer authentication. Bailian's shared
Dashscope inference gateway uses the raw key, following its tuning guide.

## Model instructions and input

`questions.next_tab.instructions` asks for the next tab the user will select
now, explains domain/tab usage, opening relationships and their limits, and
uses recent visits as a fallback when contextual evidence is weak. Titles and
tab-level recency distinguish candidates that share a domain. Page metadata is
untrusted data, never instructions. These are prediction heuristics; their
quality requires evaluation against actual selections.

`policy.ts` builds the following `state` fields for normal ranking requests:

| Field                                       | Meaning                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current.title`, `current.domain`           | Current page title (up to 180 characters) and hostname; private/ineligible current pages use a placeholder.                                                                      |
| `localTime.hour`, `localTime.weekday`       | Local hour (0–23) and weekday (0 = Sunday, 6 = Saturday).                                                                                                                        |
| `recentVisits`                              | Up to six eligible open tabs in most-recently-used order, including the current tab when eligible; each contains only title and domain. This is not a full browsing-history log. |
| `candidates[].id`                           | Opaque choice identifier, `tab_<Chrome tab ID>`.                                                                                                                                 |
| `candidates[].title`, `candidates[].domain` | Candidate title (up to 180 characters) and hostname.                                                                                                                             |
| `candidates[].recentRank`                   | Zero-based position in the scoped recent-tab list; smaller means more recent.                                                                                                    |
| `candidates[].minutesSinceDomainVisit`      | Rounded minutes since the last recorded domain visit, or `null` when unknown.                                                                                                    |
| `candidates[].domainVisits`                 | Decayed domain visits, rounded to one decimal place.                                                                                                                             |
| `candidates[].transitionsFromCurrentDomain` | Decayed transitions from the current domain to the candidate domain, rounded to one decimal place.                                                                               |

Each candidate also includes the following session features:

| Field                       | Meaning                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relationshipToCurrent`     | Candidate relative to the current tab: `parent`, `child`, `ancestor`, `descendant`, `sibling`, `related` (another shared ancestor), or `unknown` (no known link). |
| `openerDistance`            | Number of edges along the known opening chain, or `null` when unknown.                                                                                            |
| `tabVisits`                 | Decayed visits to the current page in this particular tab, rounded to one decimal place.                                                                          |
| `minutesSinceTabVisit`      | Rounded minutes since this specific tab/page was visited, or `null` when unknown.                                                                                 |
| `transitionsFromCurrentTab` | Decayed switches from the current tab to this candidate.                                                                                                          |
| `transitionsToCurrentTab`   | Decayed switches from this candidate back to the current tab.                                                                                                     |

Opening chains use Chrome's `openerTabId`; an absent source is never inferred
from whichever tab happened to be active. Existing openers are imported when
enabling or initializing ranking. Original links survive a parent closing,
Chrome reparenting a child, and ordinary navigation. They describe tab origins,
not a guarantee that the current pages still belong to the same task.

URL changes reset that tab's page visit counts and all incident switch counts.
Switch observations are serialized so rapid activations retain their order;
private/ineligible pages break the observation chain. Ineligible nodes are
removed. Closed eligible nodes can remain as ancestry intermediates. Chrome
tab replacement transfers identity and relationships.

Session storage retains at most 500 nodes and 1000 directed switch edges across
worker suspension. Browser restart or extension reload/update clears it. Eviction can
make old relationships unknown. Full URLs are used only locally to detect
navigation; they are not included in model requests. Disabling ranking clears
this session state and stops collection.

The 20-tab shortlist combines recency and domain usage with modest bonuses
for per-tab visits, switches from the current tab, and nearby opening links.
Relation-state revisions participate in cache signatures, preventing reuse of
predictions prepared before new tab evidence; title-only updates still do not
invalidate them. These weights are heuristics, not measured improvements.

At most 20 eligible candidates are sent, excluding the current tab.
`questions.next_tab.criteria` maps each candidate ID to `title (domain)`.
Pinned status, window IDs, full URLs, page bodies and screenshots are not
included in model input. The API key is sent only in the authorization header.
Connection tests use synthetic example data instead of this live context.

References:

- https://docs.typesafe.ai/introduction/quickstart
- https://help.aliyun.com/zh/model-studio/decision-model-api
- https://help.aliyun.com/zh/model-studio/decision-model-tuning-guide

No live model-quality or latency measurements are implied by the initial policy.
