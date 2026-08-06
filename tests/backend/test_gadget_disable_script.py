"""Safety-contract tests for deploy/teslapi-gadget-disable.sh (Phase 2a).

The disable script MUST exit non-zero if the gadget is still bound to a UDC, so the
sync path aborts instead of mounting the backing image RW under an active gadget
(two writers on one FAT -> corruption).
"""
import os
import stat
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "teslapi-gadget-disable.sh"


def _make_gadget(tmp_path) -> Path:
    g = tmp_path / "teslapi"
    (g / "configs" / "c.1" / "strings" / "0x409").mkdir(parents=True)
    (g / "functions").mkdir(parents=True)
    (g / "strings" / "0x409").mkdir(parents=True)
    return g


def _run(gadget_dir: Path):
    return subprocess.run(
        ["bash", str(SCRIPT)],
        env={**os.environ, "TESLAPI_GADGET_DIR": str(gadget_dir)},
        capture_output=True, text=True,
    )


def test_no_gadget_dir_exits_zero(tmp_path):
    r = _run(tmp_path / "nonexistent")
    assert r.returncode == 0


def test_unbound_udc_exits_zero(tmp_path):
    g = _make_gadget(tmp_path)
    (g / "UDC").write_text("3f980000.usb")  # writable -> echo "" clears it -> success
    r = _run(g)
    assert r.returncode == 0, r.stderr
    assert "confirmed unbound" in r.stdout


def test_still_bound_udc_fails_loud_and_skips_teardown(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("root bypasses file permissions; the write-rejection can't be simulated")
    g = _make_gadget(tmp_path)
    udc = g / "UDC"
    udc.write_text("3f980000.usb")
    udc.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)  # 0444: reject the unbind write
    r = _run(g)
    assert r.returncode == 1  # fail loud
    assert "still bound" in r.stderr
    # aborted BEFORE tearing down the gadget
    assert (g / "functions").is_dir()
