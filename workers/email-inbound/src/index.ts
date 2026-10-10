/**
 * Cloudflare Email Routing Worker
 *
 * Receives inbound email for *@oxy.so via Cloudflare Email Routing,
 * reads the raw MIME stream, and forwards it to the Oxy API webhook.
 *
 * Setup:
 *   1. Deploy this worker: wrangler deploy
 *   2. In Cloudflare Dashboard → Email Routing → Routes:
 *      Create a catch-all route (*@oxy.so) → Send to Worker → email-inbound
 *   3. Set the secret: wrangler secret put EMAIL_INBOUND_WEBHOOK_SECRET
 *      (must match the API's EMAIL_INBOUND_WEBHOOK_SECRET env var)
 */

export interface Env {
  EMAIL_INBOUND_WEBHOOK_SECRET: string;
  API_URL: string; // e.g. https://api.oxy.so
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const apiUrl = env.API_URL || 'https://api.oxy.so';
    const webhookUrl = `${apiUrl}/email/inbound`;

    // Read the raw MIME message from the stream
    const rawEmail = await new Response(message.raw).arrayBuffer();

    // Build the list of recipients from the envelope
    // message.to is the envelope RCPT TO address
    const envelopeTo = message.to;
    const envelopeFrom = message.from;

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          Authorization: `Bearer ${env.EMAIL_INBOUND_WEBHOOK_SECRET}`,
          'X-Envelope-From': envelopeFrom,
          'X-Envelope-To': envelopeTo,
        },
        body: rawEmail,
      });

      if (!response.ok) {
        const text = await response.text();
        // If the API rejects the message (e.g. unknown recipient, spam),
        // we don't retry — just log it. Rate limiting and request timeouts are
        // retryable delivery failures, not permanent message rejections.
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          console.log(`API rejected message: ${response.status} ${text}`);
          // Reject the message back to the sender so they get a bounce
          message.setReject(`Message rejected: ${text}`);
          return;
        }
        // Server error — throw to trigger Cloudflare retry
        throw new Error(`API error ${response.status}: ${text}`);
      }

      console.log(`Delivered email from ${envelopeFrom} to ${envelopeTo}`);
    } catch (err) {
      console.error(`Failed to deliver email: ${err}`);
      // Throwing causes Cloudflare to retry the delivery
      throw err;
    }
  },
};
