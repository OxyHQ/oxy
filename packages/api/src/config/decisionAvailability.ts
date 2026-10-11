/**
 * No credential or environment flag can authorize Jev service. Activation needs
 * independent review of exact deployment eligibility, resale/internal-use rights,
 * privacy terms and effective ZDR, plus negotiated Kaana contract support.
 * TypeSafe standalone resale and ordinary OpenRouter resale/competitor access
 * are not authorized. Internal use is not an exemption from those checks.
 */
export function decisionAvailability(): { available: boolean; reason: string } {
  return {
    available: false,
    reason: 'Decisions await reviewed provider eligibility, privacy, ZDR and contract negotiation.',
  };
}
