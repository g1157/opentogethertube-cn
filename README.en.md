# 🎬 OpenTogetherTube (Simplified Chinese edition)

**One room, one timeline.** Play, pause, seek and speed changes apply to **everyone in the room**.

Simplified Chinese by default · No sign-up to open a room · Self-hosted or serverless

![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)
![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)
![Node](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-5FA04E?logo=nodedotjs&logoColor=white)
![Cloudflare](https://img.shields.io/badge/cloudflare-workers.dev-F38020?logo=cloudflare&logoColor=white)

[中文](README.md) · [Deployment](DEPLOYMENT.md) · [Cloudflare preview](DEPLOYMENT-CLOUDFLARE.md) · [Release notes](docs/version-notes.zh-CN.md)

## ✨ At a glance

- 🔄 **Sync**: clock starts on the first frame · buffer gate · ±8% rate convergence · drift and dropped frames on screen
- 📚 **Sources**: direct MP4/HLS/DASH/custom manifests · **Emby library** (direct or server-side HLS transcode) · neighbouring episodes probed automatically
- 🎞️ **Picture**: four enhancement tiers — sharpen / film / AI upscale / AI upscale ultra, **no GPU on the server**
- 💬 **Together**: chat · append-only room notes · peer-to-peer voice (optional Cloudflare TURN relay)
- 📱 **Chinese-first & mobile**: IME-safe chat · slim portrait controls · gestures and hold for room-wide 2×
- 🚀 **Deploy**: image prebuilt on GHCR · one `deploy/init.sh` command · upgrade is one line

## 🚀 Quick start

### 🐳 Option 1: Docker (recommended, full feature set)

Any Linux server, **2 vCPU / 2 GiB** as a starting point:

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
bash source/deploy/init.sh          # writes compose.yml and .env
# edit .env and set OTT_PUBLIC_HOSTNAME to your domain or IP:port
sudo docker compose up -d           # pulls the image, migrates the database, starts the app
```

> 💡 The image comes from `ghcr.io/g1157/opentogethertube-cn`, so the server only pulls and never
> compiles. Upgrading = change the version in `OTT_IMAGE`, then `docker compose pull && up -d`.

### ☁️ Option 2: Cloudflare preview (no server)

Follow the [step-by-step guide](DEPLOYMENT-CLOUDFLARE.md) to publish on Cloudflare with a free
`workers.dev` address; a good fit for small watch parties built on direct links. Trade-offs, quotas
and cost are in [deployment options](docs/deployment-options.zh-CN.md).

> ⚠️ A LAN Emby only works when the page itself can reach that address. Sharing `192.168.x.x` with
> friends outside the network leaves them buffering forever.

---

## 🔄 Sync is treated as an engineering problem

- **A new source waits for its first frame.** Auto-next, skip and “play now” park the room at the start of the new video and start the clock only once the first viewer has a picture; embedded players and live sources still start immediately.
- **Empty room pauses, return resumes.** The room pauses when the last viewer leaves; on return it loads the saved position and waits for that device before starting the clock. A room restored from the database alone stays paused and never auto-plays.
- **Buffer gate (room setting).** When someone explicitly reports buffering the whole room waits: 15 s maximum, 30 s cooldown, background tabs excluded.
- **Drift is corrected with rate, not repeated seeking.** A ±8% bend converges over 8–30 s before a hard seek; seeks have a cooldown, keyboard and swipes share one step, and holding doubles the room’s speed temporarily.
- **When something is off, you can see it.** The playback panel shows resolution, buffer ahead, dropped frames, measured frame rate, drift from the room clock, enhancement state and the WebGPU adapter — refreshed every second without interrupting playback.

## 🎞️ In-browser video enhancement: four tiers for different content

| Tier | Best for | How it works |
| --- | --- | --- |
| Sharpen | Anything, cheapest | FSR1's EASU edge-adaptive upscale plus CAS contrast-adaptive sharpening (WebGL2) |
| **Film (denoise, deband)** | **Live-action shows and films** | Edge-preserving denoise/deblock → banding flattened and dithered → EASU → sharpening at 0.6 strength |
| AI upscale / AI upscale (quality) | Anime | Anime4K Mode A / A+A (WebGPU); the quality tier costs about twice the fast one |
| **AI upscale (ultra)** | Anime, on devices without WebGPU | mpv's A+A (HQ) chain on WebGL2: official v4.0.1 GLSL with weights untouched, 46 passes a frame at a 2× target |

On a pointer device the automatic scale renders at **2× the source** and lets the screen downsample —
that is what makes the AI tier's upscale stages run; touch devices stay at display size to save power.
Slow devices step down tier by tier, then by render scale.

> 🖥️ Without a usable WebGPU adapter (Firefox outside Windows, Safari before 26, blocklisted drivers)
> the same networks run on WebGL2: the ultra tier only appears there, since on WebGPU the quality tier
> already is that chain. Everything runs on the client — **the server needs no GPU**.

## 📚 Sources: direct links, Emby, hotlink guards

- **Direct** MP4 / HLS / DASH / custom media manifests; adding a link probes neighbouring episodes and offers a one-click “same series” queue add.
- **Hotlink guards have a fallback**: the probe tries the app's own origin first, then no Referer, and records only the policy it measured; sources needing their own site's Referer or a cookie are flagged when the link is added.
- **Subtitles**: WebVTT and ASS/SSA, styled by libass in the browser; cross-origin subtitle files need `Access-Control-Allow-Origin`.

### 🎬 Emby: browser-direct, the server never touches video

Enter address, port and account, then browse and search:

- 🔍 Search finds the **series itself**; open it and episodes are listed by season, not as an unidentifiable wall of single episodes.
- 🏷️ Every tile is labelled **direct / needs transcoding / unverified / unsupported** with resolution and codecs; selecting one confirms it with Emby.
- 🔁 **MKV is not a dead end**: when Emby offers a transcode URL the room plays its HLS stream (TS / H264 / AAC) — the transcoding load sits on Emby.
- 🔒 The OTT server never proxies video and never stores the password; only the playback URL and display metadata enter the queue, **token included and visible**.

## 💬 Together

- **Chat**: live messages, emoji panel, mobile send button; picking a candidate with a Chinese IME never sends by accident.
- **Room notes**: an append-only shared list everyone can add to and delete from, never edit.
- **Room voice**: peer-to-peer audio, the server relays signalling only; the UI reports each peer's real path (direct, relayed, connecting, failed), and Cloudflare TURN credentials are minted automatically when a key is configured.
- **Chinese-first and mobile**: Simplified Chinese by default (locales switchable); per-role permissions (owner / administrator / moderator / trusted / registered / unregistered) with vote-to-skip; portrait keeps volume and speed in the settings, tap toggles controls, double-tap pauses, landscape or fullscreen restores the full bar.

---

## 📖 Documentation

<details>
<summary>Architecture, troubleshooting, design notes and deployment details (click to expand)</summary>

| What you need | Where to look |
| --- | --- |
| Architecture, sync engine, data flow | [architecture](docs/architecture.zh-CN.md) · [sync](docs/playback-sync.zh-CN.md) · [buffer gate](docs/buffer-gate.zh-CN.md) |
| Player controls, “always buffering” | [player-interactions](docs/player-interactions.zh-CN.md) · [playback panel](docs/player-stats.zh-CN.md) |
| Enhancement tiers and design notes | [video-enhancement](docs/video-enhancement.zh-CN.md) · [live-action filters](docs/upscale-for-live-action.zh-CN.md) · [ultra tier vs mpv](docs/upscale-webgl2-mpv-parity.zh-CN.md) |
| Emby entry | [emby](docs/emby.zh-CN.md) |
| Voice, notes, passwords | [voice](docs/voice.zh-CN.md) · [room notes](docs/room-notes.zh-CN.md) · [room password](docs/room-password.zh-CN.md) |
| Media probing | [media parsing](docs/media-parsing.zh-CN.md) · [custom media format](docs/custom-media-format.md) |
| Deployment and security | [DEPLOYMENT](DEPLOYMENT.md) · [deployment options](docs/deployment-options.zh-CN.md) · [security headers](docs/security-headers.zh-CN.md) |
| Development and contributing | [CONTRIBUTING](CONTRIBUTING.md) · [AI handbook](docs/ai-handbook.zh-CN.md) |
| Releases and index | [release notes](docs/version-notes.zh-CN.md) · [docs/README](docs/README.md) · [archive](docs/archive/README.md) · [upstream](UPSTREAM.md) |

Most documents are written in Chinese, the project's primary language.

</details>

## 📄 License and credits

[AGPL-3.0-or-later](LICENSE). This is a Simplified Chinese edition of
[OpenTogetherTube](https://github.com/dyc3/opentogethertube) (v0.15.0), keeping the original authors'
and contributors' attribution; provenance and porting scope are in [UPSTREAM.md](UPSTREAM.md), font
licenses in the [font sources](client/src/assets/fonts/vendor/LICENSES.md).

- **[Anime4K](https://github.com/bloc97/Anime4K) / [anime4k-webgpu](https://github.com/Anime4KWebBoost/anime4k-webgpu)** —
  the Mode A / A+A chains behind the AI upscale tiers: WebGPU calls an existing port, WebGL2 is
  generated from the official v4.0.1 GLSL with its convolution weights untouched. This project adds
  the driver, the tiers and the coordinate semantics.
- **[AMD FidelityFX Super Resolution 1.0](https://github.com/GPUOpen-Effects/FidelityFX-FSR)** — EASU and
  CAS in the Sharpen and Film tiers are ported from `ffx_fsr1.h`.
- **[hls.js](https://github.com/video-dev/hls.js) / [dash.js](https://github.com/Dash-Industry-Forum/dash.js)** —
  HLS / DASH playback, buffering and ABR.
- **[Vue 3](https://github.com/vuejs/core) / [Vuetify](https://github.com/vuetifyjs/vuetify) / [MDI](https://github.com/Templarian/MaterialDesign)** —
  UI, components and icons; plus [PostgreSQL](https://www.postgresql.org/), [Redis](https://redis.io/),
  [Caddy](https://caddyserver.com/), [Docker](https://www.docker.com/),
  [sponsorblock-api](https://github.com/ajayyy/SponsorBlock) and the
  [Vimeo](https://github.com/vimeo/player.js) / [PeerTube](https://github.com/Chocobozzz/PeerTube) SDKs.

We especially thank **[girigiri](https://girigirilove.com/)**: the video sources this project is
developed and tested against come from that site (`ani.girigirilove.com` with its `ana.` / `akua.` /
`danmu.` subdomains, the bullet-comment data from the same public API). This project is not affiliated
with the site — the integration is client-side compatibility only, and the content belongs to the
site and its rights holders.

Each dependency carries its own license; see the upstream repositories and `node_modules/*/LICENSE`.
