# ADR-0002: "People you may know" as a staged pipeline with an authoritative filter stage

- **Status:** accepted
- **Date:** 2026-10-06

## Context

PYMK needs to combine several signals: friends of friends, shared interests, and people who follow you. It must also explain each result, never recommend yourself, someone you already follow, or anyone on either side of a block, and stay cheap on supernodes.

The design doc (§2, §5, §6) sketches the stages. CLAUDE.md invariant 6 requires them to stay separate and requires scoring to be pure. Three questions were open:

1. **Where are exclusions guaranteed?** The doc's generators exclude in Cypher, but the doc also lists a separate filter stage.
2. **How is each generator bounded?** Invariant 3 forbids unbounded expansion. The doc's friends-of-friends query caps fan-out at the second hop only, so a user following 50,000 accounts would expand from all of them. The follows-you generator has no bound beyond its `LIMIT`.
3. **How should explanations be shaped?**

## Decision

**Stages** (`src/reco/pipeline.ts`):

1. **Generate.** Three Cypher queries run in one read transaction.
2. **Score.** `scoreCandidates` is pure TypeScript. It merges the sources by id, computes `3*mutuals + 2*sharedInterests + 5*followsYou` (weights from config), and orders by score descending, then id ascending.
3. **Filter.** A Cypher check of the top 2 × limit ids against the live graph.
4. **Hydrate.** A Cypher lookup of `{id, handle, followerCount}`.
5. **Explain.** Pure TypeScript.

The I/O stages sit behind a `RecoPorts` interface, so the orchestration is unit-tested with fakes.

**The filter stage is the exclusion guarantee.** It excludes self, followed users and blocks in both directions, and drops users who no longer exist. The generators exclude the same users only so they don't waste their `LIMIT`. Phase 5 will cache candidate lists, so a cached list must be filtered against the live graph at serve time anyway. Putting the guarantee in the last graph-reading stage keeps it correct whatever happens upstream.

Mutation checks confirm both sides:

- Removing the block check from the filter fails the filter-stage test.
- Removing it from a generator still passes the required exclusion test, because the filter catches it.

**Over-fetch:** the filter receives twice the requested limit, so a few exclusions can be backfilled. If more than that are removed, the response may be shorter than `limit`. That's acceptable for a recommendation list.

**Bounds** (all set in config and validated at startup):

| Bound                 | Default | Why                                                                                                                                                                                      |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFriends`          | 200     | Only my 200 most recent follows are expanded. This is the first-hop cap the design doc's query lacked.                                                                                   |
| `maxFanout`           | 1000    | Friends who follow more accounts than this are skipped, read from the denormalized `followingCount`.                                                                                     |
| `maxInterestFanout`   | 5000    | Interests with more members than this are skipped. The member count comes from `getDegree`, so it's cheap.                                                                               |
| `maxFollowersScan`    | 5000    | Follows-you is skipped entirely for users with more followers than this. Ordering a celebrity's followers by recency scans all of them, and for a celebrity that signal is noise anyway. |
| `candidatesPerSource` | 100     | `LIMIT` per generator.                                                                                                                                                                   |

**Explanations** are structured `reasons` (`mutuals` with a count and sample, `interests` with a count and sample, `follows_you`) plus display text, for example "followed by ana, raj and 5 others; shares an interest: rust". Sample handles are sorted, so the text is deterministic. Only handles are returned, never names. Scores stay internal and aren't returned by the API.

**API:** `GET /v1/recommendations/people?limit=` with a limit of 1 to 50. There's no cursor, because the result is a ranked top-N rather than a list to page through. Invariant 4 is met by the hard cap.

## Consequences

- **Scoring and explanations are pure and property-tested.** fast-check checks that input order never changes the output, that adding a signal never lowers a score, and that every id appears exactly once. Phase 7 can tune the weights against the offline eval without touching Cypher.
- **Celebrities lose two signals by design:** follows-you, above the scan cap, and expansion through accounts that follow too many people. Phase 7's eval will show whether that costs recall.
- **The first-hop cap favors recent follows.** A user's older follows don't contribute candidates. This is a quality trade-off to revisit in Phase 7.
- **A request makes three round trips** (generate, filter, hydrate), each in its own read transaction. Phase 5's cache removes the generate step from the hot path. Filter and hydrate stay per request.
- **Weights start at the design doc's values** (3/2/5) and are not tuned. Changing them must go through the Phase 7 eval, not intuition (CLAUDE.md).
- **Generator exclusions run after aggregation, lazily in front of the `LIMIT`, never per path.** The design doc's placement (inside the second-hop `WHERE`) checked every path. On a 150k-edge graph that cost 1.62M db hits against 139k for the final version, with identical results. Any new generator must follow the same pattern. See `docs/profiles/phase3-pymk.md`.
