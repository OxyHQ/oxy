# ADR 0051 — Image input: who may send images, and how they are bounded

- Status: accepted (the owner's decision of 2026-10-28 to let Alia see a tab
  screenshot and read scanned PDF pages); the `alia-kaana` image terms below
  were approved as written by the owner on 2026-10-28.
- Date: 2026-10-28
- Data plane: Kaana ADR 0007 (the image rules, the declared per-image bound,
  the grant fact `inputImages`), `@kaana.ai/contracts` 8.2.0.

## Context

The old edge refused every non-text part (`unsupported_modality`): an image has
no character count, so a hold sized from the request could not bound it. The
grant API did not refuse it and granted it as text, on lines that cannot see and
with a hold that ignored it. Alia's agent needs to see a screenshot Astro's
browser tool returns, and to read scanned PDF pages (Alia #918).

Every provider behind Kaana's image-capable lines bills an image as input tokens
at the line's input price. What one image costs is each publisher's documented
resize and tokenization rule, which Kaana declares per line as
`imageInput.maxInputTokensPerImage` (Kaana ADR 0007).

## Decision

1. **Images are the contract's, checked before anything is held.** Both
   surfaces apply `checkImageInput`: inline base64 only (no image URL is fetched
   or forwarded), PNG, JPEG, WebP or GIF, at most 3,750,000 bytes each, on a
   user or tool message, at most 20 a request. An issue is `invalid_request`
   naming the part (`input.messages[i].content[j].source.data`), never the
   image. Audio and file parts stay refused on the old edge.
2. **Only a line that declares its bound serves images.** The request needs a
   model whose `inputModalities` has `image` and whose line Kaana declares
   `imageInput` for. Otherwise `unsupported_modality` (`param: model`). The old
   edge reads the bound from Kaana's declared catalogue, as the grant does; an
   unreadable catalogue is `service_unavailable`.
3. **Every image is held at its line's bound.** Per route, the input is the
   text estimate (which never counts image bytes) plus images × the line's
   bound: in the context fit, the price-ceiling quote and the hold. Settlement
   is the provider's own input-token count at `input_tokens`; no unit is added.
4. **Commercial callers may send images** on a declared line: the hold is a
   bound, which is what kept them out.
5. **An internal relationship sends images only under image terms.**
   `pilot.imageInput` (`maxImages`, `maxPricePerRequestUsd`, exact
   `deployments`) sits beside a pilot's text terms. A request with images signs
   only those routes, at that ceiling (a tighter application ceiling wins),
   inside the text terms' input and output ceilings, with each image's bytes
   left out of the controlled input. Without the terms: `unsupported_modality`
   (`pilot-image-input`); more images than `maxImages`: `invalid_request`
   (`pilot-image-count`). The ADR 0037 promotional lane is unchanged; its route
   must declare `imageInput` like any other.
6. **Alia gets terms; Astro and Mention do not.** Alia's agent and its document
   reading need images. Astro's one-shot features (tab group names, titles,
   filenames, transcript summaries) and Mention's text features send none, so
   `astro-kaana-session` and `mention-kaana-text` stay text only.
7. **An image is payload.** It is never persisted, logged, put in an error, a
   usage row or a telemetry event (ADR 0016); a test plants a marker in an image
   and searches every logged field.

## The `alia-kaana` terms (approved 2026-10-28)

16 images and USD 0.15 a request, on one OpenRouter route per level Alia offers
(zero data retention, sold `platform_internal` by Kaana): `openai/gpt-5.4-nano`
(instant, 7,374 tokens an image), `anthropic/claude-haiku-4.5` (medium, 1,568)
and `anthropic/claude-sonnet-5` (high and xhigh, 4,784). A 1024×768 screenshot
costs about $0.00018, $0.0010 and $0.0021 on them. The arithmetic is in
`config/inferenceEconomicPolicy.ts` and
[internal-metering.md](../inference/internal-metering.md#image-input-2026-10-28).

## Consequences

- Rollout: `@kaana.ai/contracts` 8.2.0 is published, then this deploys (an
  Oxy on 8.1.x or earlier refuses a declared catalogue carrying `imageInput`), then Kaana
  declares the bounds and sends `inputImages`. Until Kaana declares a bound, no
  line serves images and every image request is `unsupported_modality`.
- The old edge's 768 KiB body limit still bounds a request; Alia keeps its
  images inside it.
- A model gains images by Kaana's reviewed catalogue commit; a relationship
  gains them by a reviewed change to its terms here.

## Alternatives considered

- **Bound by the context window.** Sound with no evidence, but it quotes every
  image request at the line's whole context and prices most lines out.
- **Images under the text tuples.** Alia's text routes cannot see; a request
  with images would have no route at any level.
- **Images for every internal relationship.** No product but Alia asks for them,
  and terms nobody needs are spend nobody reviewed.
