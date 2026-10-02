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
     PCM16 each way, 20 responses); or
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
signed byte caps). OpenAI-Realtime-protocol compatibility for OpenAI SDKs, and a
browser-safe ephemeral token, are follow-ups.

## Settlement

A session is one request: one hold, one receipt.

- **Hold:** per authorized route, `maxResponses × context window` at the dearest
  of the four input token units and `maxResponses × route output cap` at the
  dearest of the three output units, plus `requests`. The route cap, rather than
  the opening config's cap, covers later session updates and per-response
  overrides. Every unit must be priced. The hold expires after the session's
  maximum duration, the resume window and a grace, not after the one-shot 15
  minutes.
- **Settle, in order of authority:** the usage report Kaana sends after
  `session.closed`; if that frame is lost, the units `session.closed` carried,
  else the sum of `response.done` units (never `completed`); else zero units
  marked `estimated` (`usage_unavailable`), reconcilable by `requestId`. The
  ledger key is the request id, so a second settlement is a no-op.
- The edge task's SIGTERM drops its sessions without settling them; their holds
  are released by the reservation sweeper at expiry.
