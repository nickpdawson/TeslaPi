# TeslaPi codebase review findings

Date: 2026-08-05. Scope: full repo — backend (routers, services, main/config/database), frontend (components, hooks, api client, styles), deploy scripts, and the uncommitted diff in `backend/services/music_sync.py` + `backend/routers/music.py`. Method: five parallel review passes (backend routers, backend services, frontend code, UX/UI, deploy/ops) plus a direct review of the working-tree diff. Every critical and high finding below was verified against source; line numbers reference the current working tree.

## Executive summary

The most dangerous problems cluster in three areas:

1. **Filesystem-corruption paths around the USB gadget.** The deploy scripts manage `usb_gadget/teslapi` while the inherited teslausb scripts manage `usb_gadget/teslausb`, and the backend calls both families. On a Pi that went through upstream teslausb setup, "disable gadget" is a no-op and TeslaPi mounts images the car is still writing. Several backend paths (selective-sync stall, `delete_local_music`) can also leave an image mounted RW when the gadget re-enables.
2. **Security.** No authentication on any endpoint (one port is WAN-forwarded in the current install), a path traversal in the SPA catch-all that serves arbitrary files, a traversal in music delete that can `rmtree` the NAS share, and root shell injection via WiFi SSID / config values / notification text.
3. **Frontend/backend contract drift.** Whole features are broken end-to-end because the API client and the routers disagree on shapes: the Files page, WireGuard config, delete/rename/mkdir, several settings toggles, and both "Test" buttons.

Also significant: web-triggered provisioning (`setup-teslapi.sh` run from inside `teslapi.service`) cannot work as shipped — errexit is suppressed, the read-only root is never remounted, `ProtectHome` blocks `/root`, and mounts are trapped in the service's private namespace — yet it reports success.

Counts: **9 critical, 20 high, 34 medium, 20 low** (after deduplication).

Status of the previously known bug list (`project_next_fixes.md` memory):
- Sync progress not updating — **mostly fixed** by the uncommitted diff (progress2 parsing works), residual causes remain (C7-related F5, F6 below).
- Gadget re-enable after full sync — **fixed** (finally block covers it), but see C1/C4 for new gaps.
- "Offline" in header — **fixed** (status polls on all pages).
- Storage card empty — **fixed** (backing-file fallback in status.py).
- Library "Load More" with filter — **still present**, in two forms (M-F3).

---

## Critical

### C1. Gadget name mismatch: deploy scripts vs inherited scripts can corrupt an in-use image
`deploy/teslapi-gadget-disable.sh:6` and `deploy/teslapi-gadget-enable.sh:16` manage `/sys/kernel/config/usb_gadget/teslapi`; `run/enable_gadget.sh:10`, `run/disable_gadget.sh:12`, and `run/archiveloop` manage `usb_gadget/teslausb`. The backend uses both: `music_sync.py:36-37` calls the deploy pair, `routers/gadget.py:64` calls the run pair. On a Pi provisioned by upstream teslausb (the README's primary path), the `teslausb` gadget is exported to the car; a lock-chime upload or music delete calls `teslapi-gadget-disable.sh`, which finds no `teslapi` gadget, prints "nothing to disable," exits 0 — and the backend then loop-mounts the image read-write while the car still has it over USB. Concurrent host+car writes corrupt the FAT/exFAT filesystem. Fix: one gadget name, one enable/disable implementation, and the disable script should fail loudly if any gadget still binds the UDC.

### C2. Path traversal in SPA catch-all serves arbitrary files
`backend/main.py:161-169`: `serve_spa` builds `file_path = _static_dir / full_path` from the raw URL path and returns it if `is_file()`, with no `resolve()`/containment check (every other file handler in the repo has one). A request with `../` segments (e.g. encoded, or `curl --path-as-is`) reads any file the service user can read — teslausb config with WiFi/share credentials, SSH keys — remotely and unauthenticated, including on the WAN-forwarded port. Fix: resolve and require `relative_to(_static_dir.resolve())` before serving.

### C3. Music delete path traversal can rmtree the NAS share
`backend/routers/music.py:508-517`: the containment guard is `target.startswith(os.path.realpath(mount_point))` — a bare string prefix. `/mnt/music_share` starts with `/mnt/music`, so `POST /api/music/local/delete {"path": "../music_share/SomeArtist"}` passes the check and `shutil.rmtree` deletes files off the mounted source share (same trick reaches `/mnt/archive`, which is RW). Fix: compare with `os.path.commonpath` or against `realpath(mount) + os.sep`.

### C4. Selective-sync stall leaves rsync alive and re-exports a RW-mounted image (new in uncommitted diff)
`backend/services/music_sync.py:644`: `_run_rsync` calls `_stream_rsync_progress`, which raises `_RsyncStalled` after 90 s of silence — but unlike `_run_rsync_full` there is no supervisor and no kill. A quiet delta pass over CIFS (nothing to transfer → no progress2 output) trips the stall; the exception propagates, the job is marked failed, rsync keeps running with files open, the `umount` in the finally fails EBUSY (return code ignored), and gadget-enable exports the still-mounted, still-being-written image to the car. Fix before committing the diff: kill+wait the process on stall in `_run_rsync`, and treat a stall during a no-transfer delta pass as non-fatal (or lengthen that timeout).

### C5. Files page is entirely broken against the real backend
`frontend/src/hooks/useFiles.ts:17` expects `{path, drive, entries, parent}` but `GET /files/{drive}/ls` returns a bare `list[FileEntry]` (`backend/routers/files.py:140`), so the browser never lists anything. Field names also disagree (`is_dir` vs `isDirectory`, `FileBrowser.tsx:69`). On top of that (`useFiles.ts:37-78`): delete sends `{paths: [...]}` where the backend needs `{path, confirm: true}` → 422 always; rename sends `dest` vs `dst` → 422 always; mkdir sends the folder name in a field the backend ignores → 409 "already exists" every time; upload puts `path` in the form body but the backend reads the query string → uploads always land in the drive root. Every file operation fails.

### C6. Saving settings overwrites real secrets with the mask literal
`backend/routers/config.py:19-35` masks sensitive values as `********` in `GET /config`; the settings forms prefill those masked values (e.g. `GeneralSettings.tsx:51` for the WiFi password) and Save PUTs them back verbatim — the write path has no mask filtering. Saving General settings replaces the real `WIFIPASS` with the literal `********`; same hazard for share passwords, HA token (`homeassistant.py:60-94`), MQTT and notification secrets. Fix: treat the mask sentinel (and unchanged masked fields) as "keep existing" on the server side.

### C7. Root shell injection via SSID and WireGuard config fields
`backend/services/wireguard_manager.py:233,306-311,361`: user-supplied fields (`peer_endpoint`, `address`, `dns`, keys, `home_ssid`) are f-string-interpolated into `bash -c "echo '{content}' | sudo tee ..."`. A single quote escapes the quoting into a root shell — a legitimate SSID like `Nick's WiFi` already breaks the feature; a hostile one executes commands. Worse, `HOME_SSID="{home_ssid}"` is written unescaped into a file the root NetworkManager dispatcher `source`s on every WiFi up/down — `$(...)` in an SSID runs as root recurringly. Combined with no auth (H1), this is remote root. Fix: write files from Python and install with `sudo cp`; never route user input through `bash -c`.

### C8. Web-triggered provisioning cannot work but reports success
`deploy/setup-teslapi.sh:967`: `if ! $step_fn; then` suppresses `set -e` inside every step function, so a step only "fails" if its final command fails — and every step ends with `write_progress`, which always succeeds. A failed `mkfs`/`mount` in step 5 is swallowed; step 6 then writes a 40 G image onto the SD rootfs. Compounding it: the script never remounts `/` read-write yet writes `/etc/modules`, `/etc/fstab`, `/root/bin`, and a systemd unit (all fail silently on the documented read-only root), and `teslapi.service:22` `ProtectHome=true` blocks `/root` and gives the service a private mount namespace, so mounts made during provisioning are invisible to nginx and `archiveloop`. Setup completes "successfully" on a half-configured system.

### C9. WireGuard can never be configured from the UI (case-mismatch on every field)
`frontend/src/hooks/useNetwork.ts:132` sends camelCase (`privateKey`, `peerEndpoint`, …) where `schemas.py:211-219` requires snake_case → 422 on every save. Related breakage: generated public key never displays (`WireGuardPanel.tsx:76` reads `publicKey`, backend returns `public_key`), auto-connect prefs silently reset (`onlyNonHome` vs `only_non_home`), and tunnel test renders "Latency: undefinedms" (`latencyMs` vs `{message, details}`).

---

## High

### H1. No authentication on any endpoint
No auth dependency or middleware anywhere (`backend/main.py`); `deploy/teslapi.nginx` has no `auth_basic` (upstream teslausb supported `WEB_USERNAME`/`WEB_PASSWORD`; `deploy/configure-web.sh` drops it), and `teslapi.service:11` binds uvicorn to `0.0.0.0:8080`, so nginx-level auth would be bypassable anyway. Unauthenticated callers can reboot (`system.py:66`), rmtree files (`files.py:296`), rewrite config including WiFi/share credentials (`config.py:45`), kill dashcam recording mid-drive (`gadget.py:54`), and trigger root-level updates. Fix: bind uvicorn to 127.0.0.1 and add an auth gate on state-changing endpoints.

### H2. Dashcam viewer cannot play anything the event list shows
`backend/routers/dashcam.py:193`: `/dashcam/events` lists from the `dashcam_archived_clips` DB (clips archived to the NAS, local copies typically gone; `/mnt/cam` is unmountable while the gadget is active), but `GET /dashcam/events/{id}` scans the local filesystem under `/mnt/cam/TeslaCam` → clicking any listed event 404s; `DashcamPage.tsx:26` swallows the error and the viewer stays blank.

### H3. "Sync New" is permanently broken — wrong column plus wrong-type comparison
`backend/routers/music.py:655` queries `WHERE modified_time > ?` but the column is `modified_at` (`database.py:24`) → `no such column` → 500 whenever a completed sync exists. Even renamed, `modified_at` is a REAL epoch and `completed_at` is ISO TEXT — in SQLite `REAL > TEXT` is always false, so it would then always report "no new files." Needs the column name and an epoch-vs-ISO-consistent comparison.

### H4. `delete_local_music` predates the new mount locking and races active syncs
`backend/routers/music.py:471-532`: takes neither `music_sync._image_mount_lock` nor checks `_active_sync`, and mounts without a mountpoint check. Deleting during a sync double-mounts the image, its umount pops only the top layer, and its finally re-enables the gadget while the sync's rsync is still writing — the exact corruption the uncommitted diff's lock was added to prevent. Needs the same job-id check + lock treatment as `/music/local`.

### H5. rsync stderr pipe is never drained during streaming (own finding from the diff review)
Both `_run_rsync_full` and `_run_rsync` spawn rsync with `stderr=PIPE` but only read it after exit; `_stream_rsync_progress` reads stdout only. If rsync emits sustained stderr (vanished-file warnings, CIFS I/O errors — exactly the flaky-share case the new supervisor targets), the ~64 KB pipe fills, rsync blocks on write, stdout goes silent, and the watchdog "detects" a stall → spurious kill/retry loop (full sync) or the C4 failure (selective). Read stderr concurrently or send it to a file/DEVNULL and use `--msgs2stderr` semantics deliberately.

### H6. Update/install restarts kill the process performing them; rollback is dead code
`backend/services/updater.py:392-420` runs `deploy/install.sh` (which runs `systemctl restart teslapi`) as a child of the service itself — systemd SIGTERMs the cgroup, killing installer and updater mid-run. The health check and auto-rollback below the restart never execute; a broken update never rolls back and status sticks at "installing/restarting." `MemoryMax=256M`/`CPUQuota=50%` (`teslapi.service:18-19`) also throttle `pip install` in that cgroup. Fix: detach via `systemd-run` (own scope) and let a survivor (startup hook) do health-check/rollback.

### H7. `/api/gadget/toggle` calls scripts that are never installed
`backend/routers/gadget.py:64` runs relative `run/enable_gadget.sh` / `run/disable_gadget.sh` from cwd `/opt/teslapi`, but neither `deploy/build.sh` nor `deploy/install.sh` ships `run/` there — the endpoint fails 100% of the time on a real install (and if present would build the *teslausb* gadget, clashing with C1).

### H8. `setup-teslapi.sh` enables a service pointing at a binary it never installed
`deploy/setup-teslapi.sh:657-751`: the helper copy resolves `source_dir` to `/opt/teslapi/run` (never created by install.sh) and every copy is `[[ -f ]]`-guarded, so `archiveloop`, `mountimage`, `envsetup.sh` are silently skipped — yet step 9 still writes and enables `teslausb.service` with `ExecStart=/root/bin/archiveloop`. Boot-time failing unit forever; also unconditionally overwrites upstream's unit on an existing teslausb install.

### H9. Provisioning can wipe the wrong disk with no confirmation
`deploy/setup-teslapi.sh:396-418`: if partitions on `DATA_DRIVE` (default `/dev/sda`, line 36) aren't labeled exactly `mutable`/`backingfiles`, the script `wipefs -a` + `sgdisk --zap-all` and repartitions. Any other USB disk that enumerates first is destroyed. The UI side compounds it: the wizard's "Complete Setup" starts the wipe with only a passive warning banner, no confirmation naming the target drive (`StorageStep.tsx:306-315`), while lesser destructive actions all get confirm modals.

### H10. No crash/restart recovery for syncs — gadget stays down, job stuck "running"
`backend/services/music_sync.py:99`: `_run_sync` is a bare `create_task`. If the service restarts mid-sync (deploy, updater, OOM, power), the gadget stays disabled, the image stays mounted, and the DB job shows "running" forever; the in-memory guard resets so a new sync can start over the stale mount. Startup should fail orphaned "running" jobs and re-run gadget-enable. Related: `deploy/teslapi-gadget-enable.sh:18-21` exits 0 without rebinding UDC when the gadget dir already exists, so after a partial enable failure the drive stays invisible to the car until manual configfs teardown (also M-D2).

### H11. Uploads buffered fully into RAM before (or without) size checks
`backend/routers/customization.py:84-89` reads the whole upload then checks the 10 MB cap; `backend/routers/updates.py:46-50` reads with no cap at all. One multi-GB unauthenticated POST OOMs a 2-4 GB Pi. (`files.py:203` streams correctly — copy that pattern.) Also `updater.py:469` joins the raw client filename into `UPDATE_DIR` — `../`-bearing filenames write arbitrary paths as root; sanitize with `basename`.

### H12. Root shell injection via config values and notification text
`backend/services/config_manager.py:37-38`: `_quote` detects backticks but doesn't escape them; any API-settable value containing `` `cmd` `` executes as root when `teslausb_setup_variables.conf` is next sourced. `backend/services/notification_service.py:167-180` builds `bash -c` with unquoted channel config and interpolated title/message — sync-failure notifications embed raw rsync stderr, so remote-share-controlled text can reach a root shell. Use exec-style subprocess with `env=` dicts.

### H13. Setup wizard races provisioning and swallows completion failures
`SetupWizard.tsx:120-148` + `FinishStep.tsx:54-59`: on POST resolve the wizard replaces the "takes several minutes" ProvisionProgress screen with "Setup Complete" and redirects to the dashboard after 2 s — while the drive is still being partitioned, with no way back (revisiting `/setup` restarts at step 1). And the catch block for `POST /setup/complete` marks setup complete anyway, so a failed config write still shows success. Paired with C8, a user can watch three green checkmarks on a Pi where nothing worked.

### H14. Touch users cannot open folders in the file browser
`FileBrowser.tsx:68-77` + `FileList.tsx:53-58`: entering a folder requires double-click (`e.detail === 2`); single tap only selects. The tree sidebar — the only other way down — is hidden below 768 px (`files.css:262`). On the Tesla touchscreen and phones, the primary navigation gesture doesn't exist.

### H15. Major pages unreachable; wizard quick links are dead
`Shell.tsx:69-88`: no persistent nav to Dashcam, Music, or Files — Dashcam/Music are reachable only via dashboard cards and `/files` has no entry point anywhere in the UI. `FinishStep.tsx:198-218`: the three "Set up Home Assistant / notifications / WireGuard" links all `preventDefault()` and go nowhere.

### H16. Music actions fail silently — error state exists but is never rendered
`hooks/useMusic.ts:23` collects every failure into `error`, and no component renders it. "Sync Everything," "Sync New," "Re-index," delete, and browse failures produce no feedback; on a car screen users will tap repeatedly assuming the touch missed.

### H17. Dashcam viewer pane hidden/unstyled on desktop
`DashcamPage.tsx:60`: the viewer wrapper gets inline `display:none` whenever `mobileTab !== 'viewer'` at all widths, and when active its class is `''` (loses `dashcam-main` / `flex:1`). Desktop first-load is a sidebar next to a blank void; after selecting an event the viewer renders in an unstyled block. Should be `class={"dashcam-main" + (mobileTab !== 'viewer' ? ' hidden-mobile' : '')}` with no inline style.

### H18. Navigating to Music mid-sync shows a frozen progress panel
`MusicPage.tsx:50`: only `fetchSyncStatus()` runs on mount; polling starts only from the startSync* actions. Arriving while a sync runs shows a snapshot that never updates and never detects completion, locking LibraryTab in the "Syncing Music" view. Start polling whenever fetched status is running/pending.

### H19. Selective-sync path mismatch defeats totals and pre-computed file lists
`LibraryTab.tsx:129` strips the leading `/` from paths before `POST /music/sync`, but indexed DB paths store a leading `/` (`music_index.py:128`) — the `LIKE` matches nothing, the job gets `files_total=0/bytes_total=0`, and the file list falls back to a slow full share re-scan. The queue path keeps the slash and works; the two callers disagree.

### H20. Sync-status progress totals reset on stall retry (own finding from the diff review)
`music_sync.py` `_run_rsync_full`: when `_stream_rsync_progress` raises `_RsyncStalled`, the `_, cumulative_bytes = await ...` assignment never completes, so bytes transferred during the aborted attempt are dropped from the offset and the UI's byte counter jumps backward on the next attempt. Return progress via the exception or track it in a mutable holder.

---

## Medium

### Backend

- **M-B1. Browse idle-unmount yanks the share out from under a running sync.** `routers/music.py:81-91` + `share_browser.py:141`: the 5-minute idle unmount task doesn't check `_active_sync`, and `unmount_share` falls back to `umount -l`. Selective sync fails outright; full sync churns stall/remount cycles. Skip while a sync job is active.
- **M-B2. Check-then-set race allows two concurrent syncs/archives.** `music_sync.py:55/95`, `dashcam_archive.py:75/91`: the `job_id is not None` guard and the assignment are separated by awaited DB calls, so two POSTs both pass — double gadget-disable, two rsyncs into one image. Claim the slot synchronously before the first await.
- **M-B3. Transient index errors purge artists from the library.** `music_index.py:139-141,197-203`: artists whose walk raised OSError are "skipped" but their files still land in the stale-delete set — a CIFS hiccup during indexing silently deletes those artists from the index. Skip the delete phase when `skipped > 0`.
- **M-B4. Cancelling a selective sync reports "failed (exit -9)".** `music_sync.py:415-420,647`: cancel kills rsync; the reader hits EOF before the cancelled check and `_run_rsync` raises on rc −9. Check `_active_sync["cancelled"]` before the returncode check.
- **M-B5. rsync exit 23 still marks all files synced.** `music_sync.py:216-222`: after a tolerated partial transfer, every path in `file_list` is set `synced=1` — failed files are permanently excluded from future selective passes.
- **M-B6. Credentials visible in `ps` and debug logs.** `network_manager.py:249` passes the WiFi PSK as an nmcli argv; `script_runner.py:63` debug-logs full command lines; the WG private key rides in a `bash -c` string (`wireguard_manager.py:233`).
- **M-B7. Event-loop blocking.** `updater.py:255-268,293-304` do synchronous `rmtree`/`copytree` of the whole app; `pi_setup.py:360-431` makes six synchronous `subprocess.run` calls (up to 5 s each); `dashcam.py:401-411` streams video via a synchronous generator doing blocking reads. All stall every concurrent request on the single loop; use executors/aiofiles/async subprocess.
- **M-B8. HA/notification configs share the C6 mask round-trip.** `homeassistant.py:60-94` and `notifications.py` upsert: GET masks token/password, PUT persists the body verbatim — editing the URL breaks the saved token.

### Deploy / ops

- **M-D1. Service can start before `/mutable` mounts and write the DB to the rootfs.** `teslapi.service` has no `RequiresMountsFor=/mutable`; the fstab entries are `nofail` — stale/shadowed DB or read-only crash-loop. Same pattern at install time: `install.sh:68-78` takes the bare-directory branch and creates `/mutable/teslapi` on the rootfs, which the exit trap then remounts read-only → backend 500s; the `/var/lib/teslapi` fallback is unreachable in exactly the case it targets.
- **M-D2. Failed gadget activation wedges permanently.** `teslapi-gadget-enable.sh:18-21,77`: if `echo $UDC > UDC` fails (EBUSY from the other gadget, per C1), the dir is left configured-but-unbound and every later enable early-outs on `[ -d "$GADGET" ]` — drive never re-presented until manual teardown.
- **M-D3. Read-only-root detection matches `errors=remount-ro`.** `install.sh:35` (also `update.sh:32`, `rollback.sh:41`): `grep -q 'ro,\|ro)'` matches the Debian-default `…errors=remount-ro)` — the exit trap then remounts a normally-RW root read-only, breaking the running system.
- **M-D4. Failed nginx switch leaves the web UI down.** `install.sh:135-151`: by the time `nginx -t` fails, the upstream `sites-enabled/default` symlink is deleted; the "restore" never re-creates it nor restarts nginx.
- **M-D5. Three divergent update/rollback implementations.** `updater.py`, `deploy/update.sh` (never called despite its header), `deploy/rollback.sh`. `update.sh` deletes the previous good backup before validating the new tarball and its rollback never restarts services. Pick one path, delete the rest.
- **M-D6. `99-wireguard-teslapi` never installed; a divergent copy is generated at runtime.** `wireguard_manager.py:320-360` writes its own inline dispatcher (already drifted from the shipped file), via `sudo tee` that fails on a read-only root with no remount.
- **M-D7. `configure-web.sh` has no error handling and a wrong path.** No `set -e`; a failed release download still enables services that were never installed, and the pre-baked-image branch checks `/opt/teslapi/teslapi.nginx`, a path install.sh never creates — nginx is never switched on a pre-baked image.

### Frontend / contract

- **M-F1. Archive/sync status never surfaces.** `useStatus.ts:63` reads `archive.status`/`music.status`, fields the backend models don't have (`schemas.py:59-73`); the top-level `state` the backend does send is ignored. StatusBar never shows "Archiving…"; StatusHero never animates or shows error/unreachable. Related backend gap: `status.py:379-389` only ever returns ARCHIVING/SYNCING/IDLE though the schema defines CONNECTED/ERROR/OFFLINE.
- **M-F2. WiFi UI case-mismatch.** `useNetwork.ts:91,110`: `autoConnect` vs `auto_connect` (unchecking silently ignored); scan/connection lists consumed raw so `in_use`/`ip_address` render as undefined — the in-use marker never shows, IP is blank.
- **M-F3. Library "Load More" broken with filters (known bug c, still present).** `LibraryTab.tsx:102`: Load More omits the filter arg → appends unfiltered entries to filtered results and resets `hasMore` from the unfiltered total; 1-char client-side filters keep stale `hasMore` so the button shows when everything is displayed.
- **M-F4. `navigatingRef` is not a ref.** `LibraryTab.tsx:93`: plain object recreated each render, so the navigation guard never works — clicking into a folder can snap back to the previous directory when the stale fetch resolves last; the `[filter]` effect also duplicates the mount fetch.
- **M-F5. Auto-update toggle can't load its state.** `SystemSettings.tsx:78` GETs `/updates/auto-check`; the backend only defines PUT → 405 every time.
- **M-F6. Both "Test" buttons hit nonexistent endpoints.** `NotifySettings.tsx:90` and `HASettings.tsx:42` POST `/config/test-notification` / `/config/test-ha`; the real endpoints are `/notifications/test/{channel_id}` and `/ha/test`.
- **M-F7. Multi-clip dashcam playback stalls and desyncs.** `useDashcamPlayback.ts:127-144,266-283`: the 500 ms sync interval captures `currentClipIndex` at play() time (timeline jumps backward after auto-advance), and the `ended` handler advances the clip but never plays the new videos — playback stalls at every clip boundary with `playing` still true.
- **M-F8. Timeline can't be scrubbed by touch.** `Timeline.tsx:65`: touchstart-only tap-to-seek; no touchmove/touchend drag on the two primary target devices.
- **M-F9. Music capacity hardcoded to 1.7 TB.** `OnTeslaTab.tsx:150`: the setup default is 20 G; the storage bar reads ~0% forever and hides a genuinely full music drive. Real size is available from `/status` storage.
- **M-F10. Indexing poll leaks past unmount.** `useMusic.ts:286-299`: the poll re-arms via an unstored `setTimeout` the cleanup can't cancel; leaving the Music page during indexing keeps a 1 s poll chain running. Smaller variant re-arms `syncPollRef` after cleanup.
- **M-F11. Notification channels duplicate on save.** `Settings.tsx:125-149,205-216`: channels are parsed from `NOTIFY_<ID>_*` keys but saved as `NOTIFY_<index>_*` without deleting the old keys — every save re-keys and stale keys resurface as duplicate channels.

### UX

- **M-U1. Offline dashboard shows fabricated data.** `Dashboard.tsx:17-55,102`: on backend failure it renders `mockStatus` (847 artists, fake sentry events, "your-nas.local" healthy) behind a small banner while the StatusBar says Offline. For a public release, show an offline state; gate demo data behind a flag.
- **M-U2. Modal accessibility.** `Modal.tsx:35-53`: no `role="dialog"`, `aria-modal`, or focus trap; confirm button stays tappable while the action is pending (double-fire — e.g. OnTeslaTab delete). `AddWiFiModal.tsx:71` reimplements the overlay and has already drifted (no Escape, no scroll lock, setState-during-render prefill).
- **M-U3. Undefined CSS variables break lock-chime feedback.** `LockChimeSettings.tsx:162,205-210,244` uses `--color-surface-raised`/`--color-primary`/`--color-primary-glow`, none defined (system uses `--color-bg-raised`/`--color-accent`) — the upload progress fill is invisible, so uploads look hung. Same class of issue: `btn--xs`/`btn--accent` used but defined nowhere (`LibraryTab.tsx:218`, `RandomMode.tsx:135`).
- **M-U4. music.css violates the project's own no-`gap` rule.** `global.css:1-4` declares "Tesla browser safe (no CSS gap)" and layout code uses margin fallbacks, but music.css uses flex/grid `gap:` in ~15 rules — on the older Tesla Chromium that motivated the rule, that spacing collapses to zero.
- **M-U5. Contrast failures in both themes.** `global.css:83,166`: dark muted `#64748b` on `#0a0e17` ≈ 3.8:1 at 12 px (AA needs 4.5:1); light muted `#94a3b8` on `#f8fafc` ≈ 2.6:1 — help text barely legible in a car in daylight.
- **M-U6. Touch targets under 44 px throughout.** Despite the global rule: 32 px WiFi action buttons (`network.css:305`), 32 px artist delete/expand (`music.css:172,213`) — mis-taps delete music; 28 px search-clear/queue-remove/audio-close; 20 px upload cancel (`files.css:692`); 36×24 layout options (`dashcam.css:532`).
- **M-U7. Mobile dashcam layouts lose cameras.** `dashcam.css:717-729`: grid-2x3/3x2 collapse to one column inside a fixed-height `overflow:hidden` container (cameras cropped out); front-focus hides the thumbnail row that was the only camera-switch affordance.
- **M-U8. Error states without recovery.** `EventList.tsx:112-114` renders a bare error line with no retry; no page offers a refresh affordance for stale lists (WiFiScanner aside). "Cancel upload" (`FileBrowser.tsx:368` + `UploadOverlay.tsx:50`) only flips local state — the XHR keeps uploading and the file appears anyway.

---

## Low

- **L1. Archive step-4/step-5 layout mismatch.** `dashcam_archive.py:152-176`: creates `TeslaCam/{SavedClips,SentryClips}` on the archive but copies into `ARCHIVE_MOUNT/{event_type}` — one of the two layouts is unintended; empty dirs accumulate.
- **L2. Archive cancel is a no-op mid-clip.** `dashcam_archive.py:178-185`: `_active_archive["process"]` is never assigned, so cancel only takes effect between clips (up to 300 s).
- **L3. `_share_responsive` leaks D-state stat processes.** `music_sync.py:470-475`: kills without awaiting; a wedged-CIFS stat ignores SIGKILL — one leaked process per 10 s poll during an outage.
- **L4. WG tunnel test pings the wrong host.** `wireguard_manager.py:519-524`: rewrites the third octet to `.1` (`192.168.7.0/24` → pings `192.168.1.1`) — false negatives. Also `ha_client.py:71` uses the paho-mqtt 1.x constructor, which raises on 2.x (caught, MQTT silently disabled).
- **L5. Dashcam type filter dead values.** `dashcam.py:289-294` + `EventList.tsx:19-25`: `recent`/`track` pass through unmapped and the DB only holds SentryClips/SavedClips — those filter buttons always show "No events found."
- **L6. `/music/local` `syncing` flag ignored.** `routers/music.py` (uncommitted diff) returns `{artists: [], syncing: true}` mid-sync; `LocalMusicData` (`types.ts:289`) lacks the field and OnTeslaTab shows "No music on your Tesla yet." Also stylistic: the router reaches into `music_sync._active_sync`/`_image_mount_lock` privates — export a small public API instead.
- **L7. Duplicate/uncontrolled status polling.** `Shell.tsx:57` + `Dashboard.tsx:99` each run `useStatus()` (two 5 s loops on the dashboard); a visibilitychange resume during an in-flight initial fetch spawns a second timer chain.
- **L8. Dead code to delete or revive before release.** BrowseMode/RandomMode/RecentMode/LibraryBrowser/SearchBar/SyncQueue never mounted (~700 lines of styles ship anyway, music.css:728 admits it); most of useMusic's surface unused; `ReconnectingWebSocket` never imported; `MusicSyncStatus.progress` never populated (MusicCard fallback dead); `deploy/update.sh` uncalled; `setup-teslapi.sh:191-199` `max_power_for_model` dead while MaxPower is hardcoded 250 mA (upstream uses 500 for Pi 4).
- **L9. Invented storage fields.** `useStatus.ts:43-51`: `drive` falls back to mount_point (StorageCard's external-drive branch dead), `filesystem` always empty, `healthy` always true.
- **L10. File browser rough edges.** Native `confirm()` for delete vs Modal everywhere else; global Backspace-to-delete when the list has focus (`FileBrowser.tsx:90`); `isMobile` computed once with no resize listener (`FileBrowser.tsx:192`); FileTree never resets `loaded` on drive switch — Music tree shown for Lightshow/Boombox (`FileTree.tsx:24-36`).
- **L11. A11y/motion gaps.** No `prefers-reduced-motion` handling (StatusHero ring pulses permanently, even idle); Toggle has no visible `:focus-visible` indicator (`settings.css:154-160`).
- **L12. Page height math off.** `dashcam.css:9`/`files.css:9` use `calc(100vh - 60px)` against a 56/64 px header — 4-8 px overflow or gap.
- **L13. No 404 route.** `app.tsx:49-57`: unknown paths render the shell with an empty main area.
- **L14. Network page auto-scans WiFi every 30 s.** `useNetwork.ts:184-187`: nmcli scans can briefly degrade the Pi's own link — the link the user is on that page to debug.
- **L15. nginx `Connection "upgrade"` hardcoded for all `/api/` requests.** `deploy/teslapi.nginx:34-35`: use the standard `map $http_upgrade` — bogus Connection header breaks keepalive on plain requests.
- **L16. `setup-teslapi.sh` parsing gaps.** `size_to_bytes` (163-172) errors on `1T` and treats `500K` as GB; partition-suffix logic (379-385) handles `nvme` but not `mmcblk` (`p1`).
- **L17. Dispatcher SSID detection is wrong-field.** `deploy/99-wireguard-teslapi:45`: `GENERAL.CONNECTION` is the NM profile name, not the SSID; duplicate profiles or colons in names break home detection (WG comes up at home).
- **L18. Over-broad exception handling masks bugs.** `status.py:408`: `except (json.JSONDecodeError, Exception)` swallows Pydantic validation errors as parse warnings.
- **L19. Trapped mounts also break nginx file serving.** Consequence of C8/`ProtectHome`: any mount made inside the service namespace (music image, `/mnt/cam`) is invisible to nginx and SSH — matches the observed private-namespace behavior on the real Pi.
- **L20. Wizard/config drift.** `SystemSettings`/wizard write config the backend re-derives differently in places (e.g. tier defaults); worth one pass reconciling `teslausb_setup_variables.conf` keys the UI writes vs what `setup-teslapi.sh` and upstream scripts actually read.

---

## Suggested fix order

1. **Before committing the current diff:** C4 (stall-kill in `_run_rsync`), H5 (drain stderr), H4 (lock `delete_local_music`), H20 (retain bytes on retry), L6 (`syncing` flag in frontend type).
2. **Security batch (pre-any-public exposure):** C2, C3, C7, H1, H11, H12, M-B6.
3. **Make core features actually work:** C5 (files API), C9/M-F2 (network contracts), H2 (dashcam event source), H3 ("Sync New"), M-F5/M-F6, C6/M-B8 (mask round-trip).
4. **Gadget/provisioning integrity:** C1 (unify gadget), H7/H8, C8 (errexit + rw remount + namespace), H6 (detached updates), H9 (wipe confirmation), M-D1/M-D2.
5. **UX pass:** H13-H18, M-U1-M-U8, then the low list.

## What's in good shape

Worth keeping as-is: the path-containment guards in `files.py` (`_resolve_safe_path`), dashcam video serving, and share browsing; the new `_image_mount_lock` protocol between `/music/local` and `_run_sync` (correct double-check under lock); the progress2 parsing rewrite (fixes the old 0/N display bug); skeleton loaders on Dashboard/Network/Settings; the two-tap Confirm Cancel in SyncProgress; per-field help text across settings forms; `@media (hover: hover)` guards; aria-labels on playback controls.
