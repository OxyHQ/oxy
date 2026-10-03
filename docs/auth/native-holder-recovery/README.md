# Native ACCOUNT holder recovery

A server mint rejection for a previously authenticated native holder can mean
another app ended the shared device: both full logout and removing its last
account delete holder credentials, returning `invalid_device_secret`. ACCOUNT
stores retain that holder history and persist automatic-key-sign-in suppression.
An anonymous candidate's bad secret is not inferred to be a logout. Pinned
IDENTITY recovery remains separate. The existing 401 message-marker parser is
used; this change does not introduce a structured error-code parser.

On cold boot or an inactive/background → active resume, a healthy local holder
wins. After its explicit rejection, a different shared credential can be adopted
only after it successfully mints a live session. Candidate bytes are never saved
before that proof. Epoch, provider lifecycle/lane and exact local-state checks
run before commitment, including inside the native storage queue. Durability
failure refuses token planting. Shared mirroring and credential tracking forward
the conditional commit. Network errors, ambiguous 401 and 429 do not authorize
replacement or key recovery. The ACCOUNT provider's refresh never invokes the
Commons key lane; cold first installation and explicit IDENTITY mode retain their
separate contracts.

Shared adoption does not clear the explicit sign-out marker. Only a successful
explicit sign-in clears it, through the existing activation funnel. Signing out
one account while another remains neither sets the marker nor removes healthy
holders. A successful explicit re-login can publish a new proven holder for the
same device, replacing its dead secret. A different healthy device's shared slot
is not overwritten. Without a cross-app CAS clear operation, an old failed mint
never deletes the shared slot: a later publication could already have replaced it.

The regression suite includes real API/session service/PostgreSQL tests with two
legitimate holders, stopped-store recreation, full/last-account logout, partial
logout and explicit re-login. Native storage and hook event tests use owned
fixtures; Android acceptance and repetition against final registry packages are
tracked separately in #1527. The earlier Android wire observation showed mint
followed by challenge/verify but did not record the mint's response error code;
the API regression now verifies that code directly.
