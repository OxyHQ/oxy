# Oxy Email Server

Native email system for the Oxy platform. Every Oxy user with a username automatically has an email address: `{username}@oxy.so`.

## How It Works

- **No separate email accounts** — email addresses are derived from Oxy usernames
- **Username changes** automatically change the email address (zero sync needed)
- **User deletion** cascades to all mailboxes, messages, and attachments
- **Plus-aliases** — `user+tag@oxy.so` delivers to `user@oxy.so` with the tag preserved for filtering
- **Lazy provisioning** — mailboxes are created on first email access, not at signup

## Architecture

Mail flow in production runs through **AWS SES** for both inbound and outbound traffic. The Oxy API exposes a REST surface for mailbox / message operations and a Cloudflare Email Routing webhook handler for inbound mail.

```
Inbound:
  Sender MX  --SES--> Cloudflare Email Routing webhook
                                 │
                                 ▼
                         ┌──────────────────┐
                         │  Oxy API         │  Validates recipient against Oxy users,
                         │  emailInbound.ts │  parses MIME, runs spam checks,
                         │                  │  writes Mailbox/Message rows.
                         └────────┬─────────┘
                                  │
                                  ▼
                          PostgreSQL (RDS)
                                  │
                                  ▼
                        S3 (attachments)

Outbound:
  Oxy API --SES--> Recipient MX
   (nodemailer SES transport, DKIM signed)
```

The legacy on-box SMTP server (`smtp.inbound.ts` / Rspamd / port 25) is no longer used in production — SES handles delivery and spam scoring. The standalone SMTP modules remain in the codebase for local dev and for self-hosted deployments outside AWS.

## Setup

### 1. Environment Variables

Add these to your `.env` file:

```bash
# ─── Required ─────────────────────────────────────────────
SMTP_ENABLED=true                    # Enable the SMTP inbound server
EMAIL_DOMAIN=oxy.so                  # Your email domain

# ─── DKIM (required for sending) ──────────────────────────
DKIM_SELECTOR=default                # DKIM selector (the "default" in default._domainkey.oxy.so)
DKIM_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
# Or use the file path approach (see DKIM section below)

# ─── S3 Bucket for Email Attachments ─────────────────────
EMAIL_S3_BUCKET=oxy-email            # Dedicated bucket (separate from other assets)
EMAIL_S3_REGION=us-east-1
EMAIL_S3_ACCESS_KEY_ID=              # Falls back to AWS_ACCESS_KEY_ID if not set
EMAIL_S3_SECRET_ACCESS_KEY=          # Falls back to AWS_SECRET_ACCESS_KEY if not set
EMAIL_S3_ENDPOINT=                   # Optional: for S3-compatible services (MinIO, R2, etc.)

# ─── Spam Filtering (optional) ───────────────────────────
SPAM_FILTER_ENABLED=true             # Enable Rspamd integration
RSPAMD_URL=http://localhost:11333    # Rspamd HTTP API address
SPAM_THRESHOLD=5.0                   # Score above this → Spam folder
SPAM_REJECT_THRESHOLD=15.0           # Score above this → rejected at SMTP level

# ─── SMTP Server Ports ───────────────────────────────────
SMTP_PORT=25                         # Inbound SMTP (must be 25 for internet mail)
SMTP_HOST=0.0.0.0                    # Listen on all interfaces
SMTP_MAX_MESSAGE_SIZE=26214400       # 25 MB max message size

# ─── TLS (required for production) ───────────────────────
SMTP_TLS_KEY=/etc/letsencrypt/live/oxy.so/privkey.pem
SMTP_TLS_CERT=/etc/letsencrypt/live/oxy.so/fullchain.pem

# ─── Outbound Relay (optional) ───────────────────────────
# If not set, sends directly via MX resolution (requires proper rDNS)
SMTP_RELAY_HOST=                     # e.g., smtp.sendgrid.net
SMTP_RELAY_PORT=587
SMTP_RELAY_USER=
SMTP_RELAY_PASS=
```

### 2. DKIM Setup

**What is DKIM?**

DKIM (DomainKeys Identified Mail) is a digital signature that proves an email was actually sent by your server and wasn't tampered with in transit. Without it, Gmail/Outlook will reject or spam-folder your emails.

It works like this:
1. You generate an RSA key pair (private + public)
2. The private key stays on your server — nodemailer signs every outgoing email with it
3. The public key goes in a DNS TXT record — receiving servers use it to verify the signature

**Generate DKIM keys automatically:**

```bash
# Run the included setup script
node packages/api/scripts/generate-dkim.js

# Or manually with OpenSSL:
openssl genrsa -out dkim-private.pem 2048
openssl rsa -in dkim-private.pem -pubout -outform der 2>/dev/null | openssl base64 -A > dkim-public.txt
```

The script outputs:
- `dkim-private.pem` — your private key (keep secret, set as `DKIM_PRIVATE_KEY` env var)
- The DNS TXT record value to add

**Add the DNS record:**

```
Type:  TXT
Name:  default._domainkey.oxy.so
Value: v=DKIM1; k=rsa; p=MIIBIjANBgkqh...YOUR_PUBLIC_KEY...
```

**Set the env var:**

```bash
# Option A: Inline (escape newlines)
DKIM_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----"

# Option B: Read from file in your startup script
export DKIM_PRIVATE_KEY=$(cat /path/to/dkim-private.pem)
```

### 3. DNS Records

For email to work, you need these DNS records on your domain:

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| **MX** | `oxy.so` | `10 mail.oxy.so.` | Tells the internet where to deliver mail for @oxy.so |
| **A** | `mail.oxy.so` | `YOUR_SERVER_IP` | Points to your mail server |
| **TXT** | `oxy.so` | `v=spf1 ip4:YOUR_SERVER_IP -all` | SPF: only your IP can send as @oxy.so |
| **TXT** | `default._domainkey.oxy.so` | `v=DKIM1; k=rsa; p=YOUR_PUBLIC_KEY` | DKIM: public key for signature verification |
| **TXT** | `_dmarc.oxy.so` | `v=DMARC1; p=reject; rua=mailto:dmarc@oxy.so` | DMARC: policy for failed SPF/DKIM |
| **PTR** | `YOUR_SERVER_IP` | `mail.oxy.so` | Reverse DNS (set via your hosting provider) |

**SPF** tells receiving servers "only this IP is allowed to send email for oxy.so."
**DKIM** proves the email content wasn't modified after sending.
**DMARC** tells receiving servers what to do if SPF or DKIM fail (reject the email).
**PTR** (reverse DNS) maps your IP back to your domain — many servers reject mail without it.

### 4. Rspamd (Spam Filtering)

**What is Rspamd?**

Rspamd is a spam filtering daemon that scores incoming emails. It runs as a separate service and our SMTP server calls it via HTTP to check each incoming message. It's optional — if Rspamd is down or disabled, mail is accepted without spam checking.

**Install Rspamd:**

```bash
# Ubuntu/Debian
sudo apt install rspamd

# Docker
docker run -d --name rspamd \
  -p 11333:11333 \
  -p 11334:11334 \
  rspamd/rspamd

# Verify it's running
curl http://localhost:11333/ping
# Should return: pong
```

**How it integrates:**

1. SMTP inbound receives a message
2. Before storing, it sends the raw message to `POST http://localhost:11333/checkv2`
3. Rspamd returns a score and recommended action
4. Score < 5.0 → Inbox
5. Score 5.0–15.0 → Spam folder
6. Score > 15.0 → Rejected at SMTP level

**If you don't want Rspamd:**

```bash
SPAM_FILTER_ENABLED=false
```

All mail will be delivered to Inbox without spam checking.

### 5. S3 Bucket

Create a dedicated S3 bucket for email attachments:

```bash
# AWS CLI
aws s3 mb s3://oxy-email --region us-east-1

# Or use any S3-compatible service (MinIO, Cloudflare R2, etc.)
# Set EMAIL_S3_ENDPOINT for non-AWS services
```

The email bucket is intentionally separate from your main assets bucket for:
- Independent access control
- Separate billing/monitoring
- Clean deletion when purging email data
- Different lifecycle policies (e.g., auto-delete trashed attachments after 30 days)

## API Reference

All endpoints require authentication via `Authorization: Bearer <token>`.

### Mailboxes

```
GET    /api/email/mailboxes                    List all mailboxes
POST   /api/email/mailboxes                    Create custom folder
DELETE /api/email/mailboxes/:mailboxId          Delete custom folder (not system folders)
```

**Default mailboxes** (auto-created on first access):
- INBOX (`\Inbox`)
- Sent (`\Sent`)
- Drafts (`\Drafts`)
- Trash (`\Trash`) — 30-day retention
- Spam (`\Junk`) — 30-day retention
- Archive (`\Archive`)

**Create mailbox:**
```json
POST /api/email/mailboxes
{
  "name": "Work",
  "parentPath": "Folders"    // optional, creates "Folders/Work"
}
```

### Messages

```
GET    /api/email/messages?mailbox=ID&limit=50&offset=0   List messages
GET    /api/email/messages/:messageId                      Get full message (auto-marks as read)
PUT    /api/email/messages/:messageId/flags                Update flags
POST   /api/email/messages/:messageId/move                 Move to folder
DELETE /api/email/messages/:messageId                       Move to trash
DELETE /api/email/messages/:messageId?permanent=true        Permanently delete
```

**List messages response:**
```json
{
  "data": [
    {
      "id": "...",
      "from": { "name": "John", "address": "john@gmail.com" },
      "to": [{ "name": "", "address": "me@oxy.so" }],
      "subject": "Hello!",
      "date": "2026-02-03T10:00:00Z",
      "flags": { "seen": false, "starred": false, "answered": false },
      "size": 1234,
      "attachments": [{ "filename": "doc.pdf", "size": 50000 }]
    }
  ],
  "pagination": { "total": 150, "limit": 50, "offset": 0, "hasMore": true }
}
```

Note: `text`, `html`, and `headers` are **not included** in list responses (to keep them lightweight). They are returned when fetching a single message.

**Update flags:**
```json
PUT /api/email/messages/:id/flags
{
  "flags": { "seen": true, "starred": true }
}
```

**Move message:**
```json
POST /api/email/messages/:id/move
{
  "mailboxId": "target-mailbox-id"
}
```

### Compose & Send

```
POST   /api/email/messages       Send an email
POST   /api/email/drafts         Save a draft
```

**Send email:**
```json
POST /api/email/messages
{
  "to": [{ "name": "Jane", "address": "jane@gmail.com" }],
  "cc": [],
  "bcc": [],
  "subject": "Hello from Oxy!",
  "text": "Plain text body",
  "html": "<p>HTML body</p>",
  "inReplyTo": "<original-message-id@gmail.com>",
  "references": ["<original-message-id@gmail.com>"],
  "attachments": [
    {
      "filename": "doc.pdf",
      "contentType": "application/pdf",
      "size": 50000,
      "s3Key": "userId/uuid/doc.pdf"
    }
  ]
}
```

Response (202 Accepted):
```json
{
  "data": {
    "messageId": "<uuid@oxy.so>",
    "queued": false,
    "message": "Message sent"
  }
}
```

If sending fails (e.g., remote server down), the message is queued for retry and `queued: true` is returned.

**Save draft:**
```json
POST /api/email/drafts
{
  "to": [{ "address": "jane@gmail.com" }],
  "subject": "Draft subject",
  "html": "<p>Work in progress...</p>",
  "existingDraftId": "optional-id-to-update"
}
```

### Search

```
GET /api/email/search?q=invoice&mailbox=ID&limit=50&offset=0
```

Full-text search across subject and body, backed by PostgreSQL full-text search. The `mailbox` parameter is optional — omit it to search all mailboxes.

The `q` parameter accepts the following read-state operators:

- `is:read` filters to messages where `messages.seen = true`.
- `is:unread` filters to messages where `messages.seen = false`.

An operator may be combined with normal search text, for example
`q=invoice%20is:unread`. Combining `is:read` and `is:unread` is rejected with
`400 Bad Request`, as is sending `q` more than once.

### Attachments

```
POST   /api/email/attachments              Upload attachment (multipart/form-data)
GET    /api/email/attachments/:s3Key       Get signed download URL (1 hour expiry)
```

**Upload:**
```
POST /api/email/attachments
Content-Type: multipart/form-data

file: (binary)
```

Returns the attachment metadata with `s3Key` to include when sending.

### Quota

```
GET /api/email/quota
```

Response:
```json
{
  "data": {
    "used": 1073741824,
    "limit": 5368709120,
    "percentage": 20
  }
}
```

### Settings

```
GET    /api/email/settings
PUT    /api/email/settings
```

**Get settings:**
```json
{
  "data": {
    "address": "username@oxy.so",
    "signature": "Sent from Oxy",
    "autoReply": {
      "enabled": false,
      "subject": "",
      "body": "",
      "startDate": null,
      "endDate": null
    }
  }
}
```

**Update settings:**
```json
PUT /api/email/settings
{
  "signature": "-- \nSent from Oxy",
  "autoReply": {
    "enabled": true,
    "subject": "Out of office",
    "body": "I'll be back on Monday.",
    "startDate": "2026-02-03T00:00:00Z",
    "endDate": "2026-02-10T00:00:00Z"
  }
}
```

## Storage Quotas

Quotas are enforced per user based on their subscription tier:

| Tier | Storage | Max Attachment | Daily Send Limit | Max Recipients |
|------|---------|---------------|-----------------|----------------|
| **Free** | 5 GB | 25 MB | 100 | 50 |
| **Pro** | 50 GB | 50 MB | 1,000 | 100 |
| **Business** | 200 GB | 100 MB | 10,000 | 500 |

When quota is exceeded, incoming messages are rejected with a `552` SMTP error and the REST API returns `400 Email storage quota exceeded`.

## Data Model

### Mailbox

```
userId        → User._id
name          "INBOX", "Sent", "Drafts", "Work", etc.
path          "INBOX", "Folders/Work" (hierarchical)
specialUse    "\Inbox", "\Sent", "\Drafts", "\Trash", "\Junk", "\Archive"
totalMessages counter
unseenMessages counter
size          total bytes in this mailbox
retentionDays auto-delete after N days (Trash=30, Spam=30)
```

### Message

```
userId, mailboxId   ownership + folder
messageId           RFC Message-ID header
from, to, cc, bcc   email addresses with display names
subject, text, html  message content (text/html excluded from list queries)
headers             raw email headers (excluded from list queries)
attachments[]       { filename, contentType, size, s3Key, contentId, isInline }
flags               { seen, starred, answered, forwarded, draft }
labels              custom labels
encrypted           true if body was encrypted with recipient's publicKey
spamScore           Rspamd score
inReplyTo           parent Message-ID (for threading)
references          full thread reference chain
aliasTag            "shopping" from user+shopping@oxy.so
date                Date header from message
receivedAt          when our server received it
```

### Search and conversation identity

`GET /email/search` accepts Gmail-style read-state operators in its `q` query
parameter: `is:unread` maps to `flags.seen=false` and `is:read` maps to
`flags.seen=true`. The operators are removed before the remaining text is sent
to MongoDB full-text search; combining both operators is rejected.

Messages do not currently persist a canonical `threadId`. `messageId`,
`inReplyTo`, and `references` are RFC headers and can be absent or incomplete,
so the API's existing `getThread` relation is only a best-effort lookup. The
API must not expose a synthetic thread ID or ask clients to group conversations
by subject until a reliable server-side conversation identity is persisted.

## Encryption

For users with a `publicKey` in their Oxy profile:

- **At rest**: Incoming messages can be encrypted with the user's public key before storage (`EMAIL_ENCRYPT_AT_REST=true`)
- **Between Oxy users**: True end-to-end encryption is possible since both sender and recipient have public keys
- **External recipients**: Standard TLS in transit (encryption between Oxy users only)

The `encrypted` flag on messages indicates whether the body is stored encrypted. The client must decrypt using the user's private key.

## File Structure

```
packages/api/src/
├── config/
│   └── email.config.ts          # All email configuration
├── models/
│   ├── Mailbox.ts               # Mailbox/folder model
│   └── Message.ts               # Email message model
├── services/
│   ├── email.service.ts         # Core business logic
│   ├── smtp.inbound.ts          # SMTP server (receiving)
│   ├── smtp.outbound.ts         # Sending with DKIM + retry queue
│   └── spam.service.ts          # Rspamd integration
├── controllers/
│   └── email.controller.ts      # REST request handlers
├── routes/
│   └── email.ts                 # Route definitions
└── scripts/
    └── generate-dkim.js         # DKIM key generation utility
```

## Production Checklist

- [ ] DNS records configured (MX, SPF, DKIM, DMARC, PTR)
- [ ] DKIM private key generated and set in env
- [ ] TLS certificates configured for SMTP
- [ ] S3 bucket created with proper IAM permissions
- [ ] Rspamd running (or `SPAM_FILTER_ENABLED=false`)
- [ ] Port 25 open in firewall (inbound SMTP)
- [ ] Reverse DNS (PTR) set for your server IP
- [ ] `SMTP_ENABLED=true` in env
- [ ] (Self-hosted only) Port 25 unblock approved by hosting provider
- [ ] Test sending/receiving with an external email provider
- [ ] Monitor spam score of outgoing mail at [mail-tester.com](https://www.mail-tester.com)

## Deployment Architecture

In production, email runs entirely on AWS:

```
                Internet
                   │
                   ▼
        ┌──────────────────┐
        │  AWS SES         │  inbound + outbound
        └────────┬─────────┘
                 │ webhook
                 ▼
   ┌─────────────────────────┐
   │  Cloudflare Email       │  forwards to API webhook
   │  Routing                │  (oxy.so MX -> SES via Email Routing)
   └────────────┬────────────┘
                │ POST /api/email/inbound
                ▼
   ┌─────────────────────────┐
   │  Oxy API on ECS         │
   │  Fargate (linux/arm64)  │
   │  packages/api/...       │
   └────────────┬────────────┘
                │
       ┌────────┴────────┐
       ▼                 ▼
  PostgreSQL (RDS)  S3 (attachments)
```

**Key points:**

- **AWS SES** handles transport (delivery + DKIM-signed outbound) and basic spam classification.
- **Cloudflare Email Routing** delivers inbound mail for `@oxy.so` to the API webhook (`packages/api/src/routes/emailInbound.ts`).
- The Oxy API runs as an **ECS Fargate** task in `oxy-cluster` behind the ALB — no on-box SMTP server in this path.
- **PostgreSQL** is the shared `oxy-postgres` RDS instance described in [Infrastructure](INFRASTRUCTURE.md).
- **Auto-deploy**: push to `main` → GitHub Actions builds an `arm64` image → pushes to ECR → `aws ecs update-service --force-new-deployment`. See [Deployment](DEPLOYMENT.md).

### Self-hosted SMTP (legacy / non-AWS deployments)

The repo still ships an Express + Caddy + Rspamd setup (`Dockerfile`, `docker-compose.yml`, `Caddyfile`) that can be used outside AWS. Set `SMTP_ENABLED=true`, run `docker compose up -d`, and follow the DKIM / DNS sections above. Port 25 must be reachable; many hosting providers block it by default.

### Deployment Files

```
OxyHQServices/
├── Dockerfile                        # Multi-stage build (linux/arm64 for ECS)
├── docker-compose.yml                # Local dev / self-hosted SMTP stack
├── Caddyfile                         # Self-hosted reverse proxy config
├── .env.example                      # Template for all env vars
├── .github/workflows/
│   ├── deploy-aws.yml                # ECS Fargate auto-deploy (production)
│   └── deploy-cloudflare.yml         # Static frontends auto-deploy
└── packages/api/scripts/
    └── generate-dkim.js              # DKIM key generation utility (self-hosted)
```
