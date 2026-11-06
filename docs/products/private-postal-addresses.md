# Private account postal addresses

Oxy owns the reusable delivery address book. `oxy.addresses` calls the private
`/addresses` resource through the current Oxy session. The validated session's
subject account owns every row, including when a person acts as an organization.
The address book is bounded to 100 entries per account under the same owner lock.
There is no owner id in any request body and a service credential cannot enumerate
addresses. External OAuth applications cannot access this initial first-party
surface. Responses are `private, no-store`; the SDK does not cache them.

`PostalAddress` names the recipient explicitly. A profile display name or handle
is not a delivery recipient. Country is a two-letter uppercase code; region and
phone are optional, and a country without postal codes may keep that field empty.
The consumer validates its actual shipping destination requirements. Setting
`isDefault: true` is explicit; concurrent changes serialize under the account row
lock and a partial unique index enforces one default. Deleting a default leaves
no default rather than selecting an address the account did not choose. PATCH
accepts `null` to remove line2, region, phone or label.

Profile `address` and `user_locations` are separate existing data. In particular,
profile places participate in discovery and are not a private checkout save target.
Nothing imports, parses, publishes, migrates or deletes either automatically.
Applications may offer an explicit import with a review of the actual recipient
and required fields, then save through this API only at the account's request.
Existing app-local addresses remain available until the person chooses otherwise.

Checkout reads addresses only for the active account, discards pending reads and
selection when that identity changes, and snapshots the selected destination into
the merchant's order. Editing an address later cannot edit an existing order.
Saving an address is an explicit action independent of payment retry; payment
submission must not create a saved address automatically. Order status and access
remain the merchant backend's authoritative answer.

The API routes intentionally suppress unexpected storage exception details, which
can otherwise include bound address values. Postal details never enter logs,
URLs, public profile DTOs or analytics. Account deletion cascades saved addresses;
merchant order snapshots follow their existing retention rules.
