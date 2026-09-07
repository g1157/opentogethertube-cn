This instance is based on the official OpenTogetherTube `v0.15.0` release:
https://github.com/dyc3/opentogethertube/releases/tag/v0.15.0

The upstream release tag still contains `0.14.1` in its workspace package.json files.
The release tag, local Git history, and container image label identify this deployment.

Local changes add permanent queue checkpoints, automatic pause when the last viewer
leaves, automatic restoration, saved room listings, simplified Chinese as the default,
separate cookie names for the parallel instance, and WebSocket input validation.
Player fullscreen now targets the video and its controls, locks background scrolling,
and restores the previous page position when leaving fullscreen.

The original server deployment on ports 80/8080 is independent and remains available.
