# Invalidated native holder recovery

The frozen test bc728e68b reproduced six failures before runtime edits. Source f4ddce58dd9a0b83cdec5af8af8ecc7688fb91b8 now retains authenticated holder history and suppresses automatic Commons recovery on named invalid-secret rejection, while allowing only a separately minted new shared holder to commit. Epoch/lifecycle/exact-store checks and native queue checks protect pending replies; no unconditional shared clear occurs.

The real session service, device API and PostgreSQL suite recreates a stopped store after full and last-account logout, observes invalid_device_secret directly, and verifies no Commons call. Partial logout and explicit same-device new-holder publication/adoption also pass. The hook test exercises background→active through the installed canonical handler and pending-mint unmount. Core and Services full suites passed at this checkpoint.

The Android receipt preserves both real REDs and the earlier running-sibling successes, with 180 private input hashes independently recomputed. No raw XML/login contents were copied. Corrected Android and final registry acceptance remain pending. The separate HttpService context-epoch seam must be composed and rechecked before the next native handoff.

Two initial API invocation mistakes and the provider fixture’s unchanged thirteen lint diagnostics are retained explicitly; neither is reported as a successful check or the behavioural RED. See proof.json for exact source, records, built modules and owned PostgreSQL cleanup.
