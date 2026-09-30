# Power levels

The concepts (exact model vs power level vs app default) are in the
[developer guide](./README.md); this page is the reference for how a power
level chooses a model. Technical name: **routing profile** with a `powerLevel`.

## The seven presets

Seeded by migration `0129_power_routing_profiles` with fixed ids, so a policy
can name them identically in every environment. All are product presets that
rank on `optimiseFor: price`.

| Slug | `routingProfileId` | Chooses from class | Target reasoning effort |
|---|---|---|---|
| `auto` | `power-auto` | see below | the chosen level's |
| `instant` | `power-instant` | `instant` | none (sent as the least the model accepts) |
| `medium` | `power-medium` | `medium` | `low` |
| `high` | `power-high` | `high` | `medium` |
| `xhigh` | `power-xhigh` | `high` | `high` |
| `pro` | `power-pro` | `pro` | `high` |
| `ultra` | `power-ultra` | `ultra` | `high` (the vocabulary's maximum) |

## How a request at a level is routed

1. **Candidates** are the models whose reviewed class
   (`inference_model_power_classes`) matches the level and that have an
   approved route in the caller's audience. A model with no reviewed class is
   callable by name and chosen by no level.
2. **Servable only.** Each candidate goes through the same resolver as an exact
   request (policy controls, modality, capacity, price and score evidence). A
   member whose evidence is incomplete is skipped and logged
   (`inference.edge.power_level_member_unservable`) instead of failing the whole
   level: a level's membership is dynamic by definition. A deployment Kaana
   does not currently publish is dropped
   ([catalogue.md](./catalogue.md#a-listed-model-is-a-servable-model)).
3. **Order**: within one level, the edge's single ranking — funding class
   (free allowance → discounted pay-as-you-go → promotional credit → standard
   paid), then price score, then exact deployment id. At a level whose target
   effort is `none` (`instant`), a model that does not reason
   (`supports_reasoning = false`) ranks ahead of one that does inside the same
   funding class, before price: a reasoning model spends its output budget on
   reasoning first, which at `instant`'s budgets can be all of it (see below).
4. **Reasoning effort**: when the request names none, the level's target is
   clamped to the chosen deployment — see [the effort rule](#the-effort-rule).
   A caller's own effort always wins and excludes routes that lack it.
5. **Failover across models** inside the level is authorized by the profile
   itself: every signed route is a candidate of the level. The data plane
   reports a switch as a `route_switch` event; Oxy records it in
   `inference_route_switch_events` with `routing_profile_id`, and only when
   the destination model line was signed for that request.
6. The response names the concrete model that ran (`model`, `X-Oxy-Model`).

An exact request (`publisher/model`, `@revision`) never takes part in any of
this: it signs only deployments of that model.

## The effort rule

A level has a TARGET effort (the table above). Its vocabulary, least reasoning
first, is `none` · `minimal` · `low` · `medium` · `high`; a request can carry
only the contract's `low` / `medium` / `high`, so `none` and `minimal` exist
only as targets. The effort sent to a deployment
(`resolvePowerLevelEffort`, `packages/api/src/services/inferencePowerLevels.service.ts`) is:

1. the **lowest** effort it accepts **at or above** the target;
2. else (it accepts nothing that high) the **highest** effort it accepts;
3. else nothing — the model takes no effort control, or the deployment's
   accepted parameters exclude `reasoning.effort`.

"Accepts" is the model's advertised `reasoningEfforts` AND the deployment's
accepted parameters. So today `instant` sends `low` to a reasoning model and
nothing to one without effort control, `medium` sends `low` (else `medium`,
else `high`), and `high` sends `medium` (else `high`, else `low`). When the
contract gains `none` / `minimal`, `instant` reaches them with no rule change.

Why never leave it unsent: a reasoning model sent no effort reasons at its
provider's default (typically `medium`). On 2026-09-30 `instant` sent nothing
to `openai/gpt-oss-120b`, which spent 28 of a 30-token budget reasoning and
answered nothing.

**Failover** keeps one effort, because the envelope carries one: every signed
route must resolve its own level's target to the SAME effort as the admitted
route. A route that would refuse the effort is never signed, and neither is a
reasoning model behind a route that sends none (it would run at its default).
This narrows failover to routes that run the level as intended.

## `auto`

`auto` picks the cheapest level that suffices, from features the edge already
has, and then offers each higher level up to `xhigh` as a lower-priority
fallback (one priority per level). It never chooses `pro` or `ultra`; those
must be named. The rule is deterministic and lives in
`classifyAutoPowerLevel` (`packages/api/src/services/inferencePowerLevels.service.ts`),
behind the `AutoPowerLevelResolver` type so a trained classifier can replace it:

| Request feature | Floor |
|---|---|
| explicit `reasoning.effort: low` / `medium` / `high` | `medium` / `high` / `xhigh` |
| 1–8 tools / more than 8 tools | `medium` / `high` |
| structured output (`json_schema` or `json_object`) | `medium` |
| any non-text input part | `medium` |
| estimated input above 8 000 / 64 000 tokens | `medium` / `high` |
| `maxOutputTokens` above 4 096 / 16 000 | `medium` / `high` |

The result is the highest floor any rule sets (`instant` when none fires). The
decision and its reasons are logged as `inference.edge.auto_power_level`.

## Per-application default and allowed levels

A routing policy's `defaultTarget` may be a level
(`{ "kind": "routing_profile_id", "routingProfileId": "power-instant" }`), and
`allowedRoutingProfileIds` restricts which profiles the application may name.
Empty means unrestricted. A request naming a profile outside the list is
refused with `policy_violation` (403) before any reservation or Kaana call;
`auto` climbs only to allowed levels; a default outside the list is refused
at write time. Concrete model targets are governed by the other policy
controls, not by this list.

Staff set both in Console at `/apps/<appId>/inference`, **Routing policy**
tab: the **Power levels** checkboxes are `allowedRoutingProfileIds` (none
ticked = unrestricted) and **Default target** offers each level. Saving
appends a new policy version; the editor runs the contract's own schema first.

| App | `defaultTarget` | `allowedRoutingProfileIds` |
|---|---|---|
| Oxy Inbox (summaries) | `power-instant` | `["power-instant"]` |
| Alia | set by Alia | the levels Alia shows its users |

## The reviewed classes

Seeded by the same migration. Source: the
[Artificial Analysis Intelligence Index](https://artificialanalysis.ai/leaderboards/models)
v4.3.2, cross-checked against the [LMArena text leaderboard](https://lmarena.ai/leaderboard/text),
read 2026-09-30. Bands on that index: `ultra` ≥ 50, `pro` 40–49, `high` 28–39,
`medium` 13–27, `instant` ≤ 12 — except a publisher's cheapest SKU (nano /
flash-lite tier), which is `instant` on its published price tier. Only models
present in Kaana's reference inventory with a fetched source page are classed.
Each row stores its source, URL, summary, review time and reviewer.

| Model | Class | Source | Basis |
|---|---|---|---|
| `anthropic/claude-fable-5` | ultra | [AA `claude-fable-5`](https://artificialanalysis.ai/models/claude-fable-5) | AA Intelligence Index 50, rank 18/222 (publisher-deprecated; replaced by Fable 5.1) |
| `anthropic/claude-opus-5` | ultra | [AA `claude-opus-5`](https://artificialanalysis.ai/models/claude-opus-5) | AA Intelligence Index 51, rank 15/222 |
| `anthropic/claude-opus-4.7` | pro | [AA `claude-opus-4-7`](https://artificialanalysis.ai/models/claude-opus-4-7) | AA Intelligence Index 41 (max effort), rank 50/222 |
| `anthropic/claude-opus-4.8` | pro | [AA `claude-opus-4-8`](https://artificialanalysis.ai/models/claude-opus-4-8) | AA Intelligence Index 42 (max effort), rank 47/222 |
| `moonshotai/kimi-k3` | pro | [AA `kimi-k3`](https://artificialanalysis.ai/models/kimi-k3) | AA Intelligence Index 44 (max effort); #3 of 117 open-weight |
| `openai/gpt-5.6-sol` | pro | [AA `gpt-5-6-sol`](https://artificialanalysis.ai/models/gpt-5-6-sol) | AA Intelligence Index 47 (max effort), rank 25/222 |
| `openai/gpt-5.6-terra` | pro | [AA `gpt-5-6-terra`](https://artificialanalysis.ai/models/gpt-5-6-terra) | AA Intelligence Index 42 (max effort), rank 46/222 |
| `qwen/qwen3.8-max` | pro | [AA `qwen3-8-max`](https://artificialanalysis.ai/models/qwen3-8-max) | AA Intelligence Index 45, rank 31/222 |
| `x-ai/grok-4.6` | pro | [AA `grok-4-6`](https://artificialanalysis.ai/models/grok-4-6) | AA Intelligence Index 44 (high effort), rank 35/222 |
| `z-ai/glm-5.3` | pro | [AA `glm-5-3`](https://artificialanalysis.ai/models/glm-5-3) | AA Intelligence Index 45 (max effort); #2 of 117 open-weight |
| `anthropic/claude-sonnet-5` | high | [AA `claude-sonnet-5`](https://artificialanalysis.ai/models/claude-sonnet-5) | AA Intelligence Index 38 (max effort), rank 63/222 |
| `deepseek/deepseek-v4-flash-0731` | high | [AA `deepseek-v4-flash`](https://artificialanalysis.ai/models/deepseek-v4-flash) | AA Intelligence Index 34 (max effort); #10 of 117 open-weight |
| `deepseek/deepseek-v4-pro-0813` | high | [AA `deepseek-v4-pro`](https://artificialanalysis.ai/models/deepseek-v4-pro) | AA Intelligence Index 36 (max effort); #9 of 117 open-weight |
| `google/gemini-3.1-pro-preview` | high | [AA `gemini-3-1-pro-preview`](https://artificialanalysis.ai/models/gemini-3-1-pro-preview) | AA Intelligence Index 30, rank 91/222 |
| `google/gemini-3.5-flash` | high | [AA `gemini-3-5-flash`](https://artificialanalysis.ai/models/gemini-3-5-flash) | AA Intelligence Index 33 (high effort), rank 81/222 |
| `google/gemini-3.6-flash` | high | [AA `gemini-3-6-flash`](https://artificialanalysis.ai/models/gemini-3-6-flash) | AA Intelligence Index 34 (high effort), rank 72/222 |
| `google/gemini-3.7-flash` | high | [AA `gemini-3-7-flash`](https://artificialanalysis.ai/models/gemini-3-7-flash) | AA Intelligence Index 39 (high effort), rank 59/222 |
| `minimax/minimax-m3` | high | [AA `minimax-m3`](https://artificialanalysis.ai/models/minimax-m3) | AA Intelligence Index 29; #18 of 117 open-weight |
| `openai/gpt-5.2` | high | [AA `gpt-5-2`](https://artificialanalysis.ai/models/gpt-5-2) | AA Intelligence Index 30 (xhigh effort), rank 87/222 |
| `openai/gpt-5.4` | high | [AA `gpt-5-4`](https://artificialanalysis.ai/models/gpt-5-4) | AA Intelligence Index 39 (xhigh effort), rank 60/222 |
| `openai/gpt-5.5` | high | [AA `gpt-5-5`](https://artificialanalysis.ai/models/gpt-5-5) | AA Intelligence Index 38 (xhigh effort), rank 62/222 |
| `openai/gpt-5.6-luna` | high | [AA `gpt-5-6-luna`](https://artificialanalysis.ai/models/gpt-5-6-luna) | AA Intelligence Index 37 (max effort); #6 of 174 in its price tier |
| `qwen/qwen3.7-max` | high | [AA `qwen3-7-max`](https://artificialanalysis.ai/models/qwen3-7-max) | AA Intelligence Index 29, rank 92/222 |
| `qwen/qwen3.8-27b` | high | [AA `qwen3-8-27b`](https://artificialanalysis.ai/models/qwen3-8-27b) | AA Intelligence Index 34 (xhigh effort); #1 of 142 in its size class |
| `x-ai/grok-4.5` | high | [AA `grok-4-5`](https://artificialanalysis.ai/models/grok-4-5) | AA Intelligence Index 39 (high effort), rank 61/222 |
| `z-ai/glm-5.2` | high | [AA `glm-5-2`](https://artificialanalysis.ai/models/glm-5-2) | AA Intelligence Index 34 (max effort); #12 of 117 open-weight |
| `anthropic/claude-haiku-4.5` | medium | [AA `claude-4-5-haiku`](https://artificialanalysis.ai/models/claude-4-5-haiku) | AA Intelligence Index 15 non-reasoning, 17 reasoning |
| `deepseek/deepseek-v3.2` | medium | [AA `deepseek-v3-2`](https://artificialanalysis.ai/models/deepseek-v3-2) | AA Intelligence Index 16 non-reasoning (AA estimate) |
| `google/gemma-4-26b-a4b-it` | medium | [AA `gemma-4-26b-a4b`](https://artificialanalysis.ai/models/gemma-4-26b-a4b) | AA Intelligence Index 17 (reasoning) |
| `google/gemma-4-31b-it` | medium | [AA `gemma-4-31b`](https://artificialanalysis.ai/models/gemma-4-31b) | AA Intelligence Index 15 (reasoning) |
| `minimax/minimax-m2.7` | medium | [AA `minimax-m2-7`](https://artificialanalysis.ai/models/minimax-m2-7) | AA Intelligence Index 23 |
| `mistralai/mistral-medium-3-5` | medium | [AA `mistral-medium-3-5`](https://artificialanalysis.ai/models/mistral-medium-3-5) | AA Intelligence Index 14 |
| `moonshotai/kimi-k2.6` | medium | [AA `kimi-k2-6`](https://artificialanalysis.ai/models/kimi-k2-6) | AA Intelligence Index 27; #21 of 117 open-weight |
| `nvidia/nemotron-3-super-120b-a12b` | medium | [AA `nvidia-nemotron-3-super-120b-a12b`](https://artificialanalysis.ai/models/nvidia-nemotron-3-super-120b-a12b) | AA Intelligence Index 13 (reasoning) |
| `openai/gpt-5-mini` | medium | [AA `gpt-5-mini`](https://artificialanalysis.ai/models/gpt-5-mini) | AA Intelligence Index 17 (high effort) |
| `openai/gpt-5.4-mini` | medium | [AA `gpt-5-4-mini`](https://artificialanalysis.ai/models/gpt-5-4-mini) | AA Intelligence Index 24 (xhigh effort), rank 125/222 |
| `qwen/qwen3.5-397b-a17b` | medium | [AA `qwen3-5-397b-a17b`](https://artificialanalysis.ai/models/qwen3-5-397b-a17b) | AA Intelligence Index 18 (reasoning) |
| `qwen/qwen3.6-35b-a3b` | medium | [AA `qwen3-6-35b-a3b`](https://artificialanalysis.ai/models/qwen3-6-35b-a3b) | AA Intelligence Index 18 (reasoning); #13 of 142 in its size class |
| `qwen/qwen3.7-plus` | medium | [AA `qwen3-7-plus`](https://artificialanalysis.ai/models/qwen3-7-plus) | AA Intelligence Index 25 |
| `x-ai/grok-4.3` | medium | [AA `grok-4-3`](https://artificialanalysis.ai/models/grok-4-3) | AA Intelligence Index 25 (high effort), rank 118/222 |
| `z-ai/glm-4.7-flash` | medium | [AA `glm-4-7-flash`](https://artificialanalysis.ai/models/glm-4-7-flash) | AA Intelligence Index 15 (reasoning); #18 of 142 in its size class |
| `z-ai/glm-5.1` | medium | [AA `glm-5-1`](https://artificialanalysis.ai/models/glm-5-1) | AA Intelligence Index 26; #22 of 117 open-weight |
| `amazon/nova-2-lite-v1` | instant | [AA `nova-2-0-lite`](https://artificialanalysis.ai/models/nova-2-0-lite) | AA Intelligence Index 9 non-reasoning |
| `amazon/nova-micro-v1` | instant | [AA `nova-micro`](https://artificialanalysis.ai/models/nova-micro) | AA Intelligence Index 6 |
| `google/gemini-2.5-flash` | instant | [AA `gemini-2-5-flash`](https://artificialanalysis.ai/models/gemini-2-5-flash) | AA Intelligence Index 10 non-reasoning |
| `google/gemini-3.5-flash-lite` | instant | [AA `gemini-3-5-flash-lite`](https://artificialanalysis.ai/models/gemini-3-5-flash-lite) | Publisher's lowest-cost Flash-Lite tier; AA Intelligence Index 22, #33 of 174 in its price tier |
| `meta-llama/llama-3.1-8b-instruct` | instant | [AA `llama-3-1-instruct-8b`](https://artificialanalysis.ai/models/llama-3-1-instruct-8b) | AA Intelligence Index 7 |
| `meta-llama/llama-4-scout` | instant | [AA `llama-4-scout`](https://artificialanalysis.ai/models/llama-4-scout) | AA Intelligence Index 8 |
| `microsoft/phi-4` | instant | [AA `phi-4`](https://artificialanalysis.ai/models/phi-4) | AA Intelligence Index 6 (AA estimate) |
| `mistralai/ministral-8b-2512` | instant | [AA `ministral-3-8b`](https://artificialanalysis.ai/models/ministral-3-8b) | AA Intelligence Index 5 (Ministral 3 8B) |
| `mistralai/mistral-small-2603` | instant | [AA `mistral-small-4`](https://artificialanalysis.ai/models/mistral-small-4) | AA Intelligence Index 11 (Mistral Small 4, released 2026-03-16) |
| `nvidia/nemotron-3-nano-30b-a3b` | instant | [AA `nvidia-nemotron-3-nano-30b-a3b`](https://artificialanalysis.ai/models/nvidia-nemotron-3-nano-30b-a3b) | AA Intelligence Index 7 non-reasoning |
| `openai/gpt-4.1-mini` | instant | [AA `gpt-4-1-mini`](https://artificialanalysis.ai/models/gpt-4-1-mini) | AA Intelligence Index 10 |
| `openai/gpt-4.1-nano` | instant | [AA `gpt-4-1-nano`](https://artificialanalysis.ai/models/gpt-4-1-nano) | AA Intelligence Index 8 |
| `openai/gpt-4o-mini` | instant | [AA `gpt-4o-mini`](https://artificialanalysis.ai/models/gpt-4o-mini) | AA Intelligence Index 7 |
| `openai/gpt-5-nano` | instant | [AA `gpt-5-nano`](https://artificialanalysis.ai/models/gpt-5-nano) | Publisher's smallest nano tier; AA Intelligence Index 13 (high effort) |
| `openai/gpt-5.4-nano` | instant | [AA `gpt-5-4-nano`](https://artificialanalysis.ai/models/gpt-5-4-nano) | Publisher's smallest nano tier; AA Intelligence Index 21 (xhigh), #41 of 174 in its price tier |
| `openai/gpt-oss-120b` | instant | [AA `gpt-oss-120b`](https://artificialanalysis.ai/models/gpt-oss-120b) | AA Intelligence Index 12 (high effort) |
| `openai/gpt-oss-20b` | instant | [AA `gpt-oss-20b`](https://artificialanalysis.ai/models/gpt-oss-20b) | AA Intelligence Index 9 (high effort) |

Not classed on purpose (callable by name, chosen by no level): models whose
source page could not be fetched, very low-scoring large or legacy models
(e.g. `mistralai/mistral-large-2512`, `amazon/nova-premier-v1`,
`cohere/command-a`, `meta-llama/llama-4-maverick`), poor-value ones
(`openai/o3-pro`), and the three Anthropic 4.x models Artificial Analysis
scores only without reasoning (`claude-opus-4.6`, `claude-sonnet-4.6`,
`claude-opus-4.5`).

### Changing a class

A class is reviewed data: change it with a new migration that updates the row
(source, URL, summary, reviewer, time) in a reviewed PR. Never derive it from a
model name, and never let the Kaana sync write it.
