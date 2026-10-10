/** Supplement to generated schema DDL; never snapshots edited by hand. */
export const BILLING_CREDIT_IMMUTABILITY_SQL = `
CREATE OR REPLACE FUNCTION billing_credit_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit ledger provenance cannot be rewritten or deleted' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing_credit_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit grant history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['consumed','clawed']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['consumed','clawed']) OR NEW.consumed < OLD.consumed OR NEW.clawed < OLD.clawed THEN
    RAISE EXCEPTION 'credit grant identity is immutable and consumption/refund monotone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER billing_credit_grants_guard BEFORE UPDATE OR DELETE ON billing_credit_grants FOR EACH ROW EXECUTE FUNCTION billing_credit_grant_guard();
${['billing_credit_invoices', 'billing_credit_spends', 'billing_credit_consumptions', 'billing_credit_refund_observations'].map((table) => `--> statement-breakpoint\nCREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION billing_credit_immutable_history();`).join('\n')}
`;
