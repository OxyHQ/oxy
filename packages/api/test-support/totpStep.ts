/**
 * Wait, when needed, until the current 30 s TOTP step has at least 10 s left.
 *
 * Tests that use the previous, current and next step's codes on purpose (the
 * server accepts one step of skew each way) break when they cross a step
 * boundary between computing a code and the server checking it: every code
 * shifts by a step. Run it as `beforeEach(awayFromTotpStepEdge, 15_000)` in the
 * describes that use step-relative codes.
 */
export async function awayFromTotpStepEdge(): Promise<void> {
  const intoStep = Date.now() % 30_000;
  if (intoStep > 20_000)
    await new Promise((resolve) => setTimeout(resolve, 30_000 - intoStep + 50));
}
