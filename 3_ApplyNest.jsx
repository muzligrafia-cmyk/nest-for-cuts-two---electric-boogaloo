/*
================================================================================
 3_ApplyNest.jsx - Step 3 of 3: build the cutting sheets
================================================================================
 Reads Desktop/nest_result.json and:
   1. creates one artboard per sheet (in a new document or the current one,
      as chosen in step 1), named after the paper, one row per paper
   2. writes the paper name on every sheet: Arial 35 pt, 1 cm from the top
      and left edge, on the "Labels" layer (black = the laser would mark it,
      so delete the labels before cutting)
   3. rotates and moves every part onto its sheet ("Arranged" layer).
      In "New document" mode the parts are copied, so your design stays as
      it was. A part with loose lines stuck to it becomes one group.
   4. recolours the placed parts for the laser - the same rules as Prep.js
      (V2.1): paper fills off, outer cuts pink / inner cuts green by depth,
      red / blue / black lines tidied, text outlined as black marking.
      nest.js already worked out pink / green for every outline, so this
      step just applies it. Anything that doesn't match up goes through the
      full Prep.js routine (included below) instead.
   5. parks parts that are bigger than the sheet on "UNFITTED"
      (not recoloured, so you can still see their paper)
 and tells you everything that was left out, and why.
================================================================================
*/
// #target illustrator
function nestApplyMain() {
    // any error shows up as an alert instead of the script silently doing nothing
    try { nestApplyInner(); }
    catch (err) { alert("3_ApplyNest stopped with an error:\n" + err.message + (err.line ? "\n(line " + err.line + ")" : "")); }

    function nestApplyInner() {
    var CFG = {
        ARRANGED_LAYER: "Arranged",
        UNFITTED_LAYER: "UNFITTED",
        LABELS_LAYER:   "Labels",
        IN_FILE:        Folder.desktop.fsName + "/nest_result.json",
        GAP_MM:         50,      // space between sheets
        MAX_ROW_MM:     5000,    // start a new row after this width (Illustrator's canvas is ~5.7 m)
        LABEL_FONTS:    ["ArialMT", "Arial-Regular", "Arial"],
        DUP_LAYER:      "duplicates"
    };
    var PT = 2.834645669291339;

    // ---- read the result ----------------------------------------------------
    var f = new File(CFG.IN_FILE);
    if (!f.exists) { alert("Can't find " + CFG.IN_FILE + "\nRun 2_RunNest first."); return; }
    f.encoding = "UTF-8"; f.open("r"); var txt = f.read(); f.close();
    var res;
    try { res = eval("(" + txt + ")"); } catch (e) { alert("nest_result.json is unreadable."); return; }
    if (res.error) { alert("The engine says:\n" + res.error); return; }
    if (!res.settings || !res.sheets) { alert("nest_result.json is from an older version. Run steps 1 and 2 again."); return; }
    var S = res.settings, W = res.sheetW, H = res.sheetH;
    var RECOLOUR = S.recolour !== false, CLEANUP = !!S.cleanup;

    // ---- find the source document ---------------------------------------------
    var src = null, d;
    for (d = 0; d < app.documents.length; d++) if (app.documents[d].name === S.sourceDoc) { src = app.documents[d]; break; }
    if (!src) { alert("Open \"" + S.sourceDoc + "\" first (the document you ran step 1 on)."); return; }
    app.activeDocument = src;

    // timing, shown at the bottom of the final alert
    var tLap = new Date().getTime(), laps = [];
    function lap(name, ms) {
        var now = new Date().getTime();
        if (ms === undefined) { ms = now - tLap; tLap = now; }
        laps.push(name + " " + (ms / 1000).toFixed(1) + " s");
    }

    // Nothing selected: Illustrator refreshes its panels after every change
    // to a selected object, which slows everything below a lot.
    try { src.selection = null; } catch (e) {}

    // Find the tagged parts. Only top-level objects carry tags, so only
    // those are checked (not everything nested inside groups).
    var byId = {}, pi;
    function scanLayer(L) {
        var items = L.pageItems, n = items.length, k;
        for (k = 0; k < n; k++) {
            var it = items[k], nt = it.note;
            if (nt && nt.indexOf("NEST_") === 0) byId[nt] = it;
        }
        var subs = L.layers, ns = subs.length;
        for (k = 0; k < ns; k++) scanLayer(subs[k]);
    }
    var srcLayers = src.layers, nL = srcLayers.length;
    for (pi = 0; pi < nL; pi++) scanLayer(srcLayers[pi]);
    var missing = 0;
    function itemsFor(ids) {
        var out = [];
        for (var k = 0; k < ids.length; k++) { var x = byId[ids[k]]; if (x) out.push(x); else missing++; }
        return out;
    }

    // ---- lay the sheets out: one row per paper ------------------------------
    var gap = CFG.GAP_MM * PT, maxRow = CFG.MAX_ROW_MM * PT;
    var pos = [], x = 0, y = 0, prevMat = null, gridW = 0, i;
    for (i = 0; i < res.sheets.length; i++) {
        var sh = res.sheets[i];
        if (i > 0 && (sh.material !== prevMat || x + W > maxRow)) { x = 0; y += H + gap; }
        pos.push({ x: x, y: y });                    // offset from the grid's top-left, y downwards
        if (x + W > gridW) gridW = x + W;
        x += W + gap; prevMat = sh.material;
    }
    var gridH = res.sheets.length ? y + H : 0;

    // ---- target document ------------------------------------------------------
    var tgt, originL, originT;
    if (S.output === "new") {
        tgt = app.documents.add(DocumentColorSpace.RGB, W, H);
        var a0 = tgt.artboards[0].artboardRect;
        originL = (a0[0] + a0[2]) / 2 - gridW / 2;   // centre the grid on the canvas
        originT = (a0[1] + a0[3]) / 2 + gridH / 2;
    } else {
        tgt = src;
        var u = tgt.artboards[0].artboardRect, uL = u[0], uB = u[3];
        for (d = 1; d < tgt.artboards.length; d++) {
            var r = tgt.artboards[d].artboardRect;
            if (r[0] < uL) uL = r[0]; if (r[3] < uB) uB = r[3];
        }
        originL = uL; originT = uB - gap * 2;        // below everything that's already there
    }

    // ---- artboards first (if the canvas is full, nothing has moved yet) ------
    var rects = [];
    try {
        for (i = 0; i < res.sheets.length; i++) {
            var L = originL + pos[i].x, T = originT - pos[i].y, rect = [L, T, L + W, T - H], ab;
            if (S.output === "new" && i === 0) { ab = tgt.artboards[0]; ab.artboardRect = rect; }
            else ab = tgt.artboards.add(rect);
            try { ab.name = res.sheets[i].artboardName || res.sheets[i].label; } catch (e) {}
            rects.push(rect);
        }
    } catch (e) {
        alert("Couldn't create sheet " + (rects.length + 1) + " of " + res.sheets.length +
              " (the canvas is probably full).\n" +
              (S.output === "new" ? "" : "Try \"New document\" in step 1.\n") + "Nothing was moved.");
        return;
    }

    lap("find parts + sheets");

    // ---- layers -------------------------------------------------------------------
    function getLayer(doc, name) {
        for (var k = 0; k < doc.layers.length; k++) if (doc.layers[k].name === name) return doc.layers[k];
        var nl = doc.layers.add(); nl.name = name; return nl;
    }
    function openLayer(doc, name) { var ly = getLayer(doc, name); ly.locked = false; ly.visible = true; return ly; }
    var arr = openLayer(tgt, CFG.ARRANGED_LAYER);
    if (S.output === "new" && tgt.layers.length > 1) {          // drop the empty default layer
        for (var k2 = tgt.layers.length - 1; k2 >= 0; k2--) {
            var ly2 = tgt.layers[k2];
            if (ly2.pageItems.length === 0 && ly2.layers.length === 0 && ly2.name !== CFG.ARRANGED_LAYER) try { ly2.remove(); } catch (e) {}
        }
    }

    // ---- where the work happens -------------------------------------------------------
    // Copying objects between documents is very slow in Illustrator (about a
    // quarter of a second per object). So in "New document" mode everything is
    // built on a temporary layer in YOUR document (copies only, your artwork
    // isn't touched), then sent to the new document in ONE copy at the end.
    var NEW = S.output === "new";
    var work = arr, sOL = originL, sOT = originT, wRects = rects;
    if (NEW) {
        app.activeDocument = src;
        work = src.layers.add(); work.name = "__NestForCuts_work";
        var s0 = src.artboards[0].artboardRect;
        sOL = (s0[0] + s0[2]) / 2 - gridW / 2;          // same grid, centred on your first artboard
        sOT = (s0[1] + s0[3]) / 2 + gridH / 2;
        wRects = [];
        for (i = 0; i < rects.length; i++) {
            var rr = rects[i], ddx = sOL - originL, ddy = sOT - originT;
            wRects.push([rr[0] + ddx, rr[1] + ddy, rr[2] + ddx, rr[3] + ddy]);
        }
    }

    // ---- copy (new document) or take (current document) a part ---------------------
    function bring(items) {
        if (!NEW) return items;
        var out = [];
        for (var k = 0; k < items.length; k++) { var c = items[k].duplicate(work, ElementPlacement.PLACEATEND); c.note = ""; out.push(c); }
        return out;
    }
    // extra (optional): Cleanup's duplicates + markers. They turn and move with
    // the part, but don't count for its position.
    function moveRigid(items, angle, left, bottom, ly, extra) {
        var obj, all = extra ? items.concat([extra]) : items, k;
        if (all.length === 1) { obj = all[0]; obj.move(ly, ElementPlacement.PLACEATEND); }
        else {
            obj = ly.groupItems.add();                       // part + its lines stay together
            for (k = 0; k < all.length; k++) all[k].move(obj, ElementPlacement.PLACEATEND);
        }
        if (angle && Math.abs(angle) > 1e-9) obj.rotate(angle);
        var b = obj.geometricBounds;                          // [L, T, R, B]
        if (extra) {
            b = items[0].geometricBounds; b = [b[0], b[1], b[2], b[3]];
            for (k = 1; k < items.length; k++) { var c = items[k].geometricBounds;
                if (c[0] < b[0]) b[0] = c[0]; if (c[1] > b[1]) b[1] = c[1]; if (c[2] > b[2]) b[2] = c[2]; if (c[3] < b[3]) b[3] = c[3]; }
        }
        obj.translate(left - b[0], bottom - b[3]);
        return obj;
    }

    // =================================================================================
    // Fast laser recolour. nest.js already decided pink / green for every paper
    // outline (the Prep.js depth rule, worked out for the whole sheet). Here the
    // colours are simply applied, path by path, in the same order step 1 read
    // them. No selecting, no menu commands. Compound paths are split by copying
    // their pieces into a group. Anything that doesn't match up exactly is
    // handed to the full Prep.js routine at the end instead.
    // =================================================================================
    function mkRGB(r, g, b) { var c = new RGBColor(); c.red = r; c.green = g; c.blue = b; return c; }
    var cPink = mkRGB(255, 0, 255), cGreen = mkRGB(0, 255, 0), cRed = mkRGB(255, 0, 0),
        cBlue = mkRGB(0, 0, 255), cBlack = mkRGB(0, 0, 0);
    function rgbArr(col) {
        if (!col) return null;
        try {
            if (col.typename === "RGBColor") return [Math.round(col.red), Math.round(col.green), Math.round(col.blue)];
            if (col.typename === "SpotColor") return rgbArr(col.spot.color);
            if (col.typename === "GrayColor") { var v = Math.round(255 * (1 - col.gray / 100)); return [v, v, v]; }
            if (col.typename === "CMYKColor" && Math.round(col.cyan) === 0 && Math.round(col.magenta) === 0 &&
                Math.round(col.yellow) === 0 && Math.round(col.black) === 100) return [0, 0, 0];
        } catch (e) {}
        return null;
    }
    function same(c, r, g, b) { return c && c[0] === r && c[1] === g && c[2] === b; }
    // Same reading as step 1: "paper" | "blackfill" | "red" | "blue" | "black" | "none" | "other"
    function styleOf(path) {
        var filled = false, stroked = false, fc = null, sc = null;
        try { filled = path.filled; if (filled) fc = path.fillColor; } catch (e) {}
        try { stroked = path.stroked; if (stroked) sc = path.strokeColor; } catch (e) {}
        if (fc && fc.typename === "NoColor") filled = false;
        if (sc && sc.typename === "NoColor") stroked = false;
        if (filled) return same(rgbArr(fc), 0, 0, 0) ? "blackfill" : "paper";
        if (stroked) {
            var c = rgbArr(sc);
            if (same(c, 255, 0, 0)) return "red";
            if (same(c, 0, 0, 255)) return "blue";
            if (same(c, 0, 0, 0)) return "black";
            if (same(c, 255, 0, 255) || same(c, 0, 255, 0)) return "paper";   // already-prepped cut line: recoloured by depth again
            return "other";
        }
        return "none";
    }
    function strokeOnly(p, col) {
        try { p.filled = false; } catch (e) {}
        try { p.stroked = true; } catch (e) {}
        try { p.strokeColor = col; } catch (e) {}
        try { p.strokeWidth = 1; } catch (e) {}
    }
    function engrave(p) {                                   // #000 fill = engraving: exact RGB black, no outline
        try { p.stroked = false; } catch (e) {}
        try { p.filled = true; p.fillColor = cBlack; } catch (e) {}
    }
    // Plain if/else on purpose: ExtendScript reads chained "a ? b : c ? d : e"
    // the wrong way round (that turned every red score line blue).
    function lineColour(st) {
        if (st === "red") return cRed;
        if (st === "blue") return cBlue;
        return cBlack;
    }
    // Read an object once: list what to do with each path (ops) and return how
    // many paper outlines step 1 would have counted (-1 = can't tell).
    function plan(item, ops, inner) {
        var tn = item.typename, n = 0, k, c, sty, top = !inner;   // top = the part itself, not something inside it
        if (tn === "PathItem") {
            try { if (item.guides || item.clipping) return 0; } catch (e) {}
            sty = styleOf(item); ops.push({ o: item, t: "path", s: sty, top: top });
            return sty === "paper" ? 1 : 0;
        }
        if (tn === "CompoundPathItem") {
            var np = item.pathItems.length;
            if (!np) return -1;
            sty = styleOf(item.pathItems[0]); ops.push({ o: item, t: "cp", s: sty, n: np, top: top });
            return sty === "paper" ? np : 0;
        }
        if (tn === "GroupItem") {
            if (item.clipped) return -1;
            var kids = item.pageItems, nk = kids.length, list = [];
            for (k = 0; k < nk; k++) list.push(kids[k]);
            for (k = 0; k < nk; k++) { c = plan(list[k], ops, true); if (c < 0) return -1; n += c; }
            return n;
        }
        if (tn === "TextFrame") { ops.push({ o: item, t: "text", top: top }); return 0; }
        return -1;
    }
    function paintBlack(item) {           // outlined text = marking: black fill, no outline
        var tn = item.typename, k;
        if (tn === "PathItem") { try { item.filled = true; item.fillColor = cBlack; item.stroked = false; } catch (e) {} }
        else if (tn === "CompoundPathItem") { for (k = 0; k < item.pathItems.length; k++) paintBlack(item.pathItems[k]); }
        else if (tn === "GroupItem") { for (k = 0; k < item.pageItems.length; k++) paintBlack(item.pageItems[k]); }
    }
    function splitCompound(cp, cols, st) {
        var subs = [], k;
        for (k = 0; k < cp.pathItems.length; k++) subs.push(cp.pathItems[k]);
        var holder = null;
        if (subs.length > 1) { holder = cp.parent.groupItems.add(); holder.move(cp, ElementPlacement.PLACEBEFORE); }
        var last = null;
        for (k = 0; k < subs.length; k++) {
            var d = holder ? subs[k].duplicate(holder, ElementPlacement.PLACEATEND)
                           : subs[k].duplicate(cp, ElementPlacement.PLACEBEFORE);
            strokeOnly(d, cols[st.i++] === "pink" ? cPink : cGreen);
            last = d;
        }
        cp.remove();
        return holder || last;
    }
    // Apply the planned ops; returns what now stands in place of the top object
    function run(ops, cols, top) {
        var st = { i: 0 }, k, j, op, res2 = top;
        for (k = 0; k < ops.length; k++) {
            op = ops[k];
            if (op.t === "path") {
                if (op.s === "paper") strokeOnly(op.o, cols[st.i++] === "pink" ? cPink : cGreen);
                else if (op.s === "blackfill") engrave(op.o);
                else if (op.s === "red" || op.s === "blue" || op.s === "black") strokeOnly(op.o, lineColour(op.s));
            } else if (op.t === "cp") {
                if (op.s === "paper") { var r = splitCompound(op.o, cols, st); if (op.top) res2 = r; }
                else for (j = 0; j < op.n; j++) {
                    var sp = op.o.pathItems[j];
                    if (op.s === "blackfill") engrave(sp);
                    else if (op.s === "red" || op.s === "blue" || op.s === "black") strokeOnly(sp, lineColour(op.s));
                }
            } else if (op.t === "text") {
                try { var g = op.o.createOutline(); paintBlack(g); if (op.top) res2 = g; } catch (e) {}
            }
        }
        return res2;
    }

    // =================================================================================
    // Cleanup (Refined Laser Janitor V2.3). nest.js already worked out what to
    // do; here it's applied by path number: merge stacked points, remove
    // specks, move duplicates (yellow) and draw overlap markers. Duplicates and
    // markers ride along with their part, then go to the "duplicates" layer.
    // =================================================================================
    var yellow = mkRGB(255, 255, 0), cleanSkipped = 0, markerN = 0, dupDest = null;
    function listPaths(item, out) {
        var tn = item.typename, k;
        if (tn === "PathItem") { try { if (item.guides || item.clipping) return; } catch (e) {} out.push(item); }
        else if (tn === "CompoundPathItem") { var sp = item.pathItems, ns = sp.length; for (k = 0; k < ns; k++) out.push(sp[k]); }
        else if (tn === "GroupItem" && !item.clipped) {
            var kids = item.pageItems, nk = kids.length, list = [];
            for (k = 0; k < nk; k++) list.push(kids[k]);
            for (k = 0; k < nk; k++) listPaths(list[k], out);
        }
    }
    function paintDuplicate(p) {
        p.stroked = true; p.strokeColor = yellow;
        if (p.strokeWidth < 1) p.strokeWidth = 1;          // hairlines would stay invisible
    }
    function moveDuplicate(item, holder) {
        var inCompound = false;
        try { inCompound = item.parent.typename === "CompoundPathItem"; } catch (e) {}
        if (!inCompound) { try { paintDuplicate(item); } catch (e) {} }
        try { item.move(holder, ElementPlacement.PLACEATBEGINNING); } catch (e) { return false; }
        try { paintDuplicate(holder.pageItems[0]); } catch (e) {}   // fresh reference
        return true;
    }
    function drawOverlapMarker(holder, pts) {
        var g = holder.groupItems.add();
        g.name = "Overlap " + (++markerN);
        var copy = g.pathItems.add();
        copy.setEntirePath(pts); copy.closed = false; copy.filled = false; copy.stroked = true;
        copy.strokeColor = yellow; copy.strokeWidth = 1.5;
        try { copy.strokeCap = StrokeCap.ROUNDENDCAP; } catch (e) {}
        copy.name = "Overlapping stretch";
        var minX = pts[0][0], maxX = pts[0][0], minY = pts[0][1], maxY = pts[0][1];
        for (var k = 1; k < pts.length; k++) {
            if (pts[k][0] < minX) minX = pts[k][0]; if (pts[k][0] > maxX) maxX = pts[k][0];
            if (pts[k][1] < minY) minY = pts[k][1]; if (pts[k][1] > maxY) maxY = pts[k][1];
        }
        var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, w = maxX - minX, h = maxY - minY;
        var r = Math.sqrt(w * w + h * h) / 2 + 2 * PT;
        if (r < 3 * PT) r = 3 * PT;
        var circle = g.pathItems.ellipse(cy + r, cx - r, 2 * r, 2 * r);
        circle.filled = false; circle.stroked = true; circle.strokeColor = yellow; circle.strokeWidth = 1;
        try { circle.strokeDashes = [4, 3]; } catch (e) {}
        circle.name = "Overlap marker";
    }
    // Returns the object (or null if the whole object was a speck)
    function cleanItem(obj, rec, getHolder) {
        var paths = [], k, j;
        listPaths(obj, paths);
        if (paths.length !== rec.n) { cleanSkipped++; return obj; }
        for (k = 0; k < rec.merges.length; k++) {
            var m = rec.merges[k], pts = paths[m[0]].pathPoints;
            for (j = 0; j < m[1].length; j++) { var at = m[1][j]; pts[at - 1].rightDirection = pts[at].rightDirection; pts[at].remove(); }
            if (m[2]) { var last = pts[pts.length - 1]; pts[0].leftDirection = last.leftDirection; last.remove(); }
        }
        var gone = false;
        for (k = 0; k < rec.specks.length; k++) {
            var sp = paths[rec.specks[k]];
            if (paths.length === 1 && obj.typename === "PathItem") gone = true;
            try { sp.remove(); } catch (e) {}
        }
        if (gone) return null;
        var selfDup = false;
        for (k = 0; k < rec.dups.length; k++) {
            if (paths.length === 1 && obj.typename === "PathItem") selfDup = true;   // the object itself is the duplicate
            moveDuplicate(paths[rec.dups[k]], getHolder());
        }
        return selfDup ? null : obj;
    }

    // Live text inside a part never goes onto the sheets. New document: the copy
    // just loses it. Current document: it stays in your design where it was.
    function dropText(obj, homeLayer) {
        if (obj.typename !== "GroupItem") return;
        var kids = obj.pageItems, nk = kids.length, list = [], k;
        for (k = 0; k < nk; k++) list.push(kids[k]);
        for (k = 0; k < list.length; k++) {
            var it = list[k];
            if (it.typename === "TextFrame") {
                if (NEW) { try { it.remove(); } catch (e) {} }
                else { try { it.move(homeLayer, ElementPlacement.PLACEATBEGINNING); } catch (e) {} }
            } else if (it.typename === "GroupItem") dropText(it, homeLayer);
        }
    }

    var perSheet = [], fallback = [], fastN = 0, msCopy = 0, msColour = 0, msMove = 0, msClean = 0, t1;
    for (i = 0; i < res.sheets.length; i++) {
        var sheet = res.sheets[i], rc = wRects[i], cnt = 0;
        for (var p = 0; p < sheet.placed.length; p++) {
            var pl = sheet.placed[p], objs = [], later = [], holder = null;
            var getHolder = function () { if (!holder) holder = work.groupItems.add(); return holder; };
            for (var q = 0; q < pl.items.length; q++) {
                var src0 = byId[pl.items[q]];
                if (!src0) { missing++; continue; }
                t1 = new Date().getTime();
                var homeLayer = null;
                try { homeLayer = src0.layer; } catch (e) {}
                var obj = bring([src0])[0];
                dropText(obj, homeLayer);
                msCopy += new Date().getTime() - t1; t1 = new Date().getTime();
                if (CLEANUP && pl.clean && pl.clean[pl.items[q]]) {
                    try { obj = cleanItem(obj, pl.clean[pl.items[q]], getHolder); } catch (e) { cleanSkipped++; }
                    if (!obj) continue;
                }
                msClean += new Date().getTime() - t1; t1 = new Date().getTime();
                var cols = pl.colours ? pl.colours[pl.items[q]] : null;
                if (RECOLOUR) {
                    var ok = false, ops = [];
                    if (cols && plan(obj, ops) === cols.length) {
                        try { obj = run(ops, cols, obj); ok = true; fastN++; } catch (e) {}
                    }
                    if (!ok) later.push(obj);
                }
                msColour += new Date().getTime() - t1;
                objs.push(obj);
            }
            if (CLEANUP && pl.overlaps) for (var ov = 0; ov < pl.overlaps.length; ov++) { try { drawOverlapMarker(getHolder(), pl.overlaps[ov]); } catch (e) {} }
            if (!objs.length) { if (holder) { try { holder.remove(); } catch (e) {} } continue; }
            t1 = new Date().getTime();
            var piece = moveRigid(objs, pl.angle, rc[0] + pl.minX, rc[3] + pl.minY, work, holder);
            if (holder) {
                // duplicates + markers off the part, onto the duplicates layer
                // (in New document mode: into one group that travels across)
                if (!dupDest) {
                    if (NEW) { dupDest = work.groupItems.add(); dupDest.note = "NEST_DUPS"; }
                    else dupDest = openLayer(tgt, CFG.DUP_LAYER);
                }
                var hk = holder.pageItems, nh = hk.length, hl = [], h2;
                for (h2 = 0; h2 < nh; h2++) hl.push(hk[h2]);
                for (h2 = 0; h2 < hl.length; h2++) hl[h2].move(dupDest, ElementPlacement.PLACEATEND);
                holder.remove();
                if (objs.length === 1 && piece.typename === "GroupItem" && piece.pageItems.length === 1) {
                    var only = piece.pageItems[0]; only.move(work, ElementPlacement.PLACEATEND); piece.remove(); piece = only;
                }
            }
            msMove += new Date().getTime() - t1;
            if (later.length) {                               // whole piece goes through Prep later
                if (NEW) piece.note = "NEST_FB"; else fallback.push(piece);
            }
            cnt++;
        }
        perSheet.push(cnt);
    }

    if (NEW) lap("copy parts", msCopy);
    if (CLEANUP) lap("cleanup", msClean);
    if (RECOLOUR) lap("recolour", msColour);
    lap("move", msMove);
    tLap = new Date().getTime();

    // ---- parts that fit no sheet ---------------------------------------------------
    var unfN = 0;
    if (res.unfitted && res.unfitted.length) {
        var unf = NEW ? work : openLayer(tgt, CFG.UNFITTED_LAYER);
        var parkX = sOL + gridW + gap, stackY = sOT;
        for (i = 0; i < res.unfitted.length; i++) {
            var us = itemsFor(res.unfitted[i].items);
            if (!us.length) continue;
            us = bring(us);
            var o = moveRigid(us, 0, 0, 0, unf), ob = o.geometricBounds;
            if (NEW) o.note = "NEST_UNF";
            o.translate(parkX - ob[0], stackY - ob[1]);
            stackY -= (ob[1] - ob[3]) + 2 * PT;
            unfN++;
        }
    }

    // ---- New document: send everything across in ONE copy -----------------------------
    if (NEW) {
        tLap = new Date().getTime();
        var wItems = work.pageItems, nW = wItems.length, wl = [], k3;
        for (k3 = 0; k3 < nW; k3++) wl.push(wItems[k3]);
        var wFlag = [];                                    // remember the tags by position too
        for (k3 = 0; k3 < wl.length; k3++) { var wn = ""; try { wn = wl[k3].note; } catch (e) {} wFlag.push(wn || ""); }
        if (wl.length) {
            var big = work.groupItems.add();
            for (k3 = 0; k3 < wl.length; k3++) wl[k3].move(big, ElementPlacement.PLACEATEND);
            var b0 = big.geometricBounds;
            app.activeDocument = tgt;
            var bigT = big.duplicate(arr, ElementPlacement.PLACEATEND);
            var bT = bigT.geometricBounds;
            bigT.translate(b0[0] + (originL - sOL) - bT[0], b0[1] + (originT - sOT) - bT[1]);
            // unpack: parts to "Arranged", oversized ones to "UNFITTED"
            var kidsT = bigT.pageItems, nK = kidsT.length, kl = [], unfT = null;
            for (k3 = 0; k3 < nK; k3++) kl.push(kidsT[k3]);
            for (k3 = 0; k3 < kl.length; k3++) {
                var kid = kl[k3], kn = (kl.length === wFlag.length) ? wFlag[k3] : kid.note;
                if (kn === "NEST_UNF") { if (!unfT) unfT = openLayer(tgt, CFG.UNFITTED_LAYER); kid.move(unfT, ElementPlacement.PLACEATEND); }
                else if (kn === "NEST_DUPS") {
                    var dl = openLayer(tgt, CFG.DUP_LAYER), dk = kid.pageItems, nd = dk.length, dlist = [], d3;
                    for (d3 = 0; d3 < nd; d3++) dlist.push(dk[d3]);
                    for (d3 = 0; d3 < dlist.length; d3++) dlist[d3].move(dl, ElementPlacement.PLACEATEND);
                    kid.remove(); continue;
                }
                else { kid.move(arr, ElementPlacement.PLACEATEND); if (kn === "NEST_FB") fallback.push(kid); }
                try { if (kid.note) kid.note = ""; } catch (e) {}
            }
            bigT.remove();
        }
        app.activeDocument = src;
        try { work.remove(); } catch (e) {}
        app.activeDocument = tgt;
        lap("send to new doc");
    }

    // ---- labels ------------------------------------------------------------------------
    var labels = openLayer(tgt, CFG.LABELS_LAYER);
    try { labels.zOrder(ZOrderMethod.BRINGTOFRONT); } catch (e) {}
    var font = null;
    for (var fi = 0; fi < CFG.LABEL_FONTS.length && !font; fi++) try { font = app.textFonts.getByName(CFG.LABEL_FONTS[fi]); } catch (e) {}
    var black = new RGBColor(); black.red = 0; black.green = 0; black.blue = 0;
    var inset = (res.labelInsetMM || 10) * PT;
    for (i = 0; i < res.sheets.length; i++) {
        var tf = labels.textFrames.add();
        tf.contents = res.sheets[i].label;
        var ca = tf.textRange.characterAttributes;
        if (font) ca.textFont = font;
        ca.size = res.labelPt || 35;
        ca.fillColor = black;
        try { ca.strokeColor = new NoColor(); } catch (e) {}
        var gb = tf.geometricBounds;
        tf.translate(rects[i][0] + inset - gb[0], rects[i][1] - inset - gb[1]);
    }

    lap("labels");

    // ---- clear the tags in the source document -------------------------------------
    for (var key in byId) if (byId.hasOwnProperty(key)) { try { byId[key].note = ""; } catch (e) {} }

    // ---- fallback recolour (full Prep.js rules) ----------------------------------------------
    // (only for objects the fast recolour couldn't match up)
    var prepMsg = "";
    if (RECOLOUR && fallback.length) {
        app.activeDocument = tgt;
        try { prepMsg = smartLaserRecolour(tgt, fallback); }
        catch (e) { prepMsg = "Recolouring stopped with an error (" + e.message + "). Run Prep.js on the sheets by hand."; }
        prepMsg = fallback.length + " object(s) didn't match the engine's colour list, so the full Prep routine recoloured them." + (prepMsg ? "\n" + prepMsg : "");
    }
    if (fallback.length) lap("Prep fallback");
    app.activeDocument = tgt;
    try { tgt.artboards.setActiveArtboardIndex(S.output === "new" ? 0 : tgt.artboards.length - res.sheets.length); } catch (e) {}
    app.redraw();

    // ---- report ----------------------------------------------------------------------------
    var msg = "Done for " + S.machine + (res.seconds ? " (engine took " + Math.round(res.seconds * 10) / 10 + " s)" : "") + ":\n";
    var totalPlaced = 0;
    for (i = 0; i < res.sheets.length; i++) { msg += "\n  " + res.sheets[i].label + " \u2014 " + perSheet[i] + " part(s)"; totalPlaced += perSheet[i]; }
    if (!res.sheets.length) msg += "\n  (no sheets: nothing could be nested)";
    if (res.inHoles) msg += "\n\n" + res.inHoles + " part(s) tucked inside holes.";
    if (res.textSkipped) msg += "\n\n" + res.textSkipped + " live text box(es) were not carried over" +
        (S.output === "new" ? "" : " (they stay where they were)") + ". Outline text first if it should be engraved.";
    if (res.autoRotation) {
        var ar = res.autoRotation, tr = [];
        for (i = 0; i < ar.tried.length; i++) tr.push(ar.tried[i].step + "\u00B0: " + ar.tried[i].sheets + " sheet(s)" +
            (ar.tried[i].unfitted ? ", " + ar.tried[i].unfitted + " unfitted" : ""));
        msg += "\n\nRotation: Auto kept " + ar.picked + "\u00B0 steps (" + tr.join(" \u00B7 ") + ").";
    }
    var notes = [];
    if (res.flags) for (i = 0; i < res.flags.length; i++) {
        var fl = res.flags[i];
        notes.push("\u2022 " + fl.reason + (fl.count > 1 ? "  (" + fl.count + "\u00D7)" : ""));
    }
    if (res.libWarnings) for (i = 0; i < res.libWarnings.length; i++) notes.push("\u2022 " + res.libWarnings[i]);
    if (res.timedOut) notes.push("\u2022 The engine hit its time limit; some parts weren't placed. Select what's left and run steps 1\u20133 again.");
    if (missing) notes.push("\u2022 " + missing + " object(s) from the result weren't found (was the document changed after step 1?).");
    if (notes.length) msg += "\n\nPlease check:\n" + notes.join("\n");
    if (CLEANUP && res.cleanTotals) {
        var ct = res.cleanTotals;
        msg += "\n\nCleanup: " + ct.specks + " speck(s) removed, " + (ct.tinyKept || 0) + " tiny non-cut item(s) kept, " + ct.points + " stacked point(s) merged, " +
               ct.dups + " duplicate(s) and " + ct.overlaps + " overlap(s) put on the \"" + CFG.DUP_LAYER + "\" layer.";
        if (cleanSkipped) msg += "\n" + cleanSkipped + " object(s) couldn't be matched up and were left uncleaned.";
    }
    if (prepMsg) msg += "\n\nRecolouring:\n" + prepMsg;
    msg += "\n\nThe paper names are on the \"" + CFG.LABELS_LAYER + "\" layer. Delete them before cutting.";
    msg += "\n\nTiming: " + laps.join(" \u00B7 ");
    alert(msg);

    // ===================================================================================
    // Prep.js V2.1 (Smart Laser Recolour), unchanged rules, run on the placed parts
    // ===================================================================================
    function smartLaserRecolour(doc, items) {

        // --- Settings ---
        var IGNORE_LAYERS   = ["duplicates", "skipped"];
        var SKIP_LAYER_NAME = "skipped";
        var PT_PER_MM  = 2.834645669;
        var EDGE_TOL   = 0.05 * PT_PER_MM;  // points this close to an outline count as "on" it
        var CURVE_STEP = 0.25 * PT_PER_MM;  // how finely curves are measured


        // Trigger colours
        var cPink  = mkRGB(255, 0,   255);
        var cGreen = mkRGB(0,   255, 0);
        var cRed   = mkRGB(255, 0,   0);
        var cBlue  = mkRGB(0,   0,   255);
        var cBlack = mkRGB(0,   0,   0);

        function mkRGB(r, g, b) {
            var c = new RGBColor(); c.red = r; c.green = g; c.blue = b; return c;
        }

        var laserInfos    = []; // geometry of every path in the job (for inside/outside tests)
        var cutCandidates = []; // loose simple cut paths, coloured at the end: {item, info}
        var skipped       = []; // {item, reason}

        // --- Run ---
        for (var i = items.length - 1; i >= 0; i--) {
            try { processItem(items[i]); }
            catch (e) { skipItem(items[i], "Unexpected error while processing"); }
        }
        doc.selection = null;

        colourCutCandidates();
        return moveSkippedAndReport();

        // =========================================================================

        function processItem(item) {
            if (isIgnored(item)) return;
            var t = item.typename;

            if (t === "TextFrame") {
                var outlined;
                try { outlined = item.createOutline(); }
                catch (e) { skipItem(item, "Text that couldn't be converted to outlines"); return; }
                processItem(outlined);
                return;
            }
            if (t === "GroupItem") {
                // Snapshot children first: splitting inserts new sub-groups into
                // this parent, which would shift a live index-based loop.
                var kids = [];
                for (var g = 0; g < item.pageItems.length; g++) kids.push(item.pageItems[g]);
                for (var k = kids.length - 1; k >= 0; k--) {
                    try { processItem(kids[k]); }
                    catch (e) { skipItem(kids[k], "Unexpected error while processing"); }
                }
                return;
            }
            if (t === "PathItem") {
                try { if (item.guides) return; } catch (e) { }
                routeSimplePath(item);
                return;
            }
            if (t === "CompoundPathItem") {
                routeCompound(item);
                return;
            }
            skipItem(item, describeType(t));
        }

        function isIgnored(item) {
            try {
                var name = item.layer.name;
                for (var i = 0; i < IGNORE_LAYERS.length; i++) {
                    if (name === IGNORE_LAYERS[i]) return true;
                }
            } catch (e) { }
            return false;
        }

        function describeType(t) {
            if (t === "PlacedItem")     return "Linked image or file (not laser vector)";
            if (t === "RasterItem")     return "Embedded image (not laser vector)";
            if (t === "SymbolItem")     return "Symbol (expand it first)";
            if (t === "PluginItem")     return "Blend, envelope or other effect object (expand it first)";
            if (t === "MeshItem")       return "Gradient mesh";
            if (t === "GraphItem")      return "Graph";
            if (t === "LegacyTextItem") return "Legacy text";
            if (t === "NonNativeItem")  return "Non-native artwork";
            return "Unsupported object (" + t + ")";
        }

        function skipItem(item, reason) {
            skipped.push({ item: item, reason: reason });
        }

        // --- SIMPLE PATH ---------------------------------------------------------

        function routeSimplePath(item) {
            // Black fill = engraving: remove any outline, otherwise leave alone
            if (hasBlackFill(item)) {
                stripOutline(item);
                addInfo(item);
                return;
            }

            var stroke = safeStroke(item);
            if (stroke) {
                if (isBlack(stroke))              { applyTo(item, cBlack); addInfo(item); return; }
                if (isExactRGB(stroke, 255, 0, 0)) { applyTo(item, cRed);   addInfo(item); return; }
                if (isExactRGB(stroke, 0, 0, 255)) { applyTo(item, cBlue);  addInfo(item); return; }
            }

            // Cut line - pink or green is decided at the end, once every
            // shape is known (see colourCutCandidates)
            cutCandidates.push({ item: item, info: addInfo(item) });
        }

        // --- COMPOUND PATH -------------------------------------------------------

        function routeCompound(item) {
            var first = readFirstPath(item);

            // Shape Builder compound - normalize to make sub-paths readable
            if (!first) {
                item = normalizeCompound(item);
                if (!item) return;
                first = readFirstPath(item);
            }

            if (first) {
                if (hasBlackFill(first)) {
                    stripOutline(item);
                    addSubpathInfos(item);
                    return;
                }
                var stroke = safeStroke(first);
                if (stroke) {
                    if (isBlack(stroke))              { styleItem(item, cBlack); addSubpathInfos(item); return; }
                    if (isExactRGB(stroke, 255, 0, 0)) { styleItem(item, cRed);   addSubpathInfos(item); return; }
                    if (isExactRGB(stroke, 0, 0, 255)) { styleItem(item, cBlue);  addSubpathInfos(item); return; }
                }
            }

            // Anything else -> release, then outer pieces pink, inner pieces green
            splitAndGroup(item);
        }

        function readFirstPath(item) {
            try { if (item.pathItems.length > 0) return item.pathItems[0]; } catch (e) { }
            return null;
        }

        function safeStroke(p) {
            try {
                if (!p.stroked) return null;
                var c = p.strokeColor;
                if (!c || c.typename === "NoColor") return null;
                return c;
            } catch (e) { return null; }
        }

        function hasBlackFill(p) {
            try { return p.filled && isBlack(p.fillColor); } catch (e) { return false; }
        }

        // --- NORMALIZE (release -> re-compound) ----------------------------------
        // Only used to make a Shape Builder compound's sub-paths readable.

        function normalizeCompound(item) {
            doc.selection = null;
            item.selected = true;

            try { app.executeMenuCommand("noCompoundPath"); }
            catch (e) { doc.selection = null; return item; }

            try { app.executeMenuCommand("compoundPath"); }
            catch (e) {
                // Re-compound failed - treat the released paths as loose paths
                var rel = [];
                for (var i = 0; i < doc.selection.length; i++) rel.push(doc.selection[i]);
                doc.selection = null;
                for (var r = 0; r < rel.length; r++) {
                    try {
                        if (rel[r].typename === "PathItem") routeSimplePath(rel[r]);
                    } catch (e2) { skipItem(rel[r], "Unexpected error while processing"); }
                }
                return null;
            }

            var result = (doc.selection.length > 0) ? doc.selection[0] : null;
            doc.selection = null;
            return result;
        }

        // --- SPLIT & GROUP -------------------------------------------------------

        function splitAndGroup(item) {
            var parent = null;
            try { parent = item.parent; } catch (e) { }

            doc.selection = null;
            item.selected = true;

            try { app.executeMenuCommand("noCompoundPath"); }
            catch (e) {
                doc.selection = null;
                skipItem(item, "Compound path that couldn't be released");
                return;
            }

            var released = [];
            for (var i = 0; i < doc.selection.length; i++) {
                if (doc.selection[i].typename === "PathItem") released.push(doc.selection[i]);
            }
            doc.selection = null;

            if (released.length === 0) {
                skipItem(item, "Compound path that couldn't be released");
                return;
            }

            // Pink or green is decided at the end, together with every other
            // cut line in the selection (see colourCutCandidates)
            for (var m = 0; m < released.length; m++) {
                cutCandidates.push({ item: released[m], info: buildInfo(released[m]) });
            }

            // Wrap multiple pieces in a new group inside the original parent
            if (released.length > 1 && parent) {
                var group = null;
                try { group = parent.groupItems.add(); } catch (e) { }
                if (group) {
                    for (var k = 0; k < released.length; k++) {
                        try { released[k].move(group, ElementPlacement.PLACEATEND); } catch (e) { }
                    }
                }
            }
        }

        // --- LOOSE CUT PATHS: PINK OR GREEN --------------------------------------

        // Depth rule (same as Audit.js): pink = even depth AND has a cut line inside
        function colourCutCandidates() {
            for (var c = 0; c < cutCandidates.length; c++) {
                var cand = cutCandidates[c];
                var pink = false;

                if (cand.info) {
                    var depth = 0, hasInside = false;
                    for (var j = 0; j < cutCandidates.length; j++) {
                        if (j === c) continue;
                        var other = cutCandidates[j].info;
                        if (!other) continue;
                        if (isInside(cand.info, other)) depth++;
                        else if (!hasInside && isInside(other, cand.info)) hasInside = true;
                    }
                    pink = (depth % 2 === 0) && hasInside;
                }

                try { applyTo(cand.item, pink ? cPink : cGreen); } catch (e) { }
            }
        }

        // --- SKIPPED LAYER + REPORT ----------------------------------------------

        function moveSkippedAndReport() {
            if (skipped.length === 0) return ""; // Nothing skipped

            var layer;
            try {
                layer = doc.layers.getByName(SKIP_LAYER_NAME);
            } catch (e) {
                layer = doc.layers.add();
                layer.name = SKIP_LAYER_NAME;
            }
            layer.locked = false;
            layer.visible = true;

            var counts = {}, order = [], notMoved = 0;
            for (var i = 0; i < skipped.length; i++) {
                var sk = skipped[i];
                try { sk.item.move(layer, ElementPlacement.PLACEATBEGINNING); }
                catch (e) { notMoved++; }
                if (!counts[sk.reason]) { counts[sk.reason] = 0; order.push(sk.reason); }
                counts[sk.reason]++;
            }

            var msg = "Some items were skipped and moved to the '" + SKIP_LAYER_NAME + "' layer:\n";
            for (var r = 0; r < order.length; r++) {
                msg += "\n- " + counts[order[r]] + " x " + order[r];
            }
            if (notMoved > 0) {
                msg += "\n\n" + notMoved + " of them couldn't be moved (probably locked) and are still in place.";
            }
            return msg;
        }

        // --- STYLE ---------------------------------------------------------------

        function styleItem(item, color) {
            applyTo(item, color);
            if (item.typename === "CompoundPathItem") {
                try {
                    for (var i = 0; i < item.pathItems.length; i++) {
                        try { applyTo(item.pathItems[i], color); } catch (e) { }
                    }
                } catch (e) { }
            }
        }

        function applyTo(p, color) {
            try { p.filled = false; } catch (e) { }
            try { p.stroked = true; } catch (e) { }
            try { p.strokeColor = color; } catch (e) { }
            try { p.strokeWidth = 1; } catch (e) { }
        }

        // Removes the outline from a black-filled engraving shape, keeps the fill
        function stripOutline(item) {
            if (item.typename === "CompoundPathItem") {
                try {
                    for (var i = 0; i < item.pathItems.length; i++) {
                        try { item.pathItems[i].stroked = false; } catch (e) { }
                        try { item.pathItems[i].fillColor = cBlack; } catch (e) { }   // exact RGB #000
                    }
                } catch (e) { }
            } else {
                try { item.stroked = false; } catch (e) { }
                try { item.fillColor = cBlack; } catch (e) { }
            }
        }

        // --- COLOUR DETECTION (strict) -------------------------------------------
        // Values are rounded to whole numbers, i.e. exactly what the hex code shows.

        function isBlack(c) {
            if (!c) return false;
            if (c.typename === "SpotColor") {
                try { return isBlack(c.spot.color); } catch (e) { return false; }
            }
            if (c.typename === "RGBColor") {
                return Math.round(c.red) === 0 && Math.round(c.green) === 0 && Math.round(c.blue) === 0;
            }
            if (c.typename === "GrayColor") return Math.round(c.gray) === 100; // 100% gray = #000
            if (c.typename === "CMYKColor") return Math.round(c.cyan) === 0 && Math.round(c.magenta) === 0 &&
                                                   Math.round(c.yellow) === 0 && Math.round(c.black) === 100;
            return false;
        }

        function isExactRGB(c, r, g, b) {
            if (!c) return false;
            if (c.typename === "SpotColor") {
                try { return isExactRGB(c.spot.color, r, g, b); } catch (e) { return false; }
            }
            return c.typename === "RGBColor" &&
                   Math.round(c.red) === r && Math.round(c.green) === g && Math.round(c.blue) === b;
        }

        // --- GEOMETRY: what's inside what ----------------------------------------

        function addInfo(path) {
            var inf = buildInfo(path);
            if (inf) laserInfos.push(inf);
            return inf;
        }

        function addSubpathInfos(compound) {
            try {
                for (var i = 0; i < compound.pathItems.length; i++) addInfo(compound.pathItems[i]);
            } catch (e) { }
        }

        function dist(a, b) {
            var dx = a[0] - b[0], dy = a[1] - b[1];
            return Math.sqrt(dx * dx + dy * dy);
        }

        // Turns one curve segment into a chain of short straight pieces
        function flattenSegment(p0, p1, p2, p3, out) {
            if (dist(p0, p1) < 0.001 && dist(p2, p3) < 0.001) { out.push(p3[0], p3[1]); return; }
            var est = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
            var steps = Math.ceil(est / CURVE_STEP);
            if (steps < 4) steps = 4;
            if (steps > 200) steps = 200;
            for (var i = 1; i <= steps; i++) {
                var t = i / steps, mt = 1 - t;
                var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
                out.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                         a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);
            }
        }

        function buildInfo(path) {
            var pts, n, closed;
            try { pts = path.pathPoints; n = pts.length; closed = path.closed; } catch (e) { return null; }
            if (n < 2) return null;

            var poly = [];
            var a0 = pts[0].anchor;
            poly.push(a0[0], a0[1]);
            var segCount = closed ? n : n - 1;
            for (var s = 0; s < segCount; s++) {
                var P = pts[s], Q = pts[(s + 1) % n];
                flattenSegment(P.anchor, P.rightDirection, Q.leftDirection, Q.anchor, poly);
            }

            var minX = poly[0], maxX = poly[0], minY = poly[1], maxY = poly[1];
            for (var i = 2; i < poly.length; i += 2) {
                var x = poly[i], y = poly[i + 1];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }

            // Enclosed area (shoelace formula); open lines enclose nothing
            var area = 0;
            if (closed) {
                var m = poly.length / 2;
                for (var j = 0; j < m; j++) {
                    var k = (j + 1) % m;
                    area += poly[2 * j] * poly[2 * k + 1] - poly[2 * k] * poly[2 * j + 1];
                }
                area = Math.abs(area / 2);
            }

            return { poly: poly, closed: closed, area: area,
                     minX: minX, maxX: maxX, minY: minY, maxY: maxY };
        }

        function pointInPoly(x, y, poly) {
            var inside = false, n = poly.length / 2;
            for (var i = 0, j = n - 1; i < n; j = i++) {
                var xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
                if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
            }
            return inside;
        }

        function nearEdge(x, y, poly) {
            var n = poly.length / 2, tolSq = EDGE_TOL * EDGE_TOL;
            for (var i = 0; i < n - 1; i++) {
                var x1 = poly[2 * i], y1 = poly[2 * i + 1], x2 = poly[2 * i + 2], y2 = poly[2 * i + 3];
                var dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy, t = 0;
                if (len2 > 0) {
                    t = ((x - x1) * dx + (y - y1) * dy) / len2;
                    if (t < 0) t = 0; else if (t > 1) t = 1;
                }
                var cx = x1 + t * dx - x, cy = y1 + t * dy - y;
                if (cx * cx + cy * cy <= tolSq) return true;
            }
            return false;
        }

        // Is shape a completely inside closed shape b?
        function isInside(a, b) {
            if (!a || !b || a === b || !b.closed) return false;
            if (a.minX < b.minX - EDGE_TOL || a.maxX > b.maxX + EDGE_TOL ||
                a.minY < b.minY - EDGE_TOL || a.maxY > b.maxY + EDGE_TOL) return false;
            if (b.area <= a.area) return false; // The container must be the bigger shape

            var p = a.poly, n = p.length / 2;
            var stride = Math.max(1, Math.floor(n / 200)); // Cap the work on very detailed shapes
            for (var i = 0; i < n; i += stride) {
                var x = p[2 * i], y = p[2 * i + 1];
                if (!pointInPoly(x, y, b.poly) && !nearEdge(x, y, b.poly)) return false;
            }
            return true;
        }
    }
    }
}

// Run via a deferred BridgeTalk message (same reason as in Prep.js): when the
// script is started from an Action, Illustrator still holds a lock that makes
// app.executeMenuCommand() (used to split compound paths) silently fail.
// The message just tells Illustrator to run this same file again a moment
// later, with a flag set, once the Action has let go of that lock.
if ($.global.__NEST_APPLY_NOW) {
    $.global.__NEST_APPLY_NOW = false;
    nestApplyMain();
} else if (typeof BridgeTalk === "undefined") {
    nestApplyMain();
} else {
    var bt = new BridgeTalk();
    bt.target = "illustrator";
    bt.body = '$.global.__NEST_APPLY_NOW = true; $.evalFile(new File("' + new File($.fileName).absoluteURI + '"));';
    bt.onError = function (errObj) { alert("3_ApplyNest failed to run: " + errObj.body); };
    bt.send();
}
