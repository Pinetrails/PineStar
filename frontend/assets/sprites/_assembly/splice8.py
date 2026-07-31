#!/usr/bin/env python3
# Splice an EIGHT-direction set (rot/walk/gesture x8 from assemble8.py) into
# manifest.json. Cardinal sit/blink/type entries are left untouched — the 8-dir
# rebuilds keep those on the shipped cardinal frames. Same encoding laws as
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
    for d in DIRS8:
        sprites[f"{setname}.rot.{d}"] = [f"{setname}/rot_{d}.png"]
        walks = frames_for(setname, "walk", d)
        if walks:
            sprites[f"{setname}.walk.{d}"] = walks
        gests = frames_for(setname, "gesture", d)
        if gests:
            sprites[f"{setname}.gesture.{d}"] = gests

if __name__ == "__main__":
    with open(MANIFEST, encoding="utf-8") as f:
        m = json.load(f)
    for setname in sys.argv[1:]:
        add_set8(m["sprites"], setname)
    with open(MANIFEST, "w", encoding="utf-8", newline="\r\n") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("spliced 8-dir:", ", ".join(sys.argv[1:]))
