-- oxy:deploy-phase=pre
--
-- PRE: five nullable-or-defaulted columns and three foreign keys on `sessions`.
-- Nothing is dropped, renamed or narrowed, no existing statement changes shape,
-- and no value is written — so the image still serving goes on reading and
-- writing `sessions` exactly as it does today while this lands.
--
-- ISSUE #937, PHASE 6. An access token stops being a bare `{userId, sessionId,
-- deviceId}` and starts saying WHO it acts as, WHO is acting, THROUGH which
-- application and device context, and WITH which scopes — and every one of
-- those claims is checked back against the row on each request. The claims are
-- derived from these columns and never the reverse, which is what lets a
-- re-mint of a live session reproduce the same token and lets a claim that
-- disagrees with the row be recognised as a token that no longer describes its
-- session.
--
-- WHY THE BINDING IS A COLUMN AND NOT A CLAIM WE SIMPLY TRUST. A token is
-- signed by us, so its claims are authentic — but authenticity is not currency:
-- a token minted for an application says nothing about whether that grant still
-- stands, and the whole point of the isolation below is that the answer can
-- change without the token changing. The row is the authority; the token is a
-- copy with an expiry.
--
-- WHAT NULL MEANS, PER COLUMN, BECAUSE ALL FIVE ARE NULLABLE AND NONE MEANS
-- "missing data":
--
--   application_id / client_id / scopes
--     NULL is the ordinary SHARED device session — the one every official Oxy
--     app on a device uses. It belongs to no single application, so its token
--     carries no `azp`: naming one of those apps would be false for the others.
--     A value means the session is exactly one application's and nothing else
--     may reach it, which today is an untrusted OAuth client's exchange.
--     `scopes` defaults to the empty array rather than NULL because "granted
--     nothing" and "not an application's session" are different facts and only
--     the first is a scope set.
--
--   device_session_id / device_context_id
--     NULL is a session whose device has not registered it yet. The device
--     login lane creates the context AFTER the session exists, so there is a
--     real interval where the ids are unknowable; the token picks them up on
--     its next mint.
--
-- THE TWO OPPOSITE DELETE RULES, both deliberate:
--
--   application_id  ON DELETE CASCADE. NOT `SET NULL`, for the same reason
--     `operated_by_user_id` is not: NULL here means "not an application's
--     session", so `SET NULL` would silently PROMOTE a third-party session into
--     a first-party one the moment its application row went away — laundering
--     exactly the isolation the column exists to enforce. Deleting the
--     application must kill its sessions.
--
--   device_session_id / device_context_id  ON DELETE SET NULL. Losing the
--     device context must not delete a live session; it must only stop the
--     token claiming a context that no longer exists. The next mint then omits
--     the claim, and the binding check agrees with it.
--
-- NO BACKFILL, AND THAT IS THE HONEST STATE. Nothing in an existing row records
-- which application obtained it: the OAuth exchange left only a cosmetic
-- `device_name` of `'<App> OAuth'`, and a string that a later session reuse can
-- rewrite is not something to make an authorization decision from. So every
-- pre-existing session is `application_id IS NULL` and is treated as
-- first-party by the device lane. The bound is the token lifetime, not this
-- migration: every mint after deploy is v2, an access token lives 15 minutes
-- and a refresh token 7 days, and the sessions that matter here are third-party
-- OAuth sessions whose clients must re-exchange to get a v2 token — at which
-- point they land on the isolated path and become bound.
--
-- NO INDEX. `application_id` is read in exactly one query, the session-reuse
-- lookup, which already leads with `(user_id, device_id)` and resolves to a
-- handful of rows before this predicate is applied. An index here would serve
-- nothing and cost every session write.
--
ALTER TABLE "sessions" ADD COLUMN "application_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_session_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_context_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_context_id_device_account_contexts_id_fk" FOREIGN KEY ("device_context_id") REFERENCES "public"."device_account_contexts"("id") ON DELETE set null ON UPDATE no action;
