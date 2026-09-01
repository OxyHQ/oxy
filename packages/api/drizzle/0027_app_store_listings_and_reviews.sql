-- oxy:deploy-phase=pre
--
-- PRE: five new tables and nothing else. No column is dropped, renamed or
-- narrowed, and no existing statement changes shape, so the previous image goes
-- on serving unaware of them while this lands.
--
-- The app-store module: a listing per application, its screenshots, the reviews
-- people leave and the publisher's single answer to each. Every one references
-- `applications`, `files` or `users` with a real foreign key — see the schema
-- files for what each `ON DELETE` is asserting.
--
CREATE TABLE "app_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "app_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app_listing_screenshots" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"file_id" text NOT NULL,
	"platform" text DEFAULT 'desktop' NOT NULL,
	"caption" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"slug" text NOT NULL,
	"tagline" text,
	"description" text,
	"category_id" text,
	"support_url" text,
	"support_email" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "app_listings_slug_unique" UNIQUE("slug"),
	CONSTRAINT "app_listings_application_id_key" UNIQUE("application_id")
);
--> statement-breakpoint
CREATE TABLE "app_review_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "app_review_replies_review_id_key" UNIQUE("review_id")
);
--> statement-breakpoint
CREATE TABLE "app_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"title" text,
	"body" text,
	"status" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "app_reviews_application_id_user_id_key" UNIQUE("application_id","user_id"),
	CONSTRAINT "app_reviews_rating_range" CHECK ("app_reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "app_listing_screenshots" ADD CONSTRAINT "app_listing_screenshots_listing_id_app_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."app_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_listing_screenshots" ADD CONSTRAINT "app_listing_screenshots_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_listings" ADD CONSTRAINT "app_listings_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_listings" ADD CONSTRAINT "app_listings_category_id_app_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."app_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_review_replies" ADD CONSTRAINT "app_review_replies_review_id_app_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."app_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_review_replies" ADD CONSTRAINT "app_review_replies_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_reviews" ADD CONSTRAINT "app_reviews_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_reviews" ADD CONSTRAINT "app_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_categories_order_idx" ON "app_categories" USING btree ("order");--> statement-breakpoint
CREATE INDEX "app_listing_screenshots_listing_id_position_idx" ON "app_listing_screenshots" USING btree ("listing_id","position");--> statement-breakpoint
CREATE INDEX "app_listing_screenshots_file_id_idx" ON "app_listing_screenshots" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "app_listings_category_id_idx" ON "app_listings" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "app_listings_status_published_at_idx" ON "app_listings" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "app_reviews_application_id_status_created_at_idx" ON "app_reviews" USING btree ("application_id","status","created_at");--> statement-breakpoint
CREATE INDEX "app_reviews_user_id_idx" ON "app_reviews" USING btree ("user_id");