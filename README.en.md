# OpenTogetherTube (Simplified Chinese edition)

Watch videos together, in sync: one room, one link. Play, pause, seek and speed changes apply to
**everyone in the room**. Ships in Simplified Chinese by default, needs no sign-up to start, and
runs either self-hosted (**Docker / Node.js**) or as a **serverless Cloudflare preview**.

[中文文档](README.md) · [Deployment](DEPLOYMENT.md) · [Cloudflare preview](DEPLOYMENT-CLOUDFLARE.md) · [Release notes](docs/version-notes.zh-CN.md)

## Highlights

- **Synchronized playback** — play, pause, seek and speed are room-wide, measured to within
  0.01 s between two viewers; holding a gesture temporarily doubles the room speed.
- **Chinese-first UI** — Simplified Chinese by default with other locales available, and no
  account required to create a room.
- **Rooms** — temporary rooms disappear when everyone leaves; permanent rooms keep the current
  video, its position and the queue so you can continue later.
- **Talk together** — live chat and **room notes**: a shared, append-only list everyone can add
  to and delete from (notes are never edited).
- **Room voice** — peer-to-peer audio; the server relays signaling only and never carries media.
  Without TURN configured it runs in “direct only” mode.
- **Fine-grained permissions** — owner / administrator / moderator / trusted / registered /
  unregistered, configurable per permission, plus vote-to-skip.
- **Sources** — public direct links (MP4 / HLS / DASH / custom media manifests) and upstream
  platform adapters (YouTube, Vimeo, PeerTube, … depending on your configuration).
- **Comfort features** — video enhancement (sharpen / Anime4K), subtitles, optional
  “pause while others buffer”, and phone-friendly portrait/landscape controls.

## Quick start

**Self-hosted Docker / Node.js (full feature set, recommended)** — on any Linux server
(2 vCPU / 2 GiB is a starting point):

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
bash source/deploy/init.sh          # writes compose.yml and .env
# edit .env and set OTT_PUBLIC_HOSTNAME to your domain or IP:port
sudo docker compose up -d           # pulls the image, migrates the database, starts the app
```

Images are published to GHCR by GitHub Actions, so the server never compiles anything. Upgrades,
rollbacks, a Cloudflare Tunnel entry point and capacity notes live in the
[deployment guide](DEPLOYMENT.md).

**Cloudflare preview (no server)** — follow the
[step-by-step guide](DEPLOYMENT-CLOUDFLARE.md) to publish on Cloudflare with a free `workers.dev`
address; best for small watch parties that mostly use direct video links.

The full trade-off table is in [deployment options](docs/deployment-options.zh-CN.md) (Chinese).

## Documentation

| What you need | Where to look |
| --- | --- |
| Deployment, upgrades, rollbacks | [DEPLOYMENT.md](DEPLOYMENT.md) · [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md) · [deployment options](docs/deployment-options.zh-CN.md) |
| Room voice (P2P, cost brake) | [docs/voice.zh-CN.md](docs/voice.zh-CN.md) |
| Room notes (append-only, permissions, migration) | [docs/room-notes.zh-CN.md](docs/room-notes.zh-CN.md) |
| Player controls and “always buffering” | [docs/player-interactions.zh-CN.md](docs/player-interactions.zh-CN.md) |
| Playback sync and rate bending | [docs/playback-sync.zh-CN.md](docs/playback-sync.zh-CN.md) |
| “Pause while others buffer” | [docs/buffer-gate.zh-CN.md](docs/buffer-gate.zh-CN.md) |
| Large MP4 probing (`FFPROBE_STRATEGY`) | [docs/media-parsing.zh-CN.md](docs/media-parsing.zh-CN.md) |
| Security headers and CSP reports | [docs/security-headers.zh-CN.md](docs/security-headers.zh-CN.md) |
| Cloudflare quotas and cost | [docs/cloudflare-quotas.zh-CN.md](docs/cloudflare-quotas.zh-CN.md) |
| What changed in each release | [docs/version-notes.zh-CN.md](docs/version-notes.zh-CN.md) |
| Development and contributing | [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) |
| Upstream and porting scope | [UPSTREAM.md](UPSTREAM.md) |

Most documents are written in Chinese; they are the project’s primary language.

## License and credits

[AGPL-3.0-or-later](LICENSE). This is a Simplified Chinese edition of
[OpenTogetherTube](https://github.com/dyc3/opentogethertube) (v0.15.0), keeping the original
authors’ and contributors’ attribution; see [UPSTREAM.md](UPSTREAM.md) for provenance and porting
scope, and the [font licenses](client/src/assets/fonts/vendor/LICENSES.md).
