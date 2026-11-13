# Project map

Every Oxy product and shared package is its own repository under [github.com/OxyHQ](https://github.com/OxyHQ). Each repository documents what it owns, in the repository; a rule that spans repositories lives in the repository that owns the mechanism, and Oxy is the default owner of ecosystem-wide engineering standards ([README](README.md)).

## Platform and shared packages

| Repository | Purpose |
|---|---|
| [oxy](https://github.com/OxyHQ/oxy) | The platform: API and identity provider, the SDK (`@oxy.so/core`, `@oxy.so/services`, `@oxy.so/contracts`, `@oxy.so/protocol`), Oxy ID, the Oxy Console and Commons, data nodes. Formerly OxyHQServices |
| [Bloom](https://github.com/OxyHQ/Bloom) | The UI library every Oxy app is built with (`@oxy.so/bloom`): one component set for React Native, Expo and the web |
| [BloomAiIcons](https://github.com/OxyHQ/BloomAiIcons) | AI model-publisher marks for Bloom (`@oxy.so/bloom-ai-icons`) |
| [Kaana](https://github.com/OxyHQ/Kaana) | The inference data plane (Go): executes signed, already-authorized requests across upstream providers at `https://kaana.ai` |
| [Gemies](https://github.com/OxyHQ/Gemies) | The agent runtime (gemies.ai): HTTP API at `api.gemies.ai`, integrations, the computer host, and the `@gemies/sdk` and `@gemies/server` packages other apps embed |
| [Alia](https://github.com/OxyHQ/Alia) | The assistant app (Alia, the official gemie) for web, iOS and Android, built on `@gemies/sdk` |
| [GoWay](https://github.com/OxyHQ/GoWay) | Open map and geographic platform (goway.to) and the `@goway.to/sdk` and Maps SDK other apps embed |
| [CrowdSource](https://github.com/OxyHQ/CrowdSource) | Participatory moderation infrastructure: reports become cases, a randomly drawn jury reviews them, a versioned decision returns by webhook |
| [examples](https://github.com/OxyHQ/examples) | Standalone Next.js, Vite and Expo reference apps for signing in with Oxy |
| [oxy-infra](https://github.com/OxyHQ/oxy-infra) | Production Terraform and runbooks for Oxy's AWS infrastructure (private) |

## Products

| Repository | Purpose |
|---|---|
| [Mention](https://github.com/OxyHQ/Mention) | Social network for iOS, Android and the web, federated through ActivityPub; reference layout for single-app repositories |
| [Allo](https://github.com/OxyHQ/Allo) | Chat app with end-to-end encrypted direct messages |
| [Syra](https://github.com/OxyHQ/Syra) | Music and podcast platform with live audio rooms |
| [Homiio](https://github.com/OxyHQ/Homiio) | Housing trust and transparency: find a place, research its history and cost, manage the tenancy |
| [Inbox](https://github.com/OxyHQ/Inbox) | Inbosh, the email client (inbo.sh); frontend only, its backend is the Oxy API |
| [Clarity](https://github.com/OxyHQ/Clarity) | Search across the web, jobs, places, news and markets, with an assistant that is an ordinary Alia agent |
| [Mercaria](https://github.com/OxyHQ/Mercaria) | Buy-and-sell marketplace for shops and individuals (mercaria.co) with dashboard and point-of-sale apps |
| [mercaria-woocommerce](https://github.com/OxyHQ/mercaria-woocommerce) | WooCommerce plugin that syncs a store's catalogue to Mercaria |
| [Moovo](https://github.com/OxyHQ/Moovo) | Courier and transport platform: packages, food and moves, carried by Moovo couriers or external providers |
| [Peable](https://github.com/OxyHQ/Peable) | Payments platform: merchant workspace, APIs, SDKs, checkout and a personal payment app, for fiat and FairCoin |
| [Noted](https://github.com/OxyHQ/Noted) | Local-first notes app with on-device recording and transcription |
| [Nilo](https://github.com/OxyHQ/Nilo) | Workspace for pages, blocks, typed databases, comments, sharing and real-time collaboration |
| [Willo](https://github.com/OxyHQ/Willo) | Smart-home control over a Home Assistant instance |
| [willo-ha](https://github.com/OxyHQ/willo-local) | Home Assistant integration that connects an instance to Willo over one outbound connection |
| [Dropsea](https://github.com/OxyHQ/Dropsea) | Photos and files (dropsea.net): albums over what a person keeps in Oxy Files |
| [Schedio](https://github.com/OxyHQ/Schedio) | Compose once, schedule, and publish to connected social accounts |
| [Atlas](https://github.com/OxyHQ/Atlas) | The Oxy app store (atlas.oxy.so); frontend only, the store lives in the Oxy API |
| [Authenticator](https://github.com/OxyHQ/Authenticator) | Two-factor (TOTP) authenticator app with sync across devices through Oxy |
| [Move](https://github.com/OxyHQ/Move) | Migrator (move.oxy.so) that brings a Mastodon or Bluesky account to Oxy and Mention |
| [TNP](https://github.com/OxyHQ/tnp) | The Network Protocol: an alternative namespace, edge and privacy layer that runs on top of the existing internet |
| [Astro](https://github.com/OxyHQ/Astro) | Chromium browser with a sidebar, split view and tracker blocking (pnpm and Turbo workspace) |
| [OxyOS](https://github.com/OxyHQ/OxyOS) | Native Linux platform with its own compositor and Bloom applications; a foundation, with no image published yet |
| [website](https://github.com/OxyHQ/website) | Source of oxy.so and fairco.in |
| [ActivityWallpaper](https://github.com/OxyHQ/activity-wallpaper) | Oxy Globe, an Android live wallpaper that renders platform activity |
| [FAIRWallet](https://github.com/FairCoinOfficial/FAIRWallet) | SPV wallet for FairCoin (FairCoinOfficial organization) |

Not Oxy products: `GWJ` and `Eufesio` belong to the GlobalWorldJournal organization and are independent of the Oxy ecosystem, and `expo`, `react-native` and `react-native-screens` are upstream forks kept for reading and patch work.

## How the AI products relate

AI roles are not repo-name aliases. Kaana executes provider inference at `https://kaana.ai`; Alia owns conversations, agents, memory and tools; Oxy owns authorization and billing. One-shot app AI uses app -> Oxy -> Kaana, while agent and chat features use app -> Alia -> Oxy -> Kaana. Sindi (Homiio) and Clarity's assistant are Alia agents. Provider credentials are exact `(provider, keyId)` PostgreSQL rows encrypted by Kaana through KMS, never environment variables or MongoDB; neither deployment nor credential selection falls back to a display name, insertion order or first row. Routing rules and ownership: [request-routing](../inference/request-routing.md).

## Layout

Oxy's Expo apps with a backend use `packages/frontend`, `packages/backend` and `packages/shared-types` (reference: Mention), never `apps/`. Frontend-only apps (Atlas, Inbox) read a backend owned by another product.
