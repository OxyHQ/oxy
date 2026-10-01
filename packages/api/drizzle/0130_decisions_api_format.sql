-- oxy:deploy-phase=pre
-- Add the typed decisions dialect to the allowed capability declarations.
-- This changes no catalogue rows and does not authorize any provider.
ALTER TABLE "inference_models" DROP CONSTRAINT "inference_models_api_formats_check";--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_api_formats_check" CHECK ("inference_models"."api_formats" is null or (cardinality("inference_models"."api_formats") >= 1 and "inference_models"."api_formats" <@ array['responses', 'chat_completions', 'embeddings', 'decisions', 'images_generations', 'audio_transcriptions', 'audio_speech', 'rerank', 'batches']::text[]));