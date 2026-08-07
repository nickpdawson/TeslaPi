# TeslaPi fix plan — merged from fable_findings.md + sol_findings.md

Date: 2026-08-05. This reconciles the two independent reviews into one prioritized, de-duplicated action list. Where both reviews found the same defect it's marked **[both]** (high confidence); single-source items are marked **[fable]** or **[sol]**. Line references are the current working tree at `ac8795a` plus the uncommitted music diff.

Both reviews reach the same bottom line: **do not expose this on any network until the security phase is done.** The two systemic problems are (1) an unauthenticated, root-privileged management plane with several shell-injection paths, and (2) major frontend features built against API contracts the backend doesn't implement.

---

## STATUS — updated 2026-08-07 (v0.3.0 released)

Progress against this plan after ~84 loop iterations. Full detail in `teslapi_work_log.md`.

**Primary goal — music AND video sync reliable — DONE, hardware-verified on joulesusb.**
- Music sync: root cause was an orphaned "running" job (May-8) pinning the dashboard on "syncing" for 3 months + a stale index predating a 2026-04-21 share reorg. Fixed (startup reconciliation + re-index). Real albums verified landing on the drive.
- Video: dashcam auto-archive (write) verified running; archived-clip playback (read/H2) now streams from the NAS — all 23k clips watchable.

**Phase status:**
- Phase 0 (sync resilience) — DONE ✓ (mount-safety, stall/retry, exit-code policy, reconciliation; unit + hardware verified)
- Phase 1 (security) — auth DONE ✓ (login gate + session cookies + Settings control); injection/traversal/OTA-gate/setup-masking verified + tested; 127.0.0.1 bind DONE. **Deferred (supervised):** 1f detached update restart (self-kills health-check/rollback), 1a root-drop/sudo-helper privilege separation.
- Phase 2 (gadget & fs integrity) — DONE ✓ (2a disable fail-loud, 2b toggle scripts, 2c dashcam layout, 2d/2e/2f/2g)
- Phase 4 (API contract drift) — backend items DONE ✓ (H3, M-F5, C9, SOL-019, H2) + contract-drift regression guard. Frontend request/response shapes verified snake_case-correct.
- Phase 5 (truthful status) — DONE ✓
- Phase 3 (provisioning) — NOT done; needs a fresh SD-card boot to validate (deploy-onto-working-teslausb is the tested path).
- Phase 6 (UX/visual) — mostly NOT done; needs a browser (nav entry points, wizard race, drive-wipe confirm, mobile layout).

**Tests:** 102 backend + 39 frontend = 141, all green. CI green on main (Node 22). Releases: v0.2.0 (sync/data-safety), v0.3.0 (auth + H2 playback + hardening).

**Remaining = the "Deferred (supervised)" security items above + Phase 3 (fresh hardware) + Phase 6 (browser).** Also pending: music re-index after the user's multi-day share de-dupe (re-index prune verified correct).

---

## Phase 0 — Before committing the current working-tree diff

The uncommitted `music_sync.py`/`music.py` changes are mostly good (progress2 parsing, mount lock, gadget-enable finally), but have regressions to close first. **[fable]**

1. `_run_rsync` (selective sync, `music_sync.py:644`): wrap the `_stream_rsync_progress` call so `_RsyncStalled` kills+waits rsync and doesn't propagate as a hard failure that leaves rsync alive. Treat a stall during a no-transfer delta pass as non-fatal or lengthen its timeout.
2. Both rsync paths: drain `stderr` concurrently (or redirect to a file/DEVNULL). Today stderr is only read after exit; sustained CIFS warnings fill the pipe, rsync blocks, stdout goes silent, and the watchdog fires a false stall.
3. `_run_rsync_full`: preserve `cumulative_bytes` across a stall retry (the `_, cumulative_bytes = await …` assignment is skipped when the exception fires, so the byte counter jumps backward).
4. `delete_local_music` (`music.py:471-532`): take `_image_mount_lock` and check `_active_sync` like `/music/local` now does — otherwise it double-mounts and re-enables the gadget mid-sync.
5. Add `syncing` to the frontend `LocalMusicData` type and have OnTeslaTab show a "syncing" state instead of "No music yet."

---

## Phase 1 — Security (BLOCKER; both reviews gate release on this)

### 1a. Authentication + reduce privilege **[both]** (SOL-001, fable H1)
- Bind uvicorn to `127.0.0.1` (`teslapi.service:11`); let nginx be the only listener.
- Add an auth gate (session or token) on all state-changing/secret-bearing endpoints; add CSRF protection for destructive actions.
- Remove the `/TeslaCam/` autoindex in nginx (`teslapi.nginx:43-48`) or put it behind auth. **[sol]**
- Stop running the web process as root: move privileged operations (mount, gadget, reboot, provision) behind a narrowly allowlisted sudo helper rather than running uvicorn as root. **[sol SOL-001]**

### 1b. Path traversals **[both where overlapping]**
- SPA catch-all `main.py:161-169`: resolve and require `relative_to(_static_dir.resolve())` before `FileResponse`. Currently serves any file via `../`. **[fable C2]**
- Music delete `music.py:508-517`: replace the `startswith` prefix check with `os.path.commonpath` / `realpath(mount)+os.sep`; today `../music_share/...` passes and rmtrees the NAS. **[fable C3]**
- Update upload `updater.py:466-471`: `os.path.basename` the client filename before joining. **[both]** (SOL-007, fable H11)

### 1c. Shell injection — three paths, all reaching a root shell **[both]**
- WireGuard fields + `home_ssid` (`wireguard_manager.py:194-235,276-339`): write config files from Python at mode 0600, atomically; never `bash -c`/`echo`. Validate keys, CIDRs, host:port, DNS, keepalive bounds, SSID. Stop `source`-ing data files. (SOL-004, fable C7)
- Config values (`config_manager.py:32-40`): `_quote` doesn't escape backticks; the `.conf` is sourced by root. Move to a typed non-sourceable format; interim: allowlist exact keys (`^[A-Z][A-Z0-9_]*$`), reject control chars, single-quote values. (SOL-003, fable H12)
- Notification dispatch (`notification_service.py:152-179`): use `create_subprocess_exec` with an argv + separate `env=` dict; allowlist channel types/fields; keep secrets out of argv and logs. (SOL-005, fable H12)

### 1d. OTA supply chain **[both]** (SOL-002/007, fable H6/H11)
- Disable manual tarball upload+execute until signed updates exist. It currently extracts an uploaded `.tar.gz` and runs its `install.sh` via `sudo bash`, unauthenticated.
- When re-enabled: pinned signing key, verify detached signature + digest before extraction, authenticated admin confirmation, non-root staging.
- Enforce a small body cap in nginx (`teslapi.nginx:38-40` currently sets unlimited + buffering off) and stream to disk with a size/digest check instead of `await file.read()` into a 256 MB-capped process.

### 1e. First-run setup exposure **[sol SOL-006]**
- `/setup/status` and `/setup/detect` return raw detected config **including secrets** — apply the same masking as `/api/config`.
- `/setup/provision` takes an arbitrary dict and starts partitioning: make setup local-only or gate on a one-time bootstrap secret, validate a strict schema, and require an explicit target-device confirmation (also addresses fable H9's "wipe wrong disk").

### 1f. Detached update restart **[both]** (SOL-002 correction, fable H6)
- `install.sh`/updater restart the systemd unit from inside its own cgroup, killing the updater mid-run so health-check/rollback never execute. Launch updates via `systemd-run` (own scope) or a separate updater unit; run health-check/rollback from a survivor.

---

## Phase 2 — Gadget & filesystem integrity (BLOCKER for data safety)

### 2a. Unify the two gadget systems **[fable C1]**
Deploy scripts manage `usb_gadget/teslapi`; inherited `run/` scripts manage `usb_gadget/teslausb`; the backend calls both (`music_sync.py:36` vs `gadget.py:64`). Pick one gadget name and one enable/disable implementation. The disable script must fail loudly if any gadget still binds the UDC (prevents mounting an image the car is actively writing).

### 2b. `/api/gadget/toggle` calls uninstalled scripts **[fable H7]**
`gadget.py:64` runs relative `run/enable_gadget.sh`; neither `build.sh` nor `install.sh` installs `run/` under `/opt/teslapi`. Fails 100% on a real install. Install the scripts and point at the unified gadget from 2a.

### 2c. Dashcam archive lifecycle **[both]** (SOL-014, fable L1/L2)
- It mounts the cam image `ro,loop` while the gadget is active and calls that "safe" — replace with the proven gadget-detach → mount → archive → unmount → reattach lifecycle (or a validated snapshot strategy). **[sol]**
- `delete_after` does `rm -f` on the read-only mount — can never work as written; only delete after the destination is verified and from a writable path. **[sol]**
- Archive mount is hardcoded `share_type="cifs"` (`dashcam_archive.py:131`) regardless of configured NFS — honor the configured share type. **[sol]**
- `_active_archive["process"]` is never assigned, so cancel is a no-op mid-clip. **[fable L2]**
- Step-4 creates `TeslaCam/{Saved,Sentry}Clips` but step-5 copies to `{event_type}` — reconcile the two layouts. **[fable L1]**

### 2d. rsync partial-transfer codes treated as success **[both]** (SOL-015, fable M-B5)
- Dashcam (code 23) and music (23/24) are recorded as complete; selective sync then marks requested files `synced=1` even when they failed. Treat 23/24 as incomplete, verify per-file, model a `completed_with_errors`/partial state, and don't suppress future retries or (once 2c is fixed) delete unverified clips.

### 2e. Crash/restart recovery for syncs **[fable H10]**
`_run_sync` is a bare `create_task`; a mid-sync restart leaves the gadget disabled, image mounted, and the DB job "running" forever. On startup, fail orphaned "running" jobs and re-run gadget-enable.

### 2f. Race: two concurrent syncs/archives **[fable M-B2]**
Check-then-set guard is split by awaited DB calls in `music_sync.py:55/95` and `dashcam_archive.py:75/91`. Claim the slot synchronously before the first await.

### 2g. Idle browse-unmount vs active sync **[fable M-B1]**
The 5-min idle unmount (`umount -l`) doesn't check `_active_sync` and can lazy-detach the share under a running rsync. Skip while a sync job is active.

---

## Phase 3 — Provisioning that actually works **[fable C8, sol overlaps]**

`setup-teslapi.sh` launched from inside `teslapi.service` cannot succeed but reports success:
- `if ! $step_fn` suppresses `set -e` inside step functions; every step ends in `write_progress` (always succeeds), so `mkfs`/`mount` failures are swallowed. Fix the error-propagation pattern.
- The script writes `/etc/modules`, `/etc/fstab`, `/root/bin`, a systemd unit, but never remounts `/` rw (read-only root) — add an explicit rw remount or run these from a context that can write.
- `teslapi.service:22` `ProtectHome=true` blocks `/root` and gives the service a private mount namespace, so provisioning mounts are invisible to nginx/archiveloop. Reconcile the namespace settings with what the launched scripts need.
- `setup-teslapi.sh:657-751` enables `teslausb.service` pointing at `/root/bin/archiveloop`, which it never installed (source dir `/opt/teslapi/run` doesn't exist) — install the helpers or stop enabling the unit.
- Deploy-script robustness: read-only-root detection matches `errors=remount-ro` (M-D3, breaks a normal system on exit); service needs `RequiresMountsFor=/mutable` (M-D1); failed nginx switch leaves the UI down (M-D4); `install.sh` writes DB to rootfs on the common bare-`/mutable` path (M-D1); `size_to_bytes`/partition-suffix parsing gaps (L16); dispatcher SSID detection uses the wrong nmcli field (L17).

---

## Phase 4 — API contract drift (features that don't work end-to-end)

Both reviews recommend generating one OpenAPI contract and shared/generated client types so these can't silently re-drift. **[both]** (SOL-008/028, fable C5/C9)

| Feature | Fix | Refs |
|---|---|---|
| **File Manager** | `/files/{drive}/ls` returns a bare list, not `{path,drive,entries,parent}`; `is_dir` vs `isDirectory`; delete needs `{path,confirm}` not `{paths}`; move uses `dst` not `dest`; mkdir ignores the name field; upload `path` is a query param not form field. Nothing in the Files page works. | **[both]** SOL-008, fable C5 |
| **Settings secret round-trip** | GET masks secrets `********`, forms prefill and PUT them back verbatim, overwriting real WiFi/share/HA/MQTT credentials. Use an omitted/null "unchanged" sentinel; never treat the mask as data. | **[both]** SOL-009, fable C6/M-B8 |
| **Settings key drift** | Setup writes `WIFI_SSID/WIFI_PASS`; Settings + runtime use `SSID/WIFIPASS`; music-share saved as `MUSIC_SERVER/...` but runtime reads lowercase `music_share_*`. Establish one canonical schema + migration. | **[sol]** SOL-009 |
| **Home Assistant** | Settings maps HA through `/api/config` shell vars and tests `/config/test-ha` (404). Real endpoints are `/ha/config` + `/ha/test`; live client isn't reconfigured after save. | **[both]** SOL-010, fable M-F6 |
| **Notifications** | UI invents `NOTIFY_*` shell vars via `/config` and tests `/config/test-notification` (404). Real APIs: `/notifications/channels`, `/notifications/test/{id}`, `/notifications/rules`. Also fixes duplicate-channel-on-save. | **[both]** SOL-011, fable M-F6/M-F11 |
| **WireGuard** | camelCase vs snake_case → 422 on every save; UI sends empty private key that backend rejects; generated `public_key` read as `publicKey`; auto-connect keys mismatch. | **[both]** SOL-012, fable C9 |
| **WiFi add/list** | `autoConnect` vs `auto_connect` (unchecking ignored); `in_use`/`ip_address` read raw as camelCase → blank IP, no in-use marker. | **[both]** SOL-019, fable M-F2 |
| **Sync New** | Queries `modified_time`; column is `modified_at` → 500. Also `modified_at` (epoch REAL) vs `completed_at` (ISO TEXT) never compares true — normalize timestamps. | **[both]** SOL-016, fable H3 |
| **Selective sync path** | LibraryTab strips leading `/` but DB paths keep it → LIKE matches nothing, totals show 0. | **[fable]** H19 |
| **Auto-update toggle** | Frontend GETs `/updates/auto-check`; backend only defines PUT → 405. Add the GET and a real scheduler, or remove the control. | **[both]** SOL-020, fable M-F5 |
| **Dashcam archived playback** | List reads archived DB rows; detail scans local `/mnt/cam` (unmounted while gadget active) → every event 404s. Persist the archive path per clip and stream from the NAS with Range support. | **[both]** SOL-013, fable H2 |
| **Validation errors** | Client reads only `error`/`message`, discards FastAPI `detail`/422 arrays → generic messages. Surface field-level reasons. | **[sol]** SOL-023 |

---

## Phase 5 — Truthful status & health

- **Dashboard shows false health** **[both]** (SOL-017, fable M-F1): frontend ignores backend top-level `state`, defaults missing `archive.status` to `idle`, CPU to 0%, missing WiFi to 0 dBm labeled "Excellent"; sparse backing-file blocks shown as used bytes. Backend `_determine_system_state` never emits CONNECTED/ERROR/OFFLINE though the schema defines them. Define one health contract with `unknown` as a first-class value; collect real CPU; read filesystem metadata correctly.
- **Frontend fails open on setup error** **[sol SOL-018]**: `appState.ts:23` sets `setupComplete = true` on any `/setup/status` error, so a transient backend failure on a fresh Pi bypasses the wizard into the live dashboard. Model `unknown`/`needs_setup`/`ready`/`recovery` and fail closed for destructive controls.
- **Missing probe scripts** **[sol SOL-022/024]**: every status request runs nonexistent `run/status.sh` first; diagnostics runs nonexistent `run/diagnose.sh` and returns fewer checks than its docstring promises. Remove the dead probes or ship the scripts; implement the promised diagnostics with bounded allowlisted commands and secret redaction.
- **Auto-sync not persisted/exposed** **[sol SOL-021]**: the archive loop enables itself in-memory every boot with no UI and no persistence. Persist state/interval and add a settings/status control — important since it drives the (currently unsafe) archive lifecycle.
- **Offline dashboard shows fabricated demo data** **[fable M-U1]**: `Dashboard.tsx` renders `mockStatus` (847 artists, fake sentry events) behind a small banner. Gate demo data behind a dev flag; show a real offline state.
- **Duplicate/uncontrolled polling** **[both]** (SOL-022, fable L7): Shell and Dashboard each run `useStatus()` (two 5s loops); visibilitychange can spawn a second timer chain. Own polling once in a store; stop when hidden.

---

## Phase 6 — UX / UI improvements

### Navigation & flow
- **Add persistent nav to Dashcam/Music/Files** — `/files` has no entry point in the UI at all. **[fable H15]**
- **Fix the wizard provisioning race & swallowed errors** — it shows "Setup Complete" and redirects while partitioning is still running, and marks success even when `/setup/complete` throws. **[fable H13]**
- **Wire up the three dead FinishStep links** (HA/notifications/WireGuard all `preventDefault()` to nowhere). **[fable H15]**
- **Confirmation for the drive wipe** naming the target drive, matching every other destructive action. **[both]** (SOL-006, fable H9)

### Touch (Tesla browser + phone are primary targets)
- **Folders open on double-click only** (`e.detail === 2`) and the tree is hidden < 768px — touch users can't navigate. Make single-tap open on touch. **[both]** SOL-026, fable H14
- **Mobile tree toggle is dead** — rendering also requires `!isMobile`, and `isMobile` has no resize listener. Add a responsive drawer + matchMedia. **[sol SOL-026]**
- **Timeline scrubber is touchstart-only** — no drag on touch. Add touchmove/touchend. **[fable M-F8]**
- **Touch targets below 44px** across WiFi actions (32px), artist delete/expand (32px, sits beside expand → mis-taps delete music), upload cancel (20px), layout options. **[both]** SOL-027-adjacent, fable M-U6

### Feedback & error states
- **Music actions fail silently** — `useMusic` collects `error` but nothing renders it; on a car screen users tap repeatedly. Surface it. **[fable H16]**
- **"Cancel upload" doesn't cancel** — flips local state but the XHR keeps going. Actually abort. **[fable M-U8]**
- **Event list / stale lists have no retry/refresh affordance.** **[fable M-U8]**
- **Modal has no pending-disabled state** → double-fire on delete. **[fable M-U2]**

### Accessibility **[both, strong overlap]** (SOL-025/027/029, fable M-U2/L11)
- Modal: add `role="dialog"`, `aria-modal`, labelled title, initial focus, focus trap, focus restoration. AddWiFiModal duplicates a non-semantic overlay and sets state during render — consolidate on the shared Modal and move the reset into an effect.
- Toasts: make them live regions with a real dismiss button.
- Context menu: add menu roles, arrow-key model, initial focus.
- FileList: it's one focus target with the outline removed; give rows real roles/tab stops/selection and restore visible focus.
- `prefers-reduced-motion`: none exists; the hero ring pulses even when idle. Add a reduced-motion override and only animate for active transient states.
- Expandable cards need `aria-expanded`; dashcam filter buttons need `aria-pressed` and Space activation.

### Visual correctness
- **Undefined CSS variables** in LockChimeSettings (`--color-surface-raised`/`--color-primary*`) make the upload progress fill invisible → uploads look hung; `btn--xs`/`btn--accent` used but undefined. **[fable M-U3]**
- **music.css uses `gap:` in ~15 rules** despite the project's "no CSS gap (Tesla browser safe)" rule — spacing collapses on older Tesla Chromium. **[fable M-U4]**
- **Contrast failures** in both themes (dark muted 3.8:1, light muted 2.6:1 at 12px). **[fable M-U5]**
- **Music capacity hardcoded to 1.7 TB** while the default image is 20G — bar reads ~0% forever, hides a full drive. **[both]** SOL-017-adjacent, fable M-F9
- **Status ring label** cramped in a 100px circle ("ALL SYSTEMS GO" wraps to 3 lines in the checked-in screenshot) — enlarge/shorten and add adjacent plain-text detail. **[sol SOL-027]**
- **Dashcam viewer pane** hidden by inline `display:none` at all widths and unstyled when shown. **[both]** fable H17, sol layout
- Mobile dashcam grids crop cameras / hide the only switch affordance (**[fable M-U7]**); page-height `calc(100vh-60px)` vs 56/64px header (**[fable L12]**); no 404 route (**[fable L13]**).

---

## Phase 7 — Testing & release gate **[sol SOL-028, both recommend]**

- Add CI: clean install + frontend type/build, backend unit/integration, **OpenAPI contract tests** (would have caught most of Phase 4), shell lint.
- A casing/schema mutation should fail CI.
- Real-hardware acceptance lane before release: Tesla attach/detach, NAS loss (CIFS **and** NFS), WiFi loss, power loss mid-archive, full storage, archive deletion, update rollback, and the 1200×600 Tesla viewport + tablet + phone.
- Docs cleanup: README has a duplicate "screenshots coming soon" section; `Screenshots/settings.png` is actually the Music page; README claims all config works via UI (contradicted by Phase 4). **[sol SOL-030]**

---

## Where the two reviews differ

- **sol** frames the OTA upload as its own critical RCE (SOL-002) and adds setup-endpoint secret leakage (SOL-006), the dashcam RO-mount/delete lifecycle (SOL-014), fail-open setup gating (SOL-018), missing `run/status.sh`/`run/diagnose.sh` probes (SOL-022/024), auto-sync persistence (SOL-021), discarded validation detail (SOL-023), and the no-tests/CI gap (SOL-028) — all verified and folded in above.
- **fable** goes deeper on the uncommitted diff regressions (Phase 0), the two-gadget-name corruption path (2a), deploy-script robustness (Phase 3), and the granular UX/CSS inventory (Phase 6).
- They agree, independently, on every critical: no auth, three shell-injection paths, config mask round-trip, Files/WireGuard/HA/notifications contract breaks, dashcam archived playback, `modified_time` column, dashboard false health, and modal accessibility. That convergence is the strongest signal in either document.

## Suggested execution order

Phase 0 (unblock the commit) → Phase 1 (security, gate any exposure) → Phase 2 (data-safety) → Phase 4 secret round-trip + Sync New + Files (highest-visibility breakage) → Phase 3 (provisioning) → rest of Phase 4 → Phase 5 → Phase 6 → Phase 7. Keep the service off any network until Phase 1 lands.
