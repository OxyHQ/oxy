-- oxy:deploy-phase=pre
--
-- The sticker catalogue (`src/db/schema/stickers.ts`): packs, their stickers,
-- and the packs each person installed. All three tables are new, so nothing
-- serving today reads or writes them.
--
-- `files` gains the `sticker` purpose and the `__stickers__` system owner.
-- Both CHECKs are strictly WIDER than the ones they replace, so the image still
-- serving cannot violate them, and the arriving image needs them before its
-- first sticker upload. PRE, for the same reason 0022 gave.
--
-- LOCKING: `files` holds every stored asset, so a plain `ADD CONSTRAINT … CHECK`
-- would hold ACCESS EXCLUSIVE for a full-table scan. The re-added CHECKs are
-- `NOT VALID` instead: they are enforced on every write from this point on, and
-- skipping the scan is safe because a widening cannot fail on an existing
-- row. `VALIDATE CONSTRAINT` would not help here — the migrator replays pending
-- migrations in one transaction, so the ADD's lock would be held through it.
CREATE TABLE "sticker_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"author" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "sticker_packs_slug_unique" UNIQUE("slug"),
	CONSTRAINT "sticker_packs_status_check" CHECK ("sticker_packs"."status" in ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "stickers" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"position" integer NOT NULL,
	"emoji" text[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"lottie_file_id" text NOT NULL,
	"fallback_file_id" text NOT NULL,
	"size" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "stickers_size_check" CHECK ("stickers"."size" in (512, 1024)),
	CONSTRAINT "stickers_duration_ms_check" CHECK ("stickers"."duration_ms" > 0),
	CONSTRAINT "stickers_emoji_check" CHECK (cardinality("stickers"."emoji") > 0)
);
--> statement-breakpoint
CREATE TABLE "user_sticker_packs" (
	"user_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"position" integer NOT NULL,
	"installed_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_sticker_packs_user_id_pack_id_pk" PRIMARY KEY("user_id","pack_id")
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_purpose_check";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_system_owner_check";--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_pack_id_sticker_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_lottie_file_id_files_id_fk" FOREIGN KEY ("lottie_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_fallback_file_id_files_id_fk" FOREIGN KEY ("fallback_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sticker_packs" ADD CONSTRAINT "user_sticker_packs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sticker_packs" ADD CONSTRAINT "user_sticker_packs_pack_id_sticker_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sticker_packs_status_published_at_idx" ON "sticker_packs" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "stickers_pack_id_position_idx" ON "stickers" USING btree ("pack_id","position");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_purpose_check" CHECK ("files"."purpose" in ('user', 'federation-media-cache', 'sticker')) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_system_owner_check" CHECK ("files"."system_owner" is null or "files"."system_owner" in ('__federation__', '__federation_media_cache__', '__stickers__')) NOT VALID;