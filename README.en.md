# OpenTogetherTube (Simplified Chinese edition)

Watch videos together, in sync: one room, many links. Play, pause, seek and speed changes apply to
**everyone in the room**. Ships in Simplified Chinese by default, needs no sign-up to start, and
offers low-latency sync, chat, voice and AI video upscaling (Anime4K); run it self-hosted
(**Docker / Node.js**) or as a **serverless Cloudflare preview**.

[中文文档](README.md) · [Deployment](DEPLOYMENT.md) · [Cloudflare preview](DEPLOYMENT-CLOUDFLARE.md) · [Release notes](docs/version-notes.zh-CN.md)

## What makes this fork different

### Sync is treated as an engineering problem, not a slider

- **A new source waits for its first frame.** Auto-next, skip and “play now” park the room at the
  start of the new video and start the room clock only once the first viewer has a picture — no
  more missing the opening ten seconds. Embedded players and live sources still start immediately.
- **Empty-room resume, and pauses that survive.** The room pauses when the last viewer leaves and,
  on return, loads the saved position and waits for that device before starting the clock. A room
  restored from the database alone stays paused: entering it never auto-plays the queue.
- **Buffer gate (optional).** When someone explicitly reports buffering the whole room waits —
  15 s maximum, 30 s cooldown, background tabs excluded, controlled by a room setting.
- **Drift is corrected with rate, not with repeated seeking.** A ±8% rate bend converges over
  8–30 s before falling back to a hard seek; seeks have a cooldown, the keyboard and touch swipes
  share one step, and holding → temporarily doubles the room’s speed.
- **When something is off, you can see it.** The playback details panel shows resolution, buffer
  ahead, dropped frames, measured frame rate, drift from the room clock, enhancement state and the
  WebGPU adapter — refreshed every second without interrupting playback.

### In-browser video enhancement: four tiers, each aimed at different content

| Tier | Best for | How it works |
| --- | --- | --- |
| Sharpen | Anything, cheapest | FSR1's EASU edge-adaptive upscale plus CAS contrast-adaptive sharpening (WebGL2) |
| **Film (denoise, deband)** | **Live-action shows and movies** | Edge-preserving denoise/deblock, banding flattening where a neighborhood spans a few code values, LSB dither, then EASU and sharpening at 0.6 strength |
| AI upscale / AI upscale (quality) | Anime | Anime4K Mode A / A+A (WebGPU); the quality tier costs about twice the fast one |

On a pointer device the automatic scale renders at **2× the source** and lets the screen
downsample, which is what makes the AI tier’s upscale stages run at all; touch devices keep the
display-sized target to save power. Slow devices step down tier by tier, then by render scale.
All of it runs on the client — **the server needs no GPU**.

### Sources are broad, and hotlink guards have a fallback

- Direct MP4 / HLS / DASH / custom media manifests; adding a direct link probes neighbouring
  episodes and offers a one-click “same series” queue add.
- **Sources that only reject a foreign Referer are retried**: the probe tries the app’s own origin
  first, then no Referer, and only records the policy it measured. Sources that require their own
  site’s Referer or a cookie are flagged when the link is added, instead of “adds fine, fails to
  play”.
- Upstream platform adapters (YouTube, Bilibili, Vimeo, PeerTube, Odysee, … depending on your
  configuration).

### Talk, note and speak together

- **Chat**: live messages, an emoji panel, and a mobile composer with a send button and IME
  handling (picking a candidate with a Chinese IME never sends by accident).
- **Room notes**: a shared append-only list everyone can add to and delete from, never edit.
- **Room voice**: peer-to-peer audio; the server relays signaling only and never carries media.
  Without TURN configured it says so and runs in “direct only” mode.

### Chinese-first, with phone details worked out

- Simplified Chinese by default (other locales available), no account needed to create a room.
  Permissions are per-role (owner / administrator / moderator / trusted / registered /
  unregistered) and per-permission, with vote-to-skip.
- On a phone: slim portrait controls (volume and speed move into the settings menu), tap to
  toggle controls, double-tap to play or pause, full controls in landscape or fullscreen,
  selectable swipe-seek step, and a chat composer that keeps the keyboard open while sending.

### Self-hosting without ceremony

- GitHub Actions builds and pushes the image to GHCR on a tag, so **the server only pulls and
  never compiles**; `deploy/init.sh` writes `compose.yml` and `.env`, and an upgrade is one line
  of `OTT_IMAGE`.
- A **Cloudflare preview** deployment needs no server at all — a good fit for small watch parties
  that mostly use direct video links. Trade-offs, quotas and cost live in the deployment docs.

## Quick start

**Self-hosted Docker / Node.js (full feature set, recommended)** — on any Linux server
(2 vCPU / 2 GiB is a starting point):

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
bash source/deploy/init.sh          # writes compose.yml and .env
# edit .env and set OTT_PUBLIC_HOSTNAME to your domain or IP:port
sudo docker compose up -d           # pulls the image, migrates the database, starts the app
```

Upgrades, rollbacks, a Cloudflare Tunnel entry point and capacity notes live in the
[deployment guide](DEPLOYMENT.md).

**Cloudflare preview (no server)** — follow the
[step-by-step guide](DEPLOYMENT-CLOUDFLARE.md) to publish on Cloudflare with a free `workers.dev`
address. The full trade-off table is in [deployment options](docs/deployment-options.zh-CN.md).

## Documentation

| What you need | Where to look |
| --- | --- |
| Player controls, chat and “always buffering” | [docs/player-interactions.zh-CN.md](docs/player-interactions.zh-CN.md) |
| Playback sync and rate bending | [docs/playback-sync.zh-CN.md](docs/playback-sync.zh-CN.md) |
| “Pause while others buffer” | [docs/buffer-gate.zh-CN.md](docs/buffer-gate.zh-CN.md) |
| Enhancement tiers, render scale and the film tier | [docs/video-enhancement.zh-CN.md](docs/video-enhancement.zh-CN.md) · [live-action filter survey](docs/upscale-for-live-action.zh-CN.md) |
| Playback details panel | [docs/player-stats.zh-CN.md](docs/player-stats.zh-CN.md) |
| Room voice (P2P, cost brake) | [docs/voice.zh-CN.md](docs/voice.zh-CN.md) |
| Room notes (append-only, permissions, migration) | [docs/room-notes.zh-CN.md](docs/room-notes.zh-CN.md) |
| Large MP4 probing | [docs/media-parsing.zh-CN.md](docs/media-parsing.zh-CN.md) |
| Deployment, upgrades, rollbacks, resource use | [DEPLOYMENT.md](DEPLOYMENT.md) · [docs/deployment-options.zh-CN.md](docs/deployment-options.zh-CN.md) |
| Security headers and CSP | [docs/security-headers.zh-CN.md](docs/security-headers.zh-CN.md) |
| What changed in each release | [docs/version-notes.zh-CN.md](docs/version-notes.zh-CN.md) |
| Development, testing and contributing | [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) |
| Upstream and porting scope | [UPSTREAM.md](UPSTREAM.md) |

Most documents are written in Chinese, the project’s primary language.

## License and credits

[AGPL-3.0-or-later](LICENSE). This is a Simplified Chinese edition of
[OpenTogetherTube](https://github.com/dyc3/opentogethertube) (v0.15.0), keeping the original
authors’ and contributors’ attribution; see [UPSTREAM.md](UPSTREAM.md) for provenance and porting
scope, and the [font licenses](client/src/assets/fonts/vendor/LICENSES.md).

This fork stands on a lot of open-source work — in particular:

- **[Anime4K](https://github.com/bloc97/Anime4K)** (bloc97 and contributors): the AI upscale tiers
  run its Mode A / A+A shader chain; this project only drives it, manages the tiers and picks the
  render target.
- **[anime4k-webgpu](https://github.com/Anime4KWebBoost/anime4k-webgpu)**: the WebGPU port of those
  models, which we call directly (`ModeA`, `ModeAA`, restore and upscale pipelines).
- **[AMD FidelityFX Super Resolution 1.0](https://github.com/GPUOpen-Effects/FidelityFX-FSR)**:
  EASU (the 12-tap edge-adaptive upscale) and CAS sharpening in the Sharpen and Film tiers are
  ported from `ffx_fsr1.h`.
- **[hls.js](https://github.com/video-dev/hls.js) and [dash.js](https://github.com/Dash-Industry-Forum/dash.js)**:
  HLS / DASH playback, buffering and ABR — the buffering strategy is built on their configuration.
- **[Vue 3](https://github.com/vuejs/core), [Vuetify](https://github.com/vuetifyjs/vuetify) and
  [MDI](https://github.com/Templarian/MaterialDesign)**: UI, components and icons.
- **[PostgreSQL](https://www.postgresql.org/), [Redis](https://redis.io/), [Caddy](https://caddyserver.com/)
  and [Docker](https://www.docker.com/)**: persistence, room state, HTTPS entry and deployment; plus
  [sponsorblock-api](https://github.com/ajayyy/SponsorBlock) and the
  [Vimeo](https://github.com/vimeo/player.js) / [PeerTube](https://github.com/Chocobozzz/PeerTube)
  embed SDKs.

Each dependency carries its own license; see the upstream repositories and `node_modules/*/LICENSE`.
