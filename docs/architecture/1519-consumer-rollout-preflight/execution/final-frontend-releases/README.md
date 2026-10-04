# Seven final frontend releases — root operator handoff

All seven pinned main CIs passed. These commands were prepared without dispatching or restoring workflows. Original workflow state was active; each is currently held. Root must refresh source/CI/hold state immediately before each operation and retain unrelated deployment holds.

| App | Main | Main CI | Workflow | Public client source |
| --- | --- | --- | --- | --- |
| OxyHQ/Alia | `3904331b48e70bcb4560cd876f3aa5e7dc183ef0` | [37167676080](https://github.com/OxyHQ/Alia/actions/runs/37167676080) SUCCESS | `246635202` / `.github/workflows/deploy-frontends.yml` | source fallback used by app and canvas; GET 200 |
| OxyHQ/Clarity | `b7b3fc2c338feb82cf4b1e94c54be349a9203c0e` | [37163246733](https://github.com/OxyHQ/Clarity/actions/runs/37163246733) SUCCESS | `256392990` / `.github/workflows/deploy.yml` | registered product client literal in layout; GET 200 |
| OxyHQ/Nilo | `ac5ebe5d30427cea6336c2819eec8f1312d8200b` | [37168968634](https://github.com/OxyHQ/Nilo/actions/runs/37168968634) SUCCESS | `282793657` / `.github/workflows/deploy.yml` | GitHub EXPO_PUBLIC_OXY_CLIENT_ID; GET 200 |
| OxyHQ/Move | `5c9c819902ef530200382b53720b6edc8fd37f86` | [37168791994](https://github.com/OxyHQ/Move/actions/runs/37168791994) SUCCESS | `367281369` / `.github/workflows/deploy-frontends.yml` | GitHub EXPO_PUBLIC_OXY_CLIENT_ID; GET 200 |
| OxyHQ/Noted | `bd4599b9a9fe205fb93b5ec221dc9d0e3b891ab5` | [37168786543](https://github.com/OxyHQ/Noted/actions/runs/37168786543) SUCCESS | `299591403` / `.github/workflows/deploy-cloudflare.yml` | source fallback when missing or blank variable; GET 200 |
| OxyHQ/Allo | `a597619ff71497226bf80449732678c93e047a20` | [37168245905](https://github.com/OxyHQ/Allo/actions/runs/37168245905) SUCCESS | `246810797` / `.github/workflows/deploy-frontends.yml` | source fallback; GET 200 |
| OxyHQ/Homiio | `4d9e1ed843be0d22ec360933b76ccf63cb3c26ec` | [37168533009](https://github.com/OxyHQ/Homiio/actions/runs/37168533009) SUCCESS | `246636761` / `.github/workflows/deploy-frontends.yml` | GitHub production client overrides source fallback; GET 200 |

The manifest pins exact workflow bytes and original hold receipts. Clarity, Nilo and Move retain their reviewed manual guards before build and deployment. Alia, Noted, Allo and Homiio use their existing manual paths; root must separately check current main and successful CI before dispatch, then verify the resulting run SHA. Move also retains `OXY_1519_ROLLOUT_HOLD=true`; release that existing hold only after its backend acceptance. Homiio backend caller hold remains separate from its frontend workflow.

Nilo `NILO_API_URL` is verified as `https://api.nilo.so`. Alia and Allo use canonical source client fallbacks; Noted normalizes absent/blank environment input to its canonical source fallback. Homiio injects its production GitHub variable, which differs from its development fallback. No variable or registration change is needed.

Root commands, after those gates:

`OxyHQ/Alia`:
```bash
gh workflow enable 246635202 --repo OxyHQ/Alia
gh workflow run 246635202 --repo OxyHQ/Alia --ref main
```

`OxyHQ/Clarity`:
```bash
gh workflow enable 256392990 --repo OxyHQ/Clarity
gh workflow run 256392990 --repo OxyHQ/Clarity --ref main -f expected_sha=b7b3fc2c338feb82cf4b1e94c54be349a9203c0e -f ci_run_id=37163246733
```

`OxyHQ/Nilo`:
```bash
gh workflow enable 282793657 --repo OxyHQ/Nilo
gh workflow run 282793657 --repo OxyHQ/Nilo --ref main -f expected_sha=ac5ebe5d30427cea6336c2819eec8f1312d8200b -f ci_run_id=37168968634
```

`OxyHQ/Move`:
```bash
gh workflow enable 367281369 --repo OxyHQ/Move
gh workflow run 367281369 --repo OxyHQ/Move --ref main -f expected_sha=5c9c819902ef530200382b53720b6edc8fd37f86 -f ci_run_id=37168791994
```

`OxyHQ/Noted`:
```bash
gh workflow enable 299591403 --repo OxyHQ/Noted
gh workflow run 299591403 --repo OxyHQ/Noted --ref main
```

`OxyHQ/Allo`:
```bash
gh workflow enable 246810797 --repo OxyHQ/Allo
gh workflow run 246810797 --repo OxyHQ/Allo --ref main
```

`OxyHQ/Homiio`:
```bash
gh workflow enable 246636761 --repo OxyHQ/Homiio
gh workflow run 246636761 --repo OxyHQ/Homiio --ref main
```

Keep the exact main SHA through build/deploy. A successful workflow alone does not prove public adoption: retain deployment/artifact identity, compare public HTML and referenced assets, and check the registered client/API binding and SDK dialog. Readiness of a frontend does not establish delegated worker authority or introduce grants.

Recent comments were read on I04/I11 and the seven consumer PRs. The actionable Noted deadlines/HTTP errors, Homiio deferred owner guards and Alia Codea duplicate Bloom findings are already corrected in these merged sources. Latest remaining comments in this census are dependency scan reports; no new product regression was reported. I03 expiry-margin review is tracked separately by integration and blocks reuse of the old canary transport.
