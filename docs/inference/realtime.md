# Audio chat and realtime sessions

Contract set 3.2.0 (`@oxy.so/contracts` 4.4.0), OxyHQ/Kaana#90. The normative
shapes are `packages/contracts/src/inference/realtime.ts` (sessions) and
`request.ts`/`streamEvents.ts` (`audioOutput`, the `output_audio_transcript`
channel). This page is what the Oxy edge does with them.

## Capability declarations decide what is served

A model row may declare `api_formats` (the request dialects its routes can
execute) and a realtime pair (`realtime_transports`, `realtime_session_kinds`),
migration 0126. NULL is **undeclared**, never "every":

| Request | Needs |
|---|---|
| Any one-shot dialect | the dialect in `api_formats` **if** the model declares any |
| Spoken output on `/v1/chat/completions` | `chat_completions` **declared**, audio among the output modalities |
| A realtime session | the kind **and** transport declared (and audio input, a CHECK) |

A refusal on a missing declaration is `unsupported_modality` before any hold
(`capability-unsupported` in `resolveEdgeRoute`). The Kaana sync never writes
these columns; reviewed catalogue tooling and the model-documentation ingest do.

## Audio chat — `POST /v1/chat/completions`

OpenAI's own request fields: `modalities: ["text", "audio"]` and
`audio: { voice, format }` (`wav`, `mp3`, `flac`, `opus`, `pcm16`; `aac` is not
in the contract and is refused). A streamed request must use `pcm16`. The edge
forwards the envelope's `audioOutput` with modality `audio`.

- **Streamed:** Kaana's `audio` events become `delta.audio { id, data }` (the
  first chunk of each output also carries `expires_at`); its
  `output_audio_transcript` deltas become `delta.audio { id, transcript }`.
  Neither ever becomes `delta.content`.
- **Not streamed:** `message.audio { id, data, transcript, expires_at }` with
  `content: null` unless the model also wrote text. `expires_at` is the
  response's `created`: Oxy retains no audio, so an audio id cannot be
  referenced by a later request (multi-turn audio references are refused by
  the request schema).
- **Usage:** the audio-token units are nested back into OpenAI's totals —
  `prompt_tokens_details.audio_tokens` (all audio input),
  `prompt_tokens_details.cached_tokens_details.audio_tokens`,
  `completion_tokens_details.audio_tokens` — only when audio was metered, so a
  text completion's body is unchanged. `X-Oxy-Usage-Audio-*` headers likewise.
- **Money:** the output partition of the hold gains `audio_output_tokens`, so a
  route must price it (and `output_tokens`, `reasoning_tokens`) or the request
  is refused before the hold — an unpriced unit never becomes a free one.
  Audio INPUT parts remain refused on the chat surface (no sound ceiling).

## Realtime — `GET /v1/realtime?model=<publisher>/<model>`

A WebSocket upgrade with `Authorization: Bearer <api key>` — the same credential
lanes, audience gate and scopes as every `/v1` endpoint. `X-Oxy-Request-Id` on
the `101` names the session (and its receipt at `GET /v1/generations/:id`).

**The protocol is the contract's own**, one JSON text frame per message:

1. First frame, either
   - `{"type":"session.open","kind":"conversation","config":{…},"limits":{…}?,"transport":"websocket"?,"clientSessionId"?,"labels"?}`
     — `config` is `realtimeSessionConfigSchema`, `limits` a partial
     `realtimeSessionLimitsSchema` (defaults: 10 min, 2 min idle, 10 min of
     PCM16 each way, 20 responses) plus the edge's own `maxTextItems`
     (default: `maxResponses`; see "Duration-priced routes"); or
   - the contract's `session.resume` command (see below).
2. Then `realtimeClientCommandSchema` commands in, `realtimeServerEventSchema`
   events out, with Kaana's single monotonic `sequence`. Each command is
   acknowledged by `command.accepted` before it is applied; resend an
   unacknowledged command only under the SAME `commandId`.
3. `session.closed`, then the socket closes `1000` once the session is settled.

The edge authorizes the model (realtime capability, routing policy, same-model
routes only), holds spend against the signed limits, signs the contract's
`realtimeSessionRequestSchema`, and relays. It validates every frame both ways
and never forwards a frame it could not parse.

| Close | Meaning |
|---|---|
| 1000 | The session ended and was settled |
| 1003 | The customer sent a binary frame; the session was closed through the data plane first |
| 1008 | A refusal (auth, audience, invalid first frame, refused resume) or a command outside the session |
| 1009 | A frame over 2 MiB |
| 1011 | Oxy or the data plane failed; after a lost upstream the session stays resumable for its window |
| 1013 | No data plane is available; try again later |
| 4000 | This connection was replaced by a `session.resume` on another |

A refusal before any session exists is one `error` event (`fatal: true`,
`sequence: 0`) and the close — no `session.closed`, because none was opened.

**Resume.** A dropped connection leaves the session alive for
`session.created.resumeWindowMs`. Reconnect and send
`{"schemaVersion":1,"type":"session.resume","requestId":…,"commandId":…,"afterSequence":<last processed>}`
as the first frame; the edge signs it as its own first frame and Kaana replays
every event after `afterSequence`. Sessions are held in the memory of the edge
task (and the Kaana task) that opened them, so a resume that reaches another
task is refused with `invalid_request` exactly as Kaana refuses one.

**What is not served yet**, and why: `transcription` and `translation` sessions
and input-audio transcription consume audio outside responses, where no signed
limit bounds the tokens — so no hold could be sound. They need a declared audio
token rate per model (or duration pricing, whose milliseconds are exact from the
signed byte caps — the mechanism below, which today admits `conversation`
sessions only). OpenAI-Realtime-protocol compatibility for OpenAI SDKs, and a
browser-safe ephemeral token, are follow-ups.

**Turn detection is Kaana's to refuse.** `config.turnDetection` is signed
verbatim. The catalogue declares no per-model set of supported turn detections,
so the edge has no capability to check it against (and a provider-name
allow-list is not a capability). Kaana refuses one its adapter cannot bill — for
xAI, anything but `{"type":"none"}` (push-to-talk: `server_vad` is billed for
wall-clock session time, which no contract unit carries) — at open, before it
dials (the hold is released with a zero `estimated` receipt), and in
`session.update` as a non-fatal command error. A declared supported set on the
catalogue row is the follow-up that would let the edge refuse it first.

## Duration-priced routes (xAI Voice Agent)

A route whose price version prices `audio_input_milliseconds`,
`audio_output_milliseconds` and `requests` — and no token unit — is held from
the signed limits, exactly (`realtimeDurationCeiling`,
`services/inferenceEdge.service.ts`):

| Unit | Ceiling | Why it is a bound |
|---|---|---|
| `audio_input_milliseconds` | ⌈`maxInputAudioBytes` ÷ input bytes/ms⌉ | Kaana refuses a command that would pass the signed input byte cap and meters written bytes at the signed `inputAudioFormat` (fixed at open) |
| `audio_output_milliseconds` | ⌈`maxOutputAudioBytes` ÷ output bytes/ms⌉ | likewise for provider audio; with no `outputAudioFormat` signed, the format with the most milliseconds per byte (G.711) is assumed, never PCM16 |
| `requests` | `maxTextItems` | enforced by the edge (below); no signed limit bounds text items |

PCM16 24 kHz is 48 bytes/ms, G.711 8 bytes/ms. With the default limits that is
600 000 ms each way (PCM16) and 20 items: $1.68 at xAI's list prices.

**The text-item cap.** xAI bills $0.004 per client `conversation.item.create`
except a `function_call_output` and an item whose content is audio with data
(`realtimeTextItemBilled`, mirroring Kaana's `meter.go`; an item carrying both
is refused by Kaana and counted by the edge). The edge counts each such command
once per `commandId` (a same-id resend is not re-applied upstream) and, when a
new one would pass `maxTextItems`, does not forward it: it closes the session
through the data plane (`session.close`, relays to `session.closed`, settles)
and closes the customer 1008. `maxTextItems` is the edge's only unsigned limit;
Kaana never sees it. It applies only to a session one of whose routes was held
for duration units.

**Which ceiling a route gets.** Per route, the first plan whose every scenario
quotes: tokens **and** duration (a route pricing both is held for both, because
Oxy does not know which the data plane will report), then tokens alone (OpenAI
Realtime — held exactly as before, with no text-item cap), then duration alone.
A route that prices neither completely is refused `no_route_available`
(`routing_evidence:missing-price`) before any hold or upstream connection.

## Settlement

A session is one request: one hold, one receipt.

- **Hold:** per authorized route, `maxResponses × context window` at the dearest
  of the four input token units and `maxResponses × per-response output cap` at
  the dearest of the three output units, plus `requests` — or, for a
  duration-priced route, the duration ceiling above — plus
  `session_milliseconds` at `maxDurationMs + 60 000` (contract set 3.3.0; the
  allowance covers Kaana's bounded open, 20 s per stage, since Kaana measures
  from the accepted upstream handshake) on every plan. Every unit must be priced: a route
  whose provider bills no session time (OpenAI) prices `session_milliseconds`
  explicitly at zero, exactly as `requests`; a route that leaves it unpriced is
  refused before the hold. The hold expires after the session's maximum duration, the resume
  window and a grace, not after the one-shot 15 minutes.
- **Settle, in order of authority:** the usage report Kaana sends after
  `session.closed`; if that frame is lost, the units `session.closed` carried,
  else the sum of `response.done` units (never `completed`); else zero units
  marked `estimated` (`usage_unavailable`), reconcilable by `requestId`. The
  ledger key is the request id, so a second settlement is a no-op.
- The edge task's SIGTERM drops its sessions without settling them; their holds
  are released by the reservation sweeper at expiry.
