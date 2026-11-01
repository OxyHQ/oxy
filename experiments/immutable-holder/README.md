# Append-only holder directory: design model, not implementation

Run `python3 experiments/immutable-holder/test_model.py`. This uses synthetic
values, in-process simulated hosts and a boolean proof fixture. It does not
create an Android provider, iOS Keychain item, server credential or app flow.
It has not been enabled or published.

## Proposed boundaries

Each holder would be stored as an immutable v2 record under an opaque,
high-entropy random record ID. IDs identify records; they do not authorize
reading, selecting, minting or deleting them. They must not be derived from or
contain the secret, bearer, user ID, or other sensitive values. A production
implementation must generate IDs securely, handle collisions by refusing to
replace a different record, and protect record values with the platform's
device-bound encrypted storage. Never log record contents or bearer tokens.

V2 must use a **different physical storage namespace and API** from the v1
slot. Android's existing v1 `clear()` clears its entire preferences file, so a
key prefix in that same file is insufficient. Legacy reads, writes and clears
continue to operate on v1. Adding, discovering or selecting v2 must never
write, replace, delete or clear the legacy slot. An authorized legacy caller
can still change or clear v1; isolation does not fix its existing unsafe
fan-out or force an older app to use v2.

The model assumes one atomic, durable `put-if-absent` per host. Repeating the
same ID and exact content is idempotent; a conflicting ID is not overwritten.
Appending to multiple independent hosts can partially succeed. Return each host
outcome, preserve successful records, and retry the same ID; do not rollback a
successful host. A host with no v2 capability is unsupported, not empty or a
reason to overwrite v1. No hosts is also unsupported. An unreadable or unknown
host is not absent. The current Android provider and preferences APIs do not
provide this v2 atomic operation: production needs a real implementation and
cross-process/crash tests. Apple documents uniqueness of Keychain generic
password items by class/access group/account/service; using `SecItemAdd` for an
isolated v2 item is a candidate to test, not proof of the whole design.

Discovery requires a separate listing-authorization fixture and returns only
opaque IDs, not holder values or device IDs. A successful response from every host
means all reads returned, **not** that they represent one distributed snapshot;
a concurrent insertion may be missed. After a separate record grant, conflicting
content for a record ID is rejected during resolution. An unavailable host makes discovery incomplete, rather than
proving a record is absent. Host removal, package visibility, old versions,
locked storage and reinstall may prevent discovery or recovery. The simple model
fails closed for incomplete selection; a more available exact-record lookup
would need its own contract and tests.

The model requires an explicit record selection and another holder-proof check
at selection; it never elects an account from a device ID or a directory order.
In production, selection must establish the exact actor/session/bearer binding
and coordinate sockets, queries and mutations before UI publication. The
boolean fixture here proves none of that. Proof can fail, time out, or be
revoked later; a previous verification is not continuous authorization and
cannot revoke data already handed to a caller. Never treat opaque IDs, version
numbers or locally stored actor metadata as proof.

**Unresolved authorization boundary:** the in-memory model returns only IDs
from discovery and uses separate boolean fixtures for listing and secret access.
It retains synthetic holder values in the same Python process, and its boolean
grant is trivially forgeable; neither enforces real isolation. A production
`readAll` of credentials would expose multiple holders and devices to every caller allowed by
the provider, expanding the existing single-slot blast radius. Signature and
package allow-list checks alone do not establish authorization for each holder.
Do not expose a production `readAll` of credentials. Discovery and access to a
particular secret need separate, explicitly authorized contracts; how a newly
installed app obtains access without already possessing that secret remains an
open onboarding and security design. Metadata IDs can also correlate records
across apps and must be scoped and reviewed. The model provides no solution to
these issues.

Migration from v1 must be an explicit caller-authorized operation: read v1,
prove the holder, append an isolated record, and leave v1 untouched. A legacy
writer may change v1 immediately afterward or even while proof is in flight.
That does not mutate the appended record, but both values can remain valid and
represent different devices or actors. V2 must not silently assume the old
record is still the intended active account or mirror the newer v1 choice;
explicit selection and re-verification are needed. This tradeoff means the
model does **not** provide automatic account-switch synchronization with legacy
apps. A selected v2 holder can remain different from the active v1 holder.

## Retention and cleanup

The model provides no record deletion and no automatic eviction. Local logout
must not wait for a shared host or delete another app's credential; it can
clear local state independently. Existing v2 records remain, with privacy,
storage and stale-secret costs. Capacity limits must fail explicitly without
evicting an unrelated holder. Server revocation can make a retained record
unusable, but is not a local cleanup protocol. Any later garbage collection
needs a separately reviewed ownership/consent policy and a crash-safe,
conditional deletion primitive that cannot race a new writer; there is no
safe cross-host cleanup or automatic migration implementation here.

## Evidence and limits

Seventeen deterministic tests exercise isolated models of authorized metadata-only
discovery, separate secret-grant gating, concurrent distinct
adds, collision, partial retry, legacy write/clear and migration races,
selection/proof failure, no hosts, unavailable hosts, quota, non-snapshot
discovery and revocation after delivery. The model assumes atomic immutable
host operations and namespace isolation instead of proving either on Android or
iOS. It does not prove cryptographic holder verification, native process
isolation, durable recovery, UI behavior, actor/bearer synchronization, or
protection against a compromised app already authorized to call the provider.
It is not an activation or rollout proposal until those boundaries are tested.
