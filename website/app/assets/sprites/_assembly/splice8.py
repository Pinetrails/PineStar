#!/usr/bin/env python3
# Splice an EIGHT-direction set (rot/walk/gesture x8 from assemble8.py, blink from
# make_blink.py, cardinal sit/type) into manifest.json. The set's keys are REBUILT
# from the files on disk — a deleted frame (e.g. the dropped back-view blinks) must
# drop its key too, or drawBody swaps in a missing image. Same encoding laws as
# splice_manifest.py: utf-8, ensure_ascii=False, CRLF, every value a list.
import json, os, sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
MANIFEST = os.path.join(ROOT, "manifest.json")
DIRS8 = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]

def frames_for(setname, prefix, d):
    # prefix match is underscore-terminated, so "walk_south_" never swallows "walk_south-east_"
    setdir = os.path.join(ROOT, setname)
    fs = sorted(
        (f for f in os.listdir(setdir) if f.startswith(f"{prefix}_{d}_")),
        key=lambda f: int(f.rsplit("_", 1)[1].split(".")[0]))
    return [f"{setname}/{f}" for f in fs]

def add_set8(sprites, setname):
    setdir = os.path.join(ROOT, setname)
    for k in [k for k in sprites if k.startswith(setname + ".")]:
        del sprites[k]
    for d in DIRS8:
        sprites[f"{setname}.rot.{d}"] = [f"{setname}/rot_{d}.png"]
        for state in ("sit", "blink", "type"):
            if os.path.exists(os.path.join(setdir, f"{state}_{d}.png")):
                sprites[f"{setname}.{state}.{d}"] = [f"{setname}/{state}_{d}.png"]
        for track in ("walk", "gesture", "type"):
            fs = frames_for(setname, track, d)
            if fs:
                sprites[f"{setname}.{track}.{d}"] = fs

if __name__ == "__main__":
    with open(MANIFEST, encoding="utf-8") as f:
        m = json.load(f)
    for setname in sys.argv[1:]:
        add_set8(m["sprites"], setname)
    with open(MANIFEST, "w", encoding="utf-8", newline="\r\n") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("spliced 8-dir:", ", ".join(sys.argv[1:]))
