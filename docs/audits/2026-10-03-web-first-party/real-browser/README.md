# WEB04 real first-party browser acceptance (candidate)

Root executed three independent Chromium contexts against the existing owned
API/PostgreSQL/IdP and the SDK providers at two loopback origins. Each performed
real password login, explicit second-origin join, account switch to organization,
fresh SDK users.me in both, organization sign-out and automatic personal fallback
in both without reload, final personal sign-out, and cold reload signed-out.
All three pass with zero cookies and zero unexpected remote requests. SQL isolates
each newly created device: four holders become zero, both sessions become inactive,
and public revision/state agree with the observed API subjects.

Earlier real RED, failed API handover and partial driver timeout are preserved.
The handover fault was volatile descriptor enumeration; data and manifest were
retained. Root restarted those exact stopped resources in resume mode with no
migration or seed. The first partial green driver tried to select an organization
already signed out; corrected contexts perform one full cycle each.

This checks actual local candidate UI/HTTP/SQL behavior, not final registry or
production adoption. The existing fixture remains alive for root's native run;
no identity-bearing physical device or production grant was modified.
