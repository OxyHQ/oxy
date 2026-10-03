// Test transport only. URL values are read as data after the literal HTML loads;
// no request value is interpolated into HTML or JavaScript source.
export const OAUTH_POPUP_HTML = `<!doctype html><script>
setTimeout(() => {
  const params = new URL(location.href).searchParams;
  window.opener.postMessage({ type: 'oxy:oauth:code', code: 'fixture-code',
    state: params.get('state') }, new URL(params.get('redirect_uri')).origin);
}, 100);
</script>`;

export const OAUTH_MISMATCH_POPUP_HTML = `<!doctype html><script>
setTimeout(() => {
  const params = new URL(location.href).searchParams;
  window.opener.postMessage({ type: 'oxy:oauth:code', code: 'fixture-code',
    state: 'mismatched-state' }, new URL(params.get('redirect_uri')).origin);
}, 100);
</script>`;
