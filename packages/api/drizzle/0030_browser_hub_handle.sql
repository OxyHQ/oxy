-- oxy:deploy-phase=pre
--
-- PRE: four nullable columns, one index and one unique constraint on
-- `device_sessions`. Nothing is dropped, renamed or narrowed and no value is
-- written, so the image still serving goes on reading and writing
-- `device_sessions` exactly as it does today while this lands.
--
-- ISSUE #937, PHASE 5 — ADR 0003. `auth.oxy.so` becomes the browser profile's
-- first-party DeviceSession hub. These columns hold the credential behind that:
-- the verifier for the opaque handle inside `__Host-oxy-device`.
--
-- WHAT THIS DOES AND DOES NOT REOPEN OF THE ZERO-COOKIE POSTURE. It reopens
-- exactly one mechanism at exactly one origin. Relying-party origins remain
-- zero-cookie — Mention, Mercaria, Syra, Console, Accounts and every scaffolded
-- app keep `{deviceId, deviceSecret}` + `POST /session/device/token` and set no
-- cookie. There is no refresh-token family and no bootstrap hop: the handle is
-- a POINTER to a server-side device session, not a credential the browser can
-- spend against the resource API. `AGENTS.md` and `docs/SESSION-ARCHITECTURE.md`
-- are amended in the same change, because a repository that forbids what it
-- also ships is worse than either.
--
-- WHY A THIRD CREDENTIAL AND NOT A REUSE OF `secret_hash`. Same reason
-- `background_secret_hash` is a fourth: the holders, lifetimes and rotation
-- rules differ, and a shared column makes each holder a writer of a value the
-- other depends on. The device secret rotates on sign-in and is read by JS on
-- every origin that stores it; the hub handle is read by nothing the page can
-- reach (`HttpOnly`) and rotates only on a sensitive transition.
--
-- WHY THESE TWO ARE INDEXED WHEN THE OTHER FOUR SECRET COLUMNS ARE NOT. Every
-- other credential on this table is verified AFTER the row has been found by
-- `device_id`, because its holder knows the device id. The hub's holder does
-- not: the cookie carries an opaque handle and nothing else — no device id, no
-- user id, no account id, no serialized state — so `sha256(handle)` is the only
-- address there is. The UNIQUE on the live column is therefore both the lookup
-- index and the guarantee that one handle can never address two browsers; the
-- plain index on the previous one exists because a grace-window presentation
-- has no other way in either.
--
-- WHY A GRACE WINDOW AT ALL. A cookie jar is shared across a browser's tabs. A
-- rotation committed by one tab lands in the jar of every other, and a request
-- already in flight from a sibling still carries the old value. Without the
-- window an ordinary rotation races into a spurious sign-out.
--
-- NULL IS "NO HUB HANDLE", WHICH IS EVERY ROW TODAY AND EVERY NATIVE DEVICE
-- FOREVER. There is no backfill and none is possible: a handle only exists once
-- a browser has authenticated at the IdP and been handed one, and the raw value
-- lives in exactly two places — that browser's cookie jar and the `Set-Cookie`
-- line that put it there. Cleared to NULL rather than `''` throughout, for the
-- reason recorded on `secret_hash`: an empty string is a VALUE, so it would
-- collide on the unique below while also reading as "absent" to every guard.
--
ALTER TABLE "device_sessions" ADD COLUMN "hub_secret_hash" text;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN "hub_prev_secret_hash" text;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN "hub_prev_secret_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN "hub_secret_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "device_sessions_hub_prev_secret_hash_idx" ON "device_sessions" USING btree ("hub_prev_secret_hash");--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_hub_secret_hash_key" UNIQUE("hub_secret_hash");
