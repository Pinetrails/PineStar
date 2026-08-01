#!/usr/bin/env python3
# Derive a rebuilt set's blink frames from its NEW idle art, for FREE, using the OLD
# rot/blink pair only as a locator.
#
# Why not keep the old blink: a v3 rebuild changes the body's proportions (the bear went
# 46px tall to 39px, and the old set was not even uniform across directions), so the shipped
# blink no longer lines up with the new idle and the face visibly jumps for the 130ms it is
# on screen. That was the first thing Andrew caught.
#
# Why not detect eyes from scratch: the bear's detector keys on brown fur around a cream
# muzzle and does not survive contact with a skeleton, a robot or a CRT for a head.
#
# So: the OLD pair already encodes exactly which pixels a blink touches for THIS character.
# Diff them, express that region as a FRACTION of the old content box, map the fraction onto
# the new content box, and close whatever dark clusters sit inside that small window. The
# result is the new art with its own eyes shut, so it cannot disagree with the idle.
#
# Sets whose old pair has no diff (no blink shipped, or a face that never blinked) produce
# no blink at all — a missing blink is invisible, a wrong one is not.
import os, sys
from PIL import Image

CARDINALS = ["south", "east", "west", "north"]

def content_box(im):
    return im.getchannel("A").getbbox()

def diff_mask(a, b):
    pa, pb = a.load(), b.load()
    out = set()
    for y in range(min(a.height, b.height)):
        for x in range(min(a.width, b.width)):
            if pa[x, y] != pb[x, y]:
                out.add((x, y))
    return out

def luma(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]

def clusters_in(im, region, max_size=28):
    """Dark INTERIOR clusters inside `region`. Threshold is adaptive (relative to the
    region's own luma spread) so it works on white bone and dark metal alike."""
    px = im.load()
    x0, y0, x1, y1 = region
    lum = [luma(px[x, y]) for y in range(y0, y1) for x in range(x0, x1) if px[x, y][3] > 16]
    if not lum:
        return []
    lum.sort()
    med = lum[len(lum) // 2]
    thr = min(med - 18, lum[max(0, len(lum) // 6)])
    dark = set()
    for y in range(y0, y1):
        for x in range(x0, x1):
            p = px[x, y]
            if p[3] <= 16 or luma(p) > thr:
                continue
            # interior only: a silhouette outline is dark too, but touches transparency
            if any(px[x + dx, y + dy][3] <= 16
                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                   if 0 <= x + dx < im.width and 0 <= y + dy < im.height):
                continue
            dark.add((x, y))
    seen, out = set(), []
    for s in dark:
        if s in seen:
            continue
        st, comp = [s], set()
        while st:
            c = st.pop()
            if c in seen:
                continue
            seen.add(c)
            comp.add(c)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (c[0] + dx, c[1] + dy)
                    if n in dark and n not in seen:
                        st.append(n)
        if not (1 <= len(comp) <= max_size):
            continue
        xs = [c[0] for c in comp]; ys = [c[1] for c in comp]
        w, h = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        if w / h > 2.6:          # a mouth/brow line is wide and flat; an eye is not
            continue
        out.append(comp)
    out.sort(key=len, reverse=True)
    return out[:2]               # a face has at most two eyes

def close_eyes(im, comps):
    px = im.load()
    for comp in comps:
        bot = max(y for _, y in comp)
        # lid colour = the dominant opaque colour ringing the cluster (fur, bone, metal…)
        ring = {}
        for (cx, cy) in comp:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (cx + dx, cy + dy)
                    if n in comp or not (0 <= n[0] < im.width and 0 <= n[1] < im.height):
                        continue
                    p = px[n]
                    if p[3] > 16:
                        ring[p] = ring.get(p, 0) + 1
        if not ring:
            continue
        fill = max(ring.items(), key=lambda kv: kv[1])[0]
        for (x, y) in comp:
            px[x, y] = (fill[0], fill[1], fill[2], 255)
        for (x, y) in comp:      # the closed lid reads as a 1px darker line
            if y == bot:
                px[x, y] = (int(fill[0] * 0.62), int(fill[1] * 0.60), int(fill[2] * 0.60), 255)
    return im

def derive(setdir, olddir, setname):
    made, skipped = [], []
    for d in CARDINALS:
        p_oldrot = os.path.join(olddir, f"rot_{d}.png")
        p_oldbl = os.path.join(olddir, f"blink_{d}.png")
        p_new = os.path.join(setdir, f"rot_{d}.png")
        if not (os.path.exists(p_oldrot) and os.path.exists(p_oldbl) and os.path.exists(p_new)):
            skipped.append(f"{d}(no pair)"); continue
        oa = Image.open(p_oldrot).convert("RGBA")
        ob = Image.open(p_oldbl).convert("RGBA")
        mask = diff_mask(oa, ob)
        if not mask:
            skipped.append(f"{d}(no diff)"); continue
        ocb = content_box(oa)
        if not ocb:
            skipped.append(f"{d}(empty old)"); continue
        ol, ot, orr, ob_ = ocb
        ow, oh = orr - ol, ob_ - ot
        mxs = [p[0] for p in mask]; mys = [p[1] for p in mask]
        fx0, fx1 = (min(mxs) - ol) / ow, (max(mxs) + 1 - ol) / ow
        fy0, fy1 = (min(mys) - ot) / oh, (max(mys) + 1 - ot) / oh
        nim = Image.open(p_new).convert("RGBA")
        ncb = content_box(nim)
        if not ncb:
            skipped.append(f"{d}(empty new)"); continue
        nl, nt, nr, nb = ncb
        nw, nh = nr - nl, nb - nt
        PAD = 2
        region = (max(0, int(nl + fx0 * nw) - PAD), max(0, int(nt + fy0 * nh) - PAD),
                  min(nim.width, int(nl + fx1 * nw) + PAD), min(nim.height, int(nt + fy1 * nh) + PAD))
        comps = clusters_in(nim, region)
        if not comps:
            skipped.append(f"{d}(no cluster)"); continue
        close_eyes(nim, comps).save(os.path.join(setdir, f"blink_{d}.png"))
        made.append(f"{d}:{len(comps)}x{sum(len(c) for c in comps)}px")
    print(f"{setname}: blink " + (" ".join(made) if made else "NONE") +
          ("  skipped[" + " ".join(skipped) + "]" if skipped else ""))
    return len(made)

if __name__ == "__main__":
    sprites_root, old_root = sys.argv[1], sys.argv[2]
    for setname in sys.argv[3:]:
        derive(os.path.join(sprites_root, setname), os.path.join(old_root, setname), setname)
