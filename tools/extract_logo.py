"""Extracts the Switchcraft logo (the cauldron) from the KiCad PCB's silkscreen.

Writes:
  web/img/switchcraft-logo.svg   the whole logo, black, for use anywhere
  web/logo.js                    the same shapes for the editor page, split
                                 into steam, bubbles and the rest so the page
                                 can animate them (and draw the cauldron
                                 without its lettering in the header), plus
                                 the cauldron's filled silhouette, so the page
                                 can colour the spaces inside it (needs Pillow)

    python tools/extract_logo.py

The logo is the larger of the PCB's two "LOGO" footprints (the other is the
noise guaranteed mark). Re-run after changing the logo in the PCB.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PCB = ROOT / "electronics" / "switchcraft" / "switchcraft.kicad_pcb"

# Which polygons are which, by their bounds (mm, footprint coordinates):
# steam is tall and thin above the cauldron, bubbles are small and round
# around the synth, the lettering is the bottom line.
def kind(x0, y0, w, h):
    if y0 < -12.5 and h > 2.5 and w < 1.5:
        return "steam"
    if y0 > 12:
        return "text"
    bubbles = [(-3.37, -10.36), (-6.09, -7.09), (6.04, -8.99), (-4.75, -12.41), (-6.39, -9.97), (4.35, -11.72)]
    if any(abs(x0 - bx) < 0.05 and abs(y0 - by) < 0.05 for bx, by in bubbles):
        return "bubble"
    return "body"


def footprints(pcb):
    for m in re.finditer(r'\n\t\(footprint "LOGO"', pcb):
        end = pcb.find("\n\t(", m.start() + 5)
        yield pcb[m.start():end]


def polygons(body):
    for pm in re.finditer(r"\(fp_poly\s*\(pts(.*?)\)\s*\(stroke", body, re.S):
        yield [(float(x), float(y)) for x, y in re.findall(r"\(xy ([-\d.]+) ([-\d.]+)\)", pm.group(1))]


def path(pts):
    """A compact path: absolute start, then relative moves to 2 decimals."""
    out = [f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"]
    px, py = round(pts[0][0], 2), round(pts[0][1], 2)
    for x, y in pts[1:]:
        x, y = round(x, 2), round(y, 2)
        dx, dy = round(x - px, 2), round(y - py, 2)
        if dx or dy:
            out.append(f"l{dx:g} {dy:g}")
        px, py = x, y
    return "".join(out) + "z"


def silhouette(polys, scale=24):
    """The cauldron and synth filled in: everything the outside can't reach.
    Traced as one outline (in mm), a pixel inside the ink's outer edge so it
    never shows beyond it. None without Pillow."""
    try:
        from PIL import Image, ImageDraw, ImageFilter
    except ImportError:
        return None
    xs = [x for p in polys for x, _ in p]
    ys = [y for p in polys for _, y in p]
    x0, y0 = min(xs), min(ys)
    pad = 2
    w = int((max(xs) - x0) * scale) + 2 * pad
    h = int((max(ys) - y0) * scale) + 2 * pad
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    for p in polys:
        draw.polygon([((x - x0) * scale + pad, (y - y0) * scale + pad) for x, y in p], fill=255)
    ImageDraw.floodfill(img, (0, 0), 128)   # the outside
    inside = img.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.MinFilter(3))
    px = inside.load()
    on = lambda c, r: 0 <= c < w and 0 <= r < h and px[c, r] > 0
    # The outline: every pixel edge with inside on one side and outside on
    # the other, directed so inside is on the right, chained into loops.
    # One shape (not strips), so no seams can show between pieces.
    starts = {}
    for r in range(h):
        for c in range(w):
            if not on(c, r):
                continue
            if not on(c, r - 1):
                starts.setdefault((c, r), []).append((c + 1, r))
            if not on(c + 1, r):
                starts.setdefault((c + 1, r), []).append((c + 1, r + 1))
            if not on(c, r + 1):
                starts.setdefault((c + 1, r + 1), []).append((c, r + 1))
            if not on(c - 1, r):
                starts.setdefault((c, r + 1), []).append((c, r))
    loops = []
    while starts:
        first = next(iter(starts))
        loop, at = [first], first
        while True:
            nxt = starts[at].pop()
            if not starts[at]:
                del starts[at]
            if nxt == first:
                break
            loop.append(nxt)
            at = nxt
        if len(loop) >= 4:
            loops.append(loop)

    def simplify(pts, tol):
        # Douglas-Peucker on a closed loop: smooths the pixel staircase.
        n = len(pts)
        keep = [False] * n
        keep[0] = keep[n // 2] = True
        stack = [(0, n // 2), (n // 2, n)]
        while stack:
            a, b = stack.pop()
            if b - a < 2:
                continue
            (ax, ay), (bx, by) = pts[a], pts[b % n]
            dx, dy = bx - ax, by - ay
            norm = (dx * dx + dy * dy) ** 0.5 or 1
            best, k = -1, None
            for m in range(a + 1, b):
                px_, py_ = pts[m]
                d = abs(dy * (px_ - ax) - dx * (py_ - ay)) / norm
                if d > best:
                    best, k = d, m
            if best > tol:
                keep[k] = True
                stack += [(a, k), (k, b)]
        return [p for p, kp in zip(pts, keep) if kp]

    at = lambda v, origin: f"{(v - pad) / scale + origin:.3f}"
    out = []
    for loop in loops:
        pts = simplify(loop, 0.7)
        if len(pts) < 3:
            continue
        out.append("M" + "L".join(f"{at(x, x0)} {at(y, y0)}" for x, y in pts) + "Z")
    return "".join(out)


def main():
    pcb = PCB.read_text(encoding="utf-8")
    logo = max(footprints(pcb), key=lambda b: b.count("fp_poly") + len(b) / 1e6)
    parts = {"steam": [], "bubble": [], "body": [], "text": []}
    body_polys = []
    xs, ys = [], []
    for pts in polygons(logo):
        px = [p[0] for p in pts]
        py = [p[1] for p in pts]
        xs += px
        ys += py
        k = kind(min(px), min(py), max(px) - min(px), max(py) - min(py))
        parts[k].append(path(pts))
        if k == "body":
            body_polys.append(pts)
    assert len(parts["steam"]) == 3 and len(parts["bubble"]) == 6, {k: len(v) for k, v in parts.items()}
    pad = 0.3
    box = [round(min(xs) - pad, 2), round(min(ys) - pad, 2),
           round(max(xs) - min(xs) + 2 * pad, 2), round(max(ys) - min(ys) + 2 * pad, 2)]

    every = [p for k in ("body", "text", "steam", "bubble") for p in parts[k]]
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, box))}" '
           f'width="{box[2]:.1f}mm" height="{box[3]:.1f}mm">'
           f'<title>Switchcraft</title><path fill="#000" fill-rule="evenodd" d="{"".join(every)}"/></svg>\n')
    (ROOT / "web" / "img" / "switchcraft-logo.svg").write_text(svg, encoding="utf-8")

    # Without the lettering, the icon's box ends at the cauldron's feet.
    icon_ys = [y for pts in polygons(logo) for _, y in pts if y < 12]
    icon_box = [box[0], box[1], box[2], round(max(icon_ys) - min(ys) + 2 * pad, 2)]
    data = {"box": box, "iconBox": icon_box, "body": parts["body"], "text": parts["text"],
            "steam": parts["steam"], "bubbles": parts["bubble"]}
    fill = silhouette(body_polys)
    if fill:
        data["fill"] = fill
    else:
        print("Pillow isn't installed: logo.js has no fill (pip install pillow)")
    js = ("// logo.js: the Switchcraft logo (the cauldron), made by tools/extract_logo.py\n"
          "// from the PCB silkscreen. Don't edit by hand: re-run the tool.\n"
          f"window.SwitchcraftLogoData = {json.dumps(data, separators=(',', ':'))};\n")
    (ROOT / "web" / "logo.js").write_text(js, encoding="utf-8")
    print(f"logo: {sum(map(len, parts.values()))} shapes, {len(svg) // 1024} KB SVG, {len(js) // 1024} KB JS")


if __name__ == "__main__":
    main()
