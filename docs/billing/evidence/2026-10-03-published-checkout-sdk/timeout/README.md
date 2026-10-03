# Published checkout SDK: literal timeout

Root executed this additional bounded loopback fixture on the published Peable
SDK 0.2.2 in ESM and CJS. The first synthetic checkout commits, but its response
is delayed 1500 ms while the SDK timeout is 100 ms. The retry and replay use the
same key and checkout ID; a different payload produces 409 and there is exactly
one creation per format. This complements the earlier socket-loss fixture.

The original 53 installed SDK files were independently verified by root. These
files preserve the executed fixture and output; they do not represent a new
provider request, publication or rerun by integration. The accepted external
source is `/home/nate/Oxy/.agent-evidence/root-1519-20261003/checkout-timeout-0854`.
