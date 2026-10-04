# Alia production input budget correction

Incident `chatcmpl-03f86870-ed03-4760-bede-cde281975bfc` reached Oxy as `0a646304-688b-4994-ac9a-15d774a1e7e0` at 2026-10-04T16:42:35Z. Oxy returned context_length_exceeded before provider dispatch: the controlled input exceeded the internal pilot budget. The private request body was not read or copied into this audit.

Alia main b2bc57f4 builds a 29,027-byte controlled context for one synthetic Hello using the real tool pipeline, prompt builder, AI SDK adapter and Oxy normalization. Codea is 30,328 and Cowork 30,272. The 21 tool schemas alone are 22,944 bytes; the old 8,192-byte ceiling cannot admit these baselines. This does not assert the incident's exact payload size or promise that any history fits.

The Alia relationship now allows 126,976 controlled UTF-8/framing units only for text completion, under economic policy oxy-inference-economics/2026-10-04.1. Its 8,192 base ceiling remains for decisions. Each route still applies its own context limit; output remains capped at 2,048, exact allowed deployments and 32 concurrent / 5,000 daily requests remain enforced. No truncation or tool removal occurs.

Allowing larger inputs can increase actual provider cost: this change is not economically neutral, and a byte ceiling is not certified provider token usage or an invoice ceiling. Existing route quoting, metered usage and independent cost reconciliation remain canonical. No commercial caller receives an exemption and no account credit or balance is fabricated.

Regression: the same real HTTP/SQL fixture with a synthetic assistant context fails with 400 on old source and passes with one dispatch on the change; repeating its key returns409 without another dispatch. Four suites /73 tests pass, covering the exact completion ceiling and one extra byte, Unicode, tool/schema payloads, a smaller model context, decisions before spend, output clamping and caller economics. Only the Kaana data plane is simulated locally. This is not a real provider replay of the user's private prompt.
