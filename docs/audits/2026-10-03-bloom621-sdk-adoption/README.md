# Adopt the verified Bloom maintenance fixes

The catalog and scaffold pin **6.2.1 exactly**, and Services declares
**>=6.2.1 <6.3.0**. The reviewed Back/X completion and SVG paint/resize fixes are
on this maintenance line; known6.4.0 lacks them. No breaking Bloom7 migration or
unreviewed broader range is admitted. Lock delta contains only peer/catalog and
Bloom resolution. The existing typography test now parses a comparator minimum
while still requiring >=4.21.1 and checking actual unitless typography tokens.

Services113/1036 pass, package build/verify pass, scaffoldCLI50/build pass, and
the actual workspace Expo app exports web successfully. Frozen logs preserve
the initial parser failure and an erroneous invocation; the named GREEN log is
the acceptance result. Oxy packages remain candidates, and complete packed
scaffold/Examples/native/consumer registry repetition still needs its own
observations. The separate Bloom publication receipt does not publish Oxy.
