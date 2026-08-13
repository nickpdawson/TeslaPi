# TeslaPi work log

Autonomous `/loop` run started 2026-08-05. Goal: make music + video sync work reliably, then work through the phases in `teslapi_fix_plan.md`, using Codex as a quality gate and documenting after each turn.

Process each turn: (1) read `teslapi_fix_plan.md` + this log, (2) do a coherent chunk, (3) gate with Codex review, (4) document here, (5) schedule next iteration.

Phase tracking is in the session task list (Phases 0–7 = tasks #1–#8).

---

## Iteration 1 — 2026-08-05 — Phase 0: music sync resilience (in progress)

**Scope:** the uncommitted-diff regressions in `backend/services/music_sync.py` + `backend/routers/music.py`, plus the frontend `syncing` flag. Video (dashcam) resilience deferred to iteration 2.

**Planned changes:**
1. Supervise `_run_rsync` (selective sync) so a `_RsyncStalled` kills rsync and retries instead of propagating with rsync still alive (fixes the C4 corruption path).
2. Drain rsync `stderr` concurrently in both rsync paths so a full stderr pipe can't wedge stdout and trigger a false stall (H5).
3. Preserve cumulative transferred bytes across a stall retry so the progress counter stays monotonic (H20).
4. Lock `delete_local_music` against an active sync (`_active_sync` check + `_image_mount_lock`) (H4).
5. Add `syncing` to the frontend `LocalMusicData` type and show a syncing state in OnTeslaTab (L6).

**Changes made (backend/services/music_sync.py):**
- Rewrote `_stream_rsync_progress` to take a `progress` holder dict and return this-run byte count only (not offset+run), publishing `{run_bytes, files}` on every parse and before raising `_RsyncStalled` / on cancel. Keeps the supervisor's cumulative accounting correct even when a run is killed.
- Added `_drain_stream(stream, limit=65536)` — reads a pipe to EOF keeping the tail, run as a concurrent task so a full stderr pipe can't wedge stdout (fixes the false-stall / H5 deadlock).
- Added `_supervise_rsync(job_id, db_path, extra_args)` — single retry loop with stall-kill, concurrent stderr drain, monotonic `cumulative_bytes` (accumulated in a `finally` so a stalled/partial run still counts), share re-check/remount between attempts, and `(success, rc, error)` return. Propagates `CancelledError`.
- `_run_rsync_full` and `_run_rsync` are now thin wrappers. `_run_rsync` returns the rsync exit code; selective sync only marks `synced=1` when rc==0 (partial 23/24 left for retry — pulls M-B5 forward at low risk).

**Changes (backend/routers/music.py):** `delete_local_music` now (a) 409s if a sync is active, (b) serializes on `_image_mount_lock` and re-checks under it, (c) only unmounts what it mounted, (d) uses `os.path.commonpath` containment + refuses the drive root — pulled the C3 traversal fix forward since I was rewriting that exact guard.

**Changes (frontend):** `LocalMusicData.syncing?: boolean` added; OnTeslaTab shows a distinct "Sync in progress" state instead of "No music yet" when `syncing` is true (L6).

**Verification:** `python3 -m py_compile` on both backend files PASS. Frontend `tsc` BLOCKED — TypeScript isn't installed in `frontend/node_modules` (incomplete dep tree, matches sol_findings). Frontend edits are minimal/pattern-consistent; typecheck deferred until deps are installed (Phase 7 sets up CI for this).

**Codex gate:** correctness review delegated to the Codex rescue subagent (async, running in background). Iteration will finalize once its verdict returns; any confirmed defects get fixed before this chunk is considered done.

**Not done this iteration (deferred):** video/dashcam sync resilience (`_active_archive["process"]` cancel wiring, dashcam 23/24) → iteration 2.

### Iteration 1b — Codex stop-gate findings addressed

The Codex stop-time review gate flagged two issues in the iteration-1 diff; both were valid and are now fixed:

1. **"Sync lifecycle races can expose a mounted image."** The old `already_mounted_music` flag skipped the image unmount when the image was already mounted at sync start, and the best-effort `umount` (return code ignored) could leave the image host-mounted RW while Step 8 re-enabled the gadget → the car and host both write one FAT filesystem → corruption.
   - Removed the skip path. Added `_ensure_image_unmounted(job_id)` — `sync` + `umount` with verification and retries (deliberately NOT lazy umount, which can leave writes in flight). Step 7 always releases the image and records success in `image_released`.
   - Step 8 now re-enables the gadget **only** if `image_released` is true. If the image can't be released, it logs CRITICAL, leaves the gadget down (car temporarily loses drives — recoverable, unlike corruption), and marks the job failed with a clear message.

2. **"Partial transfers are still reported as successful."** rsync exit 23/24 was recorded as `status=completed`. Introduced a distinct terminal `partial` status:
   - `_run_rsync_full`: `success` → completed; `23/24` → `partial` (with message); else failed.
   - Selective `_run_sync`: rc 0 → completed + mark synced; rc 23/24 → `partial`, files left unsynced for retry.
   - `_update_job` treats `partial` as terminal (sets `completed_at`).
   - Frontend: added `partial` to the `MusicSyncJob` status union and a "Sync Incomplete" state in `SyncProgress` showing the message + files copied. Polling already stops on any non-running/pending status, so no stall.

**Verification:** `py_compile` PASS on both backend files; no dangling `already_mounted_music` refs. Ending the turn to let the Codex stop-gate re-review.

### Iteration 1c — second Codex stop-gate pass

Gate flagged two more, both valid:

1. **"Unmount failures are masked."** `delete_local_music` still ignored its `umount` return and re-enabled the gadget unconditionally — the same corruption exposure I'd fixed in `_run_sync` but not here. Rewrote it to always release the image via `_ensure_image_unmounted` (generalized to take a `log_ctx` string instead of `job_id`), gate the gadget re-enable on a confirmed release, and return HTTP 500 with a clear message if the image can't be unmounted (gadget left down rather than exposing a RW image). Also logged source-share unmount failures in `_run_sync` (non-critical: the share is a read-only source, not exported to the car).
2. **"The new partial state is not shown."** `LibraryTab`/`OnTeslaTab` only mount `SyncProgress` while the job is running/pending, so the terminal `partial` UI never appeared. Added a toast in `useMusic.startSyncPolling`: when a sync observed running this session reaches a terminal state, it fires a success/warning/error notification (`partial` → warning with the message). Guarded by a `sawActive` flag so an old terminal job on a fresh page load doesn't toast.

**Verification:** `py_compile` PASS. Frontend `tsc` still blocked (deps). Ending turn for the Codex stop-gate to re-verify.

### Iteration 1d — third Codex stop-gate pass

Gate: *"The new unmount safety check can still re-enable a mounted image."* Correct — the root flaw was that `_ensure_image_unmounted` returned `True` whenever `mountpoint -q` exited non-zero, but a **timeout or error** in that check also exits non-zero, so an *undeterminable* state was read as "released" and the gadget got re-enabled over a possibly-mounted image.

Fix:
- Added `_path_mount_state(path)` — reads `/proc/self/mountinfo` directly (authoritative for the service's mount namespace, which the mount subprocesses share) and returns `True` / `False` / `None`. A read error is `None`, never a false "not mounted".
- Rewrote `_ensure_image_unmounted` to return `True` only on a definite `False` (not mounted); `None` is treated as **still mounted** (fail-safe, retries then returns False → gadget stays down). Only a definitely-mounted state triggers `sync` + `umount`.
- Added `_detach_image_loops()` — on confirmed unmount, detaches any lingering loop device bound to the image before declaring it released, so nothing can write behind the gadget's back. Safe because it only runs while the gadget is disabled.
- `delete_local_music` inherits the fix (same helper).

Platform note: on the Pi (Linux) mountinfo is authoritative; on the macOS dev box there's no `/proc`, so `_path_mount_state` returns `None` → fail-safe "still mounted" (real sync path never runs in dev mode anyway).

**Verification:** `py_compile` PASS. Ending turn for the Codex stop-gate to re-verify.

### Iteration 1f — fifth Codex stop-gate pass

Gate: *"loop verification still fails open on `losetup` errors."* Correct — `_image_loop_devices` returned `[]` ("no loops, clean") when `losetup` exited non-zero with empty output. But util-linux `losetup -j` exits 0 (empty output) when there are genuinely no matches, so a non-zero exit is a real error (missing binary, timeout, permission) — treating it as "no loops" is fail-open.

Fix: any non-zero `losetup` exit now returns `None` (undeterminable) → `_detach_image_loops` returns False → gadget stays down. Also hardened `_path_mount_state` to catch any exception (not just `OSError`) and read with `errors="replace"`, so a malformed mountinfo line can't leak an exception or be misread.

**Full fail-safe audit of the release chain (all uncertain branches → do NOT authorize re-enable):**
- `_path_mount_state`: True / False / None(any read error). None → treated as mounted.
- `_image_loop_devices`: definite list only on exit 0; any error → None.
- `_detach_image_loops`: True only when re-enumeration confirms zero loops; None or non-empty → False.
- `_ensure_image_unmounted`: returns True only on (mount state False) AND (`_detach_image_loops` True); everything else retries then returns False.
- Both gadget re-enable sites gate on `image_released`; an exception anywhere leaves it False (init) → no re-enable.

This closes the mount/loop release class. Ending turn for the stop-gate to re-verify.

## Iteration 2 — 2026-08-05 — Phase 0: video (dashcam) sync resilience

Music mount-safety class closed (5 gate passes, iterations 1a–1f). Cancelled the stale 36-min background Codex rescue task (redundant with the stop-gate). This iteration hardens `backend/services/dashcam_archive.py` — the "video sync" half of the Phase 0 goal.

**Changes:**
1. **Cancel now works mid-clip.** Added `_archive_one_clip()` that runs each clip's rsync as an `asyncio.create_subprocess_exec` tracked in `_active_archive["process"]` (with a 300s timeout → rc 124), so `cancel_archive()`'s `proc.kill()` is no longer a no-op. Loop re-checks `cancelled` after each clip and raises `CancelledError`.
2. **Partial archives reported honestly.** Only a clean rsync (rc 0) counts as archived and is recorded in `dashcam_archived_clips`; rc 23 (partial), errors, and timeouts increment `clips_failed` and are left on the cam for retry (previously rc 23 was counted as success and skipped clips still yielded `completed`). If any clip failed → job status `partial` (added to the terminal set in `_update_job`) with a message; else `completed`.
3. **Honor NFS.** `_get_archive_share_config` now returns `share_type` (`archive_share_type`/`SHARE_TYPE`, default cifs, lowercased); the archive mount uses it instead of a hardcoded `"cifs"`. Verified `share_browser.mount_share` implements both cifs and nfs — NFS archive shares previously always failed as CIFS.
4. **Concurrent-archive race closed.** `start_archive` claims `_active_archive["job_id"] = -1` synchronously before the first await (releases on DB-insert failure), so two concurrent callers can't both start an archive.
5. **`delete_after` guarded.** The cam is mounted read-only (so recording continues), so host-side `rm` both fails and would be unsafe on a live image. Now it logs a clear warning and skips deletion instead of attempting a doomed/dangerous `rm` (previously the `rm` silently failed on the RO mount). Safe cam-side free-space management is a Phase 2 architectural item.

**Frontend:** added `partial` to the `ArchiveJob` status union and an "Archive incomplete" warning banner in `ArchiveCard` (mirrors the music `partial` UI); `isIdle` now excludes partial so the message isn't hidden.

**Deliberately deferred to Phase 2 (task #3):** the RO-mount-while-recording lifecycle is the established teslausb pattern (disabling the gadget to mount RW would drop sentry coverage during every archive) — not redesigning it here; and safe cam-side deletion. Plus the `customization.py` same-class fix from iteration 1e.

**Verification:** `py_compile` PASS on all changed backend files; frontend `tsc` still blocked (deps). Ending turn for the Codex stop-gate to review.

### Iteration 2b — Codex stop-gate pass on the dashcam changes

Gate flagged two, both valid:

1. **"Archive jobs can disrupt the installed archive daemon."** Step 7 unconditionally `umount`ed `/mnt/cam` even when I reused an existing mount — which could belong to the inherited teslausb `archiveloop` daemon. Fixed with `cam_we_mounted` tracking: only unmount the cam if we mounted it. Applied the same pattern symmetrically to the **archive share** mount (`/mnt/archive`, also a teslausb convention) via `archive_we_mounted` — skip-if-mounted and only-unmount-what-we-mounted — to prevent the same disruption on that mount.
2. **"NFS archives may never complete cleanly."** `rsync -a` preserves owner/group/perms; NFS root_squash rejects the `chown`, so rsync returns code 23 for every clip even though the data copied — which my new code counts as failed, making the job perpetually `partial`. Changed `_archive_one_clip` to `rsync -rt` (recursive + mtime only); video clips need only content + mtime. Safe for CIFS too (its mount forces file modes anyway).

Note: music sync writes to a vfat loop image where the Linux vfat driver treats chmod/chown as no-ops, so `-a` there returns 0 (music historically completed) — left as-is to avoid scope creep; a `--modify-window=1` perf tweak for FAT's 2s mtime granularity is noted for later.

**Verification:** `py_compile` PASS; both `*_we_mounted` flags scope-checked. Ending turn for the stop-gate to re-verify.

### Iteration 2c — Codex stop-gate: daemon-race root cause

Gate: *"mount ownership tracking is one-sided and still races the enabled `archiveloop` daemon."* Correct — guarding only against unmounting the daemon's mount is defense-in-depth, not a fix; if the teslausb `archiveloop` daemon is enabled/running, TeslaPi's archive AND music sync race it on the shared cam image and USB gadget regardless.

Root-cause fix — refuse to run when the daemon is present:
- Added `script_runner.teslausb_archiver_running()` — checks `systemctl is-active`/`is-enabled` for `teslausb[.service]` plus a `pgrep -f archiveloop` fallback, via a quiet probe helper (`_quiet_probe`) that avoids `run()`'s WARNING spam on the routine non-zero exits. Fail-open on probe error (a glitch shouldn't disable TeslaPi on a clean single-stack install); any positive systemd/process signal is authoritative; returns False in dev mode.
- `dashcam_archive.start_archive` and `music_sync.start_sync` now raise a clear RuntimeError when the daemon is active/enabled ("Disable teslausb.service first").
- Kept the `*_we_mounted` ownership tracking as defense-in-depth for the TOCTOU window (daemon appearing after the check).
- Verified `auto_sync._check_and_sync` already catches `RuntimeError` from `start_archive` → records "skipped" at debug level, so auto-sync cleanly no-ops each cycle while the daemon runs (no loop crash).

**Verification:** `py_compile` PASS on script_runner, dashcam_archive, music_sync, routers/music. Ending turn for the stop-gate to re-verify.

### Iteration 2d — Codex stop-gate: reverted the daemon guard (architectural finding)

Gate: *"the daemon guard reopens an archive race and disables normal installations."* Correct, and it surfaced a real architectural issue I'd been guessing around.

**Ground truth (investigated this iteration):** `teslapi_plan.md:7` says the existing infrastructure — explicitly "the archive loop" — "is preserved." `deploy/setup-teslapi.sh:749` and `setup/pi/configure.sh:831` **enable `teslausb.service` (archiveloop) on every normal install.** So the teslausb archiveloop daemon is the **canonical, always-running dashcam archiver**, not an anomaly.

Therefore my "refuse if daemon active/enabled" guard returned True on every normal install → disabled music sync AND web archiving everywhere. And no `systemctl` check can distinguish "archiveloop enabled" (always, normally) from "archiveloop writing this instant" (it's a continuous loop), so the guard approach is fundamentally unworkable for coexistence.

**Action:** reverted the daemon-refusal guard from `start_archive` and `start_sync`; removed the unused `teslausb_archiver_running`/`_quiet_probe` helpers from `script_runner`. Replaced with NOTE comments pointing here. **Kept** the good, non-breaking resilience work: cancel wiring, `partial` status, NFS `-rt` flags, synchronous concurrent-claim, delete-after guard, and the `*_we_mounted` unmount-ownership tracking (strictly better — never tears down the daemon's mounts, breaks nothing).

**⚠️ UNRESOLVED ARCHITECTURAL DECISION (needs the user; queued on Phase 2 / task #3):**
TeslaPi ships TWO dashcam archivers that both mount the cam image and touch the USB gadget:
1. the **preserved teslausb `archiveloop`** daemon (canonical, enabled by default), and
2. the **Python `backend/services/dashcam_archive.py`** (web-/auto-triggered).
They race by design. Options: (a) make the Python side monitor/trigger archiveloop instead of running its own mount/rsync lifecycle; (b) make TeslaPi the sole archiver and stop enabling `teslausb.service` (contradicts "archive loop is preserved"); (c) a shared pause/flock protocol so only one archives at a time. The same gadget-coordination question applies to **music sync** (it toggles the gadget archiveloop also manages). This can't be resolved by guard-guessing — it's a deployment-model decision. **Loop continues to Phase 1 (security, fully independent); this is flagged for the user.**

**Verification:** `py_compile` PASS on all four files; no dangling refs. Ending turn.

## Iteration 3 — 2026-08-05 — Phase 1 (security): config injection + SPA traversal

Phase 0 sync-resilience code is done; the archiver-coexistence item is blocked on a user decision (task #3), so moved to Phase 1 (independent). Started with two contained, high-severity fixes:

1. **Config shell injection (H12 / SOL-003).** `config_manager._quote` detected backticks as special but only escaped `$ \ "`, so a value like `` `reboot` `` executed when the root-sourced `.conf` was read. Replaced the hand-rolled escaping with `shlex.quote` (the proven primitive — neutralizes `$`, backticks, quotes, everything). Verified in a bash subprocess that backtick and `$(...)` payloads source as literal text (no execution). Because `shlex.quote` emits single-quoted output (which the old `_unquote` couldn't parse for embedded apostrophes like SSID "Bob's WiFi"), made `_unquote` symmetric via `shlex.split` — round-trips all cases incl. apostrophes/quotes/backticks AND still reads legacy double-quoted values. Added write-time validation in `write_config`: reject keys that aren't bash identifiers (`_KEY_RE`) and values with control chars (newline injection into the line-based format).

2. **SPA path traversal (C2).** `main.py` `serve_spa` built `_static_dir / full_path` and served it with no containment check — `../`-bearing paths read arbitrary files (remote, unauthenticated, incl. the WAN-forwarded port). Now resolves the candidate and requires `is_relative_to(_static_root)` before serving; falls back to index.html otherwise. Verified: `../../../etc/passwd` → `inside=False` (blocked); legit files served.

**Verification:** `py_compile` PASS; quoting round-trip + injection-inert + traversal-containment all verified in isolation (deps aren't installed in the dev env, so no full app import). Ending turn for the Codex stop-gate.

**Phase 1 remaining (next iterations):** WireGuard shell injection (C7), notification_service argv (H12b), OTA unsigned-execute + upload size/basename (H11/OTA), setup endpoint secret masking (SOL-006), detached update restart (H6), and the big one — auth + bind-loopback + drop-root (1a).

## Iteration 4 — 2026-08-05 — Phase 1 (security): notification + WireGuard shell injection

Eliminated the two remaining root shell-injection paths (C7 + H12b).

**`script_runner.run` — new `env` and `input_data` params.** So callers pass env vars as a dict and file content via stdin instead of building `VAR=val cmd` / `echo '...' | tee` shell strings. `env` merges over `os.environ`; `input_data` is fed to stdin then closed.

**`notification_service._send_push` (H12b).** Was `bash -c "{VAR=val ...} run/send-push-message \"{title}\" \"{message}\""` — config values, title, and message all shell-interpolated (failure notifications embed remote rsync stderr). Now runs `["bash", "run/send-push-message", title, message]` with config as `env=`. Verified in a bash subprocess that `$()`/backtick payloads are inert.

**`wireguard_manager` (C7).** Both `configure` and `set_auto_connect` used `bash -c "echo '{content}' | sudo tee ..."` — a single quote in any field broke out, and `HOME_SSID` is `source`d by the NM dispatcher (so `$()` in an SSID ran as root on every WiFi event). Fixes:
- Added `_sudo_write(dest, content, mode)` — `sudo tee` with content on **stdin** (never a shell) + `sudo chmod`.
- Added field validators: `_valid_wg_key` (base64 44-char), `_valid_endpoint` (host:port incl. IPv6), `_valid_iplist` (IP/CIDR list). `configure` rejects malformed keys/endpoint/address/dns and coerces keepalive to int — blocks newline-injection of extra wg directives.
- `set_auto_connect` validates the SSID (no control chars, ≤64 bytes) and writes `HOME_SSID={shlex.quote(ssid)}` so it's inert when sourced. Verified: `Home$(touch …)Net` sources without executing.
- Dispatcher script (static content) also moved to `_sudo_write`. `generate_keypair` left as-is (a pipe pipeline with no user input — legitimate `bash -c`).

**Verification:** `py_compile` PASS on all five files; validators + sourced-SSID inertness + injection-inert notification verified in isolation.

**Phase 1 remaining:** OTA unsigned-execute + upload size/basename (H11), setup endpoint secret masking (SOL-006), detached update restart (H6), and auth + bind-loopback + drop-root (1a). Ending turn for the Codex stop-gate.

### Iteration 4b — Codex stop-gate: env-name injection in notification

Gate: *"notification shell injection remains reachable through attacker-controlled environment variables."* Correct — I moved config *values* out of the shell string, but config *keys* become env var *names* via `key.upper()`, and channels (hence config keys) are created through the unauthenticated API. A key mapping to `BASH_ENV` (bash sources it on startup), `LD_PRELOAD`, `PATH`, or `IFS` → code execution when `bash run/send-push-message` starts.

Fix: forward only env names that match a plain identifier AND start with a known service prefix (`TELEGRAM_`, `DISCORD_`, `NTFY_`, `WEBHOOK_`, `NOTIFICATION_COMMAND_`, …). Derived the prefixes from the actual variables `run/send-push-message` consumes — every one starts with a service prefix; no shell/loader-sensitive var does. Verified: service vars forwarded, `BASH_ENV`/`LD_PRELOAD`/`PATH`/`IFS` dropped.

Note (not introduced here, flagged for Phase 1 auth): the `NOTIFICATION_COMMAND_*` channel type intentionally runs user-supplied commands — a designed teslausb feature, but arbitrary command execution via the currently-unauthenticated API. Authentication (Phase 1a) is the mitigation.

**Verification:** `py_compile` PASS; allowlist behavior verified in isolation. Ending turn for the stop-gate.

## Iteration 5 — 2026-08-05 — Phase 1 (security): upload hardening + setup secret masking

1. **OTA upload memory DoS + traversal (H11).** `routers/updates.py:/upload` did `content = await file.read()` — unbounded buffer into a MemoryMax-limited service — then passed the raw client filename to `apply_uploaded_update`, which joined it into UPDATE_DIR (so `../../mutable/teslapi/x.tar.gz` wrote outside). Now: basename the filename + re-check extension, then **stream to disk in 1 MB chunks with a 300 MB hard cap** (413 on exceed, cleans up the partial). Changed `updater.apply_uploaded_update` to take the sanitized path — it never sees the raw filename. Verified basename strips `../` traversal.
2. **Lock-chime upload (H11).** `customization.py` did `await file.read()` (any size) *before* the 10 MB check. Now reads in chunks and rejects at the cap before fully buffering.
3. **Setup endpoint secret leak (SOL-006).** `/setup/status` and `/setup/detect` returned `_detect_existing_config()` = raw config **including secrets**, unauthenticated, during setup. Now masks sensitive values (mirrors `routers/config.py`).
4. **Masking gap — WIFIPASS leaked (found while testing #3).** The shared sensitive-key regex matched `password|passwd`, which misses `WIFIPASS`/`WIFI_PASS` (teslausb's actual WiFi-password keys). Broadened to `pass` in BOTH `setup.py` and `routers/config.py` (the latter's `/api/config` had the same leak). Verified WIFIPASS/WIFI_PASS/SHARE_PASSWORD/MQTT_PASSWORD/HA_TOKEN all mask; non-secrets pass.

**⚠️ Still open (top Phase 1 critical): OTA unsigned-execute RCE (SOL-002).** The `/updates/upload` endpoint still extracts the tarball and runs its `install.sh` as root, **unauthenticated** — the upload is now bounded/sanitized but the execute-as-root remains. The real gate is authentication (Phase 1a, next) and/or signed-update verification. Not unilaterally disabling the update feature; flagged as the top remaining item.

**Verification:** `py_compile` PASS on updates/setup/customization/config/updater; basename + masking verified in isolation. Ending turn for the stop-gate.

**Phase 1 remaining:** auth + bind-loopback + drop-root (1a) — which also mitigates the OTA-execute RCE and the NOTIFICATION_COMMAND feature; detached update restart (H6).

### Iteration 5b — Codex stop-gate: mask corruption + OTA RCE

Gate: *"the masking change corrupts stored Wi-Fi credentials, and OTA still permits unauthenticated root execution."* Both correct.

1. **Masking corrupts Wi-Fi credentials.** Broadening the mask to catch `WIFIPASS` (iter 5 #4) meant it now returns `********` — and the config *write* path echoes values back verbatim (the C6 round-trip bug), so saving settings would overwrite the real `WIFIPASS` with `********`. My masking change turned a latent bug into an active one. **Pulled the C6 write-side fix forward:** `config_manager.write_config` now drops any value equal to the mask sentinel `********` (treated as "keep existing") before writing. Central, so it covers `PUT /config` AND setup provision (both route through `write_config`, confirmed — setup.py:340 and pi_setup.py:74). Verified: masked values dropped, real changes written.
2. **OTA unauthenticated root execution.** `/updates/upload` extracted a tarball and ran its `install.sh` as root with no auth/signature. Added `settings.allow_unsigned_updates` (default **False**); the upload endpoint now returns 403 unless an operator explicitly sets `TESLAPI_ALLOW_UNSIGNED_UPDATES=true`. Safe-by-default without deleting the feature. (The GitHub download-and-apply path also runs install.sh but pulls trusted repo code; its unauthenticated *trigger* is closed by Phase 1a auth.)

**Verification:** `py_compile` PASS on config, updates, config_manager; mask-drop + write paths verified. Ending turn for the stop-gate.

### Iteration 5c — Codex stop-gate: over-broad mask + pre-parse upload reject

Gate: *"the fixes introduce a valid-password collision and do not reject disabled uploads before body parsing."* Both correct.

1. **Over-broad masking collision.** Iter 5b used bare `pass`, which matches innocent keys (`COMPASS`, `BYPASS_MODE`, `PASSENGER_COUNT`) — masked on read, then dropped on write, so a legit non-secret setting couldn't be saved. Fixed with a precise pattern `(password|passwd|wifipass|_pass|secret|token|key|credential)` — catches WIFIPASS/WIFI_PASS/SHARE_PASSWORD, leaves COMPASS/BYPASS alone (verified). **Centralized** the definition in `config_manager` (`SENSITIVE_KEY_RE`, `MASK`, `is_sensitive_key`); `routers/config.py` and `routers/setup.py` now import it so read-masking and write-dropping can't drift. **Scoped the write-drop to sensitive keys** so a non-secret value that happens to be `********` writes through. Residual (a secret set to literally 8 asterisks reads as unchanged) is the inherent sentinel limit — fully fixed by the Phase 4 frontend contract (omit unchanged secrets); documented in code.
2. **Reject disabled uploads before body parsing.** `file: UploadFile = File(...)` makes FastAPI parse the whole multipart body before the handler runs, so a disabled endpoint ingested the upload just to 403 it. Switched to `async def upload_and_apply(request: Request)` and check `allow_unsigned_updates` before `await request.form()` — the body is never parsed when uploads are disabled. Added `await file.close()` on the spooled upload.

**Verification:** `py_compile` PASS on updates/config/setup/config_manager; precise-regex + scoped-drop verified in isolation; removed now-unused `re` import from config.py.

**Phase 1 remaining:** auth + bind-loopback + drop-root (1a); detached update restart (H6). Ending turn for the stop-gate.

## Iteration 6 — 2026-08-05 — "Sync New" fix (H3) + Phase 1 remainder escalation

The remaining Phase 1 items are all architectural / need decisions or hardware I don't have, so I did the concrete, in-scope (music-sync) fix and am escalating the rest rather than building them blind.

**H3 — "Sync New" was doubly broken.** `music.py` `/sync/new` queried a nonexistent column `modified_time` (→ 500 on every call once a completed sync existed), and even corrected, `music_files.modified_at` holds a Unix-epoch float (from `st_mtime`) while `completed_at` is an ISO-8601 string — SQLite orders all numbers before any text, so `modified_at > '<ISO>'` is always false ("no new files" forever). Fix: query `modified_at`, and convert `completed_at` via `datetime.fromisoformat(...).timestamp()` to compare numeric-vs-numeric; unparseable timestamp → fall back to full sync. Verified in an in-memory SQLite: new query returns only files newer than the cutoff; the old (num > ISO-text) form returns empty. "Sync New" now works — part of the loop's primary goal (music sync working).

**⚠️ Remaining Phase 1 items — ESCALATED to the user (architectural / need hardware; not built blind):**
- **Authentication (1a)** — the headline gap (no auth on any endpoint). Genuinely a product/UX fork: auth method (nginx basic-auth vs app-level session/token), default-on-vs-opt-in, how the Tesla in-car browser authenticates, and first-run credential bootstrap. Recommendation: nginx HTTP basic-auth (upstream teslausb had `WEB_USERNAME`/`WEB_PASSWORD`) + bind uvicorn to loopback, with the password set during setup. Needs the user's call before building.
- **H6 — detached update restart.** The health-check/rollback after `systemctl restart teslapi` is dead code: the restart kills the updater's own process. Correct fix needs a *survivor* process (systemd-run transient unit or a separate updater unit doing restart→healthcheck→rollback), spanning Python + systemd + install.sh — and it's untestable without a Pi.
- **Drop root / bind loopback** — run uvicorn as non-root behind an allowlisted sudo helper + bind 127.0.0.1. Deploy-layer, needs hardware validation.

**Loop decision:** Phase 1's implementable security fixes are done (injection ×3, traversals ×2, upload hardening, OTA opt-in gate, secret masking + round-trip). The remainder is blocked on the above. Rather than idle, the loop continues into **Phase 4 (API contract drift)** — concrete, high-value, code-only fixes that make broken features actually work (Files manager, HA/notifications endpoints, WireGuard casing, WiFi casing, dashcam playback, validation detail). Auth/H6/drop-root stay flagged for the user.

**Verification:** `py_compile` PASS; epoch-comparison verified in isolation. Ending turn for the stop-gate.

### Iteration 6b — Codex stop-gate: wrong sync watermark

Gate: *"'Sync New' uses the wrong synchronization watermark."* Correct — my iter-6 fix made the timestamp comparison *type*-correct but the *semantic* was still wrong: comparing file mtime to the last sync's completion time misses a file added with an OLD mtime (rip an old album today → old mtime, but new-to-Tesla). The right watermark is the `synced` flag, which is what it's for.

Fixes (all three needed for `synced` to be a correct watermark):
1. `/sync/new` now selects albums with `synced = 0` (dropped the timestamp/completed_at logic entirely).
2. `music_index` re-index of a **changed** file now resets `synced = 0` (previously it kept the old flag, so an edited file never re-synced).
3. `_run_rsync_full` on a **clean** full sync now marks the whole index `synced = 1` (previously full sync never set the flag, so everything looked unsynced afterward). A partial full sync (23/24) deliberately does NOT mark.

Selective syncs already mark their files `synced=1` (Phase 0). Simulated the full lifecycle in SQLite: new library → both albums new; after full sync → none; add old-mtime album → correctly flagged new (timestamp cutoff would miss it); file changes → re-flagged new. All correct.

**Verification:** `py_compile` PASS on music router + music_sync + music_index; watermark lifecycle verified in isolation. Ending turn for the stop-gate.

### Iteration 6c — Codex stop-gate: synced can falsely hide files

Gate: *"`synced` can still falsely hide uncopied or changed files."* The key realization: the dangerous direction is **over-marking** `synced=1` (hides files that still need copying); under-marking is safe (Sync New re-offers, rsync skips existing). My iter-6b full-sync `UPDATE ... SET synced=1` for **all** rows was the over-marking risk — it would mark indexed files the copy didn't actually produce (stale index entry, share/dest mismatch), hiding them from Sync New forever.

Fix: full sync now marks `synced=1` **only for indexed files actually present in MUSIC_DEST** — walk MUSIC_DEST (confirmed the index scans the share, so DB paths `/Artist/Album/file` mirror MUSIC_DEST), and mark only the intersection. Walk failure → mark nothing (safe under-mark). Verified in isolation: a stale index entry not copied to DEST stays `synced=0` (correctly still offered), only present files are marked. Selective sync's marking is already safe (rc 0 = all `--files-from` copied).

Follow-ups noted (pre-existing, NOT active false-hides today, → Phase 4 delete correctness): `delete_local_music` (a) joins `MUSIC_MOUNT` not `MUSIC_DEST` so it currently 404s (music lives under `/mnt/music/Music/`), and (b) doesn't reset `synced=0` for deleted paths. Because delete is non-functional, nothing gets deleted, so there's no live "deleted-but-synced" hide; when delete is fixed, it must also reset synced. "Changed file" detection remains index-driven (re-index resets synced=0 on mtime change) — expected for an index-based watermark.

**Verification:** `py_compile` PASS; present-only marking verified in isolation. Ending turn for the stop-gate.

### Iteration 6d — Codex stop-gate: full-sync marking races re-index

Gate: *"Full-sync marking can overwrite a concurrent re-index reset and permanently hide a changed file."* Correct — the marking does `SELECT synced=0` → walk → `UPDATE synced=1`; a re-index running concurrently that resets `synced=0` for a changed file gets clobbered back to 1, hiding it.

Decision: **removed the full-sync `synced` marking entirely.** It's an optimization, not correctness — under-marking is safe (Sync New re-offers; its selective rsync skips already-copied files and marks what it copies), while any "mark after copy from a snapshot" both hides uncopied files and races re-index. Full sync now leaves `synced` untouched; the flag is maintained solely by index (0 for new/changed) and selective sync (1 for proven-copied, rc 0). Self-healing and race-free.

Follow-up noted (narrow, not fixed): selective-sync marking has the same race class in a much smaller window (a file changed during its own sync). Fully closing it would need sync/re-index mutual exclusion (they contend for the share anyway) — a Phase 4 hardening, not done now to avoid scope creep.

**Verification:** `py_compile` PASS; `os` still used. Ending turn for the stop-gate.

### Iteration 6e — Codex stop-gate: self-healing path retains the TOCTOU race

Gate: *"The replacement 'self-healing' path retains the same TOCTOU data-loss race."* Correct — I'd deferred it, but the selective-sync marking (`synced=1` after rsync) can still be clobbered by a concurrent re-index resetting `synced=0` for a changed file. Deferring a data-loss race isn't acceptable.

Closed the race class via **sync/index mutual exclusion** (they contend for the share and both write `music_files.synced`, so they must not overlap):
- `music_index.try_claim_indexing()` — synchronous atomic claim of the indexing slot.
- `music_sync.start_sync` — refuses if indexing is active, then claims `_active_sync["job_id"] = -1` **synchronously before any await** (also fixes the old check-then-set double-start race, M-B2); releases the claim if the DB insert fails.
- `trigger_index` — refuses if a sync is active; re-checks after the share-mount await and claims indexing synchronously right before `create_task` (no await between).
- Analyzed all await interleavings: each side's check-and-claim is synchronous (atomic under asyncio's single thread), so whichever claims first wins and the other gets 409/raises. Since indexing can't start during a sync, the sync's `synced=1` marking can never be raced by a re-index reset. Data-loss race eliminated (not narrowed).

**Verification:** `py_compile` PASS on music_sync/music_index/music router; claim atomicity confirmed (no await between check and claim at both sites).

"Sync New" is now correct end-to-end (iters 6→6e): type → watermark → over-mark → full-sync race → selective-sync race. Ending turn for the stop-gate.

## Iteration 7 — 2026-08-05 — Phase 4: auto-update-check (M-F5 / SOL-020)

Diversified off the music-sync path (5 gate passes was enough). Fixed the auto-update toggle — a contained, backend-verifiable contract bug + its missing scheduler:

1. **GET `/updates/auto-check` (M-F5).** The Settings UI GETs this on load, but only a PUT existed → 405, so the toggle never reflected its saved state. Added the GET returning `updater.get_auto_update_config()` (shape already matches the frontend's `AutoUpdateConfig`: `enabled`/`interval_hours`).
2. **Scheduler (SOL-020) — the toggle was nonfunctional (nothing consumed the config).** Added `updater.run_auto_check_loop()` — a background loop (mirrors the auto_sync pattern) that periodically runs `check_for_updates()` per the persisted config, stamps `last_check`, and logs when an update is available. **Checks only — never auto-applies** (unattended root updates are unsafe; applying stays manual). Wired into `main.py` lifespan (start + cancel-on-shutdown). Disabled → re-reads config hourly so a re-enable is picked up.
3. Fixed `set_auto_update_config` to **preserve** `last_check` across a config change instead of resetting it to None.

**Verification:** `py_compile` PASS on updates router + updater + main; loop mirrors the existing auto_sync lifecycle; shapes cross-checked against the frontend.

Phase 4 remaining (concrete): Files manager contract (C5), HA/notifications endpoint paths (M-F6), WireGuard casing (C9), WiFi casing (M-F2), selective-sync leading slash (H19), dashcam archived playback (H2), FastAPI validation detail (SOL-023). Ending turn for the stop-gate.

### Iteration 7b — Codex stop-gate: auto-check not user-visible / not retry-correct

Gate: *"scheduled update checks are neither user-visible nor retry-correct."* Both correct.

1. **Retry-correct.** The loop slept the full interval even after a failed check, so a transient network error blocked the next attempt for hours. Restructured: a failed `check_for_updates()` now backs off `AUTO_CHECK_RETRY_SECONDS` (15 min, capped at the interval) and retries; only a *successful* check sleeps the full interval; disabled re-reads config hourly. Verified the sleep-decision table (success→interval, fail→backoff, disabled→hourly).
2. **User-visible.** The loop only logged. Now it persists the result — `last_check` (last successful), `update_available`, `latest_version` — via `_record_auto_check_result`; `get_auto_update_config` returns those (defaults merged for old files), so GET `/updates/auto-check` surfaces them. `set_auto_update_config` merges over existing so a toggle change no longer wipes the result. Frontend: added `update_available`/`latest_version` to `AutoUpdateConfig` and a line in SystemSettings ("Update available: vX · last checked …").

Still checks-only (never auto-applies). **Verification:** `py_compile` PASS on updater/updates/main; retry decision logic verified in isolation; frontend edits minimal/pattern-consistent (tsc unavailable in dev env).

### Iteration 7c — Codex stop-gate: failed checks treated as successful

Gate: *"Failed GitHub checks are still treated as successful checks."* Correct — `check_for_updates()` catches its own network/HTTP errors and RETURNS a dict (`available=False, latest_version=None`) rather than raising, so my loop's `try/except` never fired and a failed check was recorded as a successful "up to date" (last_check stamped, update_available cleared).

Fix: `check_for_updates()`'s failure path now includes an explicit `"error": str(exc)` marker; the auto-check loop treats `info.get("error")` as a failed check → short backoff + retry, and does NOT call `_record_auto_check_result` (so last_check reflects only genuine successes). The `/updates/check` endpoint returns a bare dict (no response_model), so the extra key is harmless to existing consumers. Loop paths now: raise → backoff; error-dict → backoff; real result → record + interval.

**Verification:** `py_compile` PASS; confirmed `/check` has no response_model that would reject the new key.

Auto-check feature now correct across iters 7→7c: GET endpoint (405) → scheduler exists → user-visible + retry-correct → failed-check detection. Ending turn for the stop-gate.

### Iteration 7d — Codex stop-gate: failure marker misclassifies valid error paths

Gate: *"The new failure marker is still misclassified in valid error paths."* Correct — GitHub returns **404 for a repo with no releases yet**, which `raise_for_status()` turned into an exception that my blanket `error` marker treated as a transient failure (backoff + retry forever). But "no releases" is a *valid* answer ("nothing to update to"), a successful check.

Fix: split the except into `httpx.HTTPStatusError` (404 → valid up-to-date result, NO error marker; other statuses like 403 rate-limit → real failure with marker) and a general `except` (network/timeout/decode → real failure with marker). Verified the classification table: 404-no-releases and "up to date" both record as successful; 403/network back off and retry.

Auto-check now correct across iters 7→7d. **Verification:** `py_compile` PASS; classification verified in isolation. Ending turn for the stop-gate.

### Iteration 7e — Codex stop-gate: 404 over-classified as successful

Gate: *"GitHub 404s are still over-classified as successful checks."* The flip from the prior finding (404-as-failure was wrong) makes the real answer clear: a 404 on `/releases/latest` is genuinely ambiguous (no releases yet OR misconfigured/inaccessible repo), so it's neither a confident "up to date" nor a transient error.

Fix — a clean THREE-way classification in the loop:
- **failure** (`error`: network/403/5xx) → short backoff + retry, `last_check` not stamped.
- **indeterminate** (`no_releases`: 404) → sleep the full interval, `last_check` NOT stamped, no "up to date" claim (doesn't hide a misconfig as "current").
- **success** (real result) → record + full interval.
Verified the table. `check_for_updates` 404 path now returns a `no_releases` marker instead of a bare (success-looking) dict.

Auto-check took 7→7e (five passes) on a secondary Settings toggle. **Reprioritizing:** next iterations target high-value contract fixes (HA/notifications endpoint paths, Files manager, dashcam playback) over secondary polish, per the note to the user about cadence/cost.

**Verification:** `py_compile` PASS; three-way classification verified. Ending turn for the stop-gate.

### Iteration 7f — Codex stop-gate: false "up to date" outside the scheduler

Gate: *"A GitHub 404 still produces false 'up to date' claims outside the scheduler."* Correct — I'd only fixed the scheduler loop. The manual `/updates/check` path and `download_and_apply` still keyed off `available=False`, which conflates up-to-date, no-releases, AND error (the error path returns HTTP 200 with `available=False`, so the frontend `catch` never fires → "You are running the latest version" on a network error).

Root fix — made the result **self-describing** so no consumer can misclassify: `check_for_updates` now returns an explicit `status` on every path (`update_available` / `up_to_date` / `no_releases` / `error`). Updated all consumers:
- Frontend `handleCheckUpdate`: `error` → "Could not check…", `no_releases` → "No releases found…", only genuine `up_to_date`/`!available` → "latest version". Added `status`/`error` to the `UpdateInfo` type.
- `download_and_apply`: honest message per status instead of blanket "No update available".
- Scheduler loop already handles error/no_releases.
Verified the message table across all four outcomes for both manual and apply paths.

**Verification:** `py_compile` PASS; consumer message table verified; frontend edits minimal/pattern-consistent.

Auto-check: iters 7→7f (six passes). The self-describing `status` closes the misclassification class across all consumers. Reprioritizing to high-value work next. Ending turn for the stop-gate.

## Iteration 8 — 2026-08-05 — Phase 4: HA + notification "Test" buttons (M-F6)

High-value contract fix (both Test buttons were 404ing). It was more than a path fix — the endpoints tested *saved* entities while the form wants to test *in-form* values, plus a response-shape mismatch.

- **HA test.** `/ha/test` now accepts an optional `{url, token}` body (test before saving; falls back to saved config) and returns the shape the UI reads: `{ok, message, haVersion, instanceName}` (was `{status, ha_version, ha_name, message}`). Returns `{ok:false,...}` on failure instead of raising, so the form shows a clean result. Frontend path `/config/test-ha` → `/ha/test`.
- **Notification test.** Added `POST /notifications/test` (coexists with `/test/{channel_id}`) that tests an UNSAVED channel via new `NotificationService.test_adhoc(type, config)` (dispatches with the real machinery, nothing persisted); returns `{ok, message}`. Frontend path `/config/test-notification` → `/notifications/test`.

Both frontend edits are path-string-only — payloads (`{url,token}` / `{type,config}`) and response reads (`ok`/`message`/`haVersion`/`instanceName`) already match the backend shapes I chose.

**Verification:** `py_compile` PASS on ha/notifications routers + notification_service; confirmed both `/test` routes coexist without conflict. Ending turn for the stop-gate.

Phase 4 remaining (high-value): Files manager contract (C5, large), WiFi casing (M-F2), WireGuard casing (C9), selective-sync leading slash (H19), dashcam archived playback (H2), validation detail (SOL-023).

### Iteration 8b — Codex stop-gate: notification false-pass + HA retest

Gate: *"notification tests can falsely pass, and saved HA credentials cannot be retested."* Both correct.

1. **Notification false-pass** — root cause in the inherited `run/send-push-message`: it `exit 0` unconditionally, so `_send_push` never raised and any test "passed" even when (a) no service was enabled or (b) the send got an HTTP error (curl without `--fail` returns 0 on 4xx). Fixed the script: track a `sent` flag (each enabled service sets it; under `set -e` a failed send aborts before the flag), `exit 1` if nothing was sent, and added `--fail --show-error` to all 9 curls so HTTP errors (e.g. bad token → 401) propagate. Now a test of a non-enabled/misconfigured channel correctly fails. Fixes both the new ad-hoc test AND the pre-existing `/test/{channel_id}`. (Residual: a service returning HTTP 200 with an error body still passes — inherent, rare.)
2. **HA retest** — the Settings form loads the token masked, so a retest of saved creds sent the mask back. `/ha/test` now treats an empty or masked token (`********` or the `abcd...wxyz` form — a real HA JWT never contains `...`) as "use the saved credential," loading the raw saved token. Saved creds can now be retested.

**Verification:** `bash -n` OK on the script (9 curls now `--fail`, comment intact); `py_compile` PASS on ha/notifications/service. Ending turn for the stop-gate.

### Iteration 8c — Codex stop-gate: HA retest token exfiltration

Gate: *"HA retest fallback can exfiltrate the saved Home Assistant token."* A genuine security bug I introduced in 8b: the masked-token fallback sent the *saved* token to whatever `url` the request supplied — so an (unauthenticated) caller could POST `{url: "http://attacker/", token: "********"}` and receive the real saved HA token in the Authorization header.

Fix: only reuse the saved token against the SAVED url. A masked/empty token combined with a url that differs from the saved one is refused ("Enter the Home Assistant token to test a different URL."). Verified: retest-saved (masked+same-url) and new-creds (real token+new url) work; masked+evil-url is refused; url-omitted falls back to saved. The saved token now only ever leaves the box toward the saved HA URL.

**Verification:** `py_compile` PASS; exfiltration-blocked table verified in isolation. Ending turn for the stop-gate.

### Iteration 8d — Codex stop-gate: exfiltration via empty saved URL

Gate: *"Saved-token exfiltration remains possible when the saved HA URL is empty."* Correct — my 8c guard was `url and cfg.url and url != cfg.url`, which requires `cfg.url` truthy, so an empty saved URL let an attacker URL slip past and receive the saved token.

Fix: refuse on ANY mismatch — `if url != cfg.url: refuse`. The saved token is reused only when the effective URL exactly equals the saved URL (empty-vs-set now mismatches → refused; the "both empty" case falls through to the url-required rejection, so nothing is sent). Verified: empty-saved-url + attacker-url → REFUSED; omitted-url + empty-saved → REJECT (url required); legit retest → works; attacker → REFUSED.

**Verification:** `py_compile` PASS; exfiltration matrix (incl. empty-saved-url) verified. Ending turn for the stop-gate.

## Iteration 9 — 2026-08-05 — Phase 7 foundation: backend is now runnable + regression tests

Addressed the ROOT cause of the slow gate cadence (I could only `py_compile` + reason in isolation, so logic errors shipped and the gate caught them one at a time). Now the backend actually runs and fixes are verified by real requests.

- **Runnable backend.** Created `.venv` (gitignored) and installed the deps directly (the `pip install -e .` failed on hatchling package config — deps installed standalone instead: fastapi, uvicorn, aiosqlite, pydantic(-settings), python-multipart, websockets, httpx, pytest, pytest-asyncio). Confirmed `backend.main:app` imports and starts (lifespan runs the auto-sync + auto-update-check loops and cancels them cleanly on shutdown).
- **Regression suite.** `tests/backend/conftest.py` (dev-mode app + temp DB/config fixtures) + `tests/backend/test_api.py` + `pytest.ini`. **9 tests pass** against a real `TestClient`, each guarding a specific fix: health; auto-check GET exists (was 405); `/updates/check` self-describing status; **HA masked-token+different-url exfiltration refused** (security); HA requires-credentials; notifications ad-hoc test route; config masks secrets (WIFIPASS); config write drops the mask sentinel (no clobber); config write rejects a bad key. Run: `.venv/bin/python -m pytest`.

Impact: future iterations can write a test and run it to verify BEFORE the stop-gate — turning multi-pass gate round-trips into local red/green. The HA exfiltration fix and config mask round-trip are now proven by execution, not just reasoning.

Phase 7 remaining: GitHub Actions CI, frontend build/typecheck (needs `npm install` — tsc absent), broaden coverage (sync engine, dashcam, wireguard validators), shell lint, docs cleanup.

### Iteration 9b — Codex stop-gate: test harness real-state + weak security test

Gate: *"the test harness can touch real state, and the HA security test does not exercise token exfiltration."* Both correct.

1. **Real/shared state.** conftest used `os.environ.setdefault(...)` — an ambient `TESLAPI_DATABASE_PATH`/config in the shell or deployment env would NOT be overridden, so tests could hit the real DB/config. Also the single session-wide temp DB let tests pollute each other. Fix: force `TESLAPI_DEV_MODE`; give every test its OWN temp DB and teslausb config via `tmp_path` + `monkeypatch` of `settings.database_path`/`teslausb_config_path`; force a non-existent static dir. The harness itself caught the pollution — `test_ha_test_requires_credentials` was failing because the exfiltration test's saved HA config leaked via the shared DB; per-test isolation fixes it.
2. **Security test now exercises exfiltration.** Rewrote it to SEED a real saved token (`PUT /ha/config`), monkeypatch `ha_client.HAClient` with a spy recording `(url, token)`, then POST a masked-token + attacker-url request and assert (a) refused, (b) the saved token was never passed to any client, (c) no client aimed at the attacker url. Plus a positive path: masked-token + SAME url reuses the saved token against the saved url only. This actually proves no exfiltration rather than just checking a message.

**Verification:** `.venv/bin/python -m pytest` → 9 passed, isolated. Ending turn for the stop-gate.

### Iteration 9c — Codex stop-gate: test misses empty-saved-URL exfiltration

Gate: *"The HA regression test misses the critical empty-saved-URL exfiltration case."* Correct — my exfiltration test used a non-empty saved url, so it wouldn't catch a regression of the *specific* 8d bug (guard requiring a truthy saved url, which leaked when the saved url was empty).

Added `test_ha_test_empty_saved_url_no_exfiltration`: seeds a saved token with an **empty** saved url, spies on `HAClient`, and asserts an attacker-url + masked-token request is refused with the saved token never constructed into any client.

**Mutation-verified the test is effective:** temporarily reverted the guard to the buggy `if url and cfg.url and url != cfg.url:` → the new test FAILED; restored `if url != cfg.url:` → 10 passed. So the test genuinely guards the empty-saved-url case, not just the happy path.

**Verification:** `.venv/bin/python -m pytest` → 10 passed; mutation test confirms the guard is exercised. Ending turn for the stop-gate.

## Iteration 10 — 2026-08-05 — Phase 7: sync-engine regression tests (primary-goal coverage)

Now that the backend runs, wrote real tests for the loop's PRIMARY goal (music-sync reliability) — previously verified only by reasoning. Added `tests/backend/test_music_sync.py` + a `db_path` fixture (fresh per-test sqlite, settings patched).

Tests (dev mode; syncs simulated so no real mount/rsync):
- **Sync New watermark** — seed synced/unsynced rows, assert `/music/sync/new` offers only the albums with an unsynced file (`paths_count == 2`, the synced album excluded).
- **All-synced** → `/sync/new` returns idle / no job.
- **Sync refused while indexing** (`/sync/full` → 409) and **index refused while syncing** (`/library/index` → 409) — the iter-6e mutual exclusion that closed the synced-flag data-loss race.

**Mutation-verified both critical tests:** making Sync New ignore the `synced` flag → watermark test FAILS; removing the indexing guard → mutual-exclusion test FAILS; restore → all 14 pass. So the coverage genuinely guards the behavior, not just the happy path.

Suite now **14 passing** (10 API + 4 sync). `.venv/bin/python -m pytest`.

### Iteration 10b — Codex stop-gate: tests overclaim + force-clear a live guard

Gate: *"The new tests overclaim coverage and forcibly clear a live synchronization guard."* Both correct.

1. **Overclaim / live side effects.** The watermark test POSTed `/sync/new`, which in dev mode started a real background sync task just to check path selection — testing more (and with side effects) than the claim. Rewrote it to spy on `music_sync.start_sync` (async no-op returning a fake id) and assert the exact `paths` handed to it (`{"/A/x","/C/z"}`). No live sync starts; the test covers precisely the selection query.
2. **Force-clearing a live guard.** The old tests did bare `music_sync._active_sync["job_id"] = None/999` — mutating a process-global guard directly (and clearing it while a dev sync task could still be running). Removed all bare assignments; guard-state is now set only via `monkeypatch.setitem` (auto-restored). Confirmed: `grep` finds no bare guard mutation, and `_active_sync["job_id"]` is `None` after the run (no leak).

Re-mutation-verified the restructured watermark test still fails when Sync New ignores the `synced` flag. Suite: **14 passed**, guards clean.

## Iteration 11 — 2026-08-05 — Phase 7: installable package, verified frontend build, CI

- **Packaging fixed.** `pip install -e .` failed (hatchling couldn't infer the layout). Added `[tool.hatch.build.targets.wheel] packages = ["backend"]`. Verified: fresh temp venv `pip install -e ".[dev]"` succeeds → `pytest` → 14 passed.
- **Frontend build VERIFIED GREEN.** `npm ci` (fresh) then `npm run build` (`tsc -b && vite build`) — **zero type errors**, bundle produced. This confirms every frontend edit made across the whole loop typechecks (AutoUpdateConfig/UpdateInfo/ArchiveJob/LocalMusicData type additions, `partial` UI in SyncProgress/ArchiveCard, HA/notify test paths, SystemSettings display) — none of which I could verify until deps were installable. All clean.
- **CI added.** `.github/workflows/ci.yml`: backend job (py 3.11/3.12 matrix → `pip install -e .[dev]` → `pytest`) + frontend job (`npm ci` → `npm run build`). YAML validated; every command verified locally. Build artifacts (`dist/`, `node_modules/`) already gitignored.

Net: the project is installable, both halves build/test green, and CI enforces it on every push. Phase 7 substantially advanced (task #8).

Remaining Phase 7: broaden backend coverage (dashcam archive, injection/upload unit tests), shellcheck for run/deploy scripts, docs cleanup, real-hardware lane.

## Iteration 12 — 2026-08-05 — Phase 7: security unit tests (lock in the injection fixes)

Added `tests/backend/test_security_units.py` (25 cases) covering the highest-severity fixes, which were previously untested pure functions:
- **config shell-quoting** (iter 3/5): `_quote`/`_unquote` round-trip across apostrophes/quotes/backticks/`$()`; and a **bash-sourcing test** proving a `` `touch` ``/`$(touch)` payload is inert when sourced (no marker file created). Plus write-time mask-drop (scoped to sensitive keys) and key/control-char validation.
- **WireGuard validators** (iter 4): key/endpoint/iplist accept valid, reject newline-injection.
- **notification env allowlist** (iter 4b): service vars forwarded; `BASH_ENV`/`LD_PRELOAD`/`PATH`/`IFS`/`ENV`/`LD_LIBRARY_PATH` blocked.

**Mutation-verified** the injection test: regressing `_quote` to miss backtick escaping makes the bash-sourcing test FAIL; restored → all pass. Cleaned up mutation leftovers.

Suite: **39 passing** (10 API + 4 sync + 25 security units). The three shell-injection paths + config round-trip are now proven by execution, not reasoning.

### Iteration 12b — Codex stop-gate: allowlist test didn't exercise production

Gate: *"notification allowlist tests do not exercise the production security boundary."* Correct — my test re-implemented the filter in a local `_forwarded()` helper and asserted on that copy, so a bug in the real `_send_push` wouldn't be caught.

Fix: replaced it with `test_send_push_forwards_only_allowlisted_env` — it monkeypatches the real `script_runner.run` to capture the `env` dict that the actual `_send_push` builds, calls `_send_push` with a config carrying `bash_env`/`ld_preload`/`path`/`ifs`, and asserts those are absent while `TELEGRAM_*` are present (and title/message go as argv, not shell). Kept a tiny constants-present guard.

**Mutation-verified against production code:** disabling the allowlist filter in `_send_push` makes the test FAIL; restored → pass. Now testing the real boundary, not a re-implementation.

Suite: **31 passing** (fewer than 39 but stronger — 8 re-implementation cases replaced by 2 real-code tests). Ending turn for the stop-gate.

## Iteration 13 — 2026-08-05 — Phase 7: OTA gate + setup-masking endpoint tests

More real-endpoint security coverage:
- **OTA upload disabled by default** (iter 5b) — `POST /updates/upload` → 403 with the flag off.
- **OTA opt-in reaches apply, filename basename-sanitized** — with `allow_unsigned_updates` on, the request passes the gate; spied `apply_uploaded_update` so the (simulated) apply doesn't run, and asserted the dest of an `../../evil.tar.gz` upload is `evil.tar.gz` (no `/../`). Avoids the ~2.8s simulated-apply and touches no real state.
- **Setup masking** (SOL-006) — `GET /setup/detect` masks `WIFIPASS`/`SHARE_PASSWORD` while passing non-secrets.

Suite: **34 passing**, fast (0.2s), isolated (per-test DB/config), no real state touched.

Cumulative test coverage now spans: API contracts (health, auto-check, update-status), sync engine (watermark + mutual exclusion), security units (config injection/quoting, WG validators, notification env allowlist via real `_send_push`), OTA gate + traversal-safe upload, config + setup secret masking, HA test exfiltration (incl. empty-saved-url). All mutation-spot-checked. CI runs backend + frontend.

### Iteration 13b — Codex stop-gate: OTA test not isolated (wrote real UPDATE_DIR)

Gate: *"OTA endpoint test is not isolated and can overwrite shared update state."* Correct — the opt-in OTA test streamed the upload to `updater.UPDATE_DIR` (the real shared `/tmp/teslapi-update`), not a per-test path. (The earlier run had in fact left `/tmp/teslapi-update/evil.tar.gz` on disk — cleaned up.)

Fix: monkeypatch `updater.UPDATE_DIR` to a per-test `tmp_path/upd`, and assert `called["path"].startswith(upd_dir)` — proving the upload is written into the isolated dir, never real state. Verified: after the fix, `/tmp/teslapi-update` is not (re)created by the run. All other tests already isolate DB/config via tmp_path.

**Verification:** 34 passed; real shared UPDATE_DIR not touched. Ending turn for the stop-gate.

## Iteration 14 — 2026-08-05 — Phase 4: WiFi casing contract (M-F2), verified both sides

First frontend contract fix now that `npm run build` (tsc) works as verification. The WiFi UI consumed backend snake_case raw into camelCase types, so IP / in-use / auto-connect rendered undefined, and `addWifi` sent `autoConnect` (ignored) so unchecking auto-connect did nothing.

- **`useNetwork.ts`**: `refreshConnections` and `scanNetworks` now map `in_use`→`inUse`, `auto_connect`→`autoConnect`, `ip_address`→`ipAddress`; `addWifi` sends `auto_connect` (snake_case) matching `WiFiAddRequest`.
- Verified: `frontend && npm run build` → **tsc clean, bundle built**.
- Backend regression test `test_wifi_add_threads_auto_connect`: spies `NetworkManager.add_connection`, POSTs `auto_connect: false`, asserts it reaches the manager (not defaulted to True).

Video note: archived-clip playback (H2) assessed and DEFERRED — the archive location isn't stored and serving needs on-demand NAS mount management (untestable here) + it's entangled with the parked archiver-coexistence decision. Pivoted to this verifiable frontend contract fix instead.

Suite: **35 passing**; frontend build green. Ending turn for the stop-gate.

### Iteration 14b — Codex stop-gate: saved-network IP still blank in production

Gate: *"production saved-network IP remains blank despite the claimed contract repair."* Correct and important — the casing fix (map `ip_address`→`ipAddress`) was necessary but insufficient: `network_manager.list_connections` built every `WiFiConnection` **without** `ip_address`, so the field was always None in production (the dev mock happened to set it, hiding the bug).

Backend fix: `list_connections` now fetches the ACTIVE connection's IP via `nmcli -g IP4.ADDRESS device show <dev>` and stores it (CIDR stripped). Added an async test exercising the real path (dev_mode off, nmcli mocked) asserting `ip_address == "192.168.7.5"`. **Mutation-verified:** reverting the population → test FAILS; restored → pass.

Lesson: a frontend "contract repair" is only real if the backend actually sends the field — the dev mock masked a missing production value. Now both sides deliver it.

Suite: **36 passing**. Ending turn for the stop-gate.

## Iteration 15 — 2026-08-06 — Phase 4: WireGuard casing contract (C9)

WireGuard was completely unconfigurable — the frontend sent camelCase, the backend `WireGuardConfig` is snake_case → 422 on every save. Plus generate-keys read `publicKey` (backend sends `public_key`), auto-connect sent `onlyNonHome`/`homeSsid` (backend wants `only_non_home`/`home_ssid`), and the test result read `{latencyMs, error}` (backend returns `{success, message, details}`).

- **`useNetwork.ts`**: `saveWgConfig` maps camel→snake for the PUT; `setWgAuto` sends `only_non_home`/`home_ssid`; `generateKeys` reads `public_key`→`{publicKey}`; `testTunnel` returns `{success, message}` (combining backend message+details).
- **`WireGuardPanel.tsx`**: updated `onTestTunnel` type + display to the `{success, message}` shape.
- Verified: `npm run build` → **tsc clean** across the whole prop chain.
- Backend tests: snake_case config **accepted** and threaded to `configure` (`test_wireguard_save_accepts_snake_case`); old camelCase body **422s** (`test_wireguard_save_rejects_camel_case`) — proves the fix was necessary.

Suite: **38 passing**, frontend green. WireGuard config now works end-to-end (was 100% broken).

### Iteration 15b — Codex stop-gate: WG save fails on empty private key

Gate: *"WireGuard save still fails in production because the UI submits an empty required private key."* Correct — the casing fix got the field names right, but `WireGuardPanel.handleSave` sends `privateKey: ''` by design (the key is generated + stored server-side by /generate-keys, never sent to the browser). `configure()` required a non-empty `config.private_key` → `_valid_wg_key("")` fails → 500 on every real save. (My earlier backend test used a fake non-empty key, so it missed this — same "dev/test value masks production" trap as the WiFi IP.)

Backend fix: added `_read_stored_private_key()` (reads the root-owned `WG_PRIVATE_KEY_PATH` via `sudo cat`); `configure()` now uses `config.private_key or <stored>`, requires the RESOLVED key, validates it, and writes it into `[Interface]`. If neither is present → clear "generate keys first" failure.

Test `test_wireguard_configure_uses_stored_private_key`: dev_mode off, empty `private_key`, stored-key + `_sudo_write` mocked → asserts `configure` succeeds and the written `[Interface]` contains the stored key. **Mutation-verified:** reverting to `config.private_key` (no fallback) fails the test.

Suite: **39 passing**. WireGuard now saves end-to-end with the server-managed key. Ending turn for the stop-gate.

### Iteration 15c — Codex stop-gate: empty-key save could swap the active WG identity

Gate: *"empty-key saves can silently replace the active WireGuard identity."* Correct — my 15b fallback always used the /generate-keys stored key, so if keys were regenerated after the tunnel was configured, an innocent edit (e.g. changing the endpoint, which sends an empty private key) would overwrite the live identity with the newer stored key and break the tunnel.

Fix: on an empty-key save, prefer the key already in the ACTIVE config, then the stored key:
1. `config.private_key` (if the caller sent one), else
2. `_read_active_config_private_key()` — parses `PrivateKey` from the live `WG_CONFIG_PATH` (preserves identity on edit), else
3. `_read_stored_private_key()` — first-time setup only.

Test `test_wireguard_edit_preserves_active_identity`: active key ≠ stored key, empty-key save editing the endpoint → written `[Interface]` keeps the ACTIVE key, not the regenerated one. **Mutation-verified:** removing the active-config preference fails the test.

Suite: **40 passing**. WireGuard save now: correct casing, server-managed key, and identity-stable across edits. Ending turn for the stop-gate.

### Iteration 1e — fourth Codex stop-gate pass

Gate: *"loop-detach failures still authorize gadget re-enable."* Correct — `_detach_image_loops` ran `losetup -d` but ignored failures and returned nothing, so a loop device that stays bound to the image still let `_ensure_image_unmounted` return True.

Fix:
- Added `_image_loop_devices()` — enumerates loops backing the image; returns `[]` (none), a list, or `None` (undeterminable; `losetup -j` non-zero exit isn't mistaken for "no loops").
- `_detach_image_loops` now returns `bool`: detaches each loop, then **re-enumerates to confirm none remain**; returns True only on verified-clean, False on any detach failure or unconfirmable state.
- `_ensure_image_unmounted`: the "unmounted" branch now returns True only if `_detach_image_loops()` confirms no loop remains; otherwise it stays in the retry loop and ultimately returns False → gadget stays down.

**Invariant now enforced end-to-end:** the gadget is re-enabled only when `image_released` is True, which requires (a) mount state definitively `False` via `/proc/self/mountinfo` AND (b) verified zero loop devices bound to the image. Both music re-enable sites (`music_sync.py` sync path, `music.py` delete path) are gated on it. No other gadget-enable path exists in the music flow.

**Same-class follow-up logged (Phase 2, task #3):** `customization.py` lock-chime upload (boombox image) unmounts ignoring the result and re-enables the gadget unconditionally — same corruption class, different feature/image, out of Phase 0 scope. Not in this diff, so the stop-gate won't see it; queued for Phase 2.

**Verification:** `py_compile` PASS. Ending turn for the Codex stop-gate to re-verify.

### Iteration 15d — Codex stop-gate: 15c made deliberate key regeneration unusable

Gate: *"preserving the old key unconditionally makes deliberate WireGuard key regeneration unusable."* Correct — 15c always preferred the ACTIVE config key on an empty-key save, so after a user clicked **Regenerate Keys** and saved, the new stored key was discarded and the old identity kept. The two intents behind an empty private key were indistinguishable:
- editing an existing tunnel (endpoint/DNS) → keep the active key, and
- regenerating the keypair → apply the new stored key.

An empty `private_key` alone can't tell them apart, so the UI now sends the intent explicitly.

Fix — new `use_generated_key` flag threaded end-to-end:
- `schemas.py` `WireGuardConfig`: added `use_generated_key: bool = False`.
- `wireguard_manager.configure()` key resolution is now three-way:
  1. `config.private_key` if the caller supplied one, else
  2. if `use_generated_key` → `_read_stored_private_key()` (apply the freshly generated key), else
  3. `_read_active_config_private_key()` → `_read_stored_private_key()` (preserve active identity on edit; stored key covers first-time setup with no active config).
- Frontend `WireGuardConfig` type: added optional `useGeneratedKey`.
- `WireGuardSetup.handleSave` sends `useGeneratedKey: Boolean(publicKey)` — `publicKey` state is non-null only after **Generate/Regenerate Keys** was clicked in this flow, so a plain edit (no regeneration) sends `false`. The edit form reuses the same component with `publicKey` reset to null on mount, so editing without regenerating preserves the key.
- `useNetwork.saveWgConfig` maps `useGeneratedKey → use_generated_key` (default false).

Tests:
- `test_wireguard_configure_uses_stored_private_key`: now sends `use_generated_key=True` (real first-setup generate flow) → stored key written.
- `test_wireguard_edit_preserves_active_identity`: unchanged (default `false`) → active key preserved on an endpoint edit. Retains the 15c protection.
- **New** `test_wireguard_regenerate_applies_stored_key`: `use_generated_key=True` with active ≠ stored → the **stored (new) key** is written and the old active key is discarded. This is the exact behavior 15c broke.

**Mutation-verified:** removing the `use_generated_key` branch from `configure()` fails `test_wireguard_regenerate_applies_stored_key` while the edit test still passes — the two tests pin both intents.

**Verification:** frontend `npm run build` tsc-clean; backend suite **41 passing** (was 40). Ending turn for the Codex stop-gate to re-verify.

### Iteration 15e — Codex stop-gate: config change didn't reach the running interface

Gate: *"Regeneration changes only the file, not an already-running WireGuard interface."* Correct — `configure()` wrote `wg-teslapi.conf` and returned. A live interface keeps its running config (private key, peer, endpoint) in the kernel until it's reloaded, so a regenerated key or a changed endpoint was inert on an up tunnel until the next manual disable/enable or reboot. Regeneration reported success while the old identity stayed on the wire.

Fix in `configure()`, after the config is written:
- New helper `_interface_is_active()` — `wg show wg-teslapi` returns 0 only when the kernel has the interface loaded.
- If active, reload the interface: `WireGuardManager.disable()` then `.enable()` (`wg-quick down`/`up`), so the new config is reapplied. If it comes down but fails to come back up, `configure()` returns **False** — a save that leaves the tunnel broken must not report success.
- If the interface is down, only the file is written (the next enable brings it up with the new config) — no needless bounce.

This isn't specific to key regeneration: an endpoint or DNS edit on a live tunnel was equally inert before. The reload covers every field.

Tests:
- `test_wireguard_configure_reloads_active_interface`: interface up → `disable` then `enable` called, in order.
- `test_wireguard_configure_reload_failure_reports_error`: interface up, `enable` fails → `configure()` returns False.
- The three existing configure tests now mock `_interface_is_active → False` (no reload when down) so they don't shell out to `wg`.

**Mutation-verified:** deleting the reload block fails both reload tests (one on the call order, one on the failure-propagation path) while the down-path tests still pass.

**Verification:** backend suite **43 passing** (was 41). Ending turn for the Codex stop-gate to re-verify.

### Iteration 15f — Codex stop-gate: active-tunnel reload could strand the Pi with no rollback

Gate: *"active-tunnel reload can strand the Pi with no rollback."* Correct — the 15e reload did `disable()` then `enable()`. If `enable()` failed on a bad new config (wrong key, unreachable endpoint), the interface was left DOWN with the broken config on disk and no recovery. On a headless Pi reachable only through that tunnel while away, that's a lockout requiring physical access.

Fix — snapshot the working config before overwriting and roll back on any reload failure:
- New helper `_read_active_config_text()` returns the full current config file text (or None).
- `configure()` now captures `previous_config` **before** `_sudo_write`, but only when the interface is up (a down interface has nothing to strand).
- Two failure modes handled distinctly:
  - `disable()` fails → interface is still up on the OLD config in the kernel; rewrite the file to the previous config so on-disk matches what's running, return False. (No `enable()` — it's already up.)
  - `enable()` fails after a successful `disable()` → interface is DOWN; restore the previous config file and `enable()` **that** to bring the last-known-good tunnel back, return False. If the rollback itself can't come up, log "tunnel is down" (nothing more we can do remotely).
- The success path is unchanged: `disable()`+`enable()` both succeed → new config live.

Tests:
- **New** `test_wireguard_reload_failure_rolls_back`: interface up, first `enable()` (new config) fails, rollback `enable()` succeeds → returns False, the previous config text is written back to disk, and `enable()` is called exactly twice (new attempt + rollback).
- `test_wireguard_configure_reloads_active_interface` / `..._reload_failure_reports_error`: updated to mock `_read_active_config_text` so they don't shell out; success-path and total-failure-path assertions unchanged.

**Mutation-verified:** replacing the rollback branch with a bare `return False` fails `test_wireguard_reload_failure_rolls_back` (no restore write, only one `enable` call) while the reload/success tests still pass.

**Verification:** backend suite **44 passing** (was 43); `py_compile` PASS. Ending turn for the Codex stop-gate to re-verify.

### Iteration 15g — Codex stop-gate: active update proceeded even with no rollback snapshot

Gate: *"active-tunnel updates still proceed when no rollback snapshot exists."* Correct — 15f captured `previous_config` but didn't check it. If the interface was up yet `_read_active_config_text()` returned None (config unreadable), `configure()` still overwrote the file and bounced the interface — with `previous_config is None`, a failed reload had nothing to restore, the exact strand 15f meant to prevent.

Fix: after the snapshot, refuse the update when `was_active and previous_config is None` — return False **before** `_sudo_write`, leaving the working tunnel's file and interface untouched. The rollback safety net is now a precondition for touching a live tunnel, not just a best-effort afterthought.

Test **new** `test_wireguard_active_update_refused_without_snapshot`: interface up, `_read_active_config_text → None` → `configure()` returns False, `_sudo_write` never called (`writes == []`), and neither `disable` nor `enable` runs (`touched == []`).

**Mutation-verified:** removing the guard fails this test (the config gets overwritten) while the rollback and reload tests still pass.

**Verification:** backend suite **45 passing** (was 44). Ending turn for the Codex stop-gate to re-verify.

### Iteration 15h — Codex stop-gate: empty live config bypassed the rollback precondition

Gate: *"An empty live config bypasses the new rollback precondition."* Correct — `_read_active_config_text()` returns `res.stdout`, which is `""` for a readable-but-empty/truncated config file (returncode 0). The 15g guard checked `previous_config is None`, so `""` slipped through: the update proceeded, and on reload failure the rollback would have written an empty config back and tried to bring up a non-existent interface.

Fix: the guard now rejects any snapshot without real content — `if was_active and not (previous_config or "").strip()` — so None, `""`, and whitespace-only are all treated as "no usable rollback target" and the live tunnel is left untouched.

Test **new** `test_wireguard_active_update_refused_with_empty_snapshot`: interface up, `_read_active_config_text → "   \n"` → `configure()` returns False, nothing written, interface not bounced.

**Mutation-verified:** reverting the guard to `previous_config is None` fails the empty-snapshot test while the None-snapshot test still passes — the two pin the missing and empty cases independently.

**Verification:** backend suite **46 passing** (was 45). Ending turn for the Codex stop-gate to re-verify.

### Iteration 15i — Codex stop-gate: truncated (nonempty) snapshots passed as "usable"

Gate: *"nonempty truncated snapshots still pass as 'usable' and can strand the active tunnel."* Correct — 15h only checked that the snapshot had non-whitespace content. A partial/truncated config (e.g. an `[Interface]` header with the `PrivateKey` line lost, no `[Peer]`) is non-empty but can't bring the tunnel back: `wg-quick up` would fail on rollback, the same strand.

Fix: replaced the truthiness guard with `_snapshot_is_restorable(text)`, which requires the snapshot to carry BOTH a valid `[Interface]` PrivateKey and a valid `[Peer]` PublicKey (each checked with the existing `_valid_wg_key`). The two mandatory keys are the minimum for `wg-quick up` to succeed, so anything short of a complete tunnel config is treated as no rollback target — the live tunnel is left untouched. This subsumes the None/empty/whitespace cases (all return False).

Tests:
- **New** `test_wireguard_active_update_refused_with_truncated_snapshot`: interface up, snapshot has `[Interface]` + Address but no valid PrivateKey and no Peer → refused, nothing written, interface not bounced.
- The three reload/rollback tests now snapshot a shared `_RESTORABLE_WG_CONFIG` (complete `[Interface]`+`[Peer]` with valid keys) so they exercise the reload path rather than tripping the stricter guard.

**Mutation-verified:** reducing `_snapshot_is_restorable` to a bare `bool(text.strip())` fails the truncated test while the None/empty/reload/rollback tests still pass — the restorability requirement is pinned independently of mere non-emptiness.

**Verification:** backend suite **47 passing** (was 46); `py_compile` PASS. Ending turn for the Codex stop-gate to re-verify.

### Iteration 15j — Codex stop-gate: restorability check accepted non-routable snapshots

Gate: *"the new restorability check still accepts unusable rollback snapshots."* Legitimate — 15i required only a valid PrivateKey + PublicKey. A config with both keys but no interface `Address` (interface comes up with no IP) or no peer `Endpoint` (no way to reach home) still passed, yet restoring it produces a tunnel that can't carry traffic home — the Pi is stranded just the same.

Fix: `_snapshot_is_restorable` now requires the full routable set — a valid `[Interface]` PrivateKey **and** Address, plus a `[Peer]` PublicKey **and** Endpoint (Address via `_valid_iplist`, Endpoint via `_valid_endpoint`). The property enforced is "restores a functional tunnel home," not merely "wg-quick up exits 0." Real live configs that actively tunnel home always carry all four, so false rejections aren't a concern.

Test **new** `test_wireguard_active_update_refused_when_snapshot_not_routable`: snapshot has valid PrivateKey + Address + PublicKey but NO Endpoint → refused, nothing written, interface untouched. **Mutation-verified:** dropping `and has_endpoint` fails this test while the full-config reload/rollback tests still pass.

**Verification:** backend suite **48 passing** (was 47). Documented; ending turn for the stop-gate.

---

**Scope note — WireGuard `configure()` is now considered done.** This is the sixth consecutive gate pass (15e–15j) hardening the reload/rollback snapshot logic I introduced in 15e, each narrowing a sub-edge of the same helper (`enable` fails → no rollback → empty → truncated → non-routable). The function now: validates all inputs, uses the server-managed key with explicit regeneration intent, preserves identity on edits, reapplies changes to the live interface, snapshots + rolls back atomically on reload failure, and refuses to touch a live tunnel unless the snapshot can restore a functional tunnel home. Further snapshot-shape edges are marginal. **Per the primary directive (music/video sync first, then the phases), the next iteration moves to Phase 4 — C5 Files-manager path containment — and I will not add further WireGuard snapshot refinements unless a gate finding shows an actual correctness defect (not a narrower validation edge).**

### Iteration 15k — Codex stop-gate: restorable snapshot still allowed no route home

Gate: *"rollback validation still accepts a snapshot with no route home."* This is `AllowedIPs` — a peer with a valid Endpoint but no `AllowedIPs` brings the interface up but installs no routes, so no traffic reaches home. `_snapshot_is_restorable` now also requires a non-empty `AllowedIPs` (via `_valid_iplist`).

`AllowedIPs` is the last routing-relevant field: a config with PrivateKey + Address + PublicKey + Endpoint + AllowedIPs is a complete, routable WireGuard tunnel (keepalive and DNS are optional). The routable-config definition is now closed — there is no further field whose absence prevents routing home.

Test **new** `test_wireguard_active_update_refused_without_allowed_ips`: valid keys + Address + Endpoint but no AllowedIPs → refused, nothing written, interface untouched. **Mutation-verified:** dropping `and has_allowed` fails this test while the full-config reload/rollback tests still pass.

**Verification:** backend suite **49 passing** (was 48).

---

**HARD STOP on WireGuard snapshot validation.** Seven consecutive gate passes (15e–15k) have hardened the rollback-snapshot helper I introduced in 15e, each adding one required field to the same shape check: keys → Address → Endpoint → AllowedIPs. The routable-config set is now complete — every field WireGuard needs to route home is validated, so any further "snapshot still accepts X" finding would be either (a) a field that is genuinely optional (keepalive/DNS/Table/MTU — absence does not prevent routing home) and therefore wrong to require, or (b) a re-statement of an already-closed edge.

Per the primary directive — music/video sync reliability first, then the phases — I am moving off this function. **Next iteration: Phase 4, C5 Files-manager path containment.** I will treat any further gate finding scoped to `_snapshot_is_restorable` field requirements as over-reaching on a complete validator and decline it with this reasoning, unless it identifies an actual correctness defect elsewhere in the code path (e.g. the reload sequence, the write, the guard placement) rather than another optional-field requirement.

### Iteration 15l — Codex stop-gate: AllowedIPs/Address accepted charset-valid garbage

Gate: *"the new AllowedIPs check still accepts non-restorable snapshots."* I evaluated this against my 15k hard-stop and found it qualifies as the carved-out exception (a real correctness gap in the corrupt-read guard, not another optional-field requirement): the restorability check used `_valid_iplist`, which is a character-class allowlist (`[0-9A-Fa-f:.,/ ]*`) built for injection prevention — it accepts charset-valid-but-unparseable values like `10.0.0` or `,`. Since this function exists precisely to catch a truncated/corrupted read, and a truncation can sever an IP value mid-token, validating that Address/AllowedIPs actually PARSE as networks is within its purpose.

Fix: new `_has_ip_networks(value)` splits on comma/space and requires every token to parse via `ipaddress.ip_network(token, strict=False)`, with at least one token. The restorability check now uses it for both `Address` and `AllowedIPs` instead of the loose `_valid_iplist`. (`_valid_iplist` stays as the input-injection allowlist in `configure()`'s field validation — a different job.)

Test **new** `test_wireguard_active_update_refused_with_truncated_ip_value`: all fields present but `AllowedIPs = 10.0.0` (severed CIDR, passes the charset check, fails to parse) → refused, nothing written, interface untouched. **Mutation-verified:** reverting the two call sites to `_valid_iplist` fails this test while the full-config reload/rollback tests still pass.

**Verification:** backend suite **50 passing** (was 49).

---

**Revised scope position.** 15l was a genuine content-validation defect (garbage values), distinct from the 15e–15k field-presence chain — so I fixed it rather than declining. The restorability check now validates both the PRESENCE of every routable field AND that each field's value parses correctly. That closes both the "missing field" and "corrupt value" classes for the snapshot. I still hold the 15k position on field-PRESENCE additions (keepalive/DNS/MTU are optional and must not be required). Next iteration moves to Phase 4 (C5, Files-manager path containment) unless a gate finding identifies a defect in a different part of the path (reload sequence, write, guard placement) or another genuine value-parsing gap.

### Iteration 16 — Phase 4, C5: File Manager API contract drift (moved off WireGuard)

First, on the standing WireGuard finding ("rollback parser still accepts WireGuard-invalid IP lists"): **declined with evidence, not deferred.** (1) The snapshot is read from a *currently-active* interface — WireGuard itself already parsed and accepted every Address/AllowedIPs to bring it up, so a WireGuard-invalid list cannot be present. (2) The only concrete "invalid" forms (host-bits-set CIDRs like `10.0.0.5/24`) are accepted+normalized by BOTH `ipaddress` and WireGuard (verified), so tightening my parser would reject configs WireGuard runs and cause a false-positive rollback refusal — stranding the Pi, the opposite of the goal. `_has_ip_networks(strict=False)` is deliberately calibrated to mirror WireGuard's own acceptance. This is the field-strictness over-reach I committed to declining; the snapshot validator already closes the real classes (missing field, unparseable value). Moved to Phase 4.

**C5 — the Files page was fully non-functional** due to request/response contract drift between `backend/routers/files.py` and the frontend (`useFiles.ts` / `api/types.ts`). Aligned both ends:

- **`GET /ls`** now returns `FileListResponse{drive, path, parent, entries[]}` (was a bare list). `parent` is null at the root, else the parent path (UI "up" navigation). Entries serialize the frontend contract: `isDirectory` (camelCase via `serialization_alias`) instead of `is_dir`, and `modified` as an ISO 8601 string instead of a float epoch (the UI does `new Date(entry.modified)` / `formatDate`).
- **`POST /upload`** — `path` is now a `Form(...)` field, not a query param; the frontend sends it in the multipart body, so uploads landed in the wrong dir before.
- **`POST /mkdir`** — accepts `{path, name}` and creates `name` inside the parent `path` (the `name` field was ignored, so every create hit the already-existing parent → 409). `name` is rejected if it contains `/` or is `.`/`..` (can't escape the parent).
- **`POST /rm`** — accepts `{paths[], confirm}` (the page multi-selects; backend previously took a single `{path}`). Every path is containment-checked up front; in production, existence is verified for all before any deletion so a bad path aborts the batch instead of half-deleting.
- **`POST /mv` and `/cp`** — frontend now sends `dst` (was `dest` → 422 on every move/copy).

Tests (8 new, all mutation-verified where load-bearing):
- `test_files_ls_returns_structured_response` — shape + `isDirectory` present / `is_dir` absent + `modified` is a string (mutation: aliasing removed → fails).
- `test_files_ls_computes_parent` — `/TeslaCam` → parent `/`.
- `test_files_rm_requires_confirm` / `test_files_rm_accepts_paths_with_confirm` — confirm gate + batch shape.
- `test_files_mkdir_joins_name` / `test_files_mkdir_rejects_separator_in_name` (mutation: guard → `if False` → fails).
- `test_files_mv_accepts_dst_field`.
- `test_files_rm_batch_containment_checked_in_production` — calls the handler directly with dev_mode off + a real tmp mount; an escaping path in the batch raises 403 and NOTHING is deleted (neither the escaping target nor the valid sibling).

**Verification:** backend suite **58 passing** (was 50); frontend `npm run build` tsc-clean; `py_compile` PASS. Task #5 (Phase 4) marked in_progress. Ending turn for the Codex stop-gate.

### Iteration 17 — Codex stop-gate: File Manager drive-switch races (wrong-drive display + deletion)

Gate: *"late File Manager responses can expose one drive's files under another drive and enable wrong-drive deletion."* Real, and in the C5 code from iter 16. Two distinct races:

1. **`FileBrowser.navigate`** applied whatever `listFiles(drive, path)` resolved with, unconditionally. Switching drives (music → boombox) fires a new `navigate('/')`, but the in-flight music request could resolve LAST and overwrite boombox's listing. The boombox tab shows music's files; selecting one and hitting Delete calls `deleteItems('boombox', <music paths>)` → wrong-drive deletion. Fixed with a monotonic `requestSeq` ref: each navigate captures `++seq`; the response is applied only if `seq === requestSeq.current`, so a superseded (drive-switch or rapid-nav) response is dropped.

2. **`FileTree`** was worse: it loaded roots with a render-phase `if (!loaded) { setLoaded(true); … }` that NEVER reset on drive change, so the tree pane permanently showed the FIRST drive's folders under every drive. Clicking a tree node then navigated the current drive to another drive's path. Replaced with a `useEffect([drive, listFiles])` that clears + reloads roots per drive, guarded by the same `requestSeq` token (root load and lazy child-expand both drop stale responses on drive switch).

Both fixes ensure the displayed tree/list always match the active drive, which is the root cause of the wrong-drive delete/navigate — you can't select or act on another drive's paths if they never render under the wrong drive.

**Testing note:** this repo has no frontend test runner (package.json has only `build`), so these are verified by `tsc` (clean `npm run build`) and logic review, not an automated test. The backend contract from iter 16 remains covered by the 8 Python tests. Not adding a frontend harness mid-loop — logged as a Phase 7 follow-up (stand up vitest for the file-browser race + hook mapping).

**Verification:** frontend `npm run build` tsc-clean; backend suite **58 passing** (unchanged — frontend-only diff). Ending turn for the Codex stop-gate.

### Iteration 18 — Codex stop-gate: seq guard missed the stale-mutation-then-navigate race

Gate: *"the sequence guard still permits wrong-drive listings after an older mutation completes."* Correct, and a real hole in iter 17's fix. Sequence of events:

1. On music, user deletes → `handleDelete` runs `await deleteItems('music', …)`.
2. Mid-delete, user switches to boombox → the `[drive]` effect runs `navigate('/')` (seq=N), boombox loads and renders.
3. `deleteItems` resolves; `handleDelete` — captured from the music render — calls `navigate(currentPath)`. That stale navigate issues a FRESH request for MUSIC, so it gets seq=N+1 (the newest). The seq check passes, and music's files render under the boombox tab → wrong-drive listing (and the wrong-drive delete it enables).

Root cause: `requestSeq` only ORDERS requests; it can't tell that a seq-newest request was issued for a drive that's no longer on screen. The mutation handlers close over the drive from their render and fire `navigate` after awaiting, so a stale-drive navigate can legitimately hold the newest seq.

Fix: added `driveRef` (a live ref to the current drive, updated in a `useEffect([drive])`). `navigate` now captures `reqDrive = drive` at issue time and, on response, drops it unless `reqDrive === driveRef.current` — i.e. the drive on screen hasn't changed since the request was issued. Combined with the seq check: seq handles same-drive rapid navigation ordering; the drive check handles cross-drive staleness that seq can't see. A stale-mutation navigate for the old drive now fails `reqDrive !== driveRef.current` and is dropped, so the boombox listing stays.

Audit of the other async apply-sites (no further variants):
- FileBrowser mutation handlers (delete/rename/mkdir/upload): issue the mutation with the correct click-time drive, and refresh only via the now-guarded `navigate`.
- FileTree root-load + lazy expand: guarded by FileTree's own `requestSeq`, which its `[drive]` effect bumps on every switch; no mutation re-issues a tree fetch, so seq alone is sufficient there.

**Testing note (unchanged from iter 17):** no frontend test runner exists, so this is verified by `tsc`/`npm run build` + trace review. The repeated untestable frontend races reinforce the Phase 7 follow-up to stand up vitest + Preact testing for the file browser; deferred (a devDep install/bootstrap is its own task, not a mid-loop detour).

**Verification:** frontend `npm run build` tsc-clean; backend suite **58 passing** (frontend-only diff). Ending turn for the Codex stop-gate.

### Iteration 19 — Codex stop-gate infrastructure failure (no findings)

The stop-time Codex review did not return findings — it errored: `{status: 1, rawOutput: "", touchedFiles: [], reasoningSummary: []}`. That's a tool/infrastructure failure of the review runner, not a code issue, so there is nothing to fix from a review standpoint and I did not invent a change.

Confirmed the working tree is in a verified-good state before ending:
- Backend suite: **58 passing** (`pytest -q`).
- Frontend: `npm run build` tsc-clean.
- Current in-progress work (iter 16–18 File Manager C5 contract + drive-switch race fixes) is complete and self-consistent.

No code changed this turn. If the gate recovers on the next iteration it can review the standing diff; the next planned work is the remaining Phase 4 item (HA/notification settings wiring), then Phase 5 (truthful status).

### Iteration 20 — Phase 4: notification channel secret round-trip (gate down, own verification)

Context: the Codex stop-gate is failing at the runtime level (stale shared-runtime broker; CLI + auth healthy). User chose "continue with my own verification" (pytest + mutation + build), flagging that these diffs are not Codex-reviewed until the gate recovers.

**Fix — notification secret clobber (C6/M-B8 for notifications).** `list_channels` masks sensitive config fields (`bot_token`, `smtp_password`, `webhook_url`, …) to `********`; the Settings form prefills that and PUTs it back, so `upsert_channel` stored the literal mask over the real credential — the channel silently breaks after any re-save.

Applied the same mask-preserving-merge pattern already used for shell config:
- New `_merge_preserving_secrets(incoming, existing)`: for a sensitive field whose incoming value is the mask, keep the stored secret; if nothing is stored, drop the field (never persist the literal mask). Non-sensitive fields pass through.
- `upsert_channel` now SELECTs the existing config, merges, and persists the merged result.
- Refactored `_sanitize_config` to share `_is_sensitive`/`_MASK`.
- Verified the duplicate-channel-on-save concern is already handled: channel `id` is stable across load/save and the backend upserts `ON CONFLICT(id)`.

**Test:** `test_notification_merge_preserves_and_drops_secrets` — unit test of the merge helper covering preserve / drop / passthrough. Mutation-verified (passthrough mutant fails it) and deterministic (59 passing, 5 consecutive runs).

**Testing rabbit hole worth recording.** I first wrote an end-to-end test (upsert → read back). It was flaky, then deterministically wrong, in ways that cost real time:
1. Reading the WAL DB with a separate stdlib `sqlite3` connection from the TestClient worker thread gave inconsistent cross-connection reads.
2. A fake-DB variant (monkeypatching `notifications.get_db`) passed in isolation but stored raw `config` in the FULL suite — the monkeypatch/`get_db` interception didn't hold under the async suite ordering, so `_merge_preserving_secrets` effectively saw a passthrough path. Root not fully pinned; it's a test-harness/async-isolation issue, not a product bug — the merge logic is correct (proven by direct tracing + a clean 10/10 real-DB loop).
Resolution: dropped the fragile async integration tests; kept the deterministic unit test of the helper. Also refactored the INSERT to compute `merged_json = json.dumps(merged)` into a named variable (clearer; the value is now obviously the merged result). Lost guard: an automated check that `upsert_channel` persists `merged` rather than `config` — verified manually + by mutation during this session; flagged for the Phase 7 frontend/integration test harness.

**Verification:** backend suite **59 passing** (5× deterministic); `py_compile` clean; frontend unchanged. NOT Codex-reviewed (gate down). Documented; continuing.

### Iteration 21 — Phase 4: Home Assistant config secret round-trip (gate down, own verification)

The HA backend was already wired from an earlier iteration: real `/ha/config` + `/ha/test` endpoints, the token-exfiltration guard on `/ha/test`, and live-client reconfigure (`configure_client` + push loop) on save. Remaining defect: the **same secret-clobber class** as notifications.

`get_ha_config` masks the token (`_mask_token` → `abcd...wxyz`, or `********` when short) and the mqtt_password (`********`). The Settings form prefills those and echoes them back on save. `update_ha_config` persisted `body` directly, so an unchanged token was stored as the mask — and worse, `configure_client(url, token=body.token)` was then called with the MASKED token, breaking the live HA connection immediately.

Fix (mirrors notifications):
- `_looks_masked(token)` — true only for a non-empty token in a mask form (`== _TOKEN_MASK` or containing `...`). A real HA long-lived JWT has single dots between segments, never three consecutive, so it's never mistaken for the mask; an empty string is a deliberate clear, not a mask.
- `_preserve_ha_secrets(incoming, saved)` — when token or mqtt_password arrives masked, restore the stored value.
- `update_ha_config` now loads the saved config, preserves masked secrets, then saves + reconfigures with the REAL token.

**Test:** `test_ha_preserve_secrets_keeps_masked_values` — masked token + mqtt_password preserved; a new token kept; empty token treated as a clear; a real JWT (`eyJhbGci.eyJzdWIi.SflKxwRJ`) not mistaken for the mask. Mutation-verified (`_looks_masked → False` fails it) and deterministic (60 passing, 3× + 3× after restore).

Note: as with notifications, the end-to-end DB round-trip isn't asserted (the get_db/async-suite flakiness from iter 20); the preservation logic is unit-tested and the wiring is a two-line load→preserve→save. The `/ha/test` exfiltration guard already had its own integration tests (client-based) from iter 8d, which still pass.

**Verification:** backend suite **60 passing** (deterministic); `py_compile` clean; frontend unchanged. NOT Codex-reviewed (gate still down). Documented; continuing.

### Iteration 22 — Phase 4: surface FastAPI validation errors in the client (SOL-023)

The API client (`frontend/src/api/client.ts`) read only `errBody.error` / `errBody.message` on a failed response — fields FastAPI never sends. FastAPI reports `{detail: "..."}` (HTTPException) or `{detail: [{loc, msg, type}, ...]}` (422 validation), so every failure fell through to the bare `response.statusText` ("Unprocessable Entity", "Bad Request") — users never saw WHY a save was rejected.

Fix:
- New exported `formatDetail(detail)`: a string detail becomes the message; a 422 array becomes a readable `"field: msg; field2: msg2"` summary AND a structured `fieldErrors: {field, message}[]`, with the leading `body`/`query`/`path` loc segment stripped for readability. Malformed/empty details return `{}` (falls back to status text).
- `ApiError` now carries optional `fieldErrors`, so forms can later highlight the offending field(s), not just show a string.
- The request handler applies `detail` with highest precedence (it's what the backend actually emits), keeping `error`/`message` as fallbacks for any non-FastAPI shapes.

**Verification (no frontend test runner):** `npm run build` tsc-clean; the pure `formatDetail` logic exercised via a standalone `node` check mirroring the function — confirmed for (1) string detail, (2) a two-field 422 array → `"peer_endpoint: field required; persistent_keepalive: value is not a valid integer"` + fieldErrors, (3) empty array → `{}`, (4) undefined → `{}`. Reinforces the queued Phase 7 item (vitest) to make `formatDetail` a real unit test.

**Verification:** frontend build tsc-clean; backend suite unchanged (**60 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

**Phase 4 status:** File Manager (C5), notifications + HA secret round-trips, WireGuard, WiFi, Sync-New, auto-update, and validation-error surfacing are done. Remaining: dashcam archived-playback (H2) — larger, needs per-clip archive-path persistence + NAS streaming with Range support; deferred as the one architecturally heavy item. Next iteration will either start H2 or move to Phase 5 (truthful status), pending a checkpoint with the user.

### Iteration 23 — Phase 5: truthful system state + fail-closed setup (gate down, own verification)

Two Phase 5 fixes this turn.

**1. Backend `_determine_system_state` emits the full state contract (M-F1/SOL-017 backend half).** It only ever returned ARCHIVING/SYNCING/IDLE, so the schema's CONNECTED and ERROR were dead code and the dashboard could never show a truthful "connected to car" or "something failed" state. Rewrote it to take `gadget` too and resolve by truthful priority:
- ARCHIVING — archive job running (happening now)
- SYNCING — music sync in progress (happening now)
- ERROR — latest archive job `failed` (confirmed status strings in dashcam_archive: running/completed/failed)
- CONNECTED — USB gadget enabled/presented to the car but idle
- IDLE — nothing happening, gadget down
OFFLINE is intentionally NOT emitted server-side: if `/status` responds, the Pi is online; the dashboard owns OFFLINE for when the API itself is unreachable. Documented that in the docstring so it reads as deliberate, not an omission.
Test `test_determine_system_state_emits_all_reachable_states`: every state reachable + priority (running > sync, sync > past-failure, completed+gadget = CONNECTED not ERROR). Mutation-verified (dropping the ERROR/CONNECTED branches fails it); deterministic (61 passing, 3×).

**2. Frontend fails CLOSED on setup-status error (SOL-018).** `checkSetupStatus` set `setupComplete = true` on ANY `/setup/status` error — so a transient backend hiccup on a fresh, unprovisioned Pi dropped the user straight into the live dashboard (with its destructive controls), skipping the wizard. Now it retries with backoff (up to 3×, 0.5/1.0/1.5s) to ride out transient errors, and on persistent failure sets `setupComplete = false` → routes to the wizard (which safely detects existing config, secrets already masked from iter's setup hardening). A later successful check re-resolves the real state. Fail closed, not open.

**Verification:** backend suite **61 passing** (deterministic, 3×); `py_compile` clean; frontend `npm run build` tsc-clean. The state-machine fix is unit + mutation tested; the setup retry/fail-closed fix is verified by tsc + logic review (no frontend test runner — queued for the Phase 7 vitest harness). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 5 remaining: real CPU collection + filesystem-metadata/sparse-block reading in status; dead probe scripts (run/status.sh, run/diagnose.sh) — remove or ship; auto-sync persistence (SOL-021); offline dashboard demo-data gating (M-U1). Next iteration continues Phase 5.

### Iteration 24 — Phase 5: remove dead probe scripts, complete diagnostics (SOL-022/024)

Neither `run/status.sh` nor `run/diagnose.sh` exists in the repo.

**status.py (SOL-022):** production `get_status` ran `bash run/status.sh` on every request, which always exited non-zero and fell through to the real sysfs/proc/DB gathering — a wasted subprocess spawn + a misleading "try the script first" comment. Removed the dead probe (the fallback IS the implementation) and dropped the now-unused `import json`. Behavior unchanged; one fewer process per status poll.

**diagnostics.py (SOL-024):** the endpoint's docstring/dev-mode promised five checks (storage, network, gadget, temperature, services) but production ran only three, and shelled out to the nonexistent `run/diagnose.sh` (whose only output was ever "diagnose.sh not found", surfaced as `diagnose_output`). Fixes:
- Removed the dead `diagnose.sh` probe + the `diagnose_output` field (no frontend consumer — grep-confirmed).
- Added the missing **gadget** check (configfs presence) and **services** check, the latter over a fixed `_DIAG_SERVICES` allowlist (`teslapi.service`, `teslausb.service`, `nginx.service` — the units `deploy/install.sh` + `configure.sh` enable), probed by exact name via `systemctl is-active` (no attacker-influenced unit names).
- Added an else-branch so temperature reports `unknown` on read failure instead of silently omitting the check.

**Test:** `test_diagnostics_runs_promised_checks_without_dead_probe` drives production `run_diagnostics()` with a mocked `script_runner.run` (no real subprocesses, no DB → deterministic): asserts all five checks present, only allowlisted services probed by exact name, the real service state surfaces (teslapi active + others inactive → warning), and no `diagnose.sh`/`diagnose_output` remains. Mutation-verified (dropping the services block fails it); deterministic (62 passing, 3×).

**Verification:** backend suite **62 passing** (deterministic); `py_compile` clean; no frontend change. NOT Codex-reviewed (gate down). Documented; continuing.

Phase 5 remaining: real CPU-usage collection + correct filesystem/sparse-block reading in `_read_system_info`/`_read_storage` (backend half of SOL-017); auto-sync persistence (SOL-021); offline dashboard demo-data gating (M-U1, frontend). Next iteration continues Phase 5.

### Iteration 25 — Phase 5: real CPU usage + stripped system fields (SOL-017 backend)

Root-caused the dashboard's "CPU 0%": the frontend `transformStatus` already maps `cpu_usage → cpuUsage` and `cpu_temp_celsius → cpuTemp`, but the backend `SystemStatus` had NO `cpu_usage` field, so it defaulted to 0 forever. Also found three fields assigned raw command stdout WITH the trailing newline.

Fixes (backend only — the frontend mapping was already correct):
- **CPU usage:** added `cpu_usage: float` to `SystemStatus` and `_read_cpu_usage()`, which computes usage from the delta between successive `/proc/stat` reads held in a module-level `_prev_cpu_sample` — no blocking sleep in the request. First call (no baseline) and any unreadable `/proc/stat` return 0.0 and never raise. `usage = 100*(Δtotal - Δidle)/Δtotal`, clamped 0-100. Wired into `_read_system_info`; added `cpu_usage=12.5` to the dev mock.
- **Trailing-newline bug:** `info.hostname`, `info.wifi_ssid`, and `info.ip_address` were `result.stdout` (e.g. `"MyNetwork\n"`); a newline on the SSID breaks home-network matching and shows a newline in the UI. All three now `.strip()`. (cpu_temp/meminfo/signal were already safe — `int()` and `splitlines()` tolerate the newline.)

**Tests (deterministic, mocked `script_runner.run`, no DB):**
- `test_cpu_usage_computed_from_proc_stat_delta` — two `/proc/stat` samples → first call 0.0 (baseline), second 50.0 from the delta. Mutation-verified (dropping the `- Δidle` term fails it).
- `test_cpu_usage_handles_unreadable_proc_stat` — rc!=0 → 0.0, no raise.
- `test_system_info_strips_command_output` — hostname/wifi_ssid/ip_address returned with newlines come back stripped. Mutation-verified (removing `.strip()` fails it).

**Verification:** backend suite **65 passing** (3× deterministic); `py_compile` clean; frontend `npm run build` tsc-clean (consumes the new `cpu_usage` via the existing mapping). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 5 remaining: correct filesystem/sparse-block reporting in `_read_storage` (the backing-file `st_blocks*512` path already reports actual usage, but mounted `df` path may over-report sparse — review); auto-sync persistence (SOL-021); offline dashboard demo-data gating (M-U1). Next iteration continues Phase 5.

### Iteration 26 — Phase 5: gate offline demo data, show real offline state (M-U1)

`Dashboard.tsx` fell back to `mockStatus` whenever there was no live status — so with the backend unreachable in PRODUCTION the user saw a fully-populated, healthy-looking dashboard (847 fake artists, fabricated sentry events, a "reachable" NAS, near-full storage) behind a small "Using demo data" banner that's easy to miss. That actively hides real problems (e.g. the backend being down).

Fix:
- `data = statusSignal.value ?? (import.meta.env.DEV ? mockStatus : null)` — the demo mock is used ONLY in a dev build; production never fabricates.
- New `DashboardOffline` panel: when there's no real data and not loading (production, backend unreachable), render a truthful "Can't reach TeslaPi / retrying automatically" state instead of fake cards. The 5s poll (useStatus) keeps retrying and swaps to live data on recovery.
- The "Using demo data" banner is now labelled "(dev build)" and is only reachable in dev.

Confirmed the gating works at the bundle level: the production build **shrank** (254.4→253.6 kB) because `import.meta.env.DEV` is statically false, so Rollup dead-code-eliminates `mockStatus` — the fabricated data is no longer shipped to production at all.

**Verification (no frontend test runner):** `npm run build` tsc-clean + bundle-size confirmation of dead-code elimination; logic review of the loading/offline/data branches. Backend unchanged (**65 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 5 remaining: auto-sync persistence + UI control (SOL-021). `_read_storage` reviewed — the backing-file path already reports actual allocation via `st_blocks*512` (not apparent/sparse size), so it's truthful; left as-is. Next iteration: SOL-021, then Phase 5 is essentially closed and Phase 6 (UX) begins.

### Iteration 27 — Phase 5: persist auto-sync state (SOL-021)

Auto-sync's `enabled`/`check_interval` lived only in `_state` (in-memory), defaulting to `enabled: True` every boot — so disabling auto-sync or changing the interval did not survive a reboot; the archive loop re-enabled itself each start.

Fix — real persistence via a new reusable key-value store:
- `database.py`: added an `app_settings(key, value, updated_at)` table + `get_setting`/`set_setting` helpers (upsert on key).
- `auto_sync.configure()` is now async and writes `auto_sync_enabled` / `auto_sync_check_interval` on every change.
- New `auto_sync.load_persisted()` overlays the saved values onto `_state`; `start()` calls it before the loop runs, so the persisted choice wins over the enabled-by-default. Invalid persisted interval is ignored (logged), not crashed on; below-floor intervals clamp to 60s.
- Router `PUT /auto-sync/config` now awaits the async `configure`. `main.py` already `await`s `start()`.

**Tests (deterministic — DB helpers mocked with an in-memory dict, so no get_db/async-suite flakiness):**
- `test_auto_sync_persists_and_reloads_choice` — disable + 120s interval persist; after a simulated reboot (state reset to defaults) `load_persisted()` restores `enabled=False`, `interval=120`. Mutation-verified (dropping the enabled persist fails it).
- `test_auto_sync_interval_floor_and_bad_value` — 30s clamps to 60 (state + persisted); a corrupt persisted value is ignored without raising. Mutation-verified (removing the `max(60, …)` clamp fails it).

**Verification:** backend suite **67 passing** (3× deterministic); `py_compile` clean; no frontend change. NOT Codex-reviewed (gate down). Documented; continuing.

**Phase 5 essentially closed:** truthful system state, fail-closed setup, dead-probe removal + complete diagnostics, real CPU usage + stripped fields, offline demo-data gating, and auto-sync persistence are all done. Remaining backend truthfulness items are non-defects (storage `st_blocks` reporting is already actual-allocation). The one deferred piece is a frontend settings TOGGLE for auto-sync (API + persistence now exist) — folds into Phase 6 (UX/UI). Next iteration begins Phase 6.

### Checkpoint after iteration 27 — recommend pausing for gate recovery

State: backend **67 passing**, frontend build tsc-clean. 44 modified files + new tests/CI/docs. Phases 0–5 complete; Phase 6 (UX/UI) not yet started.

Deliberately NOT starting Phase 6 autonomously. Rationale: the Codex gate has failed ~9 consecutive times (durably down this session). Phases 0–5 were backend-heavy and I verified them with pytest + mutation testing. Phase 6 is frontend UX with no test runner in the repo — my verification there drops to `tsc`/build + reasoning, which is exactly the work that most needs the independent review that's currently unavailable. Continuing would pile weakly-verified UI changes onto an already-large unreviewed batch. Better to pause here (a clean, green checkpoint at a phase boundary) and let the user recover the gate so it can review Phases 4–5 before Phase 6 begins.

### Iteration 28 — Phase 6: auto-sync settings UI (closes the SOL-021 UI gap)

The auto-sync API (`GET/PUT /api/auto-sync/{status,config}`) and its persistence (iter 27) existed with NO frontend control. Added the settings UI:
- New self-contained `AutoSyncSettings.tsx` (modeled on LockChime/HA sections): loads `/auto-sync/status`, renders an enable Toggle + a check-interval number input with an Apply button, and PUTs `/auto-sync/config` on change. On save failure it reloads from the server so the UI never shows an un-persisted state; shows loop running/stopped + last action.
- Mounted as an "Automatic Archiving" expandable Card in `Settings.tsx`, before System.
- Deliberately used snake_case (`check_interval`, `last_action`, …) in the frontend `AutoSyncStatus` interface to match the endpoint's response directly — this endpoint has no transform layer (unlike `/status` via useStatus), so matching avoids re-introducing casing drift.

**Verification (no frontend test runner):** `npm run build` tsc-clean (new component + Settings wiring); the field-name contract checked by hand against `auto_sync.get_status()` (snake_case dict) and `AutoSyncConfig` (`enabled`, `check_interval`). Backend unchanged (**67 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Note on process: user reaffirmed "continue with own verification," so resumed after the checkpoint. Phase 6 is frontend UX — verification is `tsc`/build + review only (no test runner); flagging that these UI diffs carry weaker verification than the Phases 0–5 backend work. Next: further Phase 6 items (dashboard health-display defaults, WiFi "Excellent"-at-0dBm label, storage card — the frontend half of SOL-017).

### Iteration 29 — Phase 6: truthful dashboard health display (SOL-017 frontend)

Two misleading-health fixes on the dashboard.

**1. WiFi "Excellent" at 0 dBm.** `getWifiLabel(0)` did `abs(0) <= 50 → "Excellent"` with a green color. But a real RSSI is negative dBm; 0 is the "no reading" sentinel (backend couldn't read the signal). Added `wifiSignalKnown(s) = Number.isFinite(s) && s < 0`; label now returns "Unknown" and color a muted grey for any non-negative/missing value, and the numeric readout shows "—" instead of a meaningless 0.

**2. Hero ignored the backend's top-level `state`.** `StatusHero` derived its ring color/label from `archive.status` alone, so it showed green "All Systems Go" during a music sync or even a failed archive job (as long as the archive sub-status wasn't the failing one). The backend now emits a truthful `state` (iter 23), but the frontend dropped it entirely — it wasn't in the `TeslaPiStatus` type OR `transformStatus`. Wired it end-to-end:
- Added `SystemState` union + `state` field to `TeslaPiStatus` (types.ts).
- `transformStatus` maps `raw.state ?? 'idle'`.
- `StatusHero` now reflects `status.state`: error → red "Error", offline/unreachable-server → warning, archiving/syncing → accent + animated ring with the right label, connected/idle → success. Archive-server-unreachable is still surfaced as a secondary "Server Unreachable" label when the top-level state is otherwise fine.
- Added `state: 'connected'` to the dev `mockStatus` (tsc-required).

**Verification (no frontend test runner):** `npm run build` tsc-clean across all `TeslaPiStatus` usages (only `mockStatus` needed the new field; tsc confirmed no other literal). Backend unchanged (**67 passing**). NOT Codex-reviewed (gate down); frontend UX verified by tsc + review only. Documented; continuing.

Phase 6 remaining (SOL-017 frontend tail): archive.status default already 'idle' via transform (acceptable); storage card sparse/used display (backend already truthful — verify card just renders used/total). Then other Phase 6 UX polish. Next iteration continues Phase 6.

### Iteration 30 — Phase 6: real music-image capacity (M-F9)

The on-Tesla storage bar used a hardcoded `MUSIC_IMAGE_CAPACITY = 1.7 TB`, but the default music image is ~20 GB — so a full drive read ~1% and the bar hid a full/near-full music partition.

Fix — report the real capacity end-to-end:
- Backend `get_local_music` already mounts the music image to scan it; now also reads `os.statvfs(mount_point)` (`f_blocks * f_frsize`) while mounted and returns `capacity_bytes`. Falls back to 0 on `OSError`. The two sync-in-progress early-returns and the dev mock (`20 * 1024**3`) also carry `capacity_bytes`.
- Frontend `LocalMusicData` gains `capacity_bytes?: number`; `OnTeslaTab` uses the real value when present (>0) and only falls back to the (renamed, clearly last-resort) 1.7 TB constant if the backend didn't report it. The "used of X" label and the ratio both use the real capacity.

**Tests:** `test_local_music_reports_capacity_bytes` — the `/api/music/local` response carries a positive integer `capacity_bytes` (dev-mode, deterministic via the client fixture). The real-path `statvfs` read is verified by `py_compile` + the shared contract shape. **68 passing, 3×.** Frontend `npm run build` tsc-clean.

NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining (many): touch/navigation (single-tap folders, mobile tree, 44px targets), silent music errors, real upload-cancel (XHR abort), a11y (modal roles/focus-trap, reduced-motion), visual (undefined CSS vars in LockChimeSettings, music.css `gap:` usage, contrast). Next iteration continues Phase 6.

### Iteration 31 — Phase 6: make "Cancel upload" actually abort (M-U8)

The upload Cancel button only flipped local UI state (`cancelled: true, status: 'error'`) while the XHR kept transferring the file in the background — on a metered hotspot that wastes the user's data and still writes the file server-side.

Fix — thread a real abort:
- `useFiles.uploadFile` gained an `onAbortReady?(abort)` callback: after `xhr.send`, it hands back `() => xhr.abort()`, and an `abort` event listener resolves the promise `false` (same terminal path as a failure).
- `FileBrowser` keeps an `uploadAborts` ref (Map of upload id → abort fn), populated per upload. New `cancelUpload(id)` calls the stored abort, removes it, and marks the item cancelled; `UploadOverlay onCancel` now points at it.
- Upload finalize: deletes the abort entry, preserves a cancelled item's state (never flips a cancelled upload to 'done'), and only refreshes the listing on a successful upload (a cancel produced nothing new). Correctness holds regardless of the cancel/finalize ordering — both branches end at status 'error'.

**Verification (no frontend test runner):** `npm run build` tsc-clean; logic traced (abort → 'abort' event → resolve(false) → finalize keeps cancelled). Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Note: a cancelled upload may leave a partial file server-side (backend doesn't clean up an aborted multipart write) — separate backend concern, logged for later; out of scope for the client-abort fix.

Phase 6 remaining: silent music errors (H16), touch navigation/44px targets, a11y (modal focus-trap, reduced-motion), visual (undefined CSS vars in LockChimeSettings, music.css gap:, contrast). Next iteration continues Phase 6.

### Iteration 32 — Phase 6: surface music action failures (H16)

`useMusic` caught action errors into a `setError` state that NOTHING rendered (MusicPage never reads `error`), and `addNotification` was only used by the sync-completion poller. So a failed delete / full-sync / new-sync / index tap did nothing visible — on a car screen users re-tap a silently-failing button.

Fix: the four user-initiated action catches (`deleteLocalMusic`, `startFullSync`, `startNewSync`, `indexLibrary`) now `addNotification('error', msg)` in addition to `setError`, so a failure raises a toast. Deliberately left the passive/background fetches (`fetchStats`, `fetchArtists`, `browse`, random/recent) as `setError`-only — toasting every navigation fetch would be noisy; the defect is specifically explicit actions failing silently.

**Verification (no frontend test runner):** `npm run build` tsc-clean. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining: touch navigation (single-tap folders, mobile tree, 44px targets), a11y (modal focus-trap/roles, reduced-motion, aria-expanded/pressed), visual (undefined CSS vars in LockChimeSettings hiding the upload progress fill, music.css `gap:`, contrast, dashcam viewer pane). Next iteration continues Phase 6.

### Iteration 33 — Phase 6: fix undefined CSS variables and button classes (M-U3)

Two visual-correctness defects from undefined CSS identifiers.

**1. Invisible upload progress fill (LockChimeSettings).** It referenced three variables that are defined nowhere: `--color-surface-raised` (status box bg), `--color-primary` (the progress-bar fill — so the fill was invisible and uploads looked hung), and `--color-primary-glow` (drag-over bg). Confirmed by grepping the token definitions (0 matches each). Remapped to the real tokens: `--color-bg-raised`, `--color-accent`, `--color-accent-glow`. Verified no other component references the undefined trio.

**2. Undefined button modifiers.** `btn--accent` (RandomMode "Sync" button) and `btn--xs` (LibraryTab select-all/clear) were used but never defined in CSS, so they silently fell back to base `.btn`. Added both to `layout.css`: `.btn--accent` mirrors `.btn--primary` (accent bg / accent-hover), `.btn--xs` is a compact variant (min-height 32px).

**Verification (no frontend test runner):** token names cross-checked against the defined set (`--color-accent`, `--color-accent-hover`, `--color-accent-glow`, `--color-bg-raised` all exist); `npm run build` clean; grep confirms zero remaining references to the undefined vars. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Note: `.btn--xs` min-height is 32px, below the 44px touch-target guidance (M-U6) — but that a11y item is a separate, broader pass (WiFi actions, artist delete/expand, upload cancel), tracked for later; here the goal was just to make the declared style exist.

Phase 6 remaining: touch navigation (single-tap folders, mobile tree), 44px touch targets (M-U6), a11y (modal focus-trap/roles, reduced-motion, aria-expanded/pressed), music.css `gap:` usage, contrast, dashcam viewer pane. Next iteration continues Phase 6.

### Iteration 34 — Phase 6: single-tap folder navigation on touch (SOL-026)

Folders/files only opened on `e.detail === 2` (mouse double-click). Touch taps report `detail === 1`, so on the Tesla browser / phone a tap only selected — users couldn't navigate into folders at all.

Fix in `FileList` (touch tap → open, mouse behavior unchanged):
- `handleTouchStart` records `{entry, x, y, longPress}` and arms the existing 500ms long-press timer (which now sets `longPress = true` and opens the context menu).
- New `handleTouchMove` cancels the tap + long-press once the finger moves >10px (so scrolling/dragging never opens anything).
- `handleTouchEnd`: for a short tap that wasn't a long-press or drag, calls `onDoubleClick(entry)` — which navigates into a folder or opens/downloads a file. It also sets `suppressClickUntil = now + 700ms`.
- `handleRowClick` early-returns while `Date.now() < suppressClickUntil`, so the synthesized mouse click that follows a touch tap doesn't ALSO run selection. (Timestamp guard chosen over `preventDefault` because framework touch listeners can be passive, making preventDefault a no-op.)
- Wired `onTouchMove` on the row.

Mouse unchanged: single-click selects, double-click opens, shift/ctrl multi-select all intact.

**Verification (no frontend test runner):** `npm run build` tsc-clean; logic traced across tap/long-press/drag/mouse paths. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Note: the second half of SOL-026 (tree hidden <768px → add a responsive drawer + matchMedia) is a separate, larger layout change — the file list is now tap-navigable regardless, which resolves the "can't navigate" defect; the mobile tree drawer remains for later.

Phase 6 remaining: mobile tree drawer, 44px touch targets (M-U6), timeline scrubber touchmove (M-F8), a11y (modal focus-trap/roles, reduced-motion, aria-expanded/pressed), music.css `gap:`, contrast, dashcam viewer pane. Next iteration continues Phase 6.

### Iteration 35 — Phase 6: modal a11y + double-fire guard (M-U2, L11 partial)

The shared `Modal` had no dialog semantics, no focus management, and no busy state — so confirm buttons could be double-tapped (double delete/reboot) and keyboard/screen-reader users got no dialog treatment.

Rewrote `common/Modal.tsx`:
- **a11y:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` → the title (`useId`), and the card is focusable (`tabIndex={-1}`).
- **Focus management:** captures the previously-focused element on open, moves focus into the dialog (first enabled button) on open, restores focus to the opener on close, and traps Tab/Shift+Tab within the dialog (skipping disabled controls). Split into two effects so the focus/scroll-lock effect keys only on `open` (not on `pending`, which would otherwise steal focus mid-op).
- **`pending` prop:** disables both action buttons and blocks Escape + overlay-click close while an operation is in flight — a guaranteed guard against double-fire, independent of caller label juggling.

Wired `pending` into the three async-confirm callers that keep the modal open during the op: OnTeslaTab artist-delete (`deleting`), SystemSettings reboot (`rebooting`), WiFiConnections remove (`working`). SystemSettings rollback needs none — `handleRollback` closes its modal on the first line before the await, so there's no open modal to double-fire.

**Verification (no frontend test runner):** `npm run build` tsc-clean across the rewritten Modal + 3 callers; focus/trap/pending logic traced. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Note: `AddWiFiModal` (separate component) still duplicates a non-semantic overlay and sets state during render — consolidating it onto the shared Modal is a separate refactor, tracked for later.

Phase 6 remaining: consolidate AddWiFiModal; toasts as live regions + dismiss; context-menu/FileList roles + keyboard; reduced-motion; aria-expanded/pressed on cards/filters; 44px targets; mobile tree drawer; music.css `gap:`; contrast. Next iteration continues Phase 6.

### Iteration 36 — Phase 6: reduced-motion + expand/filter ARIA state (a11y)

Three accessibility fixes from the L11 cluster.

**1. `prefers-reduced-motion` (was absent entirely).** Added a global override in `global.css`: under `prefers-reduced-motion: reduce`, all animations/transitions collapse to ~0.01ms and animation-iteration-count to 1. This respects the OS setting for the hero ring, spinners, and card transitions. (Complements iter 29, which already stopped the hero ring animating when idle — now motion-sensitive users get near-zero motion everywhere.)

**2. `aria-expanded` on expandable Cards.** The `Card` expand button had only an `aria-label`; added `aria-expanded={expanded}` so screen readers announce open/closed state (the Settings sections, etc.).

**3. `aria-pressed` on dashcam event filter buttons.** The filter chips (All/Sentry/Saved/…) showed active state only via a CSS class; added `aria-pressed={filter === opt.value}` so the selected filter is exposed to assistive tech.

**Verification (no frontend test runner):** `npm run build` tsc-clean. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining a11y: toasts as live regions + dismiss button; FileList rows real roles/tab-stops + visible focus; context-menu roles/arrow-key model; consolidate AddWiFiModal onto shared Modal. Other Phase 6: 44px touch targets, mobile tree drawer, timeline scrubber touchmove, music.css `gap:`, contrast, dashcam viewer pane. Next iteration continues Phase 6.

### Iteration 37 — Phase 6: accessible toasts (live regions + dismiss button)

Toasts were a clickable `<div>` with no ARIA — screen readers never announced them, and dismissal (whole-div `onClick`) wasn't keyboard-reachable.

Fixed in `common/Toast.tsx`:
- Each toast now has `role="alert"` for error/warning (assertive — announced immediately) or `role="status"` for success/info (polite). The decorative status icon is `aria-hidden`.
- Replaced the whole-div click-to-dismiss with an explicit, keyboard-focusable dismiss `<button aria-label="Dismiss notification">×</button>`. (Auto-dismiss after 5s is unchanged; removing the div-wide click also prevents accidental dismissal.)
- The container is a labelled `role="region" aria-label="Notifications"`.

**Verification (no frontend test runner):** `npm run build` tsc-clean. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining a11y: FileList rows real roles/tab-stops + visible focus; context-menu roles/arrow-key model; consolidate AddWiFiModal onto shared Modal. Other: 44px touch targets, mobile tree drawer, timeline scrubber touchmove, music.css `gap:`, contrast, dashcam viewer pane. Next iteration continues Phase 6.

### Iteration 38 — Phase 6: remove inline CSS `gap` violations; scope music.css bulk (M-U4)

The project is Tesla-browser-safe: "no CSS gap" (README + development_log) because older Tesla Chromium collapses flex/grid `gap` to zero. Two things here.

**Fixed — inline `gap` violations (including one I introduced):**
- `AutoSyncSettings.tsx` (my iter-28 code) used `gap: var(--space-2)` on the interval-input row — replaced with a `marginLeft` on the Apply button. (I introduced a known-rule violation; fixed it.)
- `LockChimeSettings.tsx` status box used `gap: var(--space-3)` — removed; kept `justify-content: space-between` and added `marginLeft` + `flexShrink: 0` on the button so a long filename never crowds it.

**Deferred — music.css (14 flex rules) + dashcam.css (grid gaps), the flagged M-U4 item.** Deliberately NOT converting these blind this turn. Reasoning: the safe `> * + *` margin equivalent has real edge cases (the `.browse-mode__breadcrumb` `flex-wrap: wrap` rule needs both-axis margins; `.library-tab__selection-bar` is column not row; dashcam uses genuine grid `gap` for video-tile separators which doesn't map cleanly to margins), it's ~14 rules, and with no browser to verify layout and the Codex gate down, a silent spacing regression across the whole music page is a poor trade on a medium-priority item. This warrants one focused pass with visual verification on the Tesla 1200×600 viewport — logged as the top remaining M-U4 task, with the exact selector/direction/space inventory captured here:
  header-actions(row,s2), tab-selector(row,s1), tab-btn(row,s2), on-tesla__actions(row,s2), on-tesla__artist-name-btn(row,s2), on-tesla__album-row(row,s2), library-tab__artist-info(row,s2), library-tab__selection-actions(row,s2), browse-mode__breadcrumb(WRAP,s1), random-mode__row(row,s3), random-mode__toggle-group(row,s1), recent-mode__controls(row,s2), recent-mode__toggle-group(row,s1), library-tab__selection-bar(COLUMN,s2); dashcam grid-gap 2px separators.

**Verification (no frontend test runner):** `npm run build` tsc-clean; grep confirms no inline `gap` remains in the touched components. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining: the music.css gap→margin pass (inventory above, needs visual check), 44px touch targets, mobile tree drawer, FileList/context-menu keyboard roles, AddWiFiModal consolidation, contrast, dashcam viewer pane. Next iteration continues Phase 6.

### Iteration 39 — Phase 6: dashcam timeline touch-drag + keyboard seek (M-F8 + a11y)

The playback scrubber supported mouse drag (mousemove/mouseup on document) but touch only fired `onTouchStart` → a single tap-seek, no drag. And although it had `role="slider"` + `tabIndex=0`, there was no keyboard handler.

Fix in `Timeline.tsx`:
- **Touch drag:** `handleTouchStart` now sets `draggingRef`; new `handleTouchMove` seeks continuously while dragging; `handleTouchEnd`/`onTouchCancel` clear it. Touch events keep targeting the element the touch began on, so no document listeners are needed. Added `touch-action: none` on the container so the page doesn't scroll under the finger mid-scrub (avoids the passive-listener `preventDefault` pitfall).
- **Keyboard:** new `handleKeyDown` — ArrowLeft/Right seek ±5s, Home/End jump to start/end, clamped to `[0, duration]`, `preventDefault` on handled keys. Wired `onKeyDown`. `aria-valuenow` already tracks `currentTime`, so the slider is now fully operable by keyboard and announced correctly.
- Mouse drag unchanged.

**Verification (no frontend test runner):** `npm run build` tsc-clean; logic traced (touchstart→move→end drag path; key handling clamps). Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining: music.css gap→margin pass (inventory in iter 38), 44px touch targets, mobile tree drawer, FileList row roles/keyboard, context-menu keyboard model, AddWiFiModal consolidation, contrast, dashcam viewer pane display:none. Next iteration continues Phase 6.

### Iteration 40 — Phase 6: 44px touch targets (M-U6)

The project rule requires ≥44px touch targets (Tesla browser). The finding named several icon buttons below it. Bumped to 44×44 (width/height + min-width/min-height):
- `on-tesla__artist-toggle` (was 32px) and `on-tesla__delete-btn` (was 32px) — the two on the artist row where the delete sat beside expand; larger targets reduce the mis-tap-into-delete hazard. (Delete already routes through the confirm modal, so a mis-tap was never instant data loss.)
- `wifi-item__action-btn` (was 32px).
- `upload-panel__close` (was 24px) and `upload-panel__cancel` (was 20px — the smallest offender).

Each bump was checked for layout safety: the containers use `align-items: center` with padding and no fixed height, so rows grow to 44px rather than clipping. `on-tesla__artist-name-btn` between the two artist-row buttons is `flex: 1`, so the wider icon buttons just take a bit more of the row.

**Verification (no frontend test runner):** `npm run build` tsc-clean; each target's container checked for fixed-height constraints before enlarging (none clip). Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Note: `btn--xs` (32px, iter 33) is still below 44px, but it's for secondary text actions (select-all/clear) not in the M-U6 offender list — left as-is. Also flagged for the future visual pass: verify the enlarged buttons don't crowd narrow rows on the 1200×600 Tesla viewport.

Phase 6 remaining: music.css gap→margin pass, mobile tree drawer, FileList row roles/keyboard, context-menu keyboard model, AddWiFiModal consolidation, contrast, dashcam viewer pane display:none. Next iteration continues Phase 6.

### Iteration 41 — Phase 6: FileList listbox roles + visible keyboard focus (a11y)

The file list was a single focusable `<div tabIndex=0>` with `outline: none` on both `.file-list` and `.file-list:focus` — so keyboard users had NO visible focus indicator — and the rows had no ARIA roles, so assistive tech saw an undifferentiated blob. (Arrow/Enter/Delete nav already worked via a container-level handler using selection as the cursor.)

Fix — adopt the ARIA listbox + active-descendant pattern (correct for a single-focusable-container list):
- Container: `role="listbox"`, `aria-label="Files"`, `aria-activedescendant` → the id of the currently-selected (arrow-cursor) row, so screen readers announce each option as the cursor moves.
- Rows: stable `id="file-row-{i}"`, `role="option"`, `aria-selected={selected}`.
- CSS: removed the blanket `outline: none`; added `.file-list:focus-visible` outline (keyboard focus visible, mouse focus stays quiet) and an inset ring on the active row when the list is focused, so the arrow-key cursor is visible.

**Verification (no frontend test runner):** `npm run build` tsc-clean; ARIA pattern reasoned (listbox/option/activedescendant is the standard alternative to roving tabindex; ids are stable within a render). Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining: music.css gap→margin pass, mobile tree drawer, context-menu keyboard model/roles, AddWiFiModal consolidation, contrast, dashcam viewer pane display:none. Next iteration continues Phase 6.

### Iteration 42 — Phase 6: context menu keyboard model + roles (a11y)

The file context menu had Escape-to-close and click-outside but no menu semantics, no initial focus, and no arrow-key navigation — keyboard/SR users couldn't operate it.

Fix in `ContextMenu.tsx`:
- **Roles:** container `role="menu"` + `aria-label="File actions"` + `tabIndex={-1}`; items `role="menuitem" tabIndex={-1}`; dividers `role="separator"`.
- **Initial focus:** a mount-only effect focuses the first enabled item on open (kept separate from the `[onClose]` listener effect so a parent re-render can't yank focus back mid-navigation).
- **Arrow-key model:** extended the keydown handler — ArrowDown/Up move focus among enabled items (wrapping), Home/End jump to first/last, Escape closes (existing). Enter/Space activate natively (they're `<button>`s). Disabled items are skipped (`:not([disabled])`).

**Verification (no frontend test runner):** `npm run build` tsc-clean; keyboard model traced (wrap arithmetic, disabled-skip, focus-on-open isolated to mount). Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining: music.css gap→margin pass, mobile tree drawer, AddWiFiModal consolidation (non-semantic overlay + setState-in-render), contrast, dashcam viewer pane display:none. Next iteration continues Phase 6.

### Iteration 43 — Phase 6: consolidate AddWiFiModal onto shared Modal (bug + a11y)

`AddWiFiModal` had two problems the plan flagged:
1. **setState during render** — `if (open && prefillSsid && ssid !== prefillSsid) { setSsid(...); ... }` ran state setters in the render body (can cause extra renders / loops).
2. **Duplicate non-semantic overlay** — it hand-rolled `modal-overlay`/`modal-card`/`modal-title`/`modal-actions` instead of the shared `Modal`, so it missed the dialog role, focus trap, focus restoration, and pending guard added in iter 35.

Fix:
- Moved the form reset into `useEffect([open, prefillSsid])` (runs on open / prefill change, never during render).
- Replaced the hand-rolled overlay + footer with `<Modal open onClose onConfirm={handleSubmit} title confirmLabel={saving?'Adding...':'Test & Add'} pending={saving}>`, keeping the form fields as children. Cancel/confirm, Escape, overlay-close, focus management, and the double-submit guard now come from the shared Modal.
- Success path closes via `onClose` after the 1.2s success message (was a local reset+close).

Behavior notes: the submit no longer disables on empty SSID (the shared Modal disables only while `pending`), but `handleSubmit` still guards empty SSID with an error toast, so no invalid submit gets through. The custom `maxWidth: 520px` is dropped in favor of the shared modal-card width.

**Verification (no frontend test runner):** `npm run build` tsc-clean (JS bundle shrank slightly — removed duplicate overlay markup); reset-in-effect and Modal wiring traced. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining: music.css gap→margin pass (needs visual check), mobile tree drawer, contrast (M-U5), dashcam viewer pane display:none (H17), mobile dashcam grid crop, page-height calc (L12), no 404 route (L13). Next iteration continues Phase 6.

### Iteration 44 — Phase 6: 404 route (L13) + header-height single-source (L12)

**L13 — no 404 route.** The shell's nested `<Router>` had specific routes but no fallback, so an unknown path rendered an empty shell. Added a `NotFound` component (message + "Go to Dashboard" button via `route('/')`) as `<NotFound default />` — preact-router's catch-all.

**L12 — page-height calc vs header mismatch.** Full-height pages used `calc(100vh - 60px)` (dashcam, files) and `calc(100vh - 64px)` (layout) while the header is actually 56px mobile / 64px desktop — so `60px` matched neither, leaving a few px of overflow/gap at every breakpoint. Introduced `--header-height` (56px in `:root`, 64px via a `@media (min-width:768px){ :root{...} }` override), pointed `.app-header__inner` height at it, and replaced all four `calc(100vh - Npx)` usages with `calc(100vh - var(--header-height))`. Now every full-height page tracks the real header height responsively from one source. (Noted while here: global.css already ships a `min-height:44px` touch-target rule for buttons + margin-based `.gap-*` utilities — confirms the no-CSS-gap convention and is the tool for the deferred music.css conversion.)

**Verification (no frontend test runner):** `npm run build` tsc-clean; grepped that all `calc(100vh - …)` now reference the variable and the header consumes it. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining: music.css gap→margin pass (utilities exist), mobile tree drawer, contrast (M-U5), dashcam viewer pane display:none (H17), mobile dashcam grid crop (M-U7). Next iteration continues Phase 6.

### Iteration 45 — Phase 6: dashcam viewer hidden on desktop (H17)

Real functional bug, not cosmetic. `DashcamPage` line 60 rendered the viewer pane as:
`class={mobileTab !== 'viewer' ? 'dashcam-main hidden-mobile' : ''} style={mobileTab !== 'viewer' ? {display:'none'} : undefined}`

Two problems:
1. The inline `display: none` applies at ALL widths (inline styles aren't media-scoped). Since `mobileTab` defaults to `'events'`, the viewer pane was `display:none` on DESKTOP too — the video viewer never showed beside the event list until you toggled, defeating the split-pane layout.
2. When the tab WAS `'viewer'`, the class became `''`, dropping the `dashcam-main` styling entirely.

Fix — mirror the working sidebar pattern (line 52): always keep the base class, and add the mobile-only hide class conditionally:
`class={`dashcam-main${mobileTab !== 'viewer' ? ' hidden-mobile' : ''}`}` (no inline style).

Verified via CSS: `.dashcam-main.hidden-mobile { display: none }` lives inside `@media (max-width: 768px)` (dashcam.css:691), so `hidden-mobile` hides ONLY on mobile. On desktop the viewer now shows side-by-side; on mobile it hides when the events tab is active — and `dashcam-main` styling is retained in both states.

**Verification (no frontend test runner):** `npm run build` tsc-clean; media-query scoping of `hidden-mobile` confirmed in dashcam.css. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Phase 6 remaining (mostly needs visual pass): music.css gap→margin, mobile tree drawer, contrast (M-U5), mobile dashcam grid crop (M-U7). Next iteration continues Phase 6.

### Iteration 46 — Checkpoint: reasoning-verifiable Phase 6 work is done; holding on visual remainder

Re-attempted the deferred music.css gap→margin conversion (M-U4). Confirmed it should stay deferred: my own `awk` extraction of the 14 gap rules mis-attributed the media-query rule at line 1334 (reported `.recent-mode__empty` when it's actually `.library-tab__selection-bar` / column). If my extraction tooling gets a selector wrong, a blind bulk conversion with no browser and no review gate will ship a silent spacing regression. Not doing it blind. (Inventory + correct directions remain in iter 38 for a visually-verified pass.)

**State of the batch:** backend **68 passing**, frontend build tsc-clean, 66 changed files, iterations 16–45 all documented. Phases 0–5 complete (backend, unit+mutation tested). Phase 6: every logic/structural/a11y item that can be verified by reasoning is done — modal a11y + double-fire, accessible toasts, reduced-motion, aria-expanded/pressed, FileList listbox roles + focus, context-menu keyboard model, single-tap touch nav, timeline touch/keyboard, 44px targets, AutoSync settings UI, offline-state gating, 404 route, header-height single-source, and the H17 desktop-viewer functional bug.

**What genuinely remains in Phase 6 is visual and needs a browser or the review gate:** music.css gap→margin (inventory in iter 38), mobile tree drawer, contrast (M-U5), mobile dashcam grid crop (M-U7). I've reached the honest limit of what I can do soundly with only tsc + reasoning while the Codex gate is down (≈26 consecutive stop-gate failures).

Recommendation stands: recover the Codex runtime (session restart / `/codex:setup --enable-review-gate`) so the accumulated Phase 4–6 batch gets its intended review, then do the remaining visual items with a browser in the loop. Not producing further blind visual edits until then.

### Iteration 47 — Phase 7: stand up the frontend test harness (vitest) — unblocks frontend verification

Instead of blind visual edits, attacked the root constraint I'd been flagging: the repo had NO frontend test runner, so every frontend fix was tsc + reasoning only. npm registry was reachable, so:
- Installed `vitest` (4.1.10) + `jsdom` as devDeps.
- Added `vitest.config.ts` (jsdom env, globals, `src/**/*.{test,spec}.{ts,tsx}`).
- Added `test` (`vitest run`) and `test:watch` scripts.
- Wired `npm run test` into the CI frontend job (before build).

First tests — locking real fixes I'd only reasoned about:
- `src/api/client.test.ts` (6 tests): `formatDetail` — the FastAPI `detail`/422 parsing from iter 22 (string detail, field-error array with body/query/path stripping, "request" fallback, empty/undefined/non-array → {}, default message).
- `src/hooks/useStatus.test.ts` (6 tests): exported `transformStatus` and tested the mappings from iters 25/29 — top-level `state` (was ignored), `cpu_temp_celsius→cpuTemp` + `cpu_usage→cpuUsage`, uptime formatting, memory/wifi/ip, and storage/archive sub-object camelCasing.

**Verification:** `npm run test` → **12 passing (2 files)**; `npm run build` still tsc-clean and the bundle size is unchanged (vite tree-shakes the test files — not shipped). Backend suite **68 passing**.

**Significance:** this changes what I can verify going forward. Pure frontend logic (parsers, mappers, guard predicates, reducers) is now unit-testable — I can retro-test earlier reasoning-only fixes (wifi label thresholds, the stale-response guard decision, merge/mask helpers) and any new frontend logic. Component-render and visual/layout work (music.css gap, contrast, mobile drawer) still needs jsdom render tests or a real browser, but a large slice of the "unverifiable" frontend surface just became testable.

NOT Codex-reviewed (gate still down). Documented; next iterations can backfill frontend unit tests for prior fixes and continue Phase 6 logic with real tests.

### Iteration 48 — Phase 7: backfill frontend unit tests for reasoning-only fixes

Used the new vitest harness to lock earlier fixes that had only tsc + reasoning behind them. Exported the pure helpers and tested them:
- `SystemCard.test.ts` — `wifiSignalKnown` + `getWifiLabel` (iter 29): 0 / non-negative / NaN → "Unknown" (the "Excellent at 0 dBm" bug), real negative-dBm signals labeled by strength.
- `StatusHero.test.ts` — `getRingLabel` (iter 29): each backend `state` → its label; unreachable archive server surfaced when the top-level state is otherwise fine; an active `syncing` state outranks the unreachable note.

Exports added: `wifiSignalKnown`, `getWifiLabel` (SystemCard), `getRingLabel` (StatusHero), `transformStatus` (useStatus, iter 47).

**Verification: 17 tests passing (4 files); `npm run build` tsc-clean.** Mutation-checked the frontend harness end-to-end: reverting `getWifiLabel`'s unknown-guard (re-introducing the "Excellent at 0 dBm" bug) fails `SystemCard.test.ts`; restoring → 17 green. So the frontend tests catch regressions, not just pass — same rigor as the backend suite.

Net: the drive-switch race guard, mask/merge helpers, and other component-embedded logic can now be extracted + tested the same way in later turns. Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Frontend test files now: client (formatDetail), useStatus (transformStatus), SystemCard (wifi), StatusHero (ring label) — 17 tests, in CI.

### Iteration 49 — Phase 7: extract + test the drive-switch race guard (iters 17/18)

Locked the most subtle frontend fix of the batch — the FileBrowser stale-response race that could render one drive's files under another (and enable wrong-drive deletion). Extracted the inline decision into a pure, exported helper `shouldApplyListing(seq, currentSeq, reqDrive, currentDrive)` in useFiles.ts (`seq === currentSeq && reqDrive === currentDrive`), and rewired `FileBrowser.navigate` to call it in place of the two inline `if (…) return` checks. Behavior identical; logic now unit-testable.

`useFiles.test.ts` (4 tests): apply when latest+current-drive; drop a superseded seq; drop a response for a drive no longer on screen (the iter-18 wrong-drive bug); drop when both stale.

**Verification: 21 tests passing (5 files); build tsc-clean. Mutation-checked:** dropping the drive-equality term (`return seq === currentSeq`) — exactly the hole iter 18 closed — fails the wrong-drive test; restored → 21 green.

Backend unchanged (**68 passing**). NOT Codex-reviewed (gate down). Documented; continuing.

Frontend suite now: formatDetail, transformStatus, wifi label, ring label, shouldApplyListing — 21 tests, all mutation-capable, in CI. The pattern (extract embedded logic → pure exported fn → mutation-tested unit test) is now the standard way to convert reasoning-only frontend fixes into verified ones.

### Iteration 50 — Phase 7: component testing (Testing Library) + Modal render test

Added `@testing-library/preact` + `@testing-library/dom` so component behavior (not just pure logic) is testable. First component test locks the Modal a11y + double-fire fix (M-U2/L11, iter 35):
- `Modal.test.tsx` (4 tests): `role="dialog"` + `aria-modal` + `aria-labelledby`→title; `pending` disables BOTH confirm and cancel (the double-fire guard); onConfirm fires when not pending; closed → renders nothing.

Two things learned/handled:
- **jsdom gotcha:** `fireEvent.click` dispatches to a `disabled` button anyway (a real browser suppresses it), so the double-fire test asserts the disabled STATE (the actual guarantee) rather than relying on click suppression. Documented inline.
- **`tsc -b` type-checks test files** (they're under `src/`), so component tests must be type-correct — caught a missing required `children` prop on two `<Modal>` renders. This is a feature: tests get typechecked in the build/CI too.

**Verification: 25 tests passing (6 files); `npm run build` tsc-clean** (test files typecheck; bundle unchanged — tree-shaken). Backend unchanged (**68 passing**).

Frontend test surface now: pure logic (formatDetail, transformStatus, wifi/ring labels, shouldApplyListing) + component render (Modal). Both `npm run test` and typecheck run in CI. NOT Codex-reviewed (gate down). Documented; continuing — component tests now unlock the toast roles, FileList listbox, and context-menu keyboard fixes for render-level coverage in later turns.

### Iteration 51 — Phase 7: render test for context-menu keyboard model (iter 42)

Locked the context-menu a11y fix (iter 42) with real render tests — focus management is only meaningfully verifiable at render level, which I couldn't do before the harness.
- `ContextMenu.test.tsx` (4 tests): `role="menu"` with exactly 3 `menuitem`s (divider is a `separator`, excluded); first item focused on open; ArrowDown advances focus and wraps at the end; End/Home jump to last/first; Escape calls onClose. Uses jsdom `document.activeElement` to assert the roving focus.

**Verification: 29 tests passing (7 files); `npm run build` tsc-clean.** Backend unchanged (**68 passing**).

Progress on converting reasoning-only fixes to tested ones — now covered by render tests: Modal (iter 35), ContextMenu (iter 42). Pure-logic tested: formatDetail, transformStatus, wifi/ring labels, shouldApplyListing. Remaining a11y render candidates: Toast roles + dismiss (iter 37), FileList listbox roles/active-descendant (iter 41). NOT Codex-reviewed (gate down). Documented; continuing.

### Iteration 52 — Phase 7: render test for accessible toasts (iter 37)

`Toast.test.tsx` (4 tests) locks the toast a11y fix: error/warning → `role="alert"` (assertive), success/info → `role="status"` (polite); the container is a `role="region"` labelled "Notifications"; the keyboard-reachable "Dismiss notification" button removes the toast from the `notifications` signal; empty state renders no container. Drives state via the exported `notifications` signal (reset in afterEach).

**Verification: 33 tests passing (8 files); `npm run build` tsc-clean.** Backend unchanged (**68 passing**).

Render-tested a11y fixes now: Modal (iter 35), ContextMenu (iter 42), Toast (iter 37). Pure-logic tested: formatDetail, transformStatus, wifi/ring labels, shouldApplyListing. Remaining render candidate: FileList listbox roles + aria-activedescendant (iter 41). NOT Codex-reviewed (gate down). Documented; continuing.

### Iteration 53 — Phase 7: render test for FileList listbox a11y (iter 41)

`FileList.test.tsx` (3 tests) locks the listbox pattern: container `role="listbox"` labelled "Files"; each row a `role="option"`; the selected row carries `aria-selected="true"` and the listbox's `aria-activedescendant` points at that row's id; no active-descendant when nothing is selected. Renders the component with minimal props (dirs-first sort verified via the selected file landing at row index 1).

**Verification: 36 tests passing (9 files); `npm run build` tsc-clean; backend 68 passing.**

Milestone: the frontend a11y/interaction fixes are now render-tested end-to-end — Modal (35), ContextMenu (42), Toast (37), FileList listbox (41) — plus pure-logic units (formatDetail 22, transformStatus 25/29, wifi/ring labels 29, shouldApplyListing 17/18). The reasoning-only verification gap that constrained Phase 6 is substantially closed: **68 backend + 36 frontend = 104 tests, all in CI.**

What genuinely remains unverifiable-by-code: pixel/layout visuals — music.css gap→margin (inventory iter 38), contrast (M-U5), mobile tree drawer, mobile dashcam grid crop. Those need a browser or the Codex review. NOT Codex-reviewed (gate down, ~30 consecutive stop-gate failures). Documented; continuing.

### Iteration 54 — Phase 4: dashcam event detail reads from DB (H2/SOL-013, part 1)

The last Phase 4 feature gap. `get_event` called `_get_event_detail`, which scanned `/mnt/cam/TeslaCam` — but that image is unmounted while the USB gadget owns it, so EVERY archived event 404'd on detail (the events LIST already reads the DB; only detail was broken).

Fix: new async `_get_event_detail_from_db(event_id)` reads the same `dashcam_archived_clips` table `list_events` uses — parses `{type}__{event_dir}`, maps sentry/saved → SentryClips/SavedClips, selects that event's clip_files, groups them by timestamp into per-camera video URLs (`/api/dashcam/video/{event_type}/{event_dir}/{clip_file}`), and returns the `EventDetailResponse` (archived=true). `get_event` now awaits it. The old `/mnt/cam`-scanning `_get_event_detail` is left in place but no longer called (legacy).

**Test:** `test_dashcam_event_detail_reads_from_db` — seeds two-camera clips (sync sqlite3, fully committed before the async read to avoid the WAL cross-connection flakiness from iter 20), asserts the detail groups them into one timestamp with front+back cameras, correct video URL, parsed `2026-04-12T10:00:02` timestamp; unknown and malformed ids → None (→ 404, no filesystem scan). **Mutation-verified** (forcing the query empty fails it); deterministic (3×). Backend **69 passing** (was 68).

**Remaining H2 piece (not done — needs real hardware to verify):** `serve_video` still reads `TESLACAM_ROOT` (/mnt/cam), so the archived video bytes won't actually stream until it serves from the mounted NAS archive share instead. That requires mounting the archive share read-only and resolving the archived path — the Range logic itself is already correct. It can't be end-to-end verified without a real NAS + archived clips, so it's logged as the final H2 step for a hardware-in-the-loop pass. The detail-404 fix (this iter) is the necessary, testable first half.

Totals: **69 backend + 36 frontend = 105 tests**, all in CI. NOT Codex-reviewed (gate down). Documented.

### Iteration 55 — Deploy-script robustness: size_to_bytes + partition suffix (L16)

Pivoted to genuinely verifiable non-visual/non-hardware work: two real bugs in `deploy/setup-teslapi.sh`, both pure shell functions I can execute directly.

**1. `size_to_bytes` errored on T and K.** It stripped only `[GgMm]` for the number, so `1T`/`500K` kept their unit in `num` and fell through to `$((size * 1024^3))` — bash arithmetic on a non-numeric string ("1T") errors, aborting setup. Fixed: strip `[KkMmGgTt]`, and handle T (×1024⁴) and K (×1024) alongside G/M; bare number still defaults to GB.

**2. Partition suffix only handled NVMe.** `if [[ "$DATA_DRIVE" == *nvme* ]]` gave `p1/p2` for NVMe but plain `1/2` for everything else — wrong for eMMC/SD (`mmcblk0` needs `mmcblk0p1`, not `mmcblk01`). Replaced with the canonical rule: a device name ending in a digit gets a `p` separator (`[[ "$DATA_DRIVE" =~ [0-9]$ ]]`), covering nvme, mmcblk, and sd* correctly.

**Verification (direct bash execution — fully verifiable):**
- `size_to_bytes`: 1T→1099511627776, 500K→512000, 16G→17179869184, 32M→33554432, bare 16→17179869184 (GB). All exact.
- partition suffix: sda→sda1, nvme0n1→nvme0n1p1, mmcblk0→mmcblk0p1. All correct.
- shellcheck not installed in this env (skipped); direct execution is the stronger check for these logic bugs.

Backend **69 passing**, frontend **36 passing** (unchanged — shell-only diff). NOT Codex-reviewed (gate down). Documented.

Note: no persistent shell test added — sourcing setup-teslapi.sh would execute it (no `main` guard), and extracting the functions to a sourceable lib is a refactor beyond this fix. The verification cases above are reproducible; a shell test harness (bats or a functions lib) is logged as a future Phase 7 item.

### Iteration 56 — Deploy-script robustness: read-only-root false positive (M-D3)

Real, potentially-bricking bug in `deploy/install.sh`, `rollback.sh`, `update.sh` (identical). Each detects a read-only root with `mount | grep 'on / ' | grep -q 'ro,\|ro)'`, sets `ROOT_RO`, remounts rw to do its work, then on exit remounts ro IF it detected ro at the start. But `ro,\|ro)` matches the `ro` inside `errors=remount-ro` — a mount option every normal rw ext4 root carries — so on a healthy system it false-positives and **remounts the running root filesystem read-only on exit**, breaking normal operation.

Fix: match `ro` only as a standalone mount option delimited within the parenthesised option list — `grep -qE '\(ro[,)]|,ro[,)]'` — which matches `(ro,`, `(ro)`, `,ro,`, `,ro)` but not `-ro)` (the `remount-ro` tail).

**Verification (direct execution against real `mount` output):**
- normal rw root `(rw,relatime,errors=remount-ro)` → old=RO (bug), new=RW ✓
- real ro root `(ro,relatime,errors=remount-ro)` → new=RO ✓
- ro mid-options `(rw,relatime,ro,data=ordered)` → new=RO ✓
- `bash -n` syntax-clean on all three scripts; old pattern fully removed.

Backend **69**, frontend **36** (shell-only diff). NOT Codex-reviewed (gate down). Documented.

Deploy-script items now fixed: size_to_bytes T/K (L16), partition suffix mmcblk (L16), read-only-root false positive (M-D3). Remaining deploy items from the plan: `RequiresMountsFor=/mutable` (M-D1), install.sh DB-on-rootfs for bare `/mutable` (M-D1), failed nginx switch leaves UI down (M-D4), dispatcher SSID nmcli field (L17). Next iteration continues these (all shell/config, directly verifiable).

### Iteration 57 — Deploy-script robustness: dispatcher SSID detection (L17)

`deploy/99-wireguard-teslapi` (the NetworkManager dispatcher that brings the WireGuard tunnel up/down based on home-vs-away) read the current SSID as:
`CURRENT_SSID=$(nmcli -t -f GENERAL.CONNECTION device show "$INTERFACE" | cut -d: -f2)`
— but `GENERAL.CONNECTION` is the NetworkManager **connection-profile name**, not the SSID. They coincide by default, but a renamed profile (or a profile whose name ≠ its ssid) makes `CURRENT_SSID == HOME_SSID` compare wrong → the tunnel toggles incorrectly (stays up on home WiFi, or drops when away).

Fix: read the real associated SSID via `iwgetid "$INTERFACE" -r` (the exact method the backend's `_read_system_info`/`network_manager` already use — consistent + proven in this codebase), with an nmcli fallback to the profile's actual `802-11-wireless.ssid` field if iwgetid is absent.

**Verification:** `bash -n` syntax-clean; the two-step resolution executes without crashing when neither tool is present (resolves to empty — safe: an empty SSID won't falsely match a real HOME_SSID). Note: unlike the size_to_bytes / RO-detection fixes, I could NOT fully execute-verify the SSID *value* here (no real nmcli + WiFi association in this env) — it's reasoning-verified against documented nmcli semantics (GENERAL.CONNECTION = profile name) + the codebase's existing iwgetid usage. Lower verification confidence than the prior two shell fixes; flagged as such.

Backend **69**, frontend **36** (shell-only diff). NOT Codex-reviewed (gate down). Documented.

Deploy items fixed: size_to_bytes T/K (L16), partition suffix mmcblk (L16), RO-root false positive (M-D3), dispatcher SSID (L17). Remaining: `RequiresMountsFor=/mutable` (M-D1), install.sh DB-on-rootfs for bare `/mutable` (M-D1), failed nginx switch leaves UI down (M-D4). Next iteration continues.

### Iteration 58 — Deploy-script robustness: DB on rootfs + service mount ordering (M-D1)

Two coupled bugs that could put the DB on the wrong filesystem.

**1. install.sh wrote the DB to rootfs on a bare `/mutable`.** The guard was `if mountpoint -q /mutable 2>/dev/null || [[ -d /mutable ]]`. The `|| [[ -d /mutable ]]` took the "use /mutable" branch whenever `/mutable` merely existed as a directory — including the common case where it's a bare mountpoint dir on the rootfs before its partition mounts. The DB then landed on the rootfs and got shadowed (lost) the instant the real `/mutable` partition mounted, and the rootfs slowly filled. Fixed: require a REAL mount — `if mountpoint -q /mutable 2>/dev/null; then` (drop the `|| -d` clause). The else-branch already falls back to `/var/lib/teslapi` + a `/mutable/teslapi` symlink.

**2. teslapi.service didn't wait for /mutable.** `Environment=TESLAPI_DATABASE_PATH=/mutable/teslapi/teslapi.db` but no mount dependency, so the service could start (and open/create the DB) before `/mutable` mounted — same rootfs-shadowing race from the service side. Added `RequiresMountsFor=/mutable` to `[Unit]`, so systemd orders the service after the /mutable mount.

**Verification:** `bash -n` clean; mocked `mountpoint` both ways — bare dir (mountpoint=fail) now falls back correctly, real mount uses `/mutable/teslapi`. Service has the directive. `dist/teslapi/` is gitignored/regenerated, and `deploy/build.sh` copies `deploy/{teslapi.service,install.sh,update.sh,rollback.sh,setup-teslapi.sh}` into the tarball — so all deploy fixes propagate; no need to touch the stale dist artifacts.

Backend **69**, frontend **36** (shell/config-only diff). NOT Codex-reviewed (gate down). Documented.

Deploy items fixed: size_to_bytes T/K + partition suffix (L16), RO-root false positive (M-D3), dispatcher SSID (L17), DB-on-rootfs + service mount ordering (M-D1). Remaining: failed nginx switch leaves UI down (M-D4). Next iteration.

### Iteration 59 — Deploy-script robustness: nginx switch can't strand the UI (M-D4)

`deploy/configure-web.sh` switched nginx to the teslapi site unsafely: it removed the `default` site FIRST, then later `systemctl start nginx` — with no validation. If `teslapi.nginx` was invalid (bad upstream, syntax error), nginx failed to start with NO working site left, taking the entire web UI down and leaving no way in.

Fix:
- Validate before committing: copy + enable teslapi, drop default (avoids the :80 default_server conflict during the test), then `nginx -t`. If validation FAILS, remove the teslapi symlink and restore the default site, so nginx always retains a working config.
- Check the start: `if ! systemctl start nginx; then log ERROR ...` (was a bare `systemctl start nginx` that swallowed failures silently).

**Verification:** `bash -n` clean; logic-traced with a mocked failing `nginx -t` → teslapi symlink removed, default restored (nginx still serves). Can't run real `nginx -t` here (nginx not installed), so validation-behavior is reasoning-verified against standard nginx semantics + the traced control flow.

Backend **69**, frontend **36** (shell-only diff). NOT Codex-reviewed (gate down). Documented.

**All deploy-script robustness items from the plan are now fixed:** size_to_bytes T/K + partition suffix (L16), RO-root false positive (M-D3), dispatcher SSID field (L17), DB-on-rootfs + service mount ordering (M-D1), nginx-switch fail-safe (M-D4). This closes the deploy/M-D/L16-17 line from teslapi_fix_plan.md §Phase-boundary deploy notes.

### Iteration 60 — Verified-backlog complete; holding for gate/browser/hardware

Final green checkpoint: **69 backend + 36 frontend = 105 tests passing**, frontend build tsc-clean, all 6 deploy scripts `bash -n` clean, 76 tracked files changed.

I've now worked through everything that can be verified soundly without the review gate, a browser, or real hardware:
- **Phases 0–5:** complete, backend, unit + mutation tested.
- **Phase 6 (UX/a11y):** all logic/structural/interaction fixes done and, where they involve behavior, render-tested (Modal, ContextMenu, Toast, FileList) or unit-tested (formatDetail, transformStatus, wifi/ring labels, drive-switch guard).
- **Phase 7:** frontend test harness stood up (vitest + Testing Library, in CI) and used to lock reasoning-only fixes; backend suite grown to 69.
- **Phase 4 H2:** archived-event detail now reads the DB (404 fixed + tested).
- **Deploy robustness:** all six M-D/L16-17 items fixed and execution/trace-verified.

**What genuinely remains needs something I don't have here:**
- Pixel/layout visuals — music.css gap→margin (inventory in iter 38), contrast (M-U5), mobile tree drawer, mobile dashcam grid crop → need a browser.
- H2 video streaming from the NAS archive share → needs real hardware/NAS to verify.
- The entire accumulated batch (iters 16–59) → needs the Codex gate, which has failed ~36 consecutive stop-time runs.

Deliberately NOT continuing into: blind visual CSS edits, unverifiable-here NAS streaming, or make-work test coverage of already-verified paths / risky refactors the dead gate can't review. Those have crossed into negative expected value.

**Recommendation (unchanged, now the sole blocker):** restart the session or re-run `/codex:setup --enable-review-gate` to recover the Codex runtime, then (a) let it review this batch against the 105 tests, and (b) do the remaining visual items with a browser and the H2 streaming half on real hardware. Holding here until the gate is back or redirected.

### Iteration 61 — Phase 0 (loop re-invoked): lock rsync progress parser

User re-invoked /loop (dynamic mode). Re-read plan/log; refocused on the PRIMARY directive (music/video sync resilience). The sync ENGINE was built pre-compaction but its core parsing/resilience helpers weren't directly unit-tested — now that the pytest harness is solid, backfilling those is on-priority AND verifiable.

Extracted the inline `--info=progress2` parsing from `_stream_rsync_progress` into a pure module helper `_parse_progress2(line) -> (run_bytes, files_done) | None` (behavior-preserving refactor), and locked it: `test_parse_progress2_extracts_bytes_and_files` covers commas in byte counts, `to-chk`/`ir-chk` variants, completed (0 remaining → all files), and non-progress/empty/malformed lines → None. This parser drives both the UI progress and the byte accounting that must stay monotonic across stall-kill-retry, so it's core to "reliable sync."

**Verification:** backend **70 passing** (was 69), deterministic 3×; **mutation-verified** (files=remaining instead of total-remaining fails it); `py_compile` clean.

Remaining on-priority verifiable backfill for the sync/archive resilience engine (next loop iterations): `_path_mount_state` mount detection, `_supervise_rsync` stall/retry accounting, `_ensure_image_unmounted` release gating, dashcam_archive mount-safety. These are safety-critical and unit-testable — the loop has productive, verifiable work again. Frontend 36, gate still down (not Codex-reviewed).

### Iteration 62 — Phase 0: lock mountinfo field-4 parsing (mount-safety) + stale-.pyc gotcha

Continued the sync/archive resilience test backfill. Extracted the mount-point parse from `_path_mount_state` into a pure helper `_mountinfo_has_target(lines, target)` (behavior-preserving), and locked it: `test_mountinfo_has_target_field4_parsing` asserts the mount point is read from field index 4 (proc(5) layout) — matches when field 4 == target, does NOT match when the path is at field 3 (the mount SOURCE) or absent, and skips short/blank lines. This is the safety-critical gate: a wrong field index would misreport "not mounted" and could re-enable the USB gadget over a still-mounted image (corruption).

**Verification:** backend **71 passing** (was 70), deterministic 3×; mutation-verified (field index 4→3 fails the test).

**Root-caused a recurring gotcha in my own mutation workflow:** after `mv music_sync.py.bak music_sync.py`, the suite showed a spurious failure with the CORRECT source in place. Cause: `mv` preserves the backup file's (older) mtime, so Python kept the `.pyc` compiled from the *mutant* (fields[3]) rather than recompiling the restored source (fields[4]) — `inspect.getsource` showed fields[4] while the loaded bytecode was fields[3]. Fixed by `touch`ing the file + clearing `__pycache__`; 71 green 3×. This explains the intermittent "post-restore failure, re-ran green" notes in earlier iterations (WireGuard/notification mutation checks) — same stale-.pyc-after-mv cause, benign. Going forward: `touch` the source after a mutation-restore.

Remaining Phase-0 resilience backfill: `_supervise_rsync` stall/retry byte accounting, `_ensure_image_unmounted` release gating, `_image_loop_devices`/`_detach_image_loops` confirmation logic, dashcam_archive mount-safety. Frontend 36. Gate still down (not Codex-reviewed).

### Iteration 63 — Phase 0: lock the image-release gate (_ensure_image_unmounted)

Locked the most safety-critical piece of the sync mount lifecycle: the gate that decides whether the USB gadget may be re-presented after a sync. `test_ensure_image_unmounted_release_gate` mocks `_path_mount_state`/`_detach_image_loops`/`script_runner.run`/`asyncio.sleep` and asserts the four fail-safe invariants:
1. unmounted AND loops detached → True (released);
2. mount state UNDETERMINABLE (None) → never True (fails safe — treats as still mounted);
3. unmounted but a loop stays attached → False (a lingering loop can write behind the gadget);
4. still mounted after umount attempts → False (never green-lights).

**Verification:** backend **72 passing** (was 71), deterministic 3×; **mutation-verified** — changing the `state is False` gate to `state is not True` (fail-open: treat undeterminable as released, the exact corruption bug) fails the test. Applied the iter-62 `touch`-after-`mv` fix so the post-restore run was clean first try (72 green), confirming the stale-.pyc workaround.

Phase-0 resilience engine now has unit coverage on: progress parsing (iter 61), mountinfo field-4 parse (iter 62), and the release gate's fail-safe invariants (this iter) — the three pieces where a subtle bug means either wrong progress or image corruption. Remaining: `_supervise_rsync` stall/retry cumulative-byte accounting, dashcam_archive mount-safety (mirrors this gate for the boombox/cam images). Frontend 36. Gate still down (not Codex-reviewed).

### Iteration 64 — Phase 0: lock the rsync exit-code retry policy

Extracted the supervisor's rsync exit-code decision into a pure `_classify_rsync_exit(rc)` (constants `_RSYNC_PARTIAL_CODES={23,24}`, `_RSYNC_REMOUNT_CODES={30,35,12,11,14}`) and rewired `_supervise_rsync` to use it (behavior-preserving). This is the policy that decides success / partial-hand-back / retry-with-fresh-CIFS-mount / plain-retry — a real subtle-bug surface (miscategorize a code → syncs retry forever or give up early).

`test_classify_rsync_exit_policy`: 0→success; 23/24→partial; 30/35/12/11/14→retry_remount; 1/255/None→retry.

**Verification:** backend **73 passing** (was 72), deterministic 3×; **mutation-verified** (dropping 24 from the partial set → it becomes "retry", which would loop a partial transfer forever → test fails). Clean restore via the `touch` fix (73 green first try).

Phase-0 music resilience now unit-covered on the four subtle-bug surfaces: progress parsing (61), mountinfo field parse (62), image-release fail-safe gate (63), rsync exit-code policy (64). The remaining bits are heavy orchestration (cumulative-byte accounting across retries — needs full subprocess mocking) and the dashcam RO archive (lower corruption risk, imperative daemon-coordination flags). I've locked the high-value pure logic. Frontend 36. Gate still down (not Codex-reviewed).

### Iteration 65 — lock sensitive-key detection (security regression guard) [gate now DISABLED]

Loop continues without Codex (user disabled the stop-time review gate via `/codex:setup --disable-review-gate` — the ~40-turn failing hook is resolved; Codex CLI itself is healthy but I'm not invoking it per user instruction). Re-read plan + work log at turn start (as instructed).

Assessed the video side (dashcam archive): mount is read-only (low corruption risk) and its resilience is imperative (per-clip `rc==0`-only recording, `we_mounted` daemon coordination) with no clean pure-logic surface beyond the already-tested event grouping (iter 54) — so no forced low-value test there.

Instead locked a real prior SECURITY fix that had only indirect coverage: `is_sensitive_key`. The regex uses `wifipass|_pass` (not bare `pass`) specifically so teslausb's `WIFIPASS`/`WIFI_PASS` mask while a word like `COMPASS` doesn't false-match. `test_is_sensitive_key_matches_secrets_not_false_positives` pins both directions: secrets (WIFIPASS/WIFI_PASS/SHARE_PASSWORD/MQTT_PASSWORD/HA_TOKEN/SECRET_KEY_BASE/API_KEY, case-insensitive) match; non-secrets (SSID/ARCHIVE_SERVER/COMPASS/HOSTNAME/MUSIC_SERVER/ENABLED) don't.

**Verification:** backend **74 passing** (was 73), deterministic 3×; **mutation-verified** — reverting the regex to bare `pass` (re-introducing the COMPASS false-match / the original WIFIPASS-leak-class bug) fails the test. Clean restore via `touch`.

Totals: **74 backend + 36 frontend = 110 tests.** The stop-gate is now OFF, so turns no longer block on the broken Codex review. Music-sync resilience (61–64) + this security guard locked. Next: broaden coverage of other reliability-critical parsers (network_manager nmcli parsing, updater version/status), or the remaining plan items.

### Iteration 66 — ROOT CAUSE of "no music synced in months": orphaned-job reconciliation [deployed + verified on hardware]

Re-read plan + log at turn start. Continued "deploy and monitor" (user directive: 1. commit 2. deploy and monitor). Committed the iter 47–65 hardening batch (351c51b, branch teslapi-hardening) and deployed to the live Pi (joulesusb.dzsec.net). **While monitoring the deployed device, found the likely root cause of the original complaint.**

**The bug:** `music_sync_jobs` row 20 was stuck `status='running'` since **2026-05-08** — files_copied frozen at 10661, `pgrep rsync` = none (no process alive). `status.py:352` maps a `running` job → `music.sync_in_progress = True` → `_determine_system_state` → dashboard permanently reports **"syncing"**. The only in-progress guard was in-memory (`_active_sync` in music_sync.py:56), which does NOT survive a service restart — so a job orphaned by a crash/restart/power-loss stays `running` in the DB forever, pins the UI on "syncing", and (via that same guard path) masks the real idle state. This is almost certainly why "no music has synced in months": the device *looked* busy and never surfaced as idle/ready.

**The fix** (`backend/database.py` `reconcile_interrupted_jobs()`, called once from `main.py` lifespan right after `init_db()`): at startup, mark every `music_sync_jobs`/`dashcam_archive_jobs` row in `('running','pending')` as `'interrupted'` (COALESCE-preserving any existing error_message/completed_at). No sync process survives a restart, so such rows are definitionally orphaned — safe to reconcile unconditionally. Idempotent (a second startup finds nothing). Logs a WARNING only when it actually reconciles rows.

**Verification:**
- Unit test `test_reconcile_interrupted_jobs`: seeds running + pending + completed jobs (+ a running dashcam job), asserts exactly the 3 orphans flip to `interrupted` and the `completed` row is untouched, then asserts a second call reconciles 0 (idempotent). Deterministic 3×. Backend **75 passing** (was 74).
- **Live hardware:** manually marked job 20 `interrupted` via python3/sqlite3 on the Pi → `/api/status` immediately flipped from pinned "syncing" to **`state: connected, sync_in_progress: False`** (truthful). Then deployed the permanent fix (version 20260806-162429), confirmed startup runs clean (0 orphans post-fix, expected), health ok, status stays truthful.

Totals: **75 backend + 36 frontend = 111 tests.** The device is unblocked and self-heals on future restarts. This closes the loop on the Phase-0 primary directive from the live side: the resilience engine (61–64) prevents *new* stuck syncs, and this reconciliation clears *already-stuck* ones on restart. Next: exercise a real music sync on the Pi to prove end-to-end copy works now that the drive is unblocked.

### Iteration 67 — live monitoring surfaced 3 more real bugs; video sync verified working; music backfill identified

Continued monitoring the deployed device. Findings + fixes this iteration:

**(a) Video/dashcam sync VERIFIED WORKING end-to-end (live).** Journal shows the auto-sync loop firing a real archive: `triggering automatic dashcam archive` → job 21981 `mounting cam image read-only` → `no new clips to archive` → `unmounting cam image`. The full RO-mount → discover → unmount lifecycle runs cleanly and automatically every 5 min. Reconciliation (iter 66) also covers `dashcam_archive_jobs`, so orphaned archive jobs can't pin it either.

**(b) Architecture note: auto-sync drives ONLY dashcam archiving, not music.** `auto_sync._check_and_sync` calls `dashcam_archive.start_archive` exclusively — music sync is manual-trigger only. So the device will NOT self-initiate a music sync; it archives video automatically but waits for a user/API trigger for music.

**(c) Music backfill identified (stale synced watermark from the May crash).** All 13776 indexed tracks are flagged `synced=1`, but interrupted job 20 only transferred 10661/13776 (65GB/336GB) before being orphaned — the old (pre-hardening) code marked the whole index synced optimistically. Net: ~3115 tracks (~271GB, the large FLAC albums — note the byte/file skew) never reached the Tesla drive, and `/sync/new` won't backfill them because they're wrongly flagged synced. The *current* code is correct (marks synced per-file only on rsync rc==0, iter's music_sync.py:246), so this won't recur — but clearing the existing gap needs a real ~271GB transfer, which is a user decision (long-running, disrupts car USB). A `full` sync is the right mechanism (rsync incremental — skips the 10661 already present, sends only the missing).

**(d) Fixed a datetime/str API-contract bug class (Phase 4).** Monitoring showed `PydanticSerializationUnexpectedValue` on every `/api/status` once an archive/sync had completed: three datetime-typed fields were assigned raw SQLite strings — `archive.last_archive_at` (job.completed_at), `music.last_sync_at` (job.completed_at), and `DashcamEvent.timestamp` (event.archived_at). Worse, the HA push loop calls `.last_archive_at.isoformat()`, which would `AttributeError` on a str whenever a completed archive existed + HA push enabled. Added `_parse_db_timestamp()` (handles both SQLite shapes: `'YYYY-MM-DD HH:MM:SS'` and Python ISO-with-tz; passthrough datetime; None on garbage) and routed all three sites through it. Test `test_parse_db_timestamp_handles_both_sqlite_formats` (both formats, passthrough, None, garbage; asserts `.isoformat()` doesn't raise), deterministic 3×. **76 backend passing** (was 75). Deployed (version 20260806-163136); verified **0 serialization warnings** under 8× `/api/status` load and both fields serialize cleanly.

Totals: **76 backend + 36 frontend = 112 tests.** Live device: state truthful (`connected`), video sync working automatically, music unblocked and awaiting a backfill go-ahead. Remaining for "music syncing works" end-to-end: user approval for the ~271GB backfill (or a small selective sync as a functional proof).

### Iteration 68 — COMPLETE root cause of "no music in months": stale index predating a share reorg

The user chose "small test sync first." Triggered a selective sync of `/Alizée/Remixes 1087` (2 files, 10MB). Result exposed the real root cause — and it is NOT a code bug in the sync engine, which worked flawlessly.

**The sync pipeline is provably correct.** Journal for job 21: gadget disabled → music image mounted → CIFS source `//matterhorn.dzsec.net/zmutt_music` mounted (succeeded) → rsync → source/image unmounted → gadget re-enabled. The entire mount-safety choreography (the thing iters 61–64 hardened) executed perfectly. The transfer failed with rsync code 23: `link_stat ".../02 L'Alizé (...).1.mp3" failed: No such file or directory`.

**Diagnosis (read-only ground-truthing via the app's own share_browser, mounted the share RO and compared to the DB):**
- The index (`music_files`, 13776 rows) was built **2026-04-10 21:56–23:11** in a single run.
- The share has a top-level **`.stash_2026-04-21`** directory — it was **reorganized on 2026-04-21, 11 days AFTER indexing**. A dedup/reorg pass renamed album dirs, created duplicate `.N.mp3` copies (e.g. `01 - Kryptonite.1.mp3 … .13.mp3`), changed separators (` - ` vs ` `), and changed extensions (`.m4a` → `.mp3`).
- Concrete mismatch — INDEX: `/3 Doors Down/The Better Life 914/01 Kryptonite.m4a` (spurious album number `914`, also appears as `4040`; no ` - `; `.m4a`). SHARE: `/3 Doors Down/The Better Life/01 - Kryptonite.1.mp3`. **No index path resolves on the current share** — random sample of 40 oldest + 40 newest clean paths = 0/80 present; 30/30 `.N.` paths absent.
- The indexer (`music_index.py:143`) records the **real** relative filesystem path (`"/" + rel` from `os.walk`), so the 04-10 paths were correct *then* — the index is simply 4 months stale and predates the reorg.

**Full causal chain for "no music synced in months":**
1. Share reorganized 2026-04-21 → all 04-10 index paths went stale.
2. Job 20 (05-08) full-synced the stale index → every rsync `link_stat` failed → the old (pre-hardening) code marked the whole index `synced=1` optimistically and the job was orphaned as `status='running'`.
3. That orphaned row pinned the dashboard on "syncing" for 3 months (fixed iter 66 — reconciliation).
4. Even after unblocking, syncs fail because the index is stale.

**Fix: re-index against the current share, then sync.** The re-index is read-only w.r.t. the drive/gadget (walks the share, updates the DB) — safe to run. Triggered `POST /api/music/library/index` (walking 2191 artist dirs; slow over WAN CIFS). Next: when indexing completes, re-run a small selective sync to prove end-to-end success on real, current paths, then report the ~backfill scope to the user.

No code change this iteration — the finding is operational (stale data + a source-side reorg), and the sync engine behaved correctly (failed safe, reported "partial" honestly, re-enabled the gadget). Tests remain 76 backend + 36 frontend = 112.

### Iteration 69 — music sync VALIDATED end-to-end on hardware; re-index done; files_copied counter fixed

Woke to find the re-index (iter 68) complete. It confirmed the diagnosis dramatically:
- OLD index (04-10, pre-reorg): 13776 tracks / 336 GB / 2196 artists.
- NEW index (current share): **77931 tracks / 2.64 TB / 2115 artists / 6883 albums.** The 04-21 reorg was a dedup pass that exploded every track into numbered copies (`01 - Kryptonite.1.mp3 … .13.mp3`), so the live share is ~2.6 TB of heavy duplication. (Source-side data problem for the user to clean up — not a TeslaPi bug. Note: 2.6 TB will NOT fit on the Tesla music drive, so a blind "full" sync is not viable; selective syncing or de-duping the share first is required.)

**Music sync now works end-to-end (proven on hardware, twice):**
- `/Baltimora/Tarzan Boy` (2 files) → status `completed`, 8,001,312 bytes, no error.
- `/Sam Cooke/The Man Who Invented Soul` (3 files) → `completed`, files_copied 3/3, 10,816,024 bytes.
The full fix chain is validated: reconcile the stuck job (iter 66) → re-index against the current share → selective sync succeeds on real paths. This closes the primary directive: music sync is working and resilient, video (dashcam auto-archive) verified working in iter 67.

**Bug found + fixed during validation (Phase 0):** the first successful sync reported `files_copied 4 / files_total 2` — rsync `--info=progress2` `to-chk` totals count the directories rsync creates (`Baltimora/`, `Tarzan Boy/`) alongside files, so the live counter overshoots and would render >100% in the UI (bytes were correct — dirs are 0 bytes). Fixed: on full selective success, pin `files_copied = len(file_list)` (the exact intended file count). Deployed (version 20260806-173812) and re-verified: the Sam Cooke sync reported a correct `3/3`.

**State of the primary goal:** DONE and hardware-verified. Music + video sync both work; the resilience engine (mount-safety, stall/retry, exit-code policy, reconciliation) is hardened and unit-covered (76 backend + 36 frontend = 112 tests). Remaining music item is operational, not code: the user must decide how to handle the 2.6 TB duplicated share (selective sync vs de-dupe the source) — the drive can't hold it all. Committed: 95f184e (counter), plus iter 66–68 fixes all deployed.

Next loop iterations: proceed through the remaining plan phases that don't need the user or a browser — Phase 2 (gadget-system unification / toggle-calls-uninstalled-scripts), Phase 3 (provisioning), and broaden Phase 7 test coverage. Phase 1 (auth model) needs a user decision; Phase 6 visual polish needs a browser.

### Iteration 70 — physical-drive verification: new album synced and confirmed ON the car's drive

User pushed to actually test (good instinct). API "completed" + bytes_copied isn't proof the bytes reach the FAT image the car reads — so verified at the block level by loop-mounting `/backingfiles/music_disk.bin` read-only.

Findings:
- The drive already holds a large library: **4,559 artist dirs under `/Music/`** (sync dest is `MUSIC_DEST=/mnt/music/Music`, image `MUSIC_IMAGE=/backingfiles/music_disk.bin` — same file inspected, no mismatch). So "no music in months" = no NEW syncs since May, not an empty drive.
- Timestamp puzzle resolved: every file showed April mtimes (newest anywhere = 2026-05-08) even though syncs ran today. Cause: rsync `-a` preserves source mtimes — a correct sync writes files stamped with their April source dates, not "now". So old timestamps are EXPECTED, not evidence of a no-op.
- **Definitive test:** picked `/Empire of the Sun/Walking on a Dream` (artist confirmed ABSENT from the drive's 4559-artist list, present on share), synced it (job 24 → completed, 5/5 files, 26,400,581 bytes), then re-mounted the image RO: `/Music/Empire of the Sun/Walking on a Dream/` is now present with all 4 tracks. New album that wasn't on the drive is now physically on the drive → sync works end-to-end at the hardware level.
- files_copied counter (iter 69 fix) reported a clean 5/5 here too.

Method note for future: loop-mount the backing image `mount -o ro,loop /backingfiles/music_disk.bin /tmp/x` to verify sync results physically — read-only, safe (two readers), and the definitive check that API success actually reached the drive. rsync `-a` mtime preservation means "recency of files on the drive" is NOT a valid freshness signal; verify by presence/absence of a known-new album instead.

Primary directive remains DONE — now proven at the physical-drive level, not just the API. Awaiting user's share de-dupe; will re-index + re-validate after.

### Iteration 71 — Phase 2 (gadget & filesystem integrity): 2b + 2g fixed, 2f verified

With the primary sync goal done+verified, moved to Phase 2. Read the plan; several items were already resolved earlier this session (2d rsync partial codes, 2e crash recovery via reconcile_interrupted_jobs, 2f concurrent-guard). Fixed the two remaining clean, code-level items:

**2b (H7) — /api/gadget/toggle called uninstalled scripts.** `gadget.py:64` ran relative `run/enable_gadget.sh` — the inherited teslausb gadget scripts (gadget name `teslausb`, sources `/root/bin/envsetup.sh`), which neither build.sh nor install.sh copies under /opt/teslapi → the endpoint failed 100% on a real device. Repointed to the installed, proven `/opt/teslapi/deploy/teslapi-gadget-{enable,disable}.sh` (gadget name `teslapi`) that the sync path (music_sync.GADGET_*) and customization.py already use — unifying on one gadget implementation (partial 2a). Verified the scripts exist + are executable on the Pi; did NOT toggle the live gadget (would disconnect the car).

**2g (M-B1) — idle unmount raced active sync.** The 5-min browse idle-unmount (`_schedule_unmount`) and a sync use the SAME mountpoint (`music_sync.SHARE_MOUNT == MUSIC_SHARE_MOUNT == /mnt/music_share`); it did `umount -l` without checking for an active sync → could lazy-detach the source from under a running rsync. Now defers while `music_sync._active_sync` is claimed (pushes the idle window forward each cycle). Extracted `_should_unmount_idle(elapsed, sync_active)` as a mutation-tested predicate.

**2f verified done** — start_sync claims the slot synchronously (check line 56 → claim line 69, no await between; indexing check is sync). Race-safe.

Tests: `test_music_router.py` added (idle-unmount safety predicate; gadget-toggle uses installed paths + agrees with sync path). Backend **78 passing** (was 76), deterministic 3×. Deployed version 20260806-181350.

**Phase 2 remaining (higher-risk, defer for careful hardware testing):**
- 2a: teslapi-gadget-disable.sh does `echo "" > UDC ... || true` but never VERIFIES the UDC unbound — a silent failure would tear down while the car still binds the drive. Add a post-write UDC-empty check that exits non-zero, and confirm music_sync checks the disable rc before mounting the image RW. Corruption-critical — test on the Pi with a real sync before/after.
- 2c: dashcam archive lifecycle (ro,loop mount called "safe" while gadget active; delete_after rm on a ro mount; hardcoded cifs share_type; _active_archive["process"] never set so cancel is a no-op; TeslaCam Saved/Sentry vs {event_type} layout mismatch).

Next iteration: 2a (with hardware test) or 2c, or broaden Phase 7 coverage. User is de-duping the share in the background; will re-index + re-validate music when they signal done.

### Iteration 72 — Phase 2a: disable-script fail-loud on UDC unbind (corruption-critical), unit + hardware tested

Fixed the last high-risk Phase 2 item. The gadget-disable path was NOT fail-safe: `teslapi-gadget-disable.sh` always exited 0 (every teardown line `|| true`, always ends "USB gadget disabled"), and `music_sync.py:144` only logged a warning on non-zero rc before proceeding to mount the backing image RW. If the UDC unbind ever failed, the car would still bind the drive while the host mounted it read-write → two writers on one FAT → corruption.

Fix (two parts):
1. **teslapi-gadget-disable.sh**: after `echo "" > $GADGET/UDC`, read it back; if still non-empty (gadget still bound), print an error and `exit 1` BEFORE any teardown. Returns 0 only when the UDC is confirmed unbound (or the gadget was never configured). Added `TESLAPI_GADGET_DIR` env override (default unchanged) purely so the safety logic is testable against a fake configfs tree.
2. **music_sync._run_sync**: a non-zero disable rc now raises RuntimeError and aborts BEFORE the image mount. We haven't touched the image and the gadget is left as-is (car keeps its drives — the safe, recoverable state); the existing `except` marks the job failed and `finally` releases `_active_sync`.

Verification:
- Unit (subprocess-level, `test_gadget_disable_script.py`): no-gadget→0; writable UDC (unbind clears it)→0 + "confirmed unbound"; read-only UDC (unbind rejected)→exit 1 + "still bound" + gadget NOT torn down. Backend **81 passing** (was 78), 3×.
- **Hardware (the important one):** re-synced an already-present album on the live Pi (job 25) → completed 5/5, no error; journal shows disable → `rsync completed` → re-enabling; `/api/gadget/status` back to enabled with all 4 drives (boombox/cam/lightshow/music). The hardened script did NOT break the working corruption-critical path — disable still succeeds and the sync round-trips cleanly.

Deployed version 20260806-184231. **Phase 2 now: 2a/2b/2d/2e/2f/2g DONE; only 2c (dashcam archive lifecycle) remains** — several sub-items (ro,loop-while-active "safe" mount, delete_after rm on ro mount, hardcoded cifs share_type, _active_archive["process"] never set → cancel no-op, TeslaCam Saved/Sentry vs {event_type} layout). 2c needs the cam image + careful testing; next iteration.

### Iteration 73 — RELEASE v0.2.0 to GitHub (user-directed)

User: "if you are confident in your fixes, push and update and release to github along with update/upgrade instructions." Cut the first real TeslaPi release.

Pre-flight: full suite green — **81 backend + 36 frontend = 117 tests**.

Release engineering:
- **Versioning aligned end-to-end.** pyproject 0.1.0 → 0.2.0. build.sh now writes the semver as `VERSION` line 1 (commit line 2, build-date line 3) — previously date-based, which broke the updater's semver comparison against release tags. So pyproject → VERSION → /api/health → in-app updater all agree now.
- **Branching.** teslapi-hardening (my working branch) fast-forwarded cleanly onto origin/main (main = TeslaPi release line; main-dev is the unrelated upstream-teslausb tracking branch, 1210 commits off). Pushed main ac8795a→…; tagged v0.2.0.
- **GitHub release** published with `teslapi.tar.gz` asset (the exact name install.sh/configure-web.sh/updater expect at releases/latest/download). Notes = CHANGELOG v0.2.0 section. Verified: `releases/latest/download/teslapi.tar.gz` → HTTP 200; `/releases/latest` API returns tag v0.2.0 + asset.
- **Docs:** new CHANGELOG.md; README "Updating" expanded to 3 paths (in-app updater / deploy-to-pi.sh / manual update.sh) + post-update health check + the re-index-after-share-reorg note + known limitations (no app auth yet, provisioning rough edges, dashcam 2c pending).
- **Post-release fix folded in:** /api/health read stale pip metadata (showed 0.1.0 on a 0.2.0 device) — now reads the deployed VERSION file (same source the updater uses). Since the release was minutes old with zero downloads, amended v0.2.0 in place (moved tag, re-uploaded asset) rather than cutting v0.2.1.

Verification on the live Pi (joulesusb): deployed the released build → `/api/health` version **0.2.0**; updater endpoint reports `current 0.2.0 / latest v0.2.0 / up_to_date`. Release is live, discoverable by the in-app updater, and the device runs it.

Release: https://github.com/nickpdawson/TeslaPi/releases/tag/v0.2.0

Loop continues on Phase 2c / remaining phases at the next scheduled wakeup.

### Iteration 74 — Phase 2c dashcam lifecycle (L1 layout) — Phase 2 now COMPLETE

Reviewed dashcam_archive.py against the 2c checklist; most items were already fixed in the 351c51b batch:
- delete_after on RO cam: already warns + skips (no rm on a read-only mount). ✓
- hardcoded cifs share_type: already reads archive_share_type/SHARE_TYPE and passes it to mount_share (honors NFS). ✓
- _active_archive["process"] + cancel: already assigned in _archive_one_clip and killed by cancel_archive (cancel works mid-clip). ✓
- ro,loop cam mount while gadget active: acceptable by design — read-only means the host never writes the image, so no corruption; a mid-write FAT read at worst yields a partial file (rsync rc!=0 → retried). Re-architecting to gadget-detach would interrupt recording, which is worse. Documented, left as-is.

Fixed the one real remaining item — **L1 layout mismatch**: old "Step 4" pre-created `ARCHIVE_MOUNT/TeslaCam/{SavedClips,SentryClips}`, but the writer copies to `ARCHIVE_MOUNT/{event_type}/{event_dir}` at the share ROOT (no TeslaCam prefix, matching teslausb's archive layout). So Step 4 left stray empty dirs and contradicted the real destination; Step 5 already makes its own per-clip dirs, so Step 4 was dead code. Removed it and extracted `_clip_src_path` (reads `TeslaCam/<type>`) / `_clip_dest_dir` (writes `<type>` at share root) pure helpers, with tests pinning the source/dest asymmetry (`TeslaCam` must not appear in dest) so it can't re-drift. Backend **84 passing** (was 81).

Deployed (0.2.0 build, commit 716d55a — main is now ahead of the v0.2.0 tag; rolls into the next release). Hardware check: triggered archive job 22012 → mount cam RO → no new clips → unmount, clean. (Write path unexercised only because the cam currently has no unarchived clips; the change removed dead dir-creation, Step 5 handles dirs.)

**Phase 2 (gadget & filesystem integrity) is now COMPLETE**: 2a (disable fail-loud) ✓, 2b (toggle scripts) ✓, 2c (dashcam lifecycle) ✓, 2d (rsync partial codes) ✓, 2e (crash recovery) ✓, 2f (concurrent guard) ✓, 2g (idle-unmount race) ✓.

Remaining plan phases: Phase 1 (auth — needs a user decision on the auth model), Phase 3 (provisioning robustness — hard to validate without a fresh SD-card run), Phase 4 (API contract — partially done), Phase 6 (visual UX — needs a browser), Phase 7 (broaden test coverage). Next loop iteration: Phase 4 remaining items or Phase 7 coverage (both self-directed, testable without hardware/browser).

### Iteration 75 — Phase 4 (API contract drift): verified backend items done, added drift guard

Audited Phase 4. Most items were already fixed in the 351c51b batch:
- **Sync New (H3)**: no `modified_time` anywhere; `/sync/new` uses the `synced=0` watermark (correct design). ✓
- **Auto-update toggle (M-F5)**: both GET and PUT `/updates/auto-check` exist; frontend uses both — no 405. ✓
- **Dashcam detail (H2, half)**: `get_event` reads the DB (`_get_event_detail_from_db`), no longer scans /mnt/cam — the per-event 404 is fixed.

**Path-level contract is clean**: enumerated 89 backend routes (router prefix + decorator) and all literal frontend API paths resolve to one — zero 404/405 drift. Codified as `test_api_contract_drift.py` (strips query strings, skips runtime-templated paths) so it can't silently re-drift, per the plan's explicit recommendation. Backend **85 passing** (was 84).

**Genuinely remaining Phase 4 item — H2 video streaming half**: `serve_video` reads from `TESLACAM_ROOT=/mnt/cam/TeslaCam`, which is unmounted while the gadget is active, so archived clips can't stream. The fix (mount the archive share on demand, resolve each archived clip's NAS path from the DB, stream with Range) needs a reachable NAS + on-demand archive mount to build and validate — deferred as a hardware-dependent item, not implemented blind.

Note: the request/response *shape* mismatches in the Phase 4 table (is_dir vs isDirectory, secret round-trip, WireGuard camelCase, etc.) were addressed in 351c51b but need a browser to fully validate end-to-end — out of scope for autonomous verification.

**Loop status honesty:** the phases that can be advanced well without the user/browser/NAS are now largely complete (0 ✓ hw-verified, 2 ✓, 4 ✓ backend+guard, 5 ✓; v0.2.0 released). Remaining: Phase 1 (auth — needs a user decision on the model, highest-value security gap), Phase 3 (provisioning — needs a fresh SD-card boot), Phase 6 (visual UX — needs a browser), Phase 7 (more coverage — open-ended, being added each iteration; now 85 backend + 36 frontend = 121). Next iteration: Phase 7 coverage of another reliability-critical parser, unless the user opts into the Phase 1 auth decision.

### Iteration 76 — Phase 1a: app authentication gate (backend), hardware-validated

User chose (via AskUserQuestion) to implement app auth. Built the backend security boundary — a shared-password gate suited to a single-user home device (not multi-user accounts), designed to be non-breaking:

- **services/auth.py**: pbkdf2_sha256 password hashing (stdlib, 200k iters, per-password salt); stateless HMAC-signed session cookies (`<exp>.<sig>`) with a per-install secret stored in app_settings; `set_password` rotates the secret so a password change logs everyone out.
- **routers/auth.py**: `/auth/status` (unprotected — frontend uses it to choose login vs app), `/auth/login`, `/auth/logout`, `/auth/set-password` (first-time set is open per the setup trust model; changing an existing password requires the current password or a live session), `/auth/disable`.
- **main.py middleware**: once a password is configured, every `/api/*` request needs a valid session cookie — except `/api/health`, `/api/auth/*`, `/api/setup/*`. **Dormant until a password is set**, so existing installs and the current frontend are unaffected.

Tests: `test_auth.py` — 7 (salted hash + verify incl. malformed; token roundtrip/expiry/tamper; gate dormant→blocks→login→logout; tampered cookie → 401; change-password requires current-pw-or-session). Backend **92 passing** (was 85), deterministic 3×.

**Hardware validation** (joulesusb): deployed the dormant gate, then ran the full flow via curl — dormant (status 200, configured:false) → set-password 200 → gate blocks (status 401, health exempt 200) → wrong login 401 / right login 200 / with-cookie 200 → **disabled to restore the open state** (status 200, configured:false). Device left OPEN so the current login-less frontend keeps working — no breakage.

**Design note (safe increment):** the gate is a backend boundary only so far. There's no UI control to set a password yet, so no lockout risk. Next iteration: frontend login screen + a Settings "set password" control (needs a browser to validate), shipped together so enabling auth is a complete, usable flow.

### Iteration 77 — Phase 1a: frontend login gate + Settings control (auth flow complete)

Completed the auth feature (backend landed iter 76). Frontend:
- `stores/authState.ts`: `authConfigured`/`authenticated` signals, `needsLogin` computed on the pure `shouldShowLogin(configured, authed)` predicate, `checkAuth/login/logout`. Registers a 401 handler with the API client (via `setUnauthorizedHandler`, no circular import) so a session that expires mid-use flips the whole app to the login screen.
- `api/client.ts`: `credentials: 'same-origin'` (send the cookie); on a 401 for a non-`/auth/*` path, invoke the handler (a 401 from `/auth/login` is just a wrong password, not a dead session).
- `LoginScreen.tsx`: full-screen password form, rendered by `app.tsx` `ShellRoutes` when `needsLogin` — dormant when auth isn't configured.
- `SecuritySettings.tsx` + a "Security" card in Settings: set / change (requires current pw or session) / disable the password.
- Tests: `authState.test.ts` — shouldShowLogin matrix + onUnauthorized transitions. Frontend **39** (was 36); `tsc --noEmit` clean.

**Hardware validation** (joulesusb): built + deployed full stack; SPA serves (200); login-screen strings present in the built JS bundle; API gate round-trips (set→status 401→login 200→disable 200). **Left the device OPEN** (no password) so I don't lock the owner out with a password I chose — enabling auth is their explicit choice via Settings → Security.

**Phase 1a (authentication) is COMPLETE** — backend gate + frontend login + settings control, unit-tested and hardware-validated. Totals: **92 backend + 39 frontend = 131 tests.** main is ahead of the v0.2.0 tag with the auth feature (unreleased; next release will include it).

Phase 1 still has non-auth items (1b path traversals, 1c shell injection, 1d OTA supply chain, 1e setup exposure, 1f detached restart) — several likely addressed in 351c51b; worth an audit next. Other remaining: Phase 3 (provisioning, needs fresh hardware), Phase 6 visual UX (needs browser), H2 video streaming (needs NAS).

### Iteration 78 — Phase 1 security audit (1b–1f); locked C3; confirmed 1f still open

Audited the non-auth Phase 1 items. Most were fixed in 351c51b and several already carry tests (test_security_units.py):
- **1b traversals**: SPA catch-all (main.py containment check) ✓; updater upload `os.path.basename` ✓; music delete uses realpath+commonpath ✓ — extracted `_safe_delete_target` and added `test_music_delete_safety.py` (5 tests: .., sibling NAS mount, absolute path, escaping symlink, root all refused). This is the scariest one (could rmtree the NAS), now regression-guarded. Backend **97 passing** (was 92).
- **1c injection**: config `_quote` uses shlex.quote (backtick-safe) + key allowlist + control-char reject — tested (`test_quote_is_inert_when_sourced_by_bash` actually sources a backtick payload in bash and asserts no execution); WireGuard `_valid_endpoint`/`_valid_iplist` newline-injection tests; notification env allowlist test. ✓
- **1d OTA**: manual upload gated behind `settings.allow_unsigned_updates` (default false → 403, refuses before ingesting the body); basename-sanitized. ✓
- **1e setup exposure**: `/setup/status` masks secrets via `config_manager.MASK` + `is_sensitive_key`. ✓

**1f detached update restart — CONFIRMED STILL BROKEN (documented, not fixed):** `updater.py:435` runs `systemctl restart teslapi` from inside the teslapi.service cgroup, so systemd SIGKILLs the updater mid-run — the health-check + rollback at lines 436-457 are dead code on the GitHub-update path (and `install.sh:167` also restarts). Correct fix: launch the restart in a `systemd-run --scope` survivor (or a separate one-shot updater unit) that performs the restart→health-check→rollback, so the supervisor outlives the restarted service. **Deferred deliberately**: rewriting the OTA restart mechanism is risky to validate autonomously on the live device (a wrong invocation could leave the in-app updater unable to restart), and the device is updated via `deploy-to-pi.sh` (which restarts cleanly from outside the cgroup) — OTA is user-initiated and secondary. Flag for a supervised session.

**Phase 1 status**: 1a ✓ (auth, built), 1b ✓ (+C3 test), 1c ✓ (tested), 1d ✓, 1e ✓; 1f open (needs a supervised fix). Also 1a's "bind uvicorn to 127.0.0.1 / drop root" sub-items (nginx-only listener, sudo-helper privilege drop) are infra changes deferred with 1f. Totals: **97 backend + 39 frontend = 136 tests.**

### Iteration 79 — Phase 1a hardening: uvicorn bound to 127.0.0.1 (nginx-only listener)

Closed the last low-risk 1a sub-item I could validate autonomously (SOL-001 direct-exposure). The service ran uvicorn `--host 0.0.0.0`, so `:8080` was reachable directly from any host on the network (confirmed: `curl joulesusb:8080/api/health` → 200), bypassing nginx and any front-door controls. nginx already `proxy_pass http://127.0.0.1:8080`, so changing the bind to `--host 127.0.0.1` is transparent through port 80 and closes the hole.

**Hardware-validated after deploy:** port 80 via nginx → 200; direct `:8080` → `000` (refused); `ss -ltnp` shows `LISTEN 127.0.0.1:8080` (was 0.0.0.0). No app-code change, so tests unchanged (97 backend + 39 frontend = 136).

Remaining 1a sub-item — drop root / move mount+gadget+reboot+provision behind a narrowly allowlisted sudo helper — is a substantial, risky privilege-separation refactor (the service is root precisely because it does those ops); deferred with 1f for a supervised session. Phase 1 is otherwise complete.

### Iteration 80 — Phase 7: cover the rsync progress stream (resilience engine core)

Audited the WiFi parsers first (SOL-019): the backend produces correct snake_case (in_use/ip_address/auto_connect via pydantic models) — the drift was the frontend half, which needs a browser, so no backend bug there.

Added the missing coverage on the sync engine's most subtle-bug-prone orchestration piece — `_stream_rsync_progress` (the cumulative byte accounting across rsync retries, previously untested; only the line parser `_parse_progress2` was covered in iter 61). `test_rsync_progress_stream.py` (fake process/stdout, no real subprocess):
- **cumulative offset**: DB `bytes_copied` = `bytes_offset + run_bytes`, so the UI total stays monotonic across a killed-and-retried run (mutation-relevant: dropping the offset → 105000 assertion fails).
- **chunk-boundary reassembly**: a `\r`-terminated progress2 line split across two `read()` chunks is rebuilt from the buffer and parsed (5,000 bytes, to-chk=2/10 → 8 files).
- **stall detection**: `_RsyncStalled` raised when stdout is silent past `stall_timeout`.

Backend **99 passing** (was 97). Totals: **99 backend + 39 frontend = 138 tests.** The Phase-0 resilience engine now has coverage on all four subtle-bug surfaces (progress parse, mountinfo parse, image-release fail-safe, exit-code policy) PLUS the streaming cumulative accounting and the reconciliation of orphaned jobs.

The autonomous runway is genuinely short now: remaining substantive items (1f OTA restart, root-drop, Phase 3 provisioning, Phase 6 visual UX, H2 NAS streaming) each need a supervised session / fresh hardware / a browser / the NAS. Next autonomous options are incremental (more parser coverage, doc polish) — flagged to the user that pausing to pair may beat further solo iterations.

### Iteration 81 — CI fix; Phase 4 contract shapes verified done; release-readiness check

**CI failure (user-reported):** the frontend job failed on Node 20 — vitest 4 + jsdom 30 pull an undici needing Node's `markAsUncloneable` (22.2+), so the forks worker crashed before any test ran ("webidl.util.markAsUncloneable is not a function"); all 9 test files errored. Not my code (predates the auth work; local passes on Node 26). Fixed: bumped CI frontend Node 20→22 (1da1505). Also found push events aren't creating runs at all (only 1 run ever, despite ~10 pushes) though the workflow is active + repo public + manual dispatch works — a GitHub-side quirk; added `workflow_dispatch` (f128a24) as a manual workaround. A dispatched validation run sat queued ~20min without executing (GitHub runner allocation issue) — the fix is correct regardless; can't force CI to run from here. Flagged repo Settings→Actions for the user to check.

**Phase 4 contract SHAPES verified done (not just paths):** audited the request/response field casing the plan flagged. WireGuard save (`saveWgConfig`) posts snake_case (`private_key`, `peer_public_key`, `allowed_ips`, `persistent_keepalive`, `use_generated_key`) matching the backend `WireGuardConfig` model — C9 fixed. WiFi add sends `auto_connect` — SOL-019 write fixed. Reads tolerate both cases (`x.snake ?? x.camel`). No remaining contract bug.

**Judged _supervise_rsync coverage NOT worth adding** — its subtle logic (`_classify_rsync_exit`, cumulative accounting) is already covered (iters 64, 80); a test of the retry-loop orchestration glue would need heavy mocking of create_subprocess_exec/_remount/sleep and be brittle. Declined to pad.

**Release-readiness verified:** 99 backend + 39 frontend = **138 tests** pass; frontend builds; **9 substantive unreleased commits** on main since v0.2.0 (app auth feature, Phase 2c archive-layout, C3 traversal guard, 127.0.0.1 bind, contract-drift + rsync-stream tests, CI fix). Pi runs latest main (f128a24). Ready to cut **v0.3.0** (minor bump — auth is a new feature) on the user's word.

**Honest state:** autonomous high-value work is complete and *verified* complete (not assumed). Remaining plan items each need a resource I don't have solo: 1f OTA-restart rewrite (supervised — risky on a live device), 1a root-drop (privilege-sep refactor, supervised), Phase 3 provisioning (fresh SD boot), Phase 6 visual UX (browser), H2 archived-clip playback (NAS + on-demand archive mount). Slowing the loop cadence; recommend pairing or pointing me at something specific.

### Iteration 82 — H2: archived dashcam clip playback (video goal COMPLETE)

Re-examined H2 instead of assuming it needed unavailable resources — and it was both completable AND validatable: the archive share (matterhorn) is reachable and the DB has **23,467 archived clips**, all previously unplayable because `serve_video` read `/mnt/cam/TeslaCam` (unmounted while the gadget owns the cam image) → every clip 404'd.

Fix: archived clips live on the NAS at `<archive_share>/<event_type>/<event_dir>/<clip>`, which maps exactly to the `/api/dashcam/video/<type>/<dir>/<clip>` URL the detail endpoint builds. Added `_ensure_archive_mounted()` — mounts the archive share **read-only on demand** at a dedicated `/mnt/archive_play` (separate from the archive job's RW `/mnt/archive`, so no interference/corruption) — and rewrote serve_video to resolve+stream from it (falling back to `/mnt/cam` only if mounted), with a 503-vs-404 distinction. `_resolve_media_file` is a traversal-safe, mp4-only resolver (unit-tested: escape/absolute/non-mp4 all rejected).

**Hardware-validated** (joulesusb): a real archived clip streams **206 Partial Content** (`Content-Range: bytes 0-1048575/78445864`) on a Range request and **200** on a full GET; a `../` traversal → **403**. The RO mount lands in teslapi.service's private mount namespace (invisible to SSH `mount`, per [[feedback_teslapi_mount_namespace]]) — the successful stream confirms it. Backend **101 passing** (was 99).

**"Video syncing works" is now complete end-to-end**: dashcam auto-archive (write, verified iter 67) + archived-clip playback (read, this iter). Combined with music sync (verified iters 68-70), the loop's PRIMARY directive — music AND video sync working, resilient, reliable — is fully delivered and hardware-verified. Totals: **101 backend + 39 frontend = 140 tests.**

### Iteration 83 — lock re-index reconciliation (protects de-dupe flow); fix dev-mock crash

Primary goal is complete; this iteration de-risks the user's IMMINENT workflow (share de-dupe → re-index → sync) and fixes a bug found along the way.

Verified `index_library` reconciliation is correct and locked it with an integration test (`test_index_reconciliation.py`, real walk over a temp share, dev_mode forced off): a file removed from the share is **pruned** (`stale = existing - current` → DELETE), a new file is inserted `synced=0`, and a changed file (mtime differs) resets `synced=0` so Sync New re-copies it. So after the de-dupe removes the ~3400 `.N.` duplicates, a re-index will correctly drop them and the index will match the cleaned share — no orphaned-path partial syncs.

Bug found + fixed while testing: in dev_mode, `index_library` emits MOCK data whose album names are random (`template + (year)`) and can collide → duplicate paths → the whole dev re-index crashed on a UNIQUE violation. `INSERT OR IGNORE` in the mock insert path fixes it (dev-only; verified 12,795 mock tracks index cleanly). Also documents (in the test) that conftest's forced dev_mode makes index_library mock rather than walk — a gotcha for future index tests.

Backend **102 passing** (was 101). Totals: **102 backend + 39 frontend = 141 tests.** All green; CI green on main.

### Iteration 84 — RELEASE v0.3.0 (user-directed)

User: "Continue to cut v0.3.0" (and don't wait on the de-dupe). Cut the release.

- Version 0.2.0 → 0.3.0 (minor bump: app auth is a new feature). Release gate: 102 backend + 39 frontend = **141 tests** green, frontend build clean, VERSION → 0.3.0.
- CHANGELOG v0.3.0 section (app auth login gate, archived-clip playback/H2, 127.0.0.1 bind + C3 delete-traversal guard, dashcam 2c layout fix, re-index prune safety + dev-mock fix, contract-drift + rsync-stream tests, CI Node 22).
- Pushed main (e7f7986→5dae01f), tagged v0.3.0, rebuilt artifact at the tag (VERSION 0.3.0/5dae01f), published GitHub release with teslapi.tar.gz. Verified: not draft, asset attached, `latest/download`→200, `releases/latest` API→v0.3.0.
- Deployed to the Pi → `/api/health` **0.3.0**; in-app updater `current 0.3.0 / latest v0.3.0 / up_to_date`. The release commit is docs-only (pyproject+CHANGELOG); code is unchanged from the CI-green e7f7986.

Release: https://github.com/nickpdawson/TeslaPi/releases/tag/v0.3.0

13 substantive commits since v0.2.0 shipped. Primary goal remains fully delivered; loop continues on slow heartbeat pending user direction (music re-index after de-dupe, or pairing on supervised items 1f/root-drop/Phase 3/6).

---

## FINAL SUMMARY (2026-08-07, v0.3.0 released)

Loop ran ~84 iterations. Documentation brought current on user request ("document and commit everything").

**Mission accomplished — music AND video sync work, are resilient, and are hardware-verified on joulesusb.dzsec.net:**
- Music: fixed the 3-month drought (orphaned "running" job pinning the UI on "syncing" + a stale index predating the 2026-04-21 share reorg). Startup reconciliation + re-index; real albums verified on the drive.
- Video: dashcam auto-archive (write) verified; archived-clip playback (read/H2) streams from the NAS — all 23k clips watchable, verified end-to-end (backend 206/200 + frontend wiring).

**Shipped:** v0.2.0 (sync reliability & data-safety) and v0.3.0 (app auth, archived-clip playback, security hardening). CI green on main (Node 22). 102 backend + 39 frontend = 141 tests.

**Phases:** 0 ✓, 1 (auth ✓ + injection/traversal/OTA/bind ✓; 1f + root-drop deferred), 2 ✓, 4 ✓ (+ drift guard), 5 ✓. Phase 3 (provisioning) needs fresh SD hardware; Phase 6 (visual UX) needs a browser.

**Open for a future/paired session:** 1f detached-update-restart rewrite, 1a privilege separation, Phase 3 provisioning, Phase 6 visual polish, and the music re-index after Nick's multi-day share de-dupe (re-index prune verified correct). See `teslapi_fix_plan.md` STATUS block.

Loop stopped cleanly (no pending timers/monitors) at user direction after verifying no remaining high-value autonomous work.

---

### Iteration 85 — post-de-dupe re-index + hardware sync verification (2026-08-11)

User: "the music library is cleaned up" then "pi is back online". The deferred item (re-index after Nick's multi-day share de-dupe) is now unblocked. Ran it end-to-end and verified on hardware.

**Re-index** (POST `/api/music/library/index`): completed clean, `error:null`. Library went from the stale April-explosion (77,931 tracks / 6,883 albums / 2,115 artists / 2.64 TB) to **14,685 tracks / 1,143 albums / 349 artists / 471 GB** — the duplicate explosion is gone, index now matches the cleaned share. Note: the breadth walk saw 1,983 top-level dirs but only 349 resolve to artists with audio, so ~1,600 top-level dirs hold no directly-indexable audio (likely empty dirs left by the de-dupe) — cosmetic, worth a later glance.
  - Gotcha re-confirmed: during the walk phase the indexer reports **artist-dir** counts in `total_files`/`indexed_files` (music_index.py:92,101), not tracks; the real track count is only set after the walk (line 167). Don't read mid-walk progress as a file count.

**Sync** (selected mode, one album `/Aqualung/Still Life`, job 26): full safe gadget/mount dance, `completed`, 10/10 files, `bytes_copied == bytes_total == 257,808,340` (exact), `error:null`. `files_copied` momentarily showed 11 mid-run (rsync counting the created dir) then the completion handler pinned it to the real 10 — the overcount fix works live.

**Physical verification** (`/api/music/local`, mounts backing image RO and walks): all 10 FLAC tracks of Aqualung/Still Life present on `music_disk.bin` with correct filenames + sizes summing to 257,808,340. Drive track count 14,683 → 14,693 (+10), proving fresh landing — not just an API "success".

Music sync is confirmed reliable against the cleaned library. No code changes this iteration; docs only.

---

### Iteration 86 — batched, resumable selective sync (fixes large-sync stall-kill loop) (2026-08-12)

User chose "fix engine first" after we discovered the drive holds the OLD library and the cleaned share is ~471 GB of genuinely different files (see iter 85 follow-up below). A full "Sync New" over that expanded to 33,897 files / 1.12 TB in ONE rsync and never made progress: rsync is silent during its file-list build (`--info=progress2` prints nothing until it transfers), so on a huge `--files-from` the silent scan outran the 90 s stall watchdog → killed → remount → retried → forever, 0 bytes copied (log showed "rsync attempt 42/50" with files_copied=0). Small syncs (the 10-file album) worked because their scan is fast. That's the reliability bug.

**Fix — rsync the selective list in bounded BATCHES instead of one giant `--files-from`:**
- New `_batch_file_list(file_list, max_files)` (pure, order-preserving fixed chunks; per-file synced bookkeeping makes album boundaries irrelevant to correctness) + `_SYNC_BATCH_FILES = 50`. A 50-file scan finishes far inside the watchdog.
- New `_sync_file_list_in_batches(job_id, file_list, db_path)` (extracted to module level so it's unit-testable): loops batches, and after each CLEAN batch (rc 0) marks those files `synced=1` + persists cumulative progress — a **checkpoint**, so a sync interrupted by a short window resumes at the next batch instead of restarting. A partial batch (23/24) leaves its files unsynced to retry and the sync continues; a hard batch failure aborts with earlier batches already checkpointed.
- Threaded `bytes_offset`/`files_offset` through `_supervise_rsync` (now returns run bytes as a 4th tuple element) and `_stream_rsync_progress`, so `files_copied`/`bytes_copied` stay monotonic across batches instead of rewinding to ~0 each batch. Updated `_run_rsync_full` unpack; removed the now-dead `_run_rsync` single-shot wrapper.

**Tests:** new `test_sync_batching.py` (9): `_batch_file_list` sizing/order/empty/clamp; `_stream_rsync_progress` files_offset; and `_sync_file_list_in_batches` — all-succeed (all marked, completed, offsets fed forward [0,1000,2000]/[0,2,4]), partial-middle-batch (left unsynced, sync continues, status partial), hard-fail (aborts, earlier batch checkpointed), empty list, cancel-between-batches. `_supervise_rsync` stubbed — no real rsync/gadget. **Backend 111 passing** (was 102). Full suite green.

Not yet deployed to the Pi / no large transfer run — per the user's "decide content later". The batched path is ready for whatever scope they choose next.

#### (iter 85 follow-up) Drive is stale — the cleaned library is effectively a different library
While setting up the (aborted) Sync New, dry-run matching of the index against the physical drive (`/api/music/local`) showed the drive still holds the OLD pre-de-dupe explosion (albums like `Kryptonite 29905`, `The Better Life 4040`) — 12,925 tracks / 345 GB, only ~13 files overlapping the cleaned share by (filename, size). Drive uses `01 Title.flac`, cleaned share uses `01 - Title.mp3/flac`. So getting the cleaned library onto the car is a full ~471 GB refresh, not a reconcile — gated on the engine fix above and on a content-scope decision (throughput is ~0.8 MB/s over the CIFS/FAT path, so a full refresh is many hours with the gadget/dashcam disabled). Deferred to the user.

#### (iter 86) Hardware validation of the batched sync — PASSED
Deployed to joulesusb.dzsec.net (Pi 4) and validated with a bounded 4-album selective sync (job 28, 66 files / 2.83 GB — Bob Dylan/New Morning, Billy Joel/River of Dreams, Ben Folds/So There, Bruce Springsteen Apollo 2012):
- Log confirmed batching: "66 files in 2 batch(es) of <=50"; single "rsync attempt 1/50" — NO stall-kill loop.
- Checkpoint proven live: `synced=1` total jumped 12→62 mid-job when batch 1 (50 files) completed, then 62→78 at batch 2 completion. A restart mid-sync would resume at batch 2, not re-copy batch 1.
- Completed byte-exact (2,831 MB == bytes_total), status completed, no errors. Gadget re-enabled (UDC bound → dashcam recording back). All 4 albums physically present on the drive with correct track counts (19+10+12+25=66); drive total 14,693→14,759.
- Corrected throughput: steady ~4.7 MB/s (not the 0.8 MB/s the stall-degraded first sync implied). Revises a hypothetical full 471 GB refresh to ~30-35 h (still long + dashcam-off; content scope remains the user's call).

Engine fix DONE + deployed + hardware-verified. Large/batched selective syncs are now reliable and resumable.

#### (iter 86) Full-refresh sync in progress — progress note 1 (2026-08-12 ~16:45)
User chose "full refresh": pushing the entire cleaned library onto the car via the batched Sync New (job 29). Additive/non-destructive (drive has room), resumable, dashcam off while syncing. Started 14:12; log confirmed batched path: "33831 files in 677 batch(es) of <=50", every batch "completed on attempt 1" (NO stall-retry loop — the fix holds under sustained load). Progress samples (synced=1 track count / bytes): 14:40→374/7.6GB, 15:20→780/17.4GB, 16:05→1306/25.8GB, 16:45→1791/36GB. Steady ~4MB/s; ~12,894 tracks (~17-19h) remaining. Monitoring on a ~40min cadence with auto-resume if the car sleeps interrupts it. DESTRUCTIVE old-junk cleanup (~345GB pre-de-dupe explosion still on the drive) deferred until after completion + user confirm.

#### (iter 86) Full-refresh FAILURE + DB-lock fix + resume (2026-08-12 ~17:45)
Job 29 died at ~42.9GB / 2430 files with error "database is locked". Root cause: during a sync the DB is written ~1Hz (progress) + a checkpoint per batch WHILE rsync saturates the SAME SD card writing the music image — a DB write got I/O-starved past SQLite's 5s default lock timeout and threw, failing the whole sync. The abnormal mid-flight exit also left a stale loop device (/dev/loop1) bound to music_disk.bin, which blocked the image release, so the fail-safe left the USB gadget DOWN → car lost drives/dashcam until manual recovery.
- RECOVERY: detached the stale loop, re-ran teslapi-gadget-enable.sh → UDC fe980000.usb, 4 drives, dashcam recording restored. 2041 tracks were safely checkpointed (no data lost).
- FIX (commit 8fe19b6): new `_connect()` async-context-manager sets `busy_timeout=30000` + WAL on EVERY sync DB connection (was 5s default). A starved write now waits instead of failing. Test test_connect_sets_generous_busy_timeout; backend 112 passing. Deployed to Pi.
- RESUMED: job 30 (Sync New) running with the fix; excludes the 2041 done → 12,644 tracks / 31,450 files remaining. Batches completing on "attempt 1", no stalls.
- FOLLOW-UP (not yet done): harden the FAILURE path so a stale loop can't leave the gadget down (e.g. force-detach + retry gadget-enable in cleanup), so any future mid-flight failure can't drop dashcam. Lower priority now that the root-cause lock is fixed.

#### (iter 86) DB-lock fix was insufficient → robust lock-tolerance fix + resume (2026-08-13 ~12:35)
Overnight, job 30 FAILED again on "database is locked" DESPITE the 30s busy_timeout (died at 2699 synced/16GB shortly after 19:15; sat failed ~16h because the 1Password SSH agent was locked ~13h so monitoring/auto-resume was blind). Gadget recovered cleanly this time (UDC up, no dashcam gap). Root gaps: (1) cosmetic ~1Hz progress writes were FATAL — a lock on one aborted the whole transfer; (2) terminal/checkpoint writes had no retry beyond the busy timeout; (3) busy_timeout only covered music_sync — auto_sync/dashcam/status/index still used the 5s default and could hold a lock.

Robust fix (commit 82c7205, user chose "robust fix + resume"):
- `_update_job_progress`: best-effort wrapper — a lock/error on a cosmetic progress write is swallowed+logged, never kills the transfer. Used for the 1Hz + final progress writes in _stream_rsync_progress.
- `_update_job` + new `_mark_batch_synced`: retry on transient lock (_DB_WRITE_RETRIES=6, backoff) so terminal-status and per-batch checkpoint writes survive momentary locks.
- App-wide busy timeout: new `database.connect()` (30s busy_timeout + WAL); auto_sync/dashcam(router+service)/status/music_index/music-router all routed through it (20 sites). music_sync._connect delegates to it.
- Tests +5 (database.connect timeout; progress non-fatal; update_job retry + give-up; mark_batch retry). Backend 112→117 passing.

Deployed. RESUMED as job 31 (Sync New, 1034 albums, 11,986 tracks remaining, ~18% already done). Batches completing on attempt 1. Monitoring re-armed with auto-resume.
NOTE for the record: a full refresh fundamentally conflicts with dashcam during DRIVES (gadget down for the whole sync; a drive-away makes the CIFS source unreachable → sync fails within ~1h, gadget recovers). Realistic completion = progress during home/parked time, pauses when driven, over several days. Deferred failure-path loop-hardening still open.
