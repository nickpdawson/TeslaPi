"""Tests for music router helpers (idle-unmount safety, gadget wiring)."""


def test_should_unmount_idle_never_while_sync_active():
    # 2g: the idle timer and a sync share the same mountpoint (/mnt/music_share).
    # Unmounting while a sync runs would umount -l the source out from under rsync.
    from backend.routers.music import _should_unmount_idle, MOUNT_IDLE_TIMEOUT

    over = MOUNT_IDLE_TIMEOUT + 1
    under = MOUNT_IDLE_TIMEOUT - 1
    # idle long enough, no sync -> unmount
    assert _should_unmount_idle(over, sync_active=False) is True
    # idle long enough BUT a sync is active -> never unmount (the safety property)
    assert _should_unmount_idle(over, sync_active=True) is False
    # not idle yet -> don't unmount regardless
    assert _should_unmount_idle(under, sync_active=False) is False
    assert _should_unmount_idle(under, sync_active=True) is False


def test_gadget_toggle_uses_installed_scripts():
    # 2b: the old relative run/enable_gadget.sh was never installed under /opt/teslapi,
    # so /gadget/toggle failed 100% on a real device. It must use the same installed,
    # proven scripts the sync path uses.
    from backend.routers import gadget
    from backend.services import music_sync

    assert gadget.GADGET_ENABLE == "/opt/teslapi/deploy/teslapi-gadget-enable.sh"
    assert gadget.GADGET_DISABLE == "/opt/teslapi/deploy/teslapi-gadget-disable.sh"
    # and they agree with the sync path (unified gadget implementation)
    assert gadget.GADGET_ENABLE == music_sync.GADGET_ENABLE
    assert gadget.GADGET_DISABLE == music_sync.GADGET_DISABLE
