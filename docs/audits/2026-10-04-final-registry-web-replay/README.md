# Published SDK first-party browser replay

Two standalone registry consumers passed real password sign-in, explicit sibling join, organization switching, partial logout fallback and full logout/reload with zero cookies. Six explicit profile reads required fresh HTTP responses; eight successful `/users/me` requests were observed including SDK work. After final logout, no automatic challenge/verify was observed.

The old first-party-only supervisor was stopped after PID/UID/command validation. API, IdP and both shared third-party listeners retained their process identities. The browser was isolated and closed afterward. Both Vite prebundles map 700 SDK modules into their own registry `node_modules`; source/lock/member receipts are pinned in [proof.json](proof.json).

This proves first-party web behavior against synthetic local authority. Third-party registry replay and Android device replay remain separate. No production, ADB or identity-store mutation occurred.
