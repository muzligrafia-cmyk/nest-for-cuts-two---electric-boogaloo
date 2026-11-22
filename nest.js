#!/usr/bin/env node
/*
================================================================================
 nest.js — Contour nesting engine (runs in Node.js, outside Illustrator)
================================================================================
 Reads  nest_input.json  (written by 1_ExportForNest.jsx)
 Writes nest_result.json (read by  3_ApplyNest.jsx)

 PAPERS: the paper names come from swatches.cclibs, which must sit next to
 this file. Only the "Paper Swatches" folder of the library is used. Each
 part's fill colour (flat RGB or the stops of a gradient) is looked up there
 and the part goes onto a sheet for that paper, labelled "Series – Paper".
 Export a fresh .cclibs from the CC Libraries panel to update the list.
 Fixes that don't need the library (skip a colour, rename, add one) go into
 LIBRARY_FIX right below.

 SHEETS: one sheet per paper; when it's full, the rest continues on
 "Paper (2)", "Paper (3)"... The label corner (or a full-width strip) is
 kept free of parts.

 LOOSE LINES: with "Count for overlaps" on, a loose red / blue / black line
 (or text) sticks to the paper part right under it in the stacking order
 that holds the whole line. Grouped lines always travel with their group.

 HOLES: real holes of a compound path count as free sheet, so smaller parts
 can be nested inside them (and inside their holes, and so on).

 Usage:  node nest.js <input.json> <output.json>
================================================================================
*/
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---------------------------------------------------------------------------
// LIBRARY FIXES — edit freely. Names are written as "Series / Paper name",
// exactly as they appear in the CC Libraries panel.
// ---------------------------------------------------------------------------
const LIBRARY_FIX = {
  // Colours to ignore (parts in these colours get flagged as unknown)
  EXCLUDE: [
    "Multicolour / MC Black",          // same colour as "Vegyes / Black"
  ],
  // New label text for a paper (only the paper part; the series is added)
  RENAME: {
    // "Pergraphica / Pergraohica Green": "Pergraphica Green",
    // "Multicolour / Levander": "Lavender",
    // "Multicolour / Vanilia": "Vanilla",
  },
  // Extra papers that aren't in the library (yet). Flat colours only.
  EXTRA: [
    // { series: "Vegyes", name: "Grey paperboard", rgb: [128, 128, 128] },
  ],
};
const LIBRARY_FOLDER = "Paper Swatches";

const inPath  = process.argv[2];
const outPath = process.argv[3];
if (!inPath || !outPath) { console.error("usage: node nest.js input.json output.json"); process.exit(1); }
function bail(msg) { fs.writeFileSync(outPath, JSON.stringify({ error: msg })); console.error(msg); process.exit(0); }

const IN = JSON.parse(fs.readFileSync(inPath, "utf8"));
if (!IN.version || IN.version < 2 || !IN.settings) bail("nest_input.json is from an older version of step 1. Run the new 1_ExportForNest.jsx again.");
const SET = IN.settings;

// ---------------------------------------------------------------------------
// CONFIG (millimetres). Values in the input file win.
// ---------------------------------------------------------------------------
const CFG = {
  SPACING_MM:      IN.spacingMM   ?? 2.0,
  MARGIN_MM:       IN.marginMM    ?? 5.0,
  ROTATION_STEP:   IN.rotationStep ?? 45,   // degrees; 360 = none
  ALIGN_TO_EDGES:  true,
  CAND_TOL_MM:     2.0,
  PROBE_GRID_MM:   3.0,
  SLIDE_MAX_MM:    8.0,
  SLIDE_MIN_MM:    0.1,
  NUDGE_MM:        1.0, NUDGE_TRIES: 4,
  HASH_CELL_MM:    10.0,
  TIME_LIMIT_S:    IN.timeLimitS ?? 300,
  SORT_BY:         "area",
  // Label: Arial 35 pt, top-left corner 10 mm from the sheet's top and left
  LABEL_PT:        35,
  LABEL_INSET_MM:  10,
};
const PT = 2.834645669291339;
const SPACING = CFG.SPACING_MM * PT, MARGIN = CFG.MARGIN_MM * PT, SP2 = SPACING * SPACING;
const CANDTOL = CFG.CAND_TOL_MM * PT, GRID = CFG.PROBE_GRID_MM * PT;
const SLMAX = CFG.SLIDE_MAX_MM * PT, SLMIN = CFG.SLIDE_MIN_MM * PT;
const NUDGE = CFG.NUDGE_MM * PT, HCELL = CFG.HASH_CELL_MM * PT;
const T0 = Date.now();
const timeUp = () => Date.now() - T0 > CFG.TIME_LIMIT_S * 1000;

// ---------------------------------------------------------------------------
// Read swatches.cclibs (a zip file) without any extra packages
// ---------------------------------------------------------------------------
function readZipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), name = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error("no " + wanted + " inside");
}
function findLibraryFile() {
  const dir = __dirname;
  const pref = path.join(dir, "swatches.cclibs");
  if (fs.existsSync(pref)) return pref;
  const any = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".cclibs"));
  return any.length ? path.join(dir, any[0]) : null;
}
function loadLibrary() {
  const file = findLibraryFile();
  if (!file) bail("No swatches.cclibs found next to nest.js. Export your paper library from the CC Libraries panel and put it there.");
  let man;
  try { man = JSON.parse(readZipEntry(fs.readFileSync(file), "manifest").toString("utf8")); }
  catch (e) { bail("Couldn't read " + path.basename(file) + " (" + e.message + "). Export it again from the CC Libraries panel."); }
  const node = name => (man.children || []).find(c => c.name === name) || { children: [] };
  const groups = new Map(node("groups").children.map(g => [g.id, g]));
  const groupPath = gid => { const n = []; let g = groups.get(gid), guard = 0;
    while (g && guard++ < 20) { n.unshift(g.name); g = groups.get(g["library#parentId"]); } return n; };
  const byKey = new Map(), warnings = [], excluded = new Set(LIBRARY_FIX.EXCLUDE);
  const rgbKey = v => `rgb:${Math.round(v.r)},${Math.round(v.g)},${Math.round(v.b)}`;
  function add(key, series, name) {
    const full = series ? `${series} / ${name}` : name;
    if (excluded.has(full)) return;
    const shown = LIBRARY_FIX.RENAME[full] || name;
    const label = series ? `${series} – ${shown}` : shown;
    if (byKey.has(key) && byKey.get(key).label !== label) {
      warnings.push(`"${byKey.get(key).full}" and "${full}" have the same colour; parts in it are labelled "${byKey.get(key).label}".`);
      return;
    }
    byKey.set(key, { label, full });
  }
  let count = 0;
  for (const el of node("elements").children) {
    let gp = null;
    for (const k of Object.keys(el["library#groups"] || {})) {
      const p = groupPath(k.split("#")[1]);
      if (p[0] === LIBRARY_FOLDER) { gp = p; break; }
    }
    if (!gp) continue;
    const series = gp.length > 1 ? gp[gp.length - 1] : "";
    const rep = (el.children || [])[0] || {};
    if (rep["color#data"] && rep["color#data"].mode === "RGB") {
      add(rgbKey(rep["color#data"].value), series, el.name); count++;
    } else if (rep["gradient#data"]) {
      const stops = (rep["gradient#data"].stops || []).slice().sort((a, b) => a.offset - b.offset);
      const cols = stops.map(s => { const c = (s.color || [])[0]; return c && c.mode === "RGB" ? rgbKey(c.value).slice(4) : null; });
      if (cols.some(c => !c)) continue;
      add("grad:" + cols.join(";"), series, el.name);
      add("grad:" + cols.slice().reverse().join(";"), series, el.name);   // gradient applied the other way round
      count++;
    }
  }
  for (const x of LIBRARY_FIX.EXTRA) { add(`rgb:${x.rgb[0]},${x.rgb[1]},${x.rgb[2]}`, x.series || "", x.name); count++; }
  return { byKey, warnings, count, file: path.basename(file) };
}
function describeKey(k) {
  if (k.startsWith("rgb:")) return "RGB " + k.slice(4);
  if (k.startsWith("grad:")) return "gradient " + k.slice(5).split(";").map(s => "(" + s + ")").join(" → ");
  return k;
}

// ---------------------------------------------------------------------------
// Geometry on flat rings [x0,y0,x1,y1,...]
// ---------------------------------------------------------------------------
function ringBB(r) {
  let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i]; if (r[i] > x1) x1 = r[i];
    if (r[i+1] < y0) y0 = r[i+1]; if (r[i+1] > y1) y1 = r[i+1];
  }
  return [x0, y0, x1, y1];
}
// A shape = material outlines (first nOut rings) + free holes (the rest).
function makeShape(rings, nOut) {
  const bbs = rings.map(ringBB);
  let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
  for (let i = 0; i < nOut; i++) { const b = bbs[i];
    if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3]; }
  return { rings, bbs, nOut, bb: [x0, y0, x1, y1] };
}
function translatedShape(S, dx, dy) {
  return makeShape(S.rings.map(r => { const n = new Array(r.length);
    for (let j = 0; j < r.length; j += 2) { n[j] = r[j] + dx; n[j+1] = r[j+1] + dy; } return n; }), S.nOut);
}
function rotateRings(rings, deg) {
  const c = Math.cos(deg*Math.PI/180), s = Math.sin(deg*Math.PI/180);
  return rings.map(r => { const n = new Array(r.length);
    for (let j = 0; j < r.length; j += 2) { n[j] = r[j]*c - r[j+1]*s; n[j+1] = r[j]*s + r[j+1]*c; } return n; });
}
function normaliseRings(rings) {
  let x0 = 1e12, y0 = 1e12;
  for (const r of rings) for (let j = 0; j < r.length; j += 2) { if (r[j] < x0) x0 = r[j]; if (r[j+1] < y0) y0 = r[j+1]; }
  for (const r of rings) for (let j = 0; j < r.length; j += 2) { r[j] -= x0; r[j+1] -= y0; }
  return rings;
}
function ringArea(r) { let a = 0, n = r.length;
  for (let i = 0; i < n; i += 2) { const k = (i+2)%n; a += r[i]*r[k+1] - r[k]*r[i+1]; } return Math.abs(a/2); }
function decimate(r, tol) {
  if (tol <= 0 || r.length <= 8) return r;
  const t2 = tol*tol, out = [r[0], r[1]]; let lx = r[0], ly = r[1];
  for (let i = 2; i < r.length; i += 2) { const dx = r[i]-lx, dy = r[i+1]-ly;
    if (dx*dx+dy*dy >= t2) { out.push(r[i], r[i+1]); lx = r[i]; ly = r[i+1]; } }
  return out.length >= 6 ? out : r;
}
function hullCross(o,a,b){ return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
function convexHull(pts) {
  pts.sort((a,b)=> a[0]===b[0] ? a[1]-b[1] : a[0]-b[0]);
  const n = pts.length; if (n < 3) return pts;
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length>=2 && hullCross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop(); lower.push(p); }
  for (let i = n-1; i >= 0; i--) { const p = pts[i]; while (upper.length>=2 && hullCross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop(); return lower.concat(upper);
}
function straightenAngle(rings) {
  const pts = []; for (const r of rings) for (let j = 0; j < r.length; j += 2) pts.push([r[j], r[j+1]]);
  const h = convexHull(pts); if (h.length < 3) return 0;
  let bestArea = 1e30, bestDeg = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i+1)%h.length], ang = Math.atan2(b[1]-a[1], b[0]-a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0=1e12,y0=1e12,x1=-1e12,y1=-1e12;
    for (const p of h) { const x = p[0]*c-p[1]*s, y = p[0]*s+p[1]*c;
      if (x<x0)x0=x; if (x>x1)x1=x; if (y<y0)y0=y; if (y>y1)y1=y; }
    const area = (x1-x0)*(y1-y0);
    if (area < bestArea-1e-9) { bestArea = area; bestDeg = -ang*180/Math.PI; }
  }
  while (bestDeg > 45) bestDeg -= 90; while (bestDeg <= -45) bestDeg += 90;
  return bestDeg;
}
function orient(ax,ay,bx,by,cx,cy){ const v=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax); return v>1e-9?1:v<-1e-9?-1:0; }
function segsCross(ax,ay,bx,by,cx,cy,dx,dy){
  return orient(ax,ay,bx,by,cx,cy)!==orient(ax,ay,bx,by,dx,dy) && orient(cx,cy,dx,dy,ax,ay)!==orient(cx,cy,dx,dy,bx,by); }
function ptSegD2(px,py,ax,ay,bx,by){ const vx=bx-ax,vy=by-ay,wx=px-ax,wy=py-ay,L2=vx*vx+vy*vy;
  let t = L2>0?(wx*vx+wy*vy)/L2:0; t = t<0?0:t>1?1:t; const dx=px-(ax+t*vx),dy=py-(ay+t*vy); return dx*dx+dy*dy; }
function segSegD2(ax,ay,bx,by,cx,cy,dx,dy){
  if (segsCross(ax,ay,bx,by,cx,cy,dx,dy)) return 0;
  return Math.min(ptSegD2(ax,ay,cx,cy,dx,dy), ptSegD2(bx,by,cx,cy,dx,dy), ptSegD2(cx,cy,ax,ay,bx,by), ptSegD2(dx,dy,ax,ay,bx,by)); }
function pointInRing(px,py,r,ox,oy){ let inside=false; const n=r.length;
  for (let i=0,j=n-2;i<n;j=i,i+=2){ const ax=r[i]+ox,ay=r[i+1]+oy,bx=r[j]+ox,by=r[j+1]+oy;
    if ((ay>py)!==(by>py) && px < (bx-ax)*(py-ay)/(by-ay)+ax) inside=!inside; } return inside; }
const inBB = (x,y,b) => x>=b[0] && x<=b[2] && y>=b[1] && y<=b[3];
const bbInside = (a,b) => a[0]>=b[0] && a[1]>=b[1] && a[2]<=b[2] && a[3]<=b[3];
function allInside(p, k) { for (let i = 0; i < p.length; i += 2) if (!pointInRing(p[i], p[i+1], k, 0, 0)) return false; return true; }

// Is (x,y) on solid material of shape S? (inside an outline, not inside a free hole)
function inMaterial(S, x, y) {
  if (!inBB(x, y, S.bb)) return false;
  let inside = false;
  for (let i = 0; i < S.nOut; i++) if (inBB(x, y, S.bbs[i]) && pointInRing(x, y, S.rings[i], 0, 0)) { inside = true; break; }
  if (!inside) return false;
  for (let i = S.nOut; i < S.rings.length; i++) if (inBB(x, y, S.bbs[i]) && pointInRing(x, y, S.rings[i], 0, 0)) return false;
  return true;
}
// Is (x,y) inside one of S's free holes?
function inHoleOf(S, x, y) {
  if (!inBB(x, y, S.bb)) return false;
  for (let i = S.nOut; i < S.rings.length; i++) if (inBB(x, y, S.bbs[i]) && pointInRing(x, y, S.rings[i], 0, 0)) return true;
  return false;
}
// ---------------------------------------------------------------------------
// Spatial hash of placed segments
// ---------------------------------------------------------------------------
let HASH = new Map();
const hcell = v => Math.floor(v / HCELL);
function hashInsertShape(S) {
  for (const r of S.rings) { const n = r.length;
    for (let s = 0; s < n; s += 2) { const sn=(s+2)%n, ax=r[s],ay=r[s+1],bx=r[sn],by=r[sn+1];
      const x0=hcell(Math.min(ax,bx)), x1=hcell(Math.max(ax,bx)), y0=hcell(Math.min(ay,by)), y1=hcell(Math.max(ay,by));
      for (let cy=y0;cy<=y1;cy++) for (let cx=x0;cx<=x1;cx++) { const k=cx*100003+cy;
        let a = HASH.get(k); if (!a) { a = []; HASH.set(k, a); } a.push(ax,ay,bx,by); } } }
}
function segmentsTooClose(V, dx, dy) {
  for (const ra of V.rings) { const na = ra.length;
    for (let s = 0; s < na; s += 2) { const sn=(s+2)%na, ax=ra[s]+dx,ay=ra[s+1]+dy,bx=ra[sn]+dx,by=ra[sn+1]+dy;
      const x0=hcell(Math.min(ax,bx)-SPACING), x1=hcell(Math.max(ax,bx)+SPACING), y0=hcell(Math.min(ay,by)-SPACING), y1=hcell(Math.max(ay,by)+SPACING);
      for (let cy=y0;cy<=y1;cy++) for (let cx=x0;cx<=x1;cx++) { const segs = HASH.get(cx*100003+cy); if (!segs) continue;
        for (let t=0;t<segs.length;t+=4) if (segSegD2(ax,ay,bx,by,segs[t],segs[t+1],segs[t+2],segs[t+3]) < SP2) return true; } } }
  return false;
}
// With no edges crossing, one point per outline tells us if a shape sits on
// the other's material (bad) or in a hole / outside (fine).
function overlapsEitherWay(V, dx, dy, P) {
  if (V.bb[0]+dx > P.bb[2] || V.bb[2]+dx < P.bb[0] || V.bb[1]+dy > P.bb[3] || V.bb[3]+dy < P.bb[1]) return false;
  for (let i = 0; i < V.nOut; i++) { const r = V.rings[i]; if (inMaterial(P, r[0]+dx, r[1]+dy)) return true; }
  for (let i = 0; i < P.nOut; i++) { const r = P.rings[i]; if (inMaterial(V, r[0]-dx, r[1]-dy)) return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Papers, sheet frame
// ---------------------------------------------------------------------------
const SORT = SET.sortPaper !== false;          // "Sort by paper" checkbox
const UNSORTED_LABEL = "paper name here";
const LIB = SORT ? loadLibrary() : { byKey: new Map(), warnings: [], count: 0, file: null };
const SHEET_W = SET.sheetWmm * PT, SHEET_H = SET.sheetHmm * PT;   // sheet frame: y-up, bottom-left = (0,0)
const usableW = SHEET_W - 2*MARGIN, usableH = SHEET_H - 2*MARGIN;
if (usableW <= 0 || usableH <= 0) bail("Margins larger than the sheet.");
const ORG_X = MARGIN, ORG_Y = SHEET_H - MARGIN;

const flagCounts = new Map();
const flag = reason => flagCounts.set(reason, (flagCounts.get(reason) || 0) + 1);
const bbOverlap = (a,b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// ---------------------------------------------------------------------------
// CLEANUP — Refined Laser Janitor V2.2 (Cleanup.js), same rules and settings,
// run on each part (+ its lines) on its own, in the part's original position.
// (Running it across the whole design would flag every place where two
// different parts overlap in the assembled view.) Returns what 3_ApplyNest
// should do, by path number in the order step 1 read them:
//   merges: [[path, [point numbers removed, high to low], closeFix]]
//   specks: [path]   dups: [path]   overlaps: [[[x,y],...], ...]
// ---------------------------------------------------------------------------
const CL = {
  DUP_TOLERANCE_MM: 0.05, MIN_OVERLAP_MM: 1.0, SAMPLE_STEP_MM: 1.0, FINE_STEP_MM: 0.2,
  CURVE_STEP_MM: 0.25, SPECK_AREA: 8.035, SPECK_DIAG_MM: 2, POINT_MERGE_TOL: 0.001,
};
const PT_MM = 2.834645669;
const C_TOL = CL.DUP_TOLERANCE_MM * PT_MM, C_TOL_SQ = C_TOL * C_TOL, C_MIN_OVERLAP = CL.MIN_OVERLAP_MM * PT_MM;
const C_SAMPLE_STEP = Math.min(CL.SAMPLE_STEP_MM, CL.MIN_OVERLAP_MM) * PT_MM, C_FINE_STEP = CL.FINE_STEP_MM * PT_MM;
const C_CURVE_STEP = CL.CURVE_STEP_MM * PT_MM, C_SPECK_DIAG = CL.SPECK_DIAG_MM * PT_MM;

function cDist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
function cFlattenSegment(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, out) {
  if (cDist(p0x, p0y, p1x, p1y) < 0.001 && cDist(p2x, p2y, p3x, p3y) < 0.001) { out.push(p3x, p3y); return; }
  const est = cDist(p0x, p0y, p1x, p1y) + cDist(p1x, p1y, p2x, p2y) + cDist(p2x, p2y, p3x, p3y);
  let steps = Math.ceil(est / C_CURVE_STEP); if (steps < 4) steps = 4; if (steps > 200) steps = 200;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, mt = 1 - t, a = mt*mt*mt, b = 3*mt*mt*t, c = 3*mt*t*t, d = t*t*t;
    out.push(a*p0x + b*p1x + c*p2x + d*p3x, a*p0y + b*p1y + c*p2y + d*p3y);
  }
}
// pts: [{a:[x,y], l:[x,y], r:[x,y]}]
function cPoly(pts, closed) {
  const n = pts.length, poly = [pts[0].a[0], pts[0].a[1]], segs = closed ? n : n - 1;
  for (let s = 0; s < segs; s++) { const P = pts[s], Q = pts[(s + 1) % n];
    cFlattenSegment(P.a[0], P.a[1], P.r[0], P.r[1], Q.l[0], Q.l[1], Q.a[0], Q.a[1], poly); }
  return poly;
}
function cMakeSamples(poly, step) {
  const out = [], m = poly.length / 2;
  for (let i = 0; i < m - 1; i++) {
    const x1 = poly[2*i], y1 = poly[2*i+1], x2 = poly[2*i+2], y2 = poly[2*i+3];
    out.push(x1, y1);
    const L = Math.sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1));
    if (L > C_TOL) { let extra = Math.floor(L / step); if (extra < 1) extra = 1;
      for (let e = 1; e <= extra; e++) { const t = e / (extra + 1); out.push(x1 + (x2-x1)*t, y1 + (y2-y1)*t); } }
  }
  out.push(poly[poly.length-2], poly[poly.length-1]);
  return out;
}
function cInfo(path, poly) {
  let minX = poly[0], maxX = poly[0], minY = poly[1], maxY = poly[1], length = 0;
  for (let i = 2; i < poly.length; i += 2) { const x = poly[i], y = poly[i+1];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    length += Math.sqrt((x-poly[i-2])**2 + (y-poly[i-1])**2); }
  return { path, poly, closed: path.z, samples: cMakeSamples(poly, C_SAMPLE_STEP), fine: null, minX, maxX, minY, maxY, length, flagged: false };
}
function cSegDistSq(px, py, x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1, len2 = dx*dx + dy*dy; let t = 0;
  if (len2 > 0) { t = ((px-x1)*dx + (py-y1)*dy) / len2; if (t < 0) t = 0; else if (t > 1) t = 1; }
  const cx = x1 + t*dx - px, cy = y1 + t*dy - py; return cx*cx + cy*cy;
}
function cNearPoly(px, py, b) {
  if (px < b.minX - C_TOL || px > b.maxX + C_TOL || py < b.minY - C_TOL || py > b.maxY + C_TOL) return false;
  const p = b.poly, n = p.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const x1 = p[2*i], y1 = p[2*i+1], x2 = p[2*i+2], y2 = p[2*i+3];
    if (px < Math.min(x1,x2) - C_TOL || px > Math.max(x1,x2) + C_TOL || py < Math.min(y1,y2) - C_TOL || py > Math.max(y1,y2) + C_TOL) continue;
    if (cSegDistSq(px, py, x1, y1, x2, y2) <= C_TOL_SQ) return true;
  }
  return false;
}
function cCoveredBy(a, b) {
  if (a.minX < b.minX - C_TOL || a.maxX > b.maxX + C_TOL || a.minY < b.minY - C_TOL || a.maxY > b.maxY + C_TOL) return false;
  if (a.length > b.length + 2 * C_TOL) return false;
  const s = a.samples, m = s.length / 2;
  for (const q of [0, m - 1, Math.floor(m / 2)]) if (!cNearPoly(s[2*q], s[2*q+1], b)) return false;
  for (let i = 0; i < m; i++) if (!cNearPoly(s[2*i], s[2*i+1], b)) return false;
  return true;
}
function cPartialOverlaps(a, b, out) {
  if (a.minX > b.maxX + C_TOL || a.maxX < b.minX - C_TOL || a.minY > b.maxY + C_TOL || a.maxY < b.minY - C_TOL) return;
  const cs = a.samples, cm = cs.length / 2; let hint = false;
  for (let c = 0; c < cm; c++) if (cNearPoly(cs[2*c], cs[2*c+1], b)) { hint = true; break; }
  if (!hint) return;
  if (!a.fine) a.fine = cMakeSamples(a.poly, C_FINE_STEP);
  const s = a.fine, m = s.length / 2, runs = []; let cur = null;
  for (let i = 0; i < m; i++) {
    if (cNearPoly(s[2*i], s[2*i+1], b)) { if (!cur) cur = { start: i, end: i, wrap: false }; else cur.end = i; }
    else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  if (a.closed && runs.length > 1 && runs[0].start === 0 && runs[runs.length-1].end === m - 1) {
    const lastRun = runs.pop(); runs[0] = { start: lastRun.start, end: runs[0].end, wrap: true };
  }
  for (const run of runs) {
    const idx = [];
    if (run.wrap) { for (let w = run.start; w < m - 1; w++) idx.push(w); for (let w = 0; w <= run.end; w++) idx.push(w); }
    else for (let w = run.start; w <= run.end; w++) idx.push(w);
    if (idx.length < 2) continue;
    const pts = []; let len = 0;
    for (let q = 0; q < idx.length; q++) { const x = s[2*idx[q]], y = s[2*idx[q]+1];
      if (q > 0) len += Math.sqrt((x - pts[q-1][0])**2 + (y - pts[q-1][1])**2); pts.push([x, y]); }
    if (len >= C_MIN_OVERLAP) out.push(pts);
  }
}
const cSame = (a, b) => Math.abs(a[0]-b[0]) < CL.POINT_MERGE_TOL && Math.abs(a[1]-b[1]) < CL.POINT_MERGE_TOL;
function cleanupPiece(objs) {
  const byItem = {}, paths = [];
  for (const it of objs) {
    const rec = { n: (it.paths || []).length, merges: [], specks: [], dups: [] };
    byItem[it.id] = rec;
    (it.paths || []).forEach((p, pi) => {
      const a = p.a || [], pts = [];
      for (let i = 0; i + 5 < a.length; i += 6) pts.push({ a: [a[i], a[i+1]], l: [a[i+2], a[i+3]], r: [a[i+4], a[i+5]] });
      paths.push({ it, rec, pi, z: !!p.z, pts });
    });
  }
  // STEP 2: clean points & remove specks
  const alive = [];
  for (const P of paths) {
    const pts = P.pts, removed = []; let closeFix = false;
    if (pts.length >= 2) {
      for (let i = pts.length - 1; i > 0; i--) if (cSame(pts[i].a, pts[i-1].a)) { pts[i-1].r = pts[i].r; pts.splice(i, 1); removed.push(i); }
      if (P.z && pts.length > 2 && cSame(pts[pts.length-1].a, pts[0].a)) { pts[0].l = pts[pts.length-1].l; pts.pop(); closeFix = true; }
    }
    if (removed.length || closeFix) P.rec.merges.push([P.pi, removed, closeFix]);
    let speck = pts.length < 2;
    if (!speck) {
      const poly = cPoly(pts, P.z); P.poly = poly;
      let area = 0; const m = poly.length / 2;
      for (let j = 0; j < m; j++) { const k = (j + 1) % m; area += poly[2*j]*poly[2*k+1] - poly[2*k]*poly[2*j+1]; }
      if (Math.abs(area / 2) < CL.SPECK_AREA) {
        let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
        for (let j = 0; j < poly.length; j += 2) { x0 = Math.min(x0, poly[j]); x1 = Math.max(x1, poly[j]); y0 = Math.min(y0, poly[j+1]); y1 = Math.max(y1, poly[j+1]); }
        speck = Math.hypot(x1 - x0, y1 - y0) < C_SPECK_DIAG;
      }
    }
    if (speck) P.rec.specks.push(P.pi); else alive.push(P);
  }
  // STEP 3: full duplicates
  const infos = alive.map(P => cInfo(P, P.poly));
  infos.sort((a, b) => a.minX - b.minX);
  for (let j = 0; j < infos.length; j++) { const A = infos[j]; if (A.flagged) continue;
    for (let k = j + 1; k < infos.length; k++) { const B = infos[k];
      if (B.minX > A.maxX + C_TOL) break; if (B.flagged) continue;
      if (cCoveredBy(B, A)) { B.flagged = true; B.path.rec.dups.push(B.path.pi); }
      else if (cCoveredBy(A, B)) { A.flagged = true; A.path.rec.dups.push(A.path.pi); break; } } }
  // STEP 4: partial overlaps between lines that stay
  const overlaps = [];
  for (let j = 0; j < infos.length; j++) { const A = infos[j]; if (A.flagged) continue;
    for (let k = j + 1; k < infos.length; k++) { const B = infos[k];
      if (B.minX > A.maxX + C_TOL) break; if (B.flagged) continue;
      if (A.length <= B.length) cPartialOverlaps(A, B, overlaps); else cPartialOverlaps(B, A, overlaps); } }
  const round = v => Math.round(v * 1000) / 1000;
  return { byItem, overlaps: overlaps.map(o => o.map(p => [round(p[0]), round(p[1])])),
           counts: { specks: paths.length - alive.length, points: Object.values(byItem).reduce((n, r) => n + r.merges.reduce((m, g) => m + g[1].length + (g[2] ? 1 : 0), 0), 0), dups: infos.filter(i => i.flagged).length, overlaps: overlaps.length } };
}

// ---------------------------------------------------------------------------
// Sort the exported objects into paper parts and loose lines
// ---------------------------------------------------------------------------
const ITEMS = IN.items || [];
const partItems = [], lineItems = [], cutOnly = [];
ITEMS.forEach((it, idx) => {
  it.idx = idx;
  it.cutRaw = (it.rings || []).filter(r => r.c === "cut");     // every paper outline, in export order
  it.rings = (it.rings || []).filter(r => r.p && r.p.length >= (r.c === "cut" && r.z ? 6 : 4));
  if (it.others && it.others.length) { flag("Left in place, can't handle: " + it.others.join("; ")); return; }
  const keys = it.keys || [];
  if (keys.length && !SORT) { it.material = UNSORTED_LABEL; partItems.push(it); }
  else if (keys.length) {
    const unknown = keys.filter(k => !LIB.byKey.has(k));
    if (unknown.length) { for (const k of unknown) flag("Left in place, colour not in the paper library: " + describeKey(k)); return; }
    const labels = [...new Set(keys.map(k => LIB.byKey.get(k).label))];
    if (labels.length > 1) { flag("Left in place, one group mixes papers: " + labels.join(" + ")); return; }
    it.material = labels[0];
    partItems.push(it);
  } else if (it.cut) cutOnly.push(it);           // already laser-prepped: pink / green outlines, no fill
  else if (it.lines) lineItems.push(it);
});

// Is every point of the line inside one of the part's paper outlines
// (or within HOLD_TOL of its edge)?
const HOLD_TOL = 0.5 * PT;
function nearRingTol(x, y, p, tol) {
  const t2 = tol * tol, n = p.length;
  for (let i = 0; i + 3 < n; i += 2) if (ptSegD2(x, y, p[i], p[i+1], p[i+2], p[i+3]) <= t2) return true;
  return n >= 6 && ptSegD2(x, y, p[n-2], p[n-1], p[0], p[1]) <= t2;
}
function holdsLine(part, line) {
  const cut = part.rings.filter(r => r.c === "cut" && r.z);
  if (!cut.length || !line.rings.length) return false;
  if (!part.bb) { part.cutBBs = cut.map(r => ringBB(r.p)); part.bb = part.cutBBs.reduce((a,b) => [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]); }
  for (const r of line.rings) {
    const n = r.p.length / 2, stride = Math.max(1, Math.floor(n / 200));
    for (let i = 0; i < n; i += stride) {
      const x = r.p[2*i], y = r.p[2*i+1];
      if (x < part.bb[0]-HOLD_TOL || x > part.bb[2]+HOLD_TOL || y < part.bb[1]-HOLD_TOL || y > part.bb[3]+HOLD_TOL) return false;
      let ok = false;
      for (let k = 0; k < cut.length && !ok; k++) if (inBB(x, y, part.cutBBs[k]) && pointInRing(x, y, cut[k].p, 0, 0)) ok = true;
      // touching the edge counts too (engravings often run right up to it)
      for (let k = 0; k < cut.length && !ok; k++) { const b = part.cutBBs[k];
        if (x >= b[0]-HOLD_TOL && x <= b[2]+HOLD_TOL && y >= b[1]-HOLD_TOL && y <= b[3]+HOLD_TOL && nearRingTol(x, y, cut[k].p, HOLD_TOL)) ok = true; }
      if (!ok) return false;
    }
  }
  return true;
}
// Loose lines: stick to the nearest paper part underneath that holds them
// Pink / green-only objects: a loose hole (or any part already sitting inside
// another part) travels with the smallest part that fully holds it.
const cutArea = it => it.rings.reduce((m, r) => (r.c === "cut" && r.z) ? Math.max(m, ringArea(r.p)) : m, 0);
for (const it of [...partItems, ...cutOnly]) it.area0 = cutArea(it);
for (const c of cutOnly) {
  let best = null;
  for (const h of [...partItems, ...cutOnly]) {
    if (h === c || h.area0 <= c.area0 || (best && h.area0 >= best.area0)) continue;
    if (holdsLine(h, c)) best = h;
  }
  c.container = best;
}
const rootOf = it => { let r = it, guard = 0; while (r.container && guard++ < 1000) r = r.container; return r; };
let preppedSorted = 0;
for (const c of cutOnly) {
  if (c.container) continue;
  if (SORT) { preppedSorted++; c.skip = true; continue; }
  c.material = UNSORTED_LABEL; partItems.push(c);
}
if (preppedSorted) flagCounts.set(`Left in place, already laser-coloured (pink / green outlines, no paper fill): ${preppedSorted} object(s). Turn off "Sort by paper" to nest them`, 0);
const attached = new Map(partItems.map(p => [p, []]));
for (const c of cutOnly) if (c.container && !rootOf(c).skip && attached.has(rootOf(c))) attached.get(rootOf(c)).push(c);
const hosts = [...partItems, ...cutOnly.filter(c => c.container && attached.has(rootOf(c)))];
for (const ln of lineItems) {
  if (!SET.overlaps) { flag("Left in place, loose scoring / perforation / marking not grouped with a part"); continue; }
  let best = null;
  for (const p of hosts) {
    if (p.zi <= ln.zi) continue;                       // the part underneath the line...
    if (best && p.zi >= best.zi) continue;             // ...nearest one wins
    if (holdsLine(p, ln)) best = p;
  }
  if (!best) for (const p of hosts) {                  // nothing underneath: the nearest one above it
    if (p.zi >= ln.zi) continue;
    if (best && p.zi <= best.zi) continue;
    if (holdsLine(p, ln)) best = p;
  }
  if (best) attached.get(rootOf(best)).push(ln);
  else flag("Left in place, loose line not sitting on any paper part");
}

// ---------------------------------------------------------------------------
// Turn a part (+ its attached lines) into outlines + free holes
// ---------------------------------------------------------------------------
function buildPiece(objs) {
  const R = [];
  for (const it of objs) for (const r of it.rings)
    R.push({ p: r.p, c: r.c, z: !!r.z, l: !!r.l, o: it.idx * 100000 + (r.o || 0), bb: ringBB(r.p), area: ringArea(r.p), parent: null });
  const cut = R.filter(r => r.c === "cut" && r.z);
  // direct container = smallest closed outline of the SAME object that encloses it
  for (const r of cut) { let best = null;
    for (const k of cut) {
      // filled shapes: holes come from the same compound path; pink / green
      // outlines: separate paths, so any of them can be the container
      if (k === r || (r.l ? !k.l : k.o !== r.o) || k.area <= r.area || (best && k.area >= best.area)) continue;
      if (!bbInside(r.bb, k.bb) || !allInside(r.p, k.p)) continue;
      best = k; }
    r.parent = best; }
  const hasChild = new Set(cut.filter(r => r.parent).map(r => r.parent));
  const depth = r => { let d = 0, k = r.parent; while (k) { d++; k = k.parent; } return d; };
  const outers = [], holes = [];
  for (const r of cut) {
    const d = depth(r);
    if (d === 0) outers.push(r);
    else if (d % 2 === 1 && !hasChild.has(r)) {
      // only free if nothing else of this part reaches into it
      const blocked = R.some(k => k !== r && k.parent !== r && k !== r.parent && k.o !== r.o && bbOverlap(k.bb, r.bb));
      if (!blocked) holes.push(r);
    }
  }
  for (const r of R) { if (r.c === "cut" && r.z) continue;
    if (!outers.some(o => bbInside(r.bb, o.bb) && pointInRing(r.p[0], r.p[1], o.p, 0, 0))) outers.push(r); }
  if (!outers.length) return null;
  return { outers: outers.map(r => r.p), holes: holes.map(r => r.p) };
}

let rotations = [0];
if (CFG.ROTATION_STEP > 0 && CFG.ROTATION_STEP < 360) { rotations = []; for (let d = 0; d < 360; d += CFG.ROTATION_STEP) rotations.push(d); }
function makeProbes(sh, w, h) {   // quick-reject points that are on this part's own material
  const out = [];
  for (const p of [[w*0.5, h*0.5], [SPACING, h-SPACING]]) if (inMaterial(sh, p[0], p[1])) out.push(p);
  return out;
}

const byMaterial = new Map();
let holesFound = 0;
const tooBig = [];
for (const it of partItems) {
  const g = buildPiece([it, ...attached.get(it)]);
  if (!g) continue;
  const ids = [it.id, ...attached.get(it).map(l => l.id)];
  const all = g.outers.concat(g.holes), nOut = g.outers.length;
  const baseDeg = CFG.ALIGN_TO_EDGES ? straightenAngle(g.outers) : 0;
  const variants = rotations.map(rd => { const ang = baseDeg + rd;
    const rr = rotateRings(all, ang);
    let ox = 1e12, oy = 1e12;
    for (const r of rr) for (let j = 0; j < r.length; j += 2) { if (r[j] < ox) ox = r[j]; if (r[j+1] < oy) oy = r[j+1]; }
    const sh = makeShape(normaliseRings(rr), nOut);
    const w = sh.bb[2]-sh.bb[0], h = sh.bb[3]-sh.bb[1];
    return { angle: ang, off: [ox, oy], shape: sh, w, h, probes: makeProbes(sh, w, h) }; });
  const area = g.outers.reduce((s, r) => s + ringArea(r), 0);
  holesFound += g.holes.length;
  const objs = [it, ...attached.get(it)];
  let clean = null;
  if (SET.cleanup) {
    clean = cleanupPiece(objs);
    for (const o of objs) {                 // which paper outlines are gone (speck / duplicate)?
      const rec = clean.byItem[o.id], paperIdx = [];
      (o.paths || []).forEach((p, pi) => { if (p.s === "paper" || p.s === "cutline") paperIdx.push(pi); });
      if (paperIdx.length !== o.cutRaw.length) { delete clean.byItem[o.id]; flag("Cleanup skipped for an object whose outlines couldn't be matched up"); continue; }
      const gone = new Set([...rec.specks, ...rec.dups]);
      o.removedPaper = new Set(paperIdx.map((pi, k) => gone.has(pi) ? k : -1).filter(k => k >= 0));
    }
  }
  const part = { id: it.id, ids, objs, clean, material: it.material, variants, area, w: variants[0].w, h: variants[0].h };
  if (!variants.some(v => v.w <= usableW + 1e-6 && v.h <= usableH + 1e-6)) { tooBig.push(part); continue; }
  if (!byMaterial.has(it.material)) byMaterial.set(it.material, []);
  byMaterial.get(it.material).push(part);
}

// ---------------------------------------------------------------------------
// Label corner (Arial widths, 1/1000 em)
// ---------------------------------------------------------------------------
const ARIAL = { " ":278,"!":278,"\"":355,"#":556,"$":556,"%":889,"&":667,"'":191,"(":333,")":333,"*":389,"+":584,",":278,"-":333,".":278,"/":278,
  "0":556,"1":556,"2":556,"3":556,"4":556,"5":556,"6":556,"7":556,"8":556,"9":556,":":278,";":278,"?":556,"–":556,
  A:667,B:667,C:722,D:722,E:667,F:611,G:778,H:722,I:278,J:500,K:667,L:556,M:833,N:722,O:778,P:667,Q:778,R:722,S:667,T:611,U:722,V:667,W:944,X:667,Y:667,Z:611,
  a:556,b:556,c:500,d:556,e:556,f:278,g:556,h:556,i:222,j:222,k:500,l:222,m:833,n:556,o:556,p:556,q:556,r:333,s:500,t:278,u:556,v:500,w:722,x:500,y:500,z:500 };
function textWidthPt(s, size) {
  let w = 0;
  for (const ch of s) { const base = ch.normalize("NFD")[0]; w += ARIAL[ch] ?? ARIAL[base] ?? 667; }
  return w / 1000 * size;
}
function labelShape(label) {
  const inset = CFG.LABEL_INSET_MM * PT;
  const h = CFG.LABEL_PT * 1.15;                               // ascender + descender
  const w = textWidthPt(label, CFG.LABEL_PT) + 3 * PT;         // + a little safety
  const rw = SET.labelMode === "strip" ? SHEET_W : Math.min(SHEET_W, inset + w), rh = inset + h;
  return makeShape([[0, SHEET_H, rw, SHEET_H, rw, SHEET_H - rh, 0, SHEET_H - rh]], 1);
}

// ---------------------------------------------------------------------------
// One sheet at a time (state is reset per sheet)
// ---------------------------------------------------------------------------
let placed = [], candidates = [], candKeys = new Set(), envR = 0, envB = 0;
function resetSheet() { HASH = new Map(); placed = []; candidates = []; candKeys = new Set(); envR = 0; envB = 0; addCandidate(0, 0); }
const candKey = (px,pt) => Math.round(px/0.5)*1e6 + Math.round(pt/0.5);
function addCandidate(px, pt) {
  if (px < 0) px = 0; if (pt < 0) pt = 0;
  if (px > usableW-1e-6 || pt > usableH-1e-6) return;
  const k = candKey(px, pt); if (candKeys.has(k)) return;
  candKeys.add(k); candidates.push({ px, pt, key: k });
}
function removeCandidate(i) { candKeys.delete(candidates[i].key); candidates.splice(i, 1); }
function seedFromShape(S) {
  const bb = S.bb;
  addCandidate((bb[2]+SPACING)-ORG_X, ORG_Y-bb[3]);
  addCandidate(bb[0]-ORG_X, (ORG_Y-bb[1])+SPACING);
  for (const ring of S.rings) { const r = decimate(ring, CANDTOL);
    for (let j = 0; j < r.length; j += 2) { const px = r[j]-ORG_X, pt = ORG_Y-r[j+1];
      addCandidate(px+SPACING, pt); addCandidate(px, pt+SPACING); addCandidate(px+SPACING, pt+SPACING); } }
}
function growEnvelope(S) { envR = Math.max(envR, S.bb[2]-ORG_X); envB = Math.max(envB, ORG_Y-S.bb[1]); }
function pointBlocked(x, y) { for (const P of placed) if (inMaterial(P, x, y)) return true; return false; }
function fits(v, px, pt) {
  if (px < -1e-6 || pt < -1e-6) return false;
  if (px+v.w > usableW+1e-6 || pt+v.h > usableH+1e-6) return false;
  const dx = ORG_X+px, dy = (ORG_Y-pt)-v.h;
  for (const q of v.probes) if (pointBlocked(dx+q[0], dy+q[1])) return false;
  // cheap tests first: anything nearby at all? sitting on someone's material?
  const L = v.shape.bb[0]+dx-SPACING, B = v.shape.bb[1]+dy-SPACING, R = v.shape.bb[2]+dx+SPACING, T = v.shape.bb[3]+dy+SPACING;
  let near = false;
  for (const P of placed) if (P.bb[0] < R && P.bb[2] > L && P.bb[1] < T && P.bb[3] > B) { near = true; break; }
  if (!near) return true;
  for (const P of placed) if (overlapsEitherWay(v.shape, dx, dy, P)) return false;
  if (segmentsTooClose(v.shape, dx, dy)) return false;
  return true;
}
function fitsNudged(v, px, pt, out) {
  if (fits(v,px,pt)) { out.px=px; out.pt=pt; return true; }
  for (let n = 1; n <= CFG.NUDGE_TRIES; n++) {
    if (fits(v,px+n*NUDGE,pt)) { out.px=px+n*NUDGE; out.pt=pt; return true; }
    if (fits(v,px,pt+n*NUDGE)) { out.px=px; out.pt=pt+n*NUDGE; return true; } }
  return false;
}
function slide(v, pos) {
  let moved = true, guard = 0, st;
  while (moved && guard++ < 60) { moved = false;
    st = SLMAX; while (st >= SLMIN) { if (pos.pt-st >= -1e-6 && fits(v,pos.px,pos.pt-st)) { pos.pt-=st; moved=true; } else st*=0.5; }
    st = SLMAX; while (st >= SLMIN) { if (pos.px-st >= -1e-6 && fits(v,pos.px-st,pos.pt)) { pos.px-=st; moved=true; } else st*=0.5; } }
  if (pos.pt<0) pos.pt=0; if (pos.px<0) pos.px=0;
}
function addGridProbes() {
  if (GRID <= 0 || envR <= 0 || envB <= 0) return;
  const maxX = Math.min(envR, usableW), maxY = Math.min(envB, usableH);
  for (let gy = 0; gy <= maxY; gy += GRID) for (let gx = 0; gx <= maxX; gx += GRID) addCandidate(gx, gy);
}

let inHoles = 0, timedOut = false, progressN = 0;
const totalParts = [...byMaterial.values()].reduce((s, l) => s + l.length, 0);
// Places as many of `list` as fit; returns { done: [...], rest: [...] }
function nestSheet(list, obstacle) {
  resetSheet();
  placed.push(obstacle); hashInsertShape(obstacle); seedFromShape(obstacle);
  const done = [], rest = [];
  const spot = { px: 0, pt: 0 }, SLACK = 2*SLMAX;
  for (let pi = 0; pi < list.length; pi++) {
    const part = list[pi];
    if (timeUp()) { timedOut = true; rest.push(...list.slice(pi)); break; }
    process.stderr.write(`\rPlaced ${progressN} of ${totalParts} part(s)   `);
    addGridProbes();
    candidates.sort((a,b) => (a.px*a.px+a.pt*a.pt)-(b.px*b.px+b.pt*b.pt));
    let best=null, bestVar=null, bestIdx=-1, bestScore=1e18, bestFar=1e18, bestDist=1e18;
    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci], cd = Math.hypot(c.px, c.pt);
      if (cd > bestDist + SLACK) break;
      for (const v of part.variants) {
        if (!fitsNudged(v, c.px, c.pt, spot)) continue;
        slide(v, spot);
        const sc = spot.px*spot.px+spot.pt*spot.pt, far = (spot.px+v.w)**2 + (spot.pt+v.h)**2;
        if (sc < bestScore-1e-6 || (Math.abs(sc-bestScore)<=1e-6 && far < bestFar)) {
          bestScore=sc; bestDist=Math.sqrt(sc); bestFar=far; best={px:spot.px,pt:spot.pt}; bestVar=v; bestIdx=ci; }
      }
    }
    if (best) {
      const dx = ORG_X+best.px, dy = (ORG_Y-best.pt)-bestVar.h;
      const S = translatedShape(bestVar.shape, dx, dy);
      const ref = S.rings[0];
      if (placed.some(P => inHoleOf(P, ref[0], ref[1]))) inHoles++;
      placed.push(S); hashInsertShape(S); if (bestIdx>=0) removeCandidate(bestIdx); seedFromShape(S); growEnvelope(S);
      progressN++;
      done.push({ part, v: bestVar, dx, dy, items: part.ids, angle: bestVar.angle, minX: dx, minY: dy, maxX: dx+bestVar.w, maxY: dy+bestVar.h, rings: S.rings, nOut: S.nOut });
    } else rest.push(part);
  }
  return { done, rest };
}

// ---------------------------------------------------------------------------
// Laser colours for the paper outlines (same rule as Prep.js / Audit.js):
//   depth = how many closed outlines on the sheet a line sits inside
//   PINK  = even depth AND another cut line sits inside it
//   GREEN = everything else (holes, lone shapes, open lines)
// Done here for the whole sheet at once, so a part sitting in another
// part's hole gets the right colour too.
// Returns, per placed part, { itemId: ["pink","green",...] } in export order.
// ---------------------------------------------------------------------------
const EDGE_TOL = 0.05 * PT;
function nearRing(x, y, p) {
  const t2 = EDGE_TOL * EDGE_TOL, n = p.length;
  for (let i = 0; i + 3 < n; i += 2) if (ptSegD2(x, y, p[i], p[i+1], p[i+2], p[i+3]) <= t2) return true;
  return n >= 6 && ptSegD2(x, y, p[n-2], p[n-1], p[0], p[1]) <= t2;
}
function ringInside(a, b) {          // is line a completely inside closed line b?
  if (a === b || !b.z || b.area <= a.area) return false;
  if (a.bb[0] < b.bb[0]-EDGE_TOL || a.bb[2] > b.bb[2]+EDGE_TOL || a.bb[1] < b.bb[1]-EDGE_TOL || a.bb[3] > b.bb[3]+EDGE_TOL) return false;
  const p = a.p, n = p.length / 2, stride = Math.max(1, Math.floor(n / 200));
  for (let i = 0; i < n; i += stride) { const x = p[2*i], y = p[2*i+1];
    if (!pointInRing(x, y, b.p, 0, 0) && !nearRing(x, y, b.p)) return false; }
  return true;
}
function laserColours(done) {
  // position of each kept outline in the colour list
  const pos = new Map();
  for (const d of done) for (const it of d.part.objs) { let q = 0; const m = new Array(it.cutRaw.length);
    for (let idx = 0; idx < it.cutRaw.length; idx++) m[idx] = (it.removedPaper && it.removedPaper.has(idx)) ? -1 : q++;
    pos.set(it, m); it.keptN = q; }
  const L = [];
  done.forEach((d, k) => {
    const c = Math.cos(d.v.angle*Math.PI/180), s = Math.sin(d.v.angle*Math.PI/180);
    const tx = d.dx - d.v.off[0], ty = d.dy - d.v.off[1];
    for (const it of d.part.objs) it.cutRaw.forEach((r, idx) => {
      const q = pos.get(it)[idx];
      if (it.removedPaper && it.removedPaper.has(idx)) return;      // removed by Cleanup
      const p = new Array(r.p.length);
      for (let j = 0; j < r.p.length; j += 2) { const x = r.p[j], y = r.p[j+1]; p[j] = x*c - y*s + tx; p[j+1] = x*s + y*c + ty; }
      L.push({ k, id: it.id, idx: q, p, z: !!r.z && p.length >= 6, bb: p.length ? ringBB(p) : [0,0,0,0], area: (r.z && p.length >= 6) ? ringArea(p) : 0, ok: p.length >= 4 });
    });
  });
  const out = done.map(d => { const o = {}; for (const it of d.part.objs) o[it.id] = new Array(it.keptN).fill("green"); return o; });
  for (const a of L) {
    if (!a.ok) continue;
    let depth = 0, hasInside = false;
    for (const b of L) {
      if (b === a || !b.ok) continue;
      if (ringInside(a, b)) depth++;
      else if (!hasInside && ringInside(b, a)) hasInside = true;
    }
    if (depth % 2 === 0 && hasInside) out[a.k][a.id][a.idx] = "pink";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main: every paper gets as many sheets as it needs
// ---------------------------------------------------------------------------
const result = { settings: SET, sheetW: SHEET_W, sheetH: SHEET_H, labelPt: CFG.LABEL_PT, labelInsetMM: CFG.LABEL_INSET_MM,
                 sheets: [], unfitted: [], flags: [], libWarnings: LIB.warnings, library: LIB.file, papersInLibrary: LIB.count,
                 timedOut: false, holesFound, inHoles: 0, cleanTotals: { specks: 0, points: 0, dups: 0, overlaps: 0 } };
const DEBUG = process.env.NEST_DEBUG === "1";
const materials = [...byMaterial.keys()].sort((a, b) => a.localeCompare(b));
for (const mat of materials) {
  let remaining = byMaterial.get(mat).sort((a,b) => CFG.SORT_BY==="height" ? b.h-a.h : CFG.SORT_BY==="width" ? b.w-a.w : b.area-a.area);
  let n = 1;
  while (remaining.length) {
    if (timeUp()) { timedOut = true; break; }
    const label = !SORT ? UNSORTED_LABEL : n === 1 ? mat : `${mat} (${n})`;
    const obstacle = labelShape(label);
    const { done, rest } = nestSheet(remaining, obstacle);
    if (!done.length) break;                            // nothing fits even on an empty sheet
    const colours = SET.recolour !== false ? laserColours(done) : [];
    const sheet = { material: mat, label, index: n, artboardName: SORT ? label : `Sheet ${result.sheets.length + 1}`,
                    placed: done.map((d, k) => {
                      const o = { items: d.items, angle: d.angle, minX: d.minX, minY: d.minY };
                      if (colours[k]) o.colours = colours[k];
                      if (d.part.clean) {
                        o.clean = d.part.clean.byItem; o.overlaps = d.part.clean.overlaps;
                        const c = d.part.clean.counts; for (const key in c) result.cleanTotals[key] += c[key];
                      }
                      return o; }) };
    if (DEBUG) { sheet.debug = { label: obstacle.rings, parts: done.map(d => ({ rings: d.rings, nOut: d.nOut })) }; }
    result.sheets.push(sheet);
    remaining = rest; n++;
  }
  for (const p of remaining) result.unfitted.push({ items: p.ids, material: mat });
}
for (const p of tooBig) result.unfitted.push({ items: p.ids, material: p.material, tooBig: true });
if (tooBig.length) flagCounts.set(`Parked on UNFITTED, bigger than the ${SET.machine} sheet: ${tooBig.length === 1 ? "1 part" : tooBig.length + " parts"}`, 0);
result.flags = [...flagCounts].map(([reason, count]) => ({ reason, count }));
result.timedOut = timedOut;
result.inHoles = inHoles;
process.stderr.write("\n");
result.seconds = (Date.now()-T0)/1000;
fs.writeFileSync(outPath, JSON.stringify(result));
const nPlaced = result.sheets.reduce((s, sh) => s + sh.placed.length, 0);
console.log(`Placed ${nPlaced} part(s) on ${result.sheets.length} sheet(s) in ${result.seconds.toFixed(1)} s` +
  (inHoles ? `, ${inHoles} inside holes` : "") +
  (result.unfitted.length ? `, ${result.unfitted.length} unfitted` : ""));
for (const sh of result.sheets) console.log(`  ${sh.label}: ${sh.placed.length} part(s)`);
for (const f of result.flags) console.log(`  ! ${f.reason}${f.count > 1 ? " (" + f.count + "x)" : ""}`);
for (const w of LIB.warnings) console.log(`  ! ${w}`);
