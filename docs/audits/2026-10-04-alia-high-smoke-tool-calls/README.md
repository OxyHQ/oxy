# Alia smoke mixed text/tool-call acceptance

The frozen operator at `202416b1e` accepted nonempty text with `finishReason: stop` even when the same response contained tool calls. Its `hasToolCalls` field was recorded but omitted from the acceptance predicate. The existing tool-call negative changed the finish reason and did not cover this combination.

This additive follow-up requires `!hasToolCalls` for successful conversation acceptance. A mixed response retains its completed matching usage record and answer hash, reports incomplete response recovery, and executes no tools or retries. Request, authority, transport, deadlines, quote checks and runtime policy binding are unchanged.

The preserved regression failed against the frozen baseline (0 pass / 1 fail). Five focused controls pass after the change: ordinary successful High text, empty response, length, tool-call finish, and mixed text/stop/tool call. They use the installed published core4.3 SDK with synthetic HTTP/JWKS transport. No AWS, production HTTP or provider call occurred; no broad suites were repeated.

See [proof.json](proof.json) for source, SDK and raw-log hashes. The original executed worktree remains untouched; root owns the independent live response and receipt acceptance. No push or deployment is included.
