"""Writes src/flat-<state>.svg: each menu bar glyph as ONE compound path (knockouts subtracted, no masks), for a faithful PDF.
Same geometry as glyph-<state>-black.svg. Run: uv run --with shapely python src/flatten.py"""
from shapely.geometry import Point, box
from shapely.ops import unary_union
import os
Q = 96  # segments per quarter circle: the flattened curves are well under 0.01 pt off
def rrect(x, y, w, h, r): return box(x + r, y + r, x + w - r, y + h - r).buffer(r, quad_segs=Q)
def circle(cx, cy, r): return Point(cx, cy).buffer(r, quad_segs=Q)
cx, cy, r = 14.0, 4.0, 3.0
tiles = unary_union([rrect(x, y, 4.25, 4.25, 1.2) for x, y in [(4, 9.75), (9.75, 9.75), (4, 4)]])
body = rrect(1, 1, 16, 16, 4.2).difference(tiles).difference(circle(cx, cy, r + 1))
dot = {
    "running": circle(cx, cy, r),
    "stopped": circle(cx, cy, r).difference(circle(cx, cy, r - 1.5)),
    "attention": circle(cx, cy, r).difference(unary_union([rrect(cx - 0.6, cy - 1.8, 1.2, 2.3, 0.6), circle(cx, cy + 1.35, 0.7)])),
}
def d(geom):
    polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    out = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            pts = list(ring.coords)[:-1]
            out.append("M" + " L".join(f"{x:.3f} {y:.3f}" for x, y in pts) + "Z")
    return "".join(out)
here = os.path.dirname(os.path.abspath(__file__))
for s, g in dot.items():
    shape = unary_union([body, g])
    open(os.path.join(here, f"flat-{s}.svg"), "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="#000" fill-rule="evenodd" d="{d(shape)}"/></svg>\n')
