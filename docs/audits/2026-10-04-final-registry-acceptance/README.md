# Published registry web and native acceptance

Root accepted the final published SDK replays. The two exact root receipts are retained here; no XML, typed credentials, bearer tokens or browser login transcript is copied.

| Surface | Verified behavior | Evidence and limit |
| --- | --- | --- |
| First-party web | Real password sign-in, explicit second holder, shared person/org switch, partial logout fallback, full logout/reload signed out, six explicit fresh profiles, zero cookies | Existing web proof; 8 successful GETs including bootstrap, no automatic challenge/verify after logout |
| Third-party web | Cancel, real OAuth consent/token/profile, renewed consent after grant removal, subject mismatch refusal preserving original person, full logout | 108 artifact files and12 served responses checked; browser-only RP asset routing preserves origin and real API/IdP, local-network permission noted |
| Native siblings | Running sibling, warm re-login, stopped sibling, shared person/org/fallback, full logout and cold signed out, repeated denied private reads | Same fixture packages/cert on emulator5580, ten fresh UI profile reads with GETs observed, three cold windows without challenge/verify |
| Identity preservation | Signer and SecureStore unchanged | Root device receipt; no physical device, no clear/uninstall |

Android traffic capture was shared with the concurrent browser fixture and did not capture HTTP statuses. The claim is the completed SDK UI profile sequence with the expected account and GET observed in each matching window. The historical AND03 derived-file corruption/recovery test is separate and was not rerun here.

Earlier embedded limits saying subsequent surfaces were still pending remain historical text inside immutable earlier receipts. The final root acceptance combines the independently completed surfaces without replacing their evidence. These are local owned fixtures using registry artifacts, not a claim of completed deployment or login acceptance for every product frontend.
