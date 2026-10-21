-- oxy:deploy-phase=pre
--
-- A person uploading through their own session (`POST /assets/uploads`) opens
-- an upload session no application opened: NULL `uploader_application_id`.
-- Relaxing NOT NULL is additive: the code before this writes it always.
ALTER TABLE "file_upload_sessions" ALTER COLUMN "uploader_application_id" DROP NOT NULL;
