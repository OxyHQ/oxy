# ADR 0011 — the former inference name is superseded by Kaana

- Status: superseded
- Original date: 2026-08-15
- Superseded: 2026-09-02
- Issue: #972

> **Historical record only.** This ADR originally approved a different public
> name for the inference data plane. That decision no longer authorizes any
> current product, repository, package, environment variable, header, log event,
> workflow, DNS record, hostname or documentation surface.

## Current decision

The inference data plane is **Kaana**.

- The repository is `OxyHQ/Kaana`.
- Its canonical signed origin is exactly `https://kaana.ai`.
- No hostname below `oxy.so` is a Kaana origin or alias.
- Inference code and operations use the `Kaana` / `KAANA_*` vocabulary and the
  `X-Oxy-Kaana-*` signed-envelope headers.
- Oxy is the control plane; Kaana is the inference data plane. Alia remains the
  agent runtime and is not a provider alias.

The old proper name may appear only in an explicitly historical migration
record that is needed to remove a deployed legacy binding. It must not be used
as a compatibility alias or as a second route to Kaana.

## Why the old name was retired

The old proper name collided with several legitimate, unrelated uses already in
the Oxy ecosystem:

- SMTP relay configuration (`SMTP_RELAY_*`);
- the ATProto Relay network role;
- device/OAuth relay flows; and
- generic relay behavior in MCP/TNP integrations.

Those role names stay unchanged. They do not name inference and must not be
renamed to Kaana. Retiring the inference use makes searches, logs and operational
ownership unambiguous without disturbing those protocols.

## Migration rule

When an old inference reference is found:

1. replace it with the exact Kaana name if the surface is still live;
2. delete it if the surface is obsolete; or
3. retain it only as a short, unmistakably historical removal receipt.

Do not create redirects, alternate DNS names, environment-variable fallbacks or
dual header support. A request signed for another hostname is not a Kaana request.

## Consequences

- Public documentation has one inference data-plane name: Kaana.
- DNS automation reconciles the `kaana.ai` zone and apex only.
- Signed-envelope rotation uses `KAANA_EDGE_SIGNING_*` on Oxy and
  `KAANA_EDGE_PUBLIC_KEYS` on Kaana.
- Legitimate SMTP, ATProto, device, OAuth and MCP/TNP relay terminology remains
  intact because it denotes a role rather than the retired inference product.
