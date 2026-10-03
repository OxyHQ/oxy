# Registry patches from committed inputs

The previous patches used the still-installed candidate overlays as their input. Seventy-six tracked manifests/locks in fifteen owned worktrees were backed up before restoring exact HEAD bytes. The first preflight correctly refused the fifteen changed inputs; Mercaria and Peable already matched. No install ran.

For each affected patch, the original reviewed patch was applied to its hash-verified preserved candidate inputs in an owned temporary directory. Every resulting manifest had to retain the exact previously reviewed after-SHA256. A new patch was then generated from committed HEAD to those identical final bytes. This changes patch inputs, not the approved final manifests. No node_modules, runtime source, device or service changed. Non-newline-terminated JSON required a standard git patch newline marker during generation; git apply --check passes for all final patches.

All seventeen fresh authenticated remote-main ancestry, branch, HEAD, input hash and git apply checks now pass again. Move remains the separate eighteenth pending amendment. Historical overlays and original patches remain in private evidence under i04-consumer-final-prs/candidate-overlays-before-registry-20261004. Registry requests/installs/builds/deploys remain pending.
