#!/usr/bin/env python3
# Drive a full 8-direction rebuild for many skins at once.
#
# Per set: assemble8 (rot x8, walk x8, gesture x4) -> blink_from_old (free, derived) ->
# report any size drift against the shipped art. sit/type frames are LEFT ALONE: v3
# reference mode passes the south view through pixel-for-pixel (measured 0/640 different
# on skeleton), so the set's build — and therefore its DATA.SKINS scale — is unchanged.
# That is the whole reason this rebuild needs no scale renormalisation, unlike the bear,
# which was seeded from a padded canvas and came back 15% shorter.
#
# Usage: rebuild_sets.py <sprites_root> <old_root> <charmap.json> [set ...]
import json, os, subprocess, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

def content(path):
    if not os.path.exists(path):
        return None
    im = Image.open(path).convert("RGBA")
    bb = im.getchannel("A").getbbox()
    return None if not bb else (bb[2] - bb[0], bb[3] - bb[1])

def run(script, *args):
    r = subprocess.run([sys.executable, os.path.join(HERE, script), *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"{script} failed for {args}:\n{r.stdout}\n{r.stderr}")
    return r.stdout.strip()

def rebuild(sprites_root, old_root, setname, char_id):
    before = content(os.path.join(old_root, setname, "rot_south.png"))
    print(run("assemble8.py", sprites_root, setname, char_id))
    after = content(os.path.join(sprites_root, setname, "rot_south.png"))
    drift = "" if before == after else f"  *** SOUTH DRIFT {before} -> {after} ***"
    print(run("blink_from_old.py", sprites_root, old_root, setname) + drift)
    return before == after

if __name__ == "__main__":
    sprites_root, old_root, mapfile = sys.argv[1], sys.argv[2], sys.argv[3]
    charmap = json.load(open(mapfile))
    wanted = sys.argv[4:] or sorted(charmap)
    ok, drifted = [], []
    for s in wanted:
        if s not in charmap:
            print(f"{s}: NO CHARACTER ID — skipped"); continue
        (ok if rebuild(sprites_root, old_root, s, charmap[s]) else drifted).append(s)
    print(f"\nrebuilt {len(ok)} set(s) with no south drift")
    if drifted:
        print(f"SOUTH DRIFT on: {', '.join(drifted)} — check scale before shipping")
