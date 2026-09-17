# Typed dispatch resolution verification

Audience: maintainer verification.

This record supports the opt-in `bin/fm-dispatch-resolve.sh` contract owned by [`../configuration.md`](../configuration.md) ("Typed dispatch resolution") and the declared rule and profile fields owned there under "Crew dispatch profiles".
It records only facts that must be re-established when the typesafe.ai model, its API, or firstmate's dispatch rules change.
Task chronology, the captain's rules, and the briefs themselves stay in the private scout report.

## The API the tool depends on

Verified 2026-09-16 against `https://api.typesafe.ai`.
`GET /v1/models` listed `jev-latest` and `jev-preview`, both released 2026-09-10; a `jev-latest` request answered as `jev-1.13.0`.
`POST /v1/systemone` takes `{model, state, questions}`; a `choice` question returns `{choice, probabilities, confidence}` with the probabilities summing to 1.
Observed error shapes: 401 `authentication_error` for a bad key, 403 when the header is missing, 422 with a `detail[].loc` naming the offending field, 400 `api_usage_error` for an unknown model, 405 on GET.
No rate-limit headers were present on any response; every response carried `x-typesafe-request-id`.
Observed end-to-end latency from a Mac was 123 to 348 ms per request, with the server's own upstream time at 4 to 60 ms.
The cookbooks price `jev-1.12` at $0.042 per million input tokens; there is no published price list, so the per-brief cost below is inferred from that constant.

## Live rule match against real briefs

Run 2026-09-16 with the key injected for the one command through the vault (`av inject +TYPESAFE_API_KEY -- ...`), model `jev-latest`, confidence floor 0.6, timeout 5 s, one `quota-axi --json` snapshot for the whole run.
Rules: the captain's five-rule file with a captain-authored none option, one `approval: captain` rule, two rule floors on `model:fable`, and declared `provider` on the Pi profiles.
Briefs: 15 real briefs from this home's recent work plus 10 synthetic ones written to hit each rule.

| Measure | Result |
| --- | --- |
| Rule matched the hand label | 20 of 25 |
| Resolved to the hand-labeled profile | 20 of 25 |
| Outcomes: clear / ambiguous / escalate / error | 18 / 1 / 6 / 0 |
| Clear results with a wrong profile | 0 |
| API latency (min / median / max) | 152 / 214 / 348 ms |
| Wall time per call including jq (min / median / max) | 198 / 261 / 396 ms |
| Input tokens per brief (min / median / max) | 1,279 / 3,114 / 4,538 |
| Output tokens | 150 to 152 |
| API errors | 0 |

Of the five disagreements, one was a wrong hand label (the brief quoted the bug-fix rule's wording verbatim), three were real briefs the model read as the approval-gated design rule at 0.66 to 0.86 confidence and escalated by design, each of which the captain had in fact dispatched at the strongest-reasoning class, and one was a synthetic tweak that came back ambiguous at 0.41 confidence and was handed back to firstmate.
A lean request that asks only the rule Choice matched the full request (rule, profile, and status) on all 25 briefs, which is why the shipped tool asks one question and keeps every gate in code.
That recorded agreement predates the shipped neutral `No listed rule applies to this task.` option. Agreement with the neutral sentence is re-measured as a separate live check outside the pipeline and disclosed in the PR body rather than represented by the historical table.

## What the tool replaces

Measured from this home's own Claude Code transcripts, 83 crewmate and scout dispatches over 34 days ending 2026-09-16, with prices read from platform.claude.com that day.
The routing window is the turns between the brief being written and the spawn that touched quota-axi, the dispatch rules, or the quota helper.

| Measure | Today | With the tool |
| --- | --- | --- |
| Routing API calls per dispatch, median | 3 | 1 |
| Routing output tokens per dispatch, median | 5,867 | about 150 |
| Cost per dispatch, median | $0.90 | $0.235 |
| Wall time per dispatch, median | 28.6 s | 2.75 s |

The saving comes from removing whole turns over a large cached context, not from the text the model replaces, which is why `AGENTS.md` asks for the tool inside the turn that already exists after the brief is written.
Dispatches the tool calls ambiguous or escalates fall back to today's path and save nothing.

## Offline behavior

`tests/fm-dispatch-resolve.test.sh` drives the public interface with a fake `curl` that records argv, the request body, and the header read from file descriptor 3, and with a fake `quota-axi`.
It proves: firstmate can invoke the resolve path without a preflight; rules are consumed from the isolated home's canonical `config/crew-dispatch.json`; the absent key (environment and `.env`) prints one stderr line, nothing on stdout, exits 0, and never invokes `curl` or `quota-axi`; default-only and empty-rules files resolve the default quota argmax with null request evidence and no `curl` call; a `.env` key turns the tool on and the environment wins over it; the key never appears on `curl` argv and arrives only as the bearer header on the descriptor; the request uses the fixed endpoint and model, carries only the project, brief, and rule Choice with one option per rule plus the fixed neutral none option, and never `why`, `use`, or quota; and the clear, fixed-floor ambiguous, escalate (approval, unverifiable rule floor, tie, nothing rankable), known rule-floor fall-through, known and unverifiable profile-floor evidence, declared multi-provider family, partial and unmeasured providers, account-wide quota veto, limiting-bound ranking, missing-curl and quota-axi failures, HTTP 429 and 500, transport failure, malformed usage, zero-mass or malformed probabilities, or confidence, malformed or duplicate profile, removed-option rejection, and out-of-range rule id paths behave as the contract states, with configuration errors exiting 2 before any network call.
`tests/fm-bootstrap.test.sh` proves bootstrap accepts the declared fields and reports each malformed shape.

```console
$ bash tests/fm-dispatch-resolve.test.sh | tail -1
# all fm-dispatch-resolve tests passed
```

A live run needs a key and is not part of the suite; rerun the table above by pointing the tool at a brief with the key injected for that one command.
