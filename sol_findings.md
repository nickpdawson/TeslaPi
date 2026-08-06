BLOCK: TeslaPi is not safe or functionally complete enough for deployment on a trusted home network, remote-access network, or Tesla-connected Raspberry Pi in its current state.

# TeslaPi whole-project review findings

**Review date:** 2026-08-05  
**Workspace:** `/Users/ndawson/Development/TeslaPi` at `ac8795a`, including the pre-existing uncommitted changes in `backend/routers/music.py` and `backend/services/music_sync.py`  
**Review type:** Read-only source, configuration, deployment, API-contract, UX/UI, accessibility, documentation, and safe static-verification review

## Executive summary

The project has a coherent visual direction and broad feature coverage, but the current implementation has two systemic problems:

1. The production web service runs as root and exposes privileged/destructive endpoints without authentication. Several of those endpoints also pass attacker-controlled text into shell interpreters. A device that can reach TeslaPi over Wi-Fi, the fallback hotspot, LAN, or WireGuard can obtain root-equivalent control.
2. Several major frontend features were built against API contracts that the backend does not implement. File Manager, Home Assistant settings, notifications, WireGuard setup, archived dashcam playback, and parts of general settings either fail outright or silently write configuration that runtime services do not read.

**Finding count:** 30 total — 6 Critical, 12 High, 10 Medium, 2 Low.

The minimum release bar is to close SOL-001 through SOL-018, add contract tests, and then complete real Pi/Tesla/NAS/browser validation. Code fixes alone cannot establish that concurrent USB-gadget/archive behavior is safe.

## Scope and method

Reviewed:

- 38 backend Python files and all 16 FastAPI routers (113 route declarations)
- 84 frontend source files, including every page, hook, shared component, and stylesheet
- systemd and nginx deployment configuration
- setup/provisioning, archive, gadget, notification, and inherited TeslaUSB shell paths
- SQLite schema and music/dashcam persistence paths
- README, API documentation, plan, development notes, and checked-in screenshots
- current working-tree changes without editing or reverting them

Safe verification performed:

| Check | Result |
|---|---|
| `python3 -m compileall -q backend` | PASS |
| `git diff --check` | PASS |
| Frontend build | BLOCKED — the checkout's installed dependency tree is incomplete; `npm run build` stops at `tsc: command not found` |
| Python tests | BLOCKED — `pytest` is not installed in the current environment |
| Test inventory | Only three hardware-oriented shell scripts under `tests/`; no backend or frontend automated tests |
| Live responsive screenshots | BLOCKED — the in-app browser reported `No browser is available`; checked-in screenshots and responsive source were reviewed instead |
| Pi/Tesla/NAS behavior | Not run; mounting, gadget toggles, provisioning, reboot, archive deletion, and service changes are hardware-impacting |

The checked-in screenshots are not sufficient responsive evidence: they do not cover the requested desktop/tablet/mobile viewports, and `Screenshots/settings.png` displays the Music page rather than Settings.

## Critical findings

### SOL-001 — No authentication protects a root-privileged management plane

**Severity:** Critical — remote root-equivalent control from any network with route access

**Evidence**

- Every router is included without an authentication or authorization dependency: `backend/main.py:126-143`.
- The API service runs as `root` on `0.0.0.0:8080`: `deploy/teslapi.service:7-15`.
- Nginx exposes `/api/` on the default port-80 virtual host: `deploy/teslapi.nginx:4-7`, `deploy/teslapi.nginx:24-41`.
- Privileged routes include reboot (`backend/routers/system.py:66-80`), gadget control, file deletion, configuration writes, provisioning, updates, Wi-Fi disconnect, WireGuard changes, and live log access.
- `/TeslaCam/` is separately exposed with directory listing enabled: `deploy/teslapi.nginx:43-48`.

**Failure/attack path:** A phone, guest, compromised IoT device, hotspot client, or WireGuard peer sends HTTP requests directly to TeslaPi, reads camera/log/config data, modifies storage/network configuration, executes an update, or reboots/provisions the device. No credential or local-presence check is required.

**Correction:** Add authenticated sessions or mutually authenticated API access; require re-authentication/CSRF protection for destructive actions; introduce roles/capability checks; bind the privileged backend to loopback; remove direct camera autoindex; and split root operations into a narrowly allowlisted helper instead of running the web process as root.

**Acceptance test:** Anonymous HTTP and WebSocket requests receive 401/403; a read-only user cannot call destructive endpoints; cross-site requests cannot mutate state; only an explicitly authorized administrator can perform each privileged action; a LAN scan cannot list `/TeslaCam/`.

### SOL-002 — An unsigned uploaded archive is executed as root

**Severity:** Critical — unauthenticated remote code execution

**Evidence**

- `/api/updates/upload` accepts any filename ending in `.tar.gz` or `.tgz` and reads it without signature or digest verification: `backend/routers/updates.py:36-50`.
- The archive is extracted, any nested `install.sh` is located, and it is run using `sudo bash`: `backend/services/updater.py:364-395`, `backend/services/updater.py:583-588`.
- The web service is already root: `deploy/teslapi.service:8-11`.

**Failure/attack path:** An unauthenticated client uploads a tarball containing `install.sh`; TeslaPi extracts and executes it with full system privileges.

**Correction:** Remove manual executable uploads until signed-update verification exists. Require a pinned signing key, verify a detached signature and exact artifact digest before extraction, require authenticated admin/local confirmation, inspect the archive safely, and execute a non-scripted declarative update from a non-root staging account.

**Acceptance test:** Unsigned, tampered, wrong-key, replayed, path-traversing, and multi-installer archives are rejected before any file is extracted or command is executed. A valid signed release succeeds and its signer/digest are recorded.

### SOL-003 — Generic configuration writes permit persisted shell injection

**Severity:** Critical — persistent root code execution

**Evidence**

- `PUT /api/config` accepts an arbitrary `dict[str, str]`: `backend/models/schemas.py:129-131`, `backend/routers/config.py:45-71`.
- Unknown keys are appended directly as shell variable names: `backend/services/config_manager.py:119-126`.
- `_quote()` recognizes backticks as special but does not escape them before placing the value in double quotes: `backend/services/config_manager.py:32-40`.
- The resulting `.conf` file is sourced by root-run TeslaUSB setup/runtime scripts.

**Failure/attack path:** A client writes a value containing backtick command substitution, or injects a newline through an unvalidated key. The next root script that sources the configuration executes the payload persistently.

**Correction:** Replace the shell-sourceable configuration with a typed data format. Until then, allowlist exact keys, validate keys with `^[A-Z][A-Z0-9_]*$`, reject control characters, serialize values using a proven shell-escaping primitive, and never source web-written content in a privileged shell.

**Acceptance test:** A security test corpus containing backticks, `$()`, quotes, newlines, semicolons, glob characters, and invalid keys round-trips as inert data; sourcing is eliminated or produces no side effects; only documented keys are accepted.

### SOL-004 — WireGuard fields and home SSID are interpolated into root shell commands

**Severity:** Critical — root command execution and persistent dispatcher compromise

**Evidence**

- WireGuard request fields have no format constraints: `backend/models/schemas.py:211-219`.
- Values are interpolated into `conf_content`, embedded inside a single-quoted `bash -c` string, and piped to `sudo tee`: `backend/services/wireguard_manager.py:194-235`.
- `home_ssid` is written through the same pattern: `backend/services/wireguard_manager.py:276-313`.
- The generated NetworkManager dispatcher later `source`s that file: `backend/services/wireguard_manager.py:320-339`.

**Failure/attack path:** A quote/newline in a key, endpoint, DNS value, allowed-IP list, or SSID breaks out of the shell string. The command runs immediately or persists in the sourced dispatcher configuration.

**Correction:** Write files with Python using restrictive atomic file permissions; never use `bash -c`/`echo` for user data. Strictly validate WireGuard keys, CIDRs, host:port endpoints, DNS addresses, keepalive bounds, and SSID length/control characters. Do not `source` data files.

**Acceptance test:** Malicious metacharacter inputs are rejected; valid unusual SSIDs remain inert; no shell interpreter appears in the write path; generated files are mode 0600, atomically replaced, and parse successfully with `wg-quick strip`.

### SOL-005 — Notification channel configuration is assembled into `bash -c`

**Severity:** Critical — unauthenticated remote command execution

**Evidence**

- Arbitrary notification configuration keys and values become unquoted environment assignments: `backend/services/notification_service.py:152-178`.
- The title and message are interpolated into the same command string: `backend/services/notification_service.py:169-179`.
- Notification channel creation/update/test endpoints are exposed without authentication: `backend/routers/notifications.py:24-121`.

**Failure/attack path:** An attacker creates a push channel whose configuration value contains shell separators or substitution, then invokes its test endpoint. `bash -c` executes the injected command as the root web-service user.

**Correction:** Call the script with an argument vector and pass a separately constructed `env` mapping to `create_subprocess_exec`; allowlist channel types and exact per-type fields; validate URLs/tokens/IDs; keep secrets out of command lines and logs.

**Acceptance test:** Metacharacters in every channel field/title/message are treated literally, an unexpected config key is rejected, and process inspection shows no secret or user text embedded in a shell command.

### SOL-006 — First-run endpoints leak secrets and expose destructive provisioning

**Severity:** Critical — credential disclosure and storage destruction

**Evidence**

- While setup is incomplete, `/setup/status` returns the raw detected config: `backend/routers/setup.py:180-201`.
- `/setup/detect` also returns raw existing configuration: `backend/routers/setup.py:204-216`.
- Unlike `/api/config`, these paths do not mask password/token/credential values.
- `/setup/provision` accepts an arbitrary config dictionary and starts the privileged setup process: `backend/routers/setup.py:380-398`.
- The setup service writes the submitted config and launches the provisioning script with `sudo`: `backend/services/pi_setup.py:50-101`.

**Failure/attack path:** During first boot or after the setup marker is removed, any network client retrieves Wi-Fi/NAS credentials or starts disk partitioning with attacker-controlled configuration.

**Correction:** Make initial setup local-only or protect it with a one-time physical bootstrap secret. Mask all detected secrets, validate a strict provisioning schema, require an explicit target-device challenge/confirmation, and invalidate the bootstrap credential after completion.

**Acceptance test:** Unauthenticated remote clients cannot read setup state or provision; detected config never returns secret values; a mismatched device identity/confirmation blocks provisioning; a second setup attempt requires physical recovery.

## High findings

### SOL-007 — Update upload permits a reliable memory DoS and unsafe destination path

**Severity:** High — service outage and arbitrary root file overwrite at a `.tgz` path

**Evidence**

- Nginx explicitly allows unlimited request bodies and disables request buffering: `deploy/teslapi.nginx:38-40`.
- The backend reads the entire upload into memory: `backend/routers/updates.py:46-50`.
- systemd limits TeslaPi to 256 MB RAM: `deploy/teslapi.service:17-19`.
- The client-controlled filename is joined without `basename()`/resolved-parent validation: `backend/services/updater.py:466-471`.

**Failure path:** A moderately sized request exceeds the service memory limit and restarts it. A filename containing `../` writes outside the update directory before update processing.

**Correction:** Enforce a small nginx and application limit, stream to a newly created file under a fixed staging directory, ignore the client filename, use a generated basename, verify final size/digest, and reject archive paths outside staging.

**Acceptance test:** Oversized and chunked uploads receive 413 without a memory spike; traversal filenames cannot create files outside staging; interrupted uploads leave no partial artifact.

### SOL-008 — File Manager frontend and backend implement incompatible APIs

**Severity:** High — the advertised feature is unusable

**Evidence**

- Frontend expects `{path, drive, entries, parent}` and camelCase entries: `frontend/src/api/types.ts:128-144`, `frontend/src/hooks/useFiles.ts:13-18`.
- Backend returns a bare list with `is_dir` and a numeric `modified`: `backend/routers/files.py:45-50`, `backend/routers/files.py:140-177`.
- Frontend sends `{path, name}` for mkdir, `{paths}` for delete, and `{src, dest}` for move/copy: `frontend/src/hooks/useFiles.ts:58-90`.
- Backend accepts only `{path}`, requires `{path, confirm}`, and calls the destination `dst`: `backend/routers/files.py:26-43`, `backend/routers/files.py:239-355`.
- Frontend posts upload `path` as a multipart form field, but backend declares it as a query parameter: `frontend/src/hooks/useFiles.ts:34-54`, `backend/routers/files.py:180-199`.

**Failure path:** Initial list handling reads properties from an array; directories are treated as files; create/delete/rename/copy receive 409/422; uploads silently target `/`.

**Correction:** Define one OpenAPI contract and generate/share types. Return the expected envelope (or adapt the frontend), use one naming convention, explicitly declare `Form(...)` for upload path, and cover every operation with integration tests.

**Acceptance test:** On real mounted test directories, list/navigate/upload/new-folder/rename/copy/multi-delete/download all succeed at nested paths; returned dates and directory flags render correctly; validation failures show actionable messages.

### SOL-009 — Settings key drift makes values ineffective and can replace secrets with `********`

**Severity:** High — silent misconfiguration and credential destruction

**Evidence**

- Setup writes `WIFI_SSID`/`WIFI_PASS`: `backend/routers/setup.py:274-281`; the inherited TeslaUSB config and Settings use `SSID`/`WIFIPASS`: `frontend/src/components/config/Settings.tsx:77-84`, `frontend/src/components/config/Settings.tsx:163-170`.
- Settings writes `MUSIC_SERVER`/`MUSIC_USER`/`MUSIC_PASSWORD`: `frontend/src/components/config/Settings.tsx:173-190`; runtime ignores those server/user/password keys and reads lower-case `music_share_*` or archive credentials: `backend/services/share_browser.py:260-289`.
- The config API masks secrets as `********`: `backend/routers/config.py:15-30`; the frontend loads that literal into form state and sends it back on save: `frontend/src/components/config/Settings.tsx:60-65`, `frontend/src/components/config/Settings.tsx:163-170`, `frontend/src/components/config/Settings.tsx:218-228`.

**Failure path:** First-run Wi-Fi values are written under keys the inherited runtime does not use, while music-share settings appear saved but runtime uses old values. Saving a section without re-entering a secret writes eight asterisks as the new credential.

**Correction:** Establish a typed canonical configuration schema and migration. Use an omitted/null “unchanged secret” sentinel; never return a mask as field data; update only explicitly dirty fields.

**Acceptance test:** Settings created by setup load identically; each UI field changes the exact runtime value; saving unrelated fields preserves byte-for-byte secret values; clearing a secret requires a separate explicit action.

### SOL-010 — Home Assistant Settings is disconnected from the Home Assistant backend

**Severity:** High — enable, save, and test do not configure the advertised integration

**Evidence**

- The real HA API persists SQLite-backed config at `/api/ha/config` and tests at `/api/ha/test`: `backend/routers/homeassistant.py:28-72`, `backend/routers/homeassistant.py:97-118`.
- Settings instead maps shell variables from `/api/config` and writes them back there: `frontend/src/components/config/Settings.tsx:112-120`, `frontend/src/components/config/Settings.tsx:218-228`.
- The test button calls nonexistent `/api/config/test-ha`: `frontend/src/components/config/HASettings.tsx:37-45`.

**Failure path:** Test always returns 404; saving does not update the database read at application startup, so the push loop/MQTT client remains unconfigured.

**Correction:** Load, save, and test through `/ha/config` and `/ha/test`; map snake/camel fields deliberately; support unchanged secret tokens; restart/reconfigure the live client after successful save.

**Acceptance test:** Configure HA entirely in the UI, test the connection, restart TeslaPi, and verify the same masked config loads and real entities/pushes arrive at the selected HA instance.

### SOL-011 — Notification Settings is disconnected from notification channels/rules APIs

**Severity:** High — channels, tests, and routing do not configure the runtime dispatcher

**Evidence**

- Runtime channel CRUD/test and event rules live at `/notifications/channels`, `/notifications/test/{id}`, and `/notifications/rules`: `backend/routers/notifications.py:24-121`, `backend/routers/notifications.py:192-250`.
- The frontend instead serializes invented `NOTIFY_*` shell variables through `/config`: `frontend/src/components/config/Settings.tsx:125-149`, `frontend/src/components/config/Settings.tsx:205-215`.
- Its test button calls nonexistent `/config/test-notification`: `frontend/src/components/config/NotifySettings.tsx:86-97`.
- Event routing is stored inside channel config keys rather than the backend rules model: `frontend/src/components/config/NotifySettings.tsx:225-263`.

**Failure path:** Tests 404; saved channels and event selections never appear in the SQLite tables the service reads.

**Correction:** Rebuild the screen on the actual channel and rules APIs, handle secret sentinels, validate per-channel schemas, and give each event checkbox an accessible label.

**Acceptance test:** Create two channels, test each, configure different event routes, restart, trigger each event, and verify only the intended channels send and history records the result.

### SOL-012 — WireGuard setup cannot save or display a generated configuration

**Severity:** High — remote-access setup fails

**Evidence**

- Frontend sends camelCase `WireGuardConfig`; backend requires snake_case fields: `frontend/src/api/types.ts:328-335`, `frontend/src/hooks/useNetwork.ts:132-149`, `backend/models/schemas.py:211-219`.
- The UI intentionally sends an empty private key: `frontend/src/components/network/WireGuardPanel.tsx:85-101`; backend rejects a missing private key: `backend/services/wireguard_manager.py:200-203`.
- Backend key generation returns snake_case keys while frontend reads `publicKey`: `backend/routers/network.py:189-199`, `frontend/src/hooks/useNetwork.ts:147-149`.
- Auto-connect sends `onlyNonHome`/`homeSsid`; backend expects `only_non_home`/`home_ssid`: `frontend/src/hooks/useNetwork.ts:142-145`, `backend/routers/network.py:31-34`.

**Failure path:** Save receives 422 before reaching the manager; generated public key is undefined; auto-connect silently uses defaults instead of the user's selections.

**Correction:** Generate one contract from OpenAPI, decide whether the server or client owns the private key, return the public key in the documented shape, and load the saved configuration into the form.

**Acceptance test:** Generate keys, copy a non-empty public key, save a peer, reload, enable/test the tunnel, and verify auto-connect honors both home-only choices after reboot.

### SOL-013 — Archived dashcam events cannot be opened for playback

**Severity:** High — the central dashcam viewer flow fails in production

**Evidence**

- Event listing reads archived rows from SQLite because the camera image cannot be mounted while the gadget is active: `backend/routers/dashcam.py:257-329`.
- Event detail ignores those rows and scans only local `/mnt/cam/TeslaCam`: `backend/routers/dashcam.py:193-252`, `backend/routers/dashcam.py:332-347`.
- The database stores event metadata but no archive destination/video locator.

**Failure path:** The dashboard/list shows an archived event; selecting it asks the detail route for local clips that are not mounted and returns 404.

**Correction:** Persist the archive object path for every successfully verified clip and serve/stream details from the configured NAS (or maintain a safe indexed local proxy). Keep local and archived event IDs explicit.

**Acceptance test:** With the gadget active and camera image unmounted, select an archived event and play/seek every available camera angle from the NAS with Range requests; a missing NAS file is reported as missing, not “event not found.”

### SOL-014 — Dashcam archival uses an unsafe backing-image lifecycle and broken deletion semantics

**Severity:** High — filesystem inconsistency, false completion, and possible data loss

**Evidence**

- The service mounts the camera backing image read-only while claiming that is safe during concurrent Tesla writes: `backend/services/dashcam_archive.py:108-114`.
- It never detaches/disables the USB gadget before mounting the same filesystem locally.
- It later tries to delete source files from that read-only mount: `backend/services/dashcam_archive.py:209-225`.
- Archive mounting is hardcoded to CIFS regardless of configured NFS support: `backend/services/dashcam_archive.py:131-147`.
- Jobs are marked completed even after per-file failures: `backend/services/dashcam_archive.py:187-192`, `backend/services/dashcam_archive.py:236-242`.

**Failure path:** The Tesla host and Pi access one filesystem concurrently without coordination; snapshots can be inconsistent or corrupt. `delete_after` cannot delete on a read-only mount. NFS configurations fail. Skipped files still produce “completed.”

**Correction:** Use the proven gadget-detach/mount/archive/unmount/reattach lifecycle or a filesystem-level snapshot strategy validated for the backing format. Mount the configured share type. Model `completed_with_errors` and never delete until destination size/hash/fsync verification succeeds.

**Acceptance test:** Power-loss and drive-away tests during each lifecycle phase recover without corruption; fsck stays clean; NFS and CIFS both archive; delete-after removes only verified clips; any skipped file yields a non-success job state and is retried.

### SOL-015 — Rsync partial-transfer codes are treated as success

**Severity:** High — incomplete archives/syncs are recorded as complete

**Evidence**

- Dashcam treats rsync code 23 as copied, inserts the DB row, and may proceed to deletion logic: `backend/services/dashcam_archive.py:178-215`.
- Full music sync treats codes 23 and 24 as completed: `backend/services/music_sync.py:600-605`.
- Selective music sync accepts code 23, after which the caller marks the requested files as synced: `backend/services/music_sync.py:625-649`, `backend/services/music_sync.py:212-226`.

**Failure path:** Permissions, I/O errors, vanished sources, or a partial transfer produce rsync 23/24. TeslaPi records full success and suppresses future sync attempts; dashcam deletion becomes dangerous once the read-only bug is fixed.

**Correction:** Treat 23/24 as incomplete. Parse itemized errors, verify each destination, record per-file outcomes, retry only retryable failures, and mark the job partial/failed until all requested files are verified.

**Acceptance test:** Inject one unreadable/truncated/vanishing file; the job is not completed, the file remains unsynced/on-camera, the UI names the failed item, and a later retry completes it without duplicating verified files.

### SOL-016 — “Sync new” queries a column that does not exist

**Severity:** High — incremental sync fails after the first completed job

**Evidence**

- `music_files` defines `modified_at`: `backend/database.py:17-27`.
- `/music/sync/new` queries `modified_time`: `backend/routers/music.py:649-659`.

**Failure path:** Once a completed sync exists, the endpoint executes the invalid SQL and returns HTTP 500 instead of selecting new albums.

**Correction:** Query the canonical column, normalize timestamp formats/time zones, and add a database migration/contract test for the incremental selection rule.

**Acceptance test:** Index and sync a baseline, add one newer file and one older file, invoke Sync New, and verify exactly the new file is selected; the same action again reports no new files.

### SOL-017 — Dashboard health state and telemetry can be materially false

**Severity:** High — operators receive a green “All Systems Go” during failures

**Evidence**

- Backend reports top-level `state`; `ArchiveStatus` has no `status`: `backend/models/schemas.py:59-66`, `backend/models/schemas.py:89-98`.
- Frontend ignores top-level `state` and defaults missing `archive.status` to `idle`: `frontend/src/hooks/useStatus.ts:56-64`.
- Hero/header derive health only from that invented archive field: `frontend/src/components/dashboard/StatusHero.tsx:19-35`, `frontend/src/components/layout/StatusBar.tsx:3-19`.
- Backend has no CPU-usage field, but UI defaults it to 0%; a missing Wi-Fi value becomes 0 dBm and is labeled “Excellent”: `backend/models/schemas.py:76-86`, `frontend/src/hooks/useStatus.ts:32-40`, `frontend/src/components/dashboard/SystemCard.tsx:22-35`.
- Sparse backing-file allocated blocks are shown as filesystem used bytes: `backend/routers/status.py:227-248`.

**Failure path:** Archiving/syncing, unreachable NAS, prior job error, missing sensors, or nearly-full filesystems can render as healthy, 0% CPU, excellent Wi-Fi, or inaccurate capacity.

**Correction:** Define one explicit health/state contract with `unknown` as a first-class value; include active job and last-error states; collect actual CPU load; distinguish missing Wi-Fi; mount/read filesystem metadata safely for storage or label allocated-host usage accurately.

**Acceptance test:** Contract fixtures for idle, archiving, syncing, NAS-down, archive-failed, sensor-missing, and storage-full produce the correct label/color/text with no optimistic defaults or NaN.

### SOL-018 — Frontend fails open when setup status cannot be checked

**Severity:** High — setup and safety gating are bypassed during backend failure

**Evidence**

- Any `/setup/status` error sets `setupComplete` to true: `frontend/src/stores/appState.ts:10-24`.
- The router then displays the normal application rather than a retry/recovery state: `frontend/src/app.tsx:15-45`.

**Failure path:** On a new/unprovisioned Pi, a transient backend error bypasses the wizard and exposes normal controls with incomplete/default configuration.

**Correction:** Represent `unknown`, `needs_setup`, `ready`, and `recovery` distinctly. Fail closed for provisioning-dependent/destructive controls while allowing a diagnostics/retry page.

**Acceptance test:** Simulate timeout, 500, malformed response, and network loss on a fresh device; none reaches the ready dashboard or destructive controls, and recovery/retry remains possible.

## Medium findings

### SOL-019 — Wi-Fi request/response casing silently changes behavior

**Severity:** Medium — saved-network controls lie or ignore input

**Evidence**

- Add Wi-Fi sends `autoConnect`; backend expects `auto_connect`, so Pydantic ignores the user value and uses true: `frontend/src/hooks/useNetwork.ts:110-113`, `backend/models/schemas.py:199-205`.
- Saved connections are stored directly without transforming backend `auto_connect`/`ip_address`: `frontend/src/hooks/useNetwork.ts:89-96`, `backend/models/schemas.py:174-183`.

**Correction:** Generate client types or add a single boundary mapper; reject unknown request keys instead of silently ignoring them.

**Acceptance test:** Add with auto-connect off, reload, and verify NetworkManager plus UI both show off; active IP/signal/device fields render from a backend fixture.

### SOL-020 — “Automatic update checks” has no working read endpoint or scheduler

**Severity:** Medium — shipped toggle is nonfunctional

**Evidence**

- Frontend GETs `/updates/auto-check`: `frontend/src/components/config/SystemSettings.tsx:68-81`; backend defines only PUT: `backend/routers/updates.py:78-88`.
- The service can read/write JSON but no startup task consumes the schedule: `backend/services/updater.py:548-576`; `backend/main.py:46-99` starts only auto-sync and HA loops.

**Correction:** Add the GET route and a persisted, observable scheduler, or remove/label the control until implemented. Automatic application should remain a separate opt-in from automatic checking.

**Acceptance test:** Enable a short check interval, restart, observe a timestamped check at the expected time, disable it, and verify no later network request occurs.

### SOL-021 — Auto-sync configuration is neither persisted nor exposed in the UI

**Severity:** Medium — the always-on archive loop cannot be durably controlled

**Evidence**

- In-memory defaults enable the loop every process start: `backend/services/auto_sync.py:12-21`.
- `configure()` mutates only that dictionary: `backend/services/auto_sync.py:36-54`.
- Backend exposes `/auto-sync`, but the frontend has no references to it: `backend/routers/auto_sync.py:19-31`.

**Correction:** Persist state/interval, add settings/status UI, and make initial enablement an explicit setup choice—especially before the archive lifecycle is safe.

**Acceptance test:** Disable and set an interval in UI, restart twice, and verify the loop remains disabled/retains interval; setup default matches the documented policy.

### SOL-022 — Dashboard duplicates an expensive poll and always tries a missing script

**Severity:** Medium — avoidable Pi CPU/process churn

**Evidence**

- `Shell` calls `useStatus()` on every page: `frontend/src/components/layout/Shell.tsx:55-57`; Dashboard calls it again: `frontend/src/components/dashboard/Dashboard.tsx:98-102`.
- Each hook creates an independent five-second loop: `frontend/src/hooks/useStatus.ts:6`, `frontend/src/hooks/useStatus.ts:80-111`.
- Every production request first runs missing `run/status.sh`, then falls back to multiple subprocess/database reads: `backend/routers/status.py:392-417`; no such file exists under `run/`.

**Correction:** Own polling once in a provider/store, coalesce concurrent requests, remove the dead status-script probe or ship it, and cache stable metrics briefly.

**Acceptance test:** One visible browser produces at most one status request per interval and no missing-script process; two consumers share one result; hidden tabs stop polling.

### SOL-023 — Standard FastAPI validation details are discarded

**Severity:** Medium — users receive generic, non-actionable errors

**Evidence**

- Client reads only `error` and `message`, not FastAPI's `detail`: `frontend/src/api/client.ts:38-47`.

**Correction:** Normalize `detail` strings and validation arrays into field/action messages, preserve a correlation ID, and display non-sensitive correction guidance.

**Acceptance test:** Trigger 400, 404, 409, and 422 responses; the UI shows the backend reason/field rather than only “Bad Request” or “Unprocessable Entity.”

### SOL-024 — Export Diagnostics advertises checks that production does not perform

**Severity:** Medium — support artifact is incomplete/misleading

**Evidence**

- Production tries `run/diagnose.sh`, but that file is absent: `backend/routers/diagnostics.py:25-48`.
- It then returns only storage, internet ping, and temperature checks, while the docstring promises gadget, services, logs, and structured system diagnostics: `backend/routers/diagnostics.py:25-31`, `backend/routers/diagnostics.py:50-87`.

**Correction:** Implement the missing checks directly with bounded allowlisted commands, include version/service/gadget/archive/network-share state, redact secrets/addresses where appropriate, and give each check an explicit unknown/error state.

**Acceptance test:** Break each monitored subsystem independently and verify the exported JSON detects it without exposing passwords/tokens or reporting overall OK.

### SOL-025 — Dialogs, toasts, and context menus lack required accessibility behavior

**Severity:** Medium — keyboard and screen-reader workflows are incomplete

**Evidence**

- Modal has no `role="dialog"`, `aria-modal`, labelled association, initial focus, focus trap, or focus restoration: `frontend/src/components/common/Modal.tsx:14-54`.
- Add Wi-Fi duplicates the same non-semantic overlay and also sets state during render: `frontend/src/components/network/AddWiFiModal.tsx:23-31`, `frontend/src/components/network/AddWiFiModal.tsx:68-73`.
- Toasts are clickable `div`s with no live region/status/alert semantics or keyboard dismiss control: `frontend/src/components/common/Toast.tsx:17-75`.
- Context menu has no menu roles, arrow-key model, or initial focus: `frontend/src/components/files/ContextMenu.tsx:20-82`.

**Correction:** Use accessible dialog/menu primitives or implement the full WAI-ARIA patterns; make toasts live-region announcements with a real dismiss button; move form resets into an effect.

**Acceptance test:** Complete every dialog/menu action with keyboard only; Tab cannot escape an open modal; Escape closes and restores prior focus; screen readers announce title, errors, toast priority, and menu state.

### SOL-026 — File Manager’s mobile tree toggle can never reveal the tree

**Severity:** Medium — dead mobile control and incomplete keyboard semantics

**Evidence**

- Mobile status is read from `window.innerWidth` without a resize subscription: `frontend/src/components/files/FileBrowser.tsx:191-192`.
- Toggle changes `showTree`, but rendering also requires `!isMobile`, so mobile can never show it: `frontend/src/components/files/FileBrowser.tsx:218-223`, `frontend/src/components/files/FileBrowser.tsx:336-344`.
- The entire list is one focus target; rows have no roles/tab stops/selection semantics, and CSS explicitly removes its focus outline: `frontend/src/components/files/FileList.tsx:184-219`, `frontend/src/styles/files.css:369-379`.

**Correction:** Implement a responsive drawer/tree for mobile with a matchMedia hook; expose a listbox/treegrid keyboard model or native table/list semantics; maintain visible focus and selected state.

**Acceptance test:** At 375×812, toggle opens/closes a navigable tree; resizing across 768 px updates layout; keyboard and screen-reader users can identify, select, open, rename, and delete a row.

### SOL-027 — Motion preferences are ignored and the primary health visualization is visually cramped

**Severity:** Medium — accessibility discomfort and reduced status legibility

**Evidence**

- Multiple infinite and entrance animations are defined with no `prefers-reduced-motion` override: `frontend/src/styles/global.css:294-384` and no reduced-motion rule exists under `frontend/src`.
- The hero pulse runs even while idle: `frontend/src/components/dashboard/StatusHero.tsx:71-78`.
- The status label is constrained to a 100 px circle: `frontend/src/components/dashboard/StatusHero.tsx:46-50`, `frontend/src/components/dashboard/StatusHero.tsx:80-96`; the checked-in Dashboard screenshot shows “ALL SYSTEMS GO” wrapping across three lines.

**Correction:** Disable nonessential animation/transitions under reduced motion; pulse/rotate only for an active transient state; enlarge or shorten the ring label and provide adjacent plain-text state/error detail.

**Acceptance test:** With reduced motion enabled, no shimmer/pulse/spin/slide runs except an essential progress alternative; every health label fits at 320–1200 CSS px and remains understandable without color.

### SOL-028 — No automated product tests or CI protect the API contracts and lifecycle

**Severity:** Medium — regressions are likely and current correctness is not reproducible

**Evidence**

- The repository contains only `tests/create-backingfiles-partition-test.sh`, `tests/create-backingfiles-test.sh`, and `tests/losetuptest.sh`.
- No Python/frontend test files or CI workflow exist, despite pytest dev dependencies in `pyproject.toml:19-24`.
- The numerous request/response mismatches above would be caught by one generated-client or route integration suite.

**Correction:** Add CI with locked clean installs, backend unit/integration tests, frontend type/build/component tests, OpenAPI contract tests, shell lint/tests, and a privileged Pi hardware lane for gadget/mount/power-loss behavior.

**Acceptance test:** A casing/schema mutation fails CI; clean checkout builds both artifacts; critical archive/update/config security cases have negative tests; the release record links a passing real-hardware matrix.

## Low findings

### SOL-029 — Several interactive states are not exposed semantically

**Severity:** Low — screen-reader state ambiguity

**Evidence**

- Expandable cards omit `aria-expanded` and a controlled-region relationship: `frontend/src/components/common/Card.tsx:31-59`.
- Dashcam filter buttons omit `aria-pressed`; event pseudo-buttons handle Enter but not Space: `frontend/src/components/dashcam/EventList.tsx:88-101`, `frontend/src/components/dashcam/EventList.tsx:122-129`.

**Correction:** Add state attributes/relationships, use real buttons for button actions, and support the complete keyboard activation model.

**Acceptance test:** Accessibility-tree inspection exposes expanded/selected/pressed state; Enter and Space activate all button-like controls exactly once.

### SOL-030 — Documentation and screenshot evidence contradict the product

**Severity:** Low — misleading onboarding/release evidence

**Evidence**

- README contains a populated screenshot section at `README.md:9-14`, then a second section claiming screenshots are “coming soon” at `README.md:87-89`.
- `Screenshots/settings.png` is a Music page, not Settings.
- README says all configuration works through the UI (`README.md:75-78`), which conflicts with SOL-009 through SOL-012 and SOL-021.

**Correction:** Remove duplicate/stale claims, regenerate named screenshots from the release build at 1280×800, 768×1024, 375×812, and Tesla’s 1200×600 viewport, and label features as implemented, experimental, or planned based on acceptance evidence.

**Acceptance test:** Every documented screenshot filename/page/viewport matches the release artifact; every feature claim links to a passing automated or hardware acceptance check.

## Missing-feature inventory

These are not cosmetic backlog items; they are required to make existing product claims true.

| Missing or incomplete capability | Blocking findings |
|---|---|
| Authentication, authorization, CSRF/local-presence protection, audit identity | SOL-001, SOL-006 |
| Signed and bounded OTA supply chain | SOL-002, SOL-007 |
| Typed, non-shell-sourceable canonical configuration | SOL-003, SOL-009 |
| Working File Manager contract | SOL-008, SOL-026 |
| Working Home Assistant UI integration | SOL-010 |
| Working notification channel/rule UI | SOL-011 |
| Working WireGuard UI and safe writer | SOL-004, SOL-012 |
| Archived NAS event playback | SOL-013 |
| Gadget-safe archive/delete lifecycle with per-file verification | SOL-014, SOL-015 |
| Correct incremental music sync | SOL-016 |
| Truthful unified health/unknown/error model | SOL-017 |
| Fail-closed recoverable setup state | SOL-018 |
| Persisted and observable update/auto-sync scheduling | SOL-020, SOL-021 |
| Complete redacted diagnostics | SOL-024 |
| Accessible dialogs, menus, notifications, tables, and reduced-motion mode | SOL-025 through SOL-029 |
| Automated contract/security/UI tests and real-hardware release gate | SOL-028 |

## Recommended correction order

1. Remove network exposure or disable the service until SOL-001 through SOL-006 are closed. Disable manual OTA uploads immediately.
2. Establish one typed OpenAPI/config contract, then fix File Manager, Settings, HA, notifications, WireGuard, and Wi-Fi against it.
3. Redesign archive/sync correctness around exclusive gadget ownership, destination verification, explicit partial failure, and durable archive paths.
4. Replace optimistic dashboard defaults with an explicit state/unknown/error contract.
5. Add CI and contract/security tests before further feature work.
6. Run a hardware acceptance campaign covering Tesla attach/detach, NAS loss, Wi-Fi loss, power loss, full storage, archive deletion, update rollback, 1200×600 Tesla browser, tablet, and phone.

## Release disposition

**Code disposition:** BLOCK. Critical unauthenticated RCE paths and major nonfunctional product surfaces remain.

**External gates after code correction:** clean dependency install/build, automated suite, Raspberry Pi service hardening, real Tesla USB-gadget lifecycle tests, CIFS and NFS NAS tests, fault/power-loss recovery, WireGuard/pfSense validation, Home Assistant/notification E2E, and responsive/browser/accessibility QA.
