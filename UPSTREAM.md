This instance is based on the official OpenTogetherTube `v0.15.0` release:
https://github.com/dyc3/opentogethertube/releases/tag/v0.15.0

The upstream release tag still contains `0.14.1` in its workspace package.json files.
The release tag, local Git history, and container image label identify this deployment.

Local changes add permanent queue checkpoints, automatic pause when the last viewer
leaves, automatic restoration, saved room listings, simplified Chinese as the default,
separate cookie names for the parallel instance, and WebSocket input validation.
Player fullscreen now targets the video and its controls, locks background scrolling,
and restores the previous page position when leaving fullscreen.

Deployment can start on an independent port and later replace an existing entry point.
Keep the previous application's image, configuration and separate data volumes for
rollback; the two instances do not automatically merge subsequent data changes.
See DEPLOYMENT.md for port switching, source distribution and rollback instructions.
