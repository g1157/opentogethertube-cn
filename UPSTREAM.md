This instance is based on the official OpenTogetherTube `v0.15.0` release:
https://github.com/dyc3/opentogethertube/releases/tag/v0.15.0

The upstream release tag still contains `0.14.1` in its workspace package.json files.
The release tag, local Git history, and container image label identify this deployment.
The current local branch/image version is `v0.15.0-cn10`; per-version notes live in
`docs/version-notes.zh-CN.md`.

cn4 selectively ports the official visual overhaul (#2031) from master commit
`4ea9029429a98561ba7c213c54c55ef0f0c56800`: colors, typography, home page, navigation
and room cards. This preserves the cn1–cn3 behavior and is not a wholesale update
of the project to the development branch.
https://github.com/dyc3/opentogethertube/pull/2031

Local changes add permanent queue checkpoints, automatic pause when the last viewer
leaves, automatic restoration, saved room listings, simplified Chinese as the default,
separate cookie names for the parallel instance, and WebSocket input validation.
Player fullscreen now targets the video and its controls, locks background scrolling,
and restores the previous page position when leaving fullscreen.

cn3 migrates an existing browser's locale to Simplified Chinese once, preserving other
settings and allowing later language changes. It also checks the server revision and
reloads outdated clients while deferring during text input and guarding against loops.
HTML, source archives and the version endpoint are not cached; hashed assets retain
long-lived caching. Tabs already running cn2 or earlier need one manual refresh or
reopen before the new update checks can run.

Each release is first verified on independent port 18080, then the same verified image
is promoted to port 8080 without rebuilding it.
Keep the previous application's image, configuration and separate data volumes for
rollback; the two instances do not automatically merge subsequent data changes.
See DEPLOYMENT.md for port switching, source distribution and rollback instructions.
