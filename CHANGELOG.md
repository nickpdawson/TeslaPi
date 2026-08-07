# Changelog

## v0.3.0 — App auth, archived-clip playback, security hardening

Builds on v0.2.0 with a login gate, watchable archived dashcam footage, and another
round of security hardening. All changes are unit-tested and verified on real
hardware; the whole suite (141 tests) and CI are green.

### Added

- **App authentication (opt-in login gate).** Set a password under **Settings →
  Security** to require sign-in for the whole app. Hashed storage (pbkdf2), stateless
  signed session cookies, a login screen, and set/change/disable controls. Dormant
  until you set a password, so existing installs are unaffected until you opt in.
- **Archived dashcam clip playback.** Previously every archived event 404'd in the
  viewer because playback read the cam image (unmounted while the car owns the USB
  drive). Clips now stream from the NAS archive share (read-only, on demand) with HTTP
  Range seeking — all archived footage is watchable again.

### Security

- The API now binds to `127.0.0.1` only — nginx is the sole public listener. It was
  reachable directly on `:8080` from anywhere on the network, bypassing the front door.
- Locked the local-music delete path against traversal (a crafted `../` path could have
  deleted the NAS source share); added regression tests.

### Fixed

- Dashcam archive wrote clips to the share root but pre-created a mismatched
  `TeslaCam/` directory tree — removed the dead path and pinned the layout.
- Re-indexing the music library now provably prunes files removed from the share and
  resets changed files for re-sync (so a source reorg/de-dupe indexes cleanly); fixed a
  dev-mode-only crash in the mock indexer.
- CI: the frontend job ran on Node 20, too old for the test runner, so it failed to
  execute; bumped to Node 22.

### Tests

- 102 backend + 39 frontend = **141 tests**, including an API contract-drift guard
  (frontend paths must resolve to real backend routes) and coverage of the rsync
  progress/retry accounting.

### Upgrade notes

Your data on `/mutable/teslapi/` persists. See the [Updating section of the
README](README.md#updating). Nothing changes in behavior until you opt into auth via
Settings → Security. Same known limitations as v0.2.0 apply for the not-yet-done items
(provisioning from a bare SD card, OTA restart/rollback, privilege separation).

## v0.2.0 — Sync reliability & data-safety hardening

This release fixes the root cause of syncs silently stalling, hardens the
gadget/mount lifecycle against filesystem corruption, and adds a real automated
test suite (117 tests). All fixes were verified on live hardware.

### Fixed — music/video sync reliability

- **Orphaned syncs no longer pin the dashboard on "syncing" forever.** A sync
  interrupted by a crash or restart was left `status='running'` in the database with
  no process behind it, so the UI reported "syncing" indefinitely and masked that the
  drive was idle. Startup reconciliation now marks orphaned running/pending jobs as
  `interrupted`. This was the root cause behind "nothing has synced in months."
- **rsync partial transfers (exit 23/24) are no longer recorded as success.** They're
  modeled as `partial`, files are only marked synced when actually transferred, and the
  gaps retry on the next sync instead of being skipped forever.
- **Progress counter no longer exceeds 100%.** `files_copied` is pinned to the real
  transferred-file count (rsync's live counter also counts the directories it creates).
- Resilient rsync supervision: stall detection, cumulative-byte accounting across
  retries, a classified exit-code retry policy, and CIFS remount on network failures.

### Fixed — data safety (gadget & filesystem)

- **Gadget disable now fails loudly if the USB controller won't unbind**, and a sync
  aborts before mounting the backing image rather than risking two writers on one FAT
  filesystem (drive corruption). Verified on hardware.
- **`/api/gadget/toggle` works again.** It previously called scripts that were never
  installed (failed 100% on a real device); it now uses the same proven, installed
  gadget scripts as the sync path.
- **The idle share-unmount no longer races an active sync** — it can no longer
  lazy-detach the source share out from under a running rsync.
- The image-release gate before re-enabling the gadget fails safe (never re-presents a
  still-mounted read-write image to the car).

### Fixed — status & API correctness

- Truthful system state (real CPU/temp/RAM; no more stale or invented status).
- Datetime fields (`last_archive_at`, `last_sync_at`, dashcam event timestamps) are
  serialized correctly; one of these would previously crash the Home Assistant push
  loop once an archive had completed.
- Version reporting is now proper semver end-to-end (`pyproject` → `VERSION` →
  `/api/health` → in-app updater), so update detection works.

### Added

- Automated test suite: **81 backend + 36 frontend = 117 tests**, including
  subprocess-level coverage of the gadget-disable safety contract.
- Custom Tesla lock-chime upload; dashcam events grouped into events with camera counts.

### Upgrade notes

No action needed for your data — `/mutable/teslapi/` persists across updates. See the
[Updating section of the README](README.md#updating) for the three upgrade paths
(in-app updater, `deploy-to-pi.sh`, or manual `update.sh`). Updates only restart
`teslapi.service` and `nginx`; dashcam recording and the car's drives are never
interrupted.

If your music library was reorganized on the source share after it was last indexed,
re-index from **Music → Reindex** before syncing so the library paths match the share.

### Known limitations

- App authentication is not yet implemented — keep the UI on a trusted network / behind
  WireGuard.
- First-run provisioning from a bare SD card (`setup-teslapi.sh`) still has rough edges;
  the tested path is deploying onto a working teslausb Pi.
- Dashcam archive lifecycle cleanup (cancellation, `delete_after`, NFS share type) is
  still in progress.
