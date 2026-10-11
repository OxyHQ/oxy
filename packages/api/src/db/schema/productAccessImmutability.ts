/** Schema support, never exported by the table barrel. Supplement generated 0135. */
export const PRODUCT_ACCESS_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION product_access_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; append a new version or period', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION product_access_benefit_set_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE expected_count integer;
BEGIN
  SELECT expected_benefit_count INTO expected_count FROM access_offers
    WHERE id = NEW.offer_id AND version = NEW.offer_version;
  IF NOT FOUND OR NEW.benefit_index < 0 OR NEW.benefit_index >= expected_count THEN
    RAISE EXCEPTION 'benefit index is outside the immutable offer set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
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
${['access_products', 'access_offers', 'access_offer_benefits', 'access_offer_segments'].map((table) => `--> statement-breakpoint\nCREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION product_access_immutable();`).join('\n')}
--> statement-breakpoint
CREATE TRIGGER access_offer_benefits_set_guard BEFORE INSERT ON access_offer_benefits FOR EACH ROW EXECUTE FUNCTION product_access_benefit_set_guard();
--> statement-breakpoint
CREATE TRIGGER access_subscription_sources_identity_immutable BEFORE UPDATE OR DELETE ON access_subscription_sources FOR EACH ROW EXECUTE FUNCTION product_access_source_identity_immutable();
--> statement-breakpoint
CREATE TRIGGER access_grants_provenance_guard BEFORE INSERT OR UPDATE OR DELETE ON access_grants FOR EACH ROW EXECUTE FUNCTION product_access_grant_guard();`;
