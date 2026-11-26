# Changelog: `@oxy.so/doctor`

## 1.10.1

### Fixed

- `oxy-doctor-web-budget` counts Bloom 23's agent-avatar motion blobs as
  catalogue payloads again (#2323). It recognised a payload only in the packed
  asset form (`exports = { encoding: "json", data: "..." }`); Bloom 23's shared
  motion blobs (`agent-avatar/vector-assets/blobs/`, about 850 lazy chunks)
  export one track as an object literal (`{ matrix: { samples: … } }`,
  `{ points: { rows: … } }`, `{ translation: { samples: … } }`), so ~5.6 MB of
  catalogue counted as app JS and every app on Bloom 23 failed its
  `maxJavaScriptGzipBytes` budget (Allo measured 9.36 MB against 3.61 MB; 3.83
  MB with the catalogue split out). A one-module chunk exporting a single track
  of samples or rows is now a payload; any other object stays on the app's
  lines.
