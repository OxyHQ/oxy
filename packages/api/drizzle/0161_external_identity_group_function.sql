-- oxy:deploy-phase=pre
-- Additive: one new function, which the image before this one never calls.
-- CREATE FUNCTION takes no lock on the tables its body names, so this is
-- catalogue work only and needs no lock or statement timeout.
--
-- The identity group of a user (every account Oxy has proven to be the same
-- person, plus the redirect the root starts from) is read on nearly every user
-- read: profile by username, users by id, follow and privacy checks. The same
-- recursive statement used to be sent as SQL text on every call, and the driver
-- never prepares a statement, so Postgres planned its twelve-relation edge
-- derivation each time. Measured on production (2026-10-15): 2.0-3.4 ms of
-- planning against 0.15-0.26 ms of execution, and the top oxy-api statement by
-- database load (0.078 average active sessions, two thirds of it CPU).
--
-- PL/pgSQL keeps the plan of the query below for the life of the connection
-- and switches to a generic plan after five executions. Production, through
-- PREPARE with the same array parameter: planning 2.0 ms -> 0.023 ms, for any
-- number of seeds. The query is the one that was inlined in
-- `externalIdentityRegistry.service.ts`, unchanged except that the seeds arrive
-- as one array and the output columns are named for the caller.
--
-- Every column reference is qualified: `root_id` and `user_id` are also the
-- function's output parameters, and PL/pgSQL refuses an ambiguous name.
CREATE FUNCTION external_identity_group_members(seed_user_ids text[])
RETURNS TABLE (root_id text, user_id text)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE roots(seed_id) AS (
    SELECT seed.id FROM unnest(seed_user_ids) AS seed(id)
  ), linked(a, b) AS (
    SELECT source.user_id, target.user_id FROM external_identity_claims claim
    JOIN external_identity_actors actor ON actor.actor_uri = claim.actor_uri
    JOIN external_identities source ON source.canonical_acct = actor.canonical_acct
    JOIN external_identities target ON target.canonical_acct = claim.target_acct
    WHERE claim.state = 'linked' AND claim.source_stable_id = source.stable_id
      AND claim.target_stable_id = target.stable_id AND actor.updated_at > now() - interval '7 days'
      AND EXISTS (SELECT 1 FROM external_identity_claims reverse
        JOIN external_identity_actors reverse_actor ON reverse_actor.actor_uri = reverse.actor_uri
        WHERE reverse_actor.canonical_acct = claim.target_acct AND reverse.target_acct = actor.canonical_acct
          AND reverse.source_stable_id = target.stable_id AND reverse.target_stable_id = source.stable_id
          AND reverse.state = 'linked' AND reverse_actor.updated_at > now() - interval '7 days')
    UNION
    SELECT instagram.user_id, threads.user_id FROM external_identity_meta_proofs proof
    JOIN external_identity_actors ig_actor ON ig_actor.actor_uri = proof.instagram_actor_uri
      AND ig_actor.canonical_acct = proof.instagram_acct
    JOIN external_identity_actors th_actor ON th_actor.actor_uri = proof.threads_actor_uri
      AND th_actor.canonical_acct = proof.threads_acct
    JOIN external_identities instagram ON instagram.canonical_acct = proof.instagram_acct
    JOIN external_identities threads ON threads.canonical_acct = proof.threads_acct
    WHERE proof.state = 'verified' AND proof.revoked_at IS NULL AND proof.expires_at > now()
      AND proof.verified_at <= now() AND proof.method = 'meta-public-profile-v1'
      AND proof.policy_version = 'meta-profile-badges-2026-09-13-v1'
      AND (instagram.meta_proof_revoked_at IS NULL OR proof.verified_at > instagram.meta_proof_revoked_at)
      AND (threads.meta_proof_revoked_at IS NULL OR proof.verified_at > threads.meta_proof_revoked_at)
      AND instagram.stable_id = 'instagram:pk:' || proof.instagram_pk
      AND threads.stable_id = proof.threads_actor_uri
  ), members(member_root_id, member_user_id) AS (
    SELECT roots.seed_id, coalesce(redirect.canonical_user_id, roots.seed_id)
    FROM roots LEFT JOIN canonical_user_redirects redirect ON redirect.user_id = roots.seed_id
    UNION
    SELECT members.member_root_id,
      CASE WHEN linked.a = members.member_user_id THEN linked.b ELSE linked.a END
    FROM members JOIN linked ON linked.a = members.member_user_id OR linked.b = members.member_user_id
  )
  SELECT members.member_root_id, members.member_user_id FROM members;
END;
$$;
