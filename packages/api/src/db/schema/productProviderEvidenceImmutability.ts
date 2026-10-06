/** Append to the generated migration; uses the guard installed by 0135. */
export const PRODUCT_PROVIDER_EVIDENCE_IMMUTABILITY_DDL = `
CREATE TRIGGER access_provider_periods_immutable BEFORE UPDATE OR DELETE ON access_provider_periods
FOR EACH ROW EXECUTE FUNCTION product_access_immutable();
--> statement-breakpoint
CREATE TRIGGER access_provider_events_immutable BEFORE UPDATE OR DELETE ON access_provider_events
FOR EACH ROW EXECUTE FUNCTION product_access_immutable();
`;

/** Append only to the refund-fence pre migration. */
export const PRODUCT_PROVIDER_REFUNDS_IMMUTABILITY_DDL = `CREATE TRIGGER access_provider_refunds_immutable BEFORE UPDATE OR DELETE ON access_provider_refunds FOR EACH ROW EXECUTE FUNCTION product_access_immutable();`;
