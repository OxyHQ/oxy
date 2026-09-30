-- oxy:deploy-phase=pre
--
-- Capability declarations for the catalogue (@oxy.so/contracts 4.4.0, inference
-- contract set 3.2.0; OxyHQ/Kaana#90): `inference_models.api_formats` (the
-- request dialects a route to the model can execute) and the realtime pair
-- `realtime_transports` / `realtime_session_kinds`. The edge authorizes spoken
-- output on chat completions and realtime sessions only against these
-- declarations, because catalogue presence alone is not capability evidence.
--
-- PRE: three nullable columns and two CHECKs that hold trivially on every
-- existing row (all three columns are NULL on it). The image still serving
-- never names the columns; the arriving one reads them. `inference_models` is
-- a small reviewed table, so the CHECKs are validated in place rather than
-- added NOT VALID.
ALTER TABLE "inference_models" ADD COLUMN "api_formats" text[];--> statement-breakpoint
ALTER TABLE "inference_models" ADD COLUMN "realtime_transports" text[];--> statement-breakpoint
ALTER TABLE "inference_models" ADD COLUMN "realtime_session_kinds" text[];--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_api_formats_check" CHECK ("inference_models"."api_formats" is null or (cardinality("inference_models"."api_formats") >= 1 and "inference_models"."api_formats" <@ array['responses', 'chat_completions', 'embeddings', 'images_generations', 'audio_transcriptions', 'audio_speech', 'rerank', 'batches']::text[]));--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_realtime_check" CHECK (("inference_models"."realtime_transports" is null and "inference_models"."realtime_session_kinds" is null) or ("inference_models"."realtime_transports" is not null and "inference_models"."realtime_session_kinds" is not null and cardinality("inference_models"."realtime_transports") >= 1 and "inference_models"."realtime_transports" <@ array['websocket']::text[] and cardinality("inference_models"."realtime_session_kinds") >= 1 and "inference_models"."realtime_session_kinds" <@ array['conversation', 'transcription', 'translation']::text[] and 'audio' = any("inference_models"."input_modalities")));