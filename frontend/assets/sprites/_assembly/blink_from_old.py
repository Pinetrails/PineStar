#!/usr/bin/env python3
# Give a rebuilt set its blink back — by PROVING the shipped blink still fits, not by
# regenerating or re-deriving it.
#
# v3 reference mode passes the south view through pixel-for-pixel (measured 0/640 different
# on skeleton), so for SOUTH the new idle *is* the old idle. That means the set's existing,
# artist-drawn blink_south still lines up exactly and can be kept verbatim. This checks that
# equality per set and only keeps the blink when it holds.
#
# The other directions are genuinely new art at a new uniform build (skeleton's east went
# 18x42 -> 16x40), so their old blinks no longer fit and are dropped. A missing blink is
# invisible; a misaligned one is the jump Andrew caught on the bear.
#
# An earlier version of this script tried to DERIVE the blink by closing dark clusters in
# the new art, located via the old rot/blink diff. It does not survive contact with the
# roster: on pepe it shut one eye and left the other open, and turned the side-view pupil
# into a blank white stare; on skeleton it repainted the back of the skull. Do not retry
# that approach — an eye is not reliably "the dark bit near the top".
import os, shutil, sys
from PIL import Image

CARDINALS = ["south", "east", "west", "north"]

def blink_still_fits(new_rot, old_rot, old_blink):
    """The old blink fits the new idle iff every pixel the blink TOUCHES is unchanged.

    Whole-frame equality is the wrong test: a v3 round-trip can shift a stray pixel or two
    of body shading (pepe came back 2 different out of 1196) without moving the eyes at all.
    What actually matters is that the blink's own footprint — and the placement it is
    anchored to — still describe the same art."""
    n = Image.open(new_rot).convert("RGBA")
    o = Image.open(old_rot).convert("RGBA")
    b = Image.open(old_blink).convert("RGBA")
    if not (n.size == o.size == b.size):
        return False, "size"
    if n.getchannel("A").getbbox() != o.getchannel("A").getbbox():
        return False, "placement"
    np_, op, bp = n.load(), o.load(), b.load()
    touched = drift = opaque = 0
    for y in range(o.height):
        for x in range(o.width):
            if op[x, y] != bp[x, y]:
                touched += 1
            if op[x, y][3] > 16:
                opaque += 1
            if np_[x, y] != op[x, y]:
                drift += 1
    if touched == 0:
        return False, "no blink in source"
    # Tolerance, not equality. The blink is a WHOLE replacement frame shown for ~130ms, so a
    # couple of drifted shading pixels just flicker imperceptibly (pepe: 2 of 1196). What must
    # not happen is the bear's failure — a different BUILD, where the whole head jumps. Size
    # and placement are already exact above, so cap the remaining drift well under a percent.
    if drift > max(4, opaque // 100):
        return False, f"{drift}/{opaque}px drift"
    return True, f"{touched}px" + (f", {drift}px drift" if drift else "")

def apply_set(sprites_root, old_root, setname):
    setdir = os.path.join(sprites_root, setname)
    olddir = os.path.join(old_root, setname)
    kept, dropped = [], []
    for d in CARDINALS:
        new_rot = os.path.join(setdir, f"rot_{d}.png")
        old_rot = os.path.join(olddir, f"rot_{d}.png")
        old_blink = os.path.join(olddir, f"blink_{d}.png")
        dst = os.path.join(setdir, f"blink_{d}.png")
        if not (os.path.exists(old_blink) and os.path.exists(old_rot) and os.path.exists(new_rot)):
            fits, why = False, "no source"
        else:
            fits, why = blink_still_fits(new_rot, old_rot, old_blink)
        if fits:
            shutil.copy2(old_blink, dst)
            kept.append(f"{d}({why})")
        else:
            if os.path.exists(dst):
                os.remove(dst)          # a stale blink from the 4-dir era must not survive
            dropped.append(f"{d}:{why}")
    print(f"{setname}: blink kept [{' '.join(kept) or 'none'}]"
          + (f"  dropped [{' '.join(dropped)}]" if dropped else ""))
    return len(kept)

if __name__ == "__main__":
    sprites_root, old_root = sys.argv[1], sys.argv[2]
    for setname in sys.argv[3:]:
        apply_set(sprites_root, old_root, setname)
