-- oxy:deploy-phase=post
-- ADR 0042 retired the native-product-agent lane. Homiio no longer relays
-- Sindi's chat: Sindi is an ordinary Alia agent that reaches Homiio through its
-- capability catalogue, so the Homiio application holds no inference or
-- acting-as authority of its own. The seed only ever UNIONs scopes, so the
-- narrowing is this reviewed statement, addressed by the application's exact id.
-- Its workload bindings already name neither scope.
UPDATE "applications"
SET "scopes" = array_remove(array_remove("scopes", 'inference:invoke'), 'acting-as:offline')
WHERE "id" = '6a2f851751b784a86fd0e922'
  AND "scopes" && array['inference:invoke', 'acting-as:offline']::text[];
