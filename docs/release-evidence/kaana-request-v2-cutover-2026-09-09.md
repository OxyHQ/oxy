# Kaana request-v2 production cutover — 2026-09-09

The signed readback and bounded production canary ran from the exact live Oxy
image while ambient Kaana execution remained disabled.

- readback run: 34301660359
- canary run: 34302325992
- snapshot: snap_da7406fdfed50248
- task definition: arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:359
- image digest: sha256:5be97aa30dfac6b9e0d44d8767ace26017e4ebdb7b5c31da80d80ead7ad76b0b
- deployment: dep_groq_openai_gpt_oss_120b_observed_2026_09_01
- descriptor model: openai/gpt-oss-120b@observed-2026-09-01
- routing profile: 01a06477-94f5-74f0-bc25-4a1ff59d6945
- routing policy: platform-default@1
- provider requests: 2
- Oxy ledger writes: 0

All six cases passed in order: v1 slug refusal, v2 slug refusal, unknown exact
deployment refusal, whitespace-modified deployment refusal, one-token v1 direct
model execution and one-token v2 exact-profile execution. The two workflows
completed successfully and the readback snapshot matched the bootstrap review.
