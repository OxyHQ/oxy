-- oxy:deploy-phase=pre
-- Additive I07 provenance, empty catalogue, no legacy backfill.
CREATE TABLE "access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"source_segment_id" text NOT NULL,
	"beneficiary_account_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_version" integer NOT NULL,
	"origin" text NOT NULL,
	"benefit_index" integer NOT NULL,
	"product_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "access_grants_segment_benefit_key" UNIQUE("source_segment_id","benefit_index"),
	CONSTRAINT "access_grants_period_check" CHECK ("access_grants"."period_end" > "access_grants"."period_start")
);
--> statement-breakpoint
CREATE TABLE "access_offer_benefits" (
	"offer_id" text NOT NULL,
	"offer_version" integer NOT NULL,
	"benefit_index" integer NOT NULL,
	"product_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"unit" text,
	"included" bigint,
	"combination" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "access_offer_benefits_offer_id_offer_version_benefit_index_pk" PRIMARY KEY("offer_id","offer_version","benefit_index"),
	CONSTRAINT "access_offer_benefits_product_key" UNIQUE("offer_id","offer_version","benefit_index","product_id"),
	CONSTRAINT "access_offer_benefits_index_check" CHECK ("access_offer_benefits"."benefit_index" >= 0),
	CONSTRAINT "access_offer_benefits_kind_check" CHECK ("access_offer_benefits"."kind" in ('capability', 'quota')),
	CONSTRAINT "access_offer_benefits_shape_check" CHECK (("access_offer_benefits"."kind" = 'capability' and "access_offer_benefits"."unit" is null and "access_offer_benefits"."included" is null and "access_offer_benefits"."combination" is null) or ("access_offer_benefits"."kind" = 'quota' and "access_offer_benefits"."unit" is not null and length("access_offer_benefits"."unit") > 0 and "access_offer_benefits"."included" is not null and "access_offer_benefits"."included" between 0 and 9007199254740991 and "access_offer_benefits"."combination" is not null and "access_offer_benefits"."combination" in ('maximum', 'sum', 'exclusive'))),
	CONSTRAINT "access_offer_benefits_key_check" CHECK (length("access_offer_benefits"."key") > 0)
);
--> statement-breakpoint
CREATE TABLE "access_offer_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"beneficiary_account_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_version" integer NOT NULL,
	"origin" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "access_offer_segments_provenance_key" UNIQUE("id","beneficiary_account_id","offer_id","offer_version","origin"),
	CONSTRAINT "access_offer_segments_period_check" CHECK ("access_offer_segments"."period_end" > "access_offer_segments"."period_start")
);
--> statement-breakpoint
CREATE TABLE "access_offers" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "access_offers_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "access_offers_origin_key" UNIQUE("id","version","kind"),
	CONSTRAINT "access_offers_version_check" CHECK ("access_offers"."version" > 0),
	CONSTRAINT "access_offers_kind_check" CHECK ("access_offers"."kind" in ('individual', 'bundle'))
);
--> statement-breakpoint
CREATE TABLE "access_products" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_subscription_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"beneficiary_account_id" text NOT NULL,
	"payer_account_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_account_ref" text NOT NULL,
	"mode" text NOT NULL,
	"environment" text NOT NULL,
	"status" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean NOT NULL,
	"provider_observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "access_subscription_sources_provider_key" UNIQUE("provider","provider_account_ref","mode","environment","provider_subscription_id"),
	CONSTRAINT "access_subscription_sources_beneficiary_key" UNIQUE("id","beneficiary_account_id"),
	CONSTRAINT "access_subscription_sources_live_check" CHECK ("access_subscription_sources"."mode" = 'live' and "access_subscription_sources"."environment" = 'production' and length("access_subscription_sources"."provider_account_ref") > 0),
	CONSTRAINT "access_subscription_sources_provider_check" CHECK ("access_subscription_sources"."provider" in ('stripe', 'peable')),
	CONSTRAINT "access_subscription_sources_status_check" CHECK ("access_subscription_sources"."status" in ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid')),
	CONSTRAINT "access_subscription_sources_period_check" CHECK ("access_subscription_sources"."period_end" > "access_subscription_sources"."period_start")
);
--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_source_fk" FOREIGN KEY ("source_segment_id","beneficiary_account_id","offer_id","offer_version","origin") REFERENCES "public"."access_offer_segments"("id","beneficiary_account_id","offer_id","offer_version","origin") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_benefit_fk" FOREIGN KEY ("offer_id","offer_version","benefit_index","product_id") REFERENCES "public"."access_offer_benefits"("offer_id","offer_version","benefit_index","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_offer_benefits" ADD CONSTRAINT "access_offer_benefits_product_id_access_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."access_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_offer_benefits" ADD CONSTRAINT "access_offer_benefits_offer_fk" FOREIGN KEY ("offer_id","offer_version") REFERENCES "public"."access_offers"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_offer_segments" ADD CONSTRAINT "access_offer_segments_subject_fk" FOREIGN KEY ("subscription_id","beneficiary_account_id") REFERENCES "public"."access_subscription_sources"("id","beneficiary_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_offer_segments" ADD CONSTRAINT "access_offer_segments_offer_fk" FOREIGN KEY ("offer_id","offer_version","origin") REFERENCES "public"."access_offers"("id","version","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_products" ADD CONSTRAINT "access_products_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_products" ADD CONSTRAINT "access_products_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_subscription_sources" ADD CONSTRAINT "access_subscription_sources_beneficiary_account_id_users_id_fk" FOREIGN KEY ("beneficiary_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_subscription_sources" ADD CONSTRAINT "access_subscription_sources_payer_account_id_users_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_subject_product_idx" ON "access_grants" USING btree ("beneficiary_account_id","product_id","period_end");--> statement-breakpoint
CREATE INDEX "access_offer_segments_source_idx" ON "access_offer_segments" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "access_products_application_idx" ON "access_products" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "access_subscription_sources_beneficiary_idx" ON "access_subscription_sources" USING btree ("beneficiary_account_id","status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION product_access_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; append a new version or period', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION product_access_source_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subscription source history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','period_start','period_end','cancel_at_period_end','provider_observed_at','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','period_start','period_end','cancel_at_period_end','provider_observed_at','updated_at']) THEN
    RAISE EXCEPTION 'subscription parties and provider identity are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.provider_observed_at <= OLD.provider_observed_at THEN
    RAISE EXCEPTION 'subscription observation must advance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION product_access_grant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_start timestamptz; parent_end timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grant provenance cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
       OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'grant provenance is immutable; revocation is one-way' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT period_start, period_end INTO parent_start, parent_end FROM access_offer_segments WHERE id = NEW.source_segment_id;
  IF parent_start IS NULL OR NEW.period_start < parent_start OR NEW.period_end > parent_end THEN
    RAISE EXCEPTION 'grant period exceeds its immutable segment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER access_products_immutable BEFORE UPDATE OR DELETE ON access_products FOR EACH ROW EXECUTE FUNCTION product_access_immutable();
--> statement-breakpoint
CREATE TRIGGER access_offers_immutable BEFORE UPDATE OR DELETE ON access_offers FOR EACH ROW EXECUTE FUNCTION product_access_immutable();
--> statement-breakpoint
CREATE TRIGGER access_offer_benefits_immutable BEFORE UPDATE OR DELETE ON access_offer_benefits FOR EACH ROW EXECUTE FUNCTION product_access_immutable();
--> statement-breakpoint
CREATE TRIGGER access_offer_segments_immutable BEFORE UPDATE OR DELETE ON access_offer_segments FOR EACH ROW EXECUTE FUNCTION product_access_immutable();
--> statement-breakpoint
CREATE TRIGGER access_subscription_sources_identity_immutable BEFORE UPDATE OR DELETE ON access_subscription_sources FOR EACH ROW EXECUTE FUNCTION product_access_source_identity_immutable();
--> statement-breakpoint
CREATE TRIGGER access_grants_provenance_guard BEFORE INSERT OR UPDATE OR DELETE ON access_grants FOR EACH ROW EXECUTE FUNCTION product_access_grant_guard();
