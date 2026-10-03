# AUTH touch: development overlay interception, same-source control

Root reproduced and resolved the observed touch obstruction without changing AUTH, Bloom, an installed package, or any identity store. The frozen Mention source remained5c18200489d4380770be564dcc6fcd60d48fca95 with published Bloom6.2.1 throughout this control.

The password alternative's bounds were `[303,2032][779,2137]`. Its center541,2084 repeatedly failed while LogBox was present. Although the visible warning began at2146, its native ancestor covered `[26,2081][1054,2348]`, including that center. A top-edge control541,2040 outside that ancestor succeeded. Root then returned to the code step, reproduced the center failure, dismissed the visible LogBox X through normal UI, verified the unchanged link bounds and warning absence, and tapped the same center. It immediately reached Enter your password. This establishes development-overlay interception for this recorded failure; it does not require an AUTH or Bloom runtime fix.

The installed RN0.86.0 LogBox source uses an absolutely positioned SafeAreaView container without box-none pointer handling. The banner Pressable adds no hitSlop; its small dismiss button adds12dp vertically. The native ancestor bounds, rather than the visible banner or its small dismiss hitSlop, explain this observation. No warning suppression was added to product code and no dependency source was edited.

Both isolated controls had already passed. The second matched the actual link bounds with a stable frame and with event capture both enabled and disabled. Those controls alone did not prove AUTH correct; the decisive evidence is the real same-source before/after overlay control. Their time-specific receipts retain “unresolved” wording honestly.

UI Automator omitted the IME from XML while screenshots show it visibly open. A previous inference of no keyboard based solely on XML is invalid. Fresh XML captures reject failed idle dumps instead of reusing stale files. The actual PNGs were independently inspected; private screenshots/XML retain synthetic account data and remain at their recorded paths, with68 input hashes verified across the three observations.

A real-AUTH logging instrument was prepared in a separate worktree and built, but no Metro/APK ever loaded it. Its patch was retained privately and the source restored. It is not part of this evidence or the release. Sibling Metros were unchanged during these controls. Root was the sole ADB operator on emulator5580; no physical device, clear/uninstall, key deletion or auth-state injection occurred.

This closes the touch investigation for the observed LogBox obstruction. Native durable sign-out/cold-start and foreground account reconciliation remain separate acceptance tests and require the reviewed marker candidate. No final SDK publication or full native acceptance is inferred here.
