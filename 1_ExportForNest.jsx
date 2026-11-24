/*
================================================================================
 1_ExportForNest.jsx - Step 1 of 3: send parts to the nesting engine
================================================================================
 Shows the settings panel, then reads the parts to nest (the selection, or
 every unlocked visible top-level object outside the Arranged / UNFITTED /
 Labels layers) and writes them to  Desktop/nest_input.json.
 Each object is tagged (item.note = "NEST_n") so 3_ApplyNest.jsx can find it
 again. Nothing is moved by this script.

 What gets sent for every top-level object:
   - its paper fill colour(s): flat RGB or the colour stops of a gradient.
     The engine (nest.js) looks these up in swatches.cclibs.
   - whether it holds scoring / perforation / marking (red, blue, black
     strokes, #000 fills, text)
   - anything else it can't handle (other stroke colours, images, CMYK...)
   - its stacking position (who sits on top of whom)
   - its outlines, with each sub-path of a compound path kept together so
     the engine can find real holes

 Run this BEFORE Prep / Recolour: parts still carry their paper fills.
 3_ApplyNest.jsx does the laser recolouring at the end.
================================================================================
*/
// #target illustrator
function nestExportMain() {
    // any error shows up as an alert instead of the script silently doing nothing
    try { nestExportInner(); }
    catch (err) { alert("1_ExportForNest stopped with an error:\n" + err.message + (err.line ? "\n(line " + err.line + ")" : "")); }
}
function nestExportInner() {
    var PT_PER_MM = 2.834645669291339;
    var CFG = {
        // Add or change machines here: name shown in the panel, sheet width
        // and height in millimetres (horizontal).
        MACHINES: [
            { name: "GCC (Mercury III)",        w: 630,  h: 450 },
            { name: "Trotec 300",               w: 700,  h: 430 },
            { name: "D\u00F6mpi (Trotec 400)",  w: 1010, h: 610 }
        ],
        SPACING:        2.0,    // min gap between parts (mm)
        MARGIN:         5.0,    // min distance from sheet edges (mm)
        // Rotation step is now chosen in the panel (90 / 45 / 10 degrees)
        TIME_LIMIT_S:   300,    // engine time limit for the whole job (seconds)
        CURVE_SAMPLES:  10,     // polyline samples per Bezier segment
        SIMPLIFY_TOL:   0.3,    // drop points closer than this (mm)
        SKIP_LAYERS:    ["Arranged", "UNFITTED", "Labels", "skipped", "duplicates"],
        OUT_FILE:       Folder.desktop.fsName + "/nest_input.json",
        PREFS_FILE:     Folder.userData.fsName + "/NestForCuts_settings.txt"
    };
    var SIMP = CFG.SIMPLIFY_TOL * PT_PER_MM;

    if (app.documents.length === 0) { alert("Open a document first."); return; }
    var doc = app.activeDocument;

    // =========================================================================
    // Settings panel (remembers your last choices)
    // =========================================================================
    var prefs = { machine: 0, output: "new", label: "box", overlaps: true, sortPaper: true, recolour: true, cleanup: false, rotStep: 90, normalize: true };
    (function loadPrefs() {
        var f = new File(CFG.PREFS_FILE);
        if (!f.exists) return;
        try {
            f.open("r"); var t = f.read(); f.close();
            var o = eval("(" + t + ")");
            for (var k in o) if (o.hasOwnProperty(k)) prefs[k] = o[k];
        } catch (e) {}
        if (prefs.machine < 0 || prefs.machine >= CFG.MACHINES.length) prefs.machine = 0;
    })();

    var dlg = new Window("dialog", "Nest for Cuts");
    dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"]; dlg.spacing = 12; dlg.margins = 18;
    var big = ScriptUI.newFont("dialog", "BOLD", 15);
    var norm = ScriptUI.newFont("dialog", "REGULAR", 14);
    function panel(title) {
        var p = dlg.add("panel", undefined, title);
        p.orientation = "column"; p.alignChildren = ["left", "top"]; p.margins = [14, 20, 14, 12]; p.spacing = 8;
        try { p.graphics.font = big; } catch (e) {}
        return p;
    }
    function radio(p, text, on) {
        var r = p.add("radiobutton", undefined, text);
        try { r.graphics.font = norm; } catch (e) {}
        r.value = !!on; return r;
    }

    var pM = panel("Machine (sheet size)"), rM = [];
    for (var m = 0; m < CFG.MACHINES.length; m++) {
        var M = CFG.MACHINES[m];
        rM.push(radio(pM, M.name + "  \u2014  " + M.w + " \u00D7 " + M.h + " mm", m === prefs.machine));
    }
    var pO = panel("Put the sheets in");
    var rCur = radio(pO, "Current document", prefs.output === "current");
    var rNew = radio(pO, "New document (your design stays untouched)", prefs.output !== "current");
    var pL = panel("Keep the label corner free as");
    var rBox = radio(pL, "Text box area only", prefs.label !== "strip");
    var rStrip = radio(pL, "Full-width strip", prefs.label === "strip");
    var pR = panel("Rotation (after straightening each part)");
    var ROT_CHOICES = [[90, "90\u00B0 steps (fastest, good for boxy parts)"], [45, "45\u00B0 steps (good for diagonal / fan shapes)"],
                       [10, "10\u00B0 steps (slowest, for organic shapes)"], [0, "Auto (tries all three, keeps the tightest)"]], rR = [];
    var rotRow = pR.add("group"); rotRow.orientation = "column"; rotRow.alignChildren = ["left", "top"]; rotRow.spacing = 6;
    for (var rr0 = 0; rr0 < ROT_CHOICES.length; rr0++) rR.push(radio(rotRow, ROT_CHOICES[rr0][1], ROT_CHOICES[rr0][0] === prefs.rotStep));
    var anyRot = false;
    for (rr0 = 0; rr0 < rR.length; rr0++) if (rR[rr0].value) anyRot = true;
    if (!anyRot) rR[0].value = true;
    var pX = panel("Loose lines");
    var cbOv = pX.add("checkbox", undefined, "Count for overlaps");
    try { cbOv.graphics.font = norm; } catch (e) {}
    cbOv.value = !!prefs.overlaps;
    var hint = pX.add("statictext", undefined,
        "On: loose red / blue / black lines stick to the paper part right under them.\n" +
        "Off: only grouped lines travel with their part; loose ones are flagged.", { multiline: true });
    hint.preferredSize = [430, 44];

    var pS = panel("Steps");
    function check(p, text, on) {
        var c = p.add("checkbox", undefined, text);
        try { c.graphics.font = norm; } catch (e) {}
        c.value = !!on; return c;
    }
    var cbNorm = check(pS, "Normalize compound paths first (rebuilds them; slower on big jobs)", prefs.normalize);
    var cbSort = check(pS, "Sort by paper (check fills against swatches.cclibs)", prefs.sortPaper);
    var cbClean = check(pS, "Clean up (Cleanup.js: specks, stacked points, duplicates)", prefs.cleanup);
    var cbPrep = check(pS, "Recolour for laser (Prep.js: pink / green / red / blue / black)", prefs.recolour);
    var hint2 = pS.add("statictext", undefined,
        "Sort off: everything selected goes on the same sheets, labelled \"paper name here\".\n" +
        "Clean up runs first, Prep after it (Prep ignores the duplicates layer).", { multiline: true });
    hint2.preferredSize = [430, 44];

    var bRow = dlg.add("group"); bRow.alignment = ["right", "top"];
    var bCancel = bRow.add("button", undefined, "Cancel", { name: "cancel" });
    var bOk = bRow.add("button", undefined, "Export", { name: "ok" });
    bOk.preferredSize = [110, 34]; bCancel.preferredSize = [110, 34];
    if (dlg.show() !== 1) return;

    for (m = 0; m < rM.length; m++) if (rM[m].value) prefs.machine = m;
    prefs.output = rCur.value ? "current" : "new";
    prefs.label = rStrip.value ? "strip" : "box";
    prefs.overlaps = cbOv.value;
    for (var rr1 = 0; rr1 < rR.length; rr1++) if (rR[rr1].value) prefs.rotStep = ROT_CHOICES[rr1][0];
    prefs.normalize = cbNorm.value;
    prefs.sortPaper = cbSort.value; prefs.cleanup = cbClean.value; prefs.recolour = cbPrep.value;
    (function savePrefs() {
        try {
            var f = new File(CFG.PREFS_FILE); f.encoding = "UTF-8"; f.open("w");
            f.write('{"machine":' + prefs.machine + ',"output":"' + prefs.output + '","label":"' + prefs.label +
                    '","overlaps":' + (prefs.overlaps ? "true" : "false") +
                    ',"sortPaper":' + (prefs.sortPaper ? "true" : "false") + ',"cleanup":' + (prefs.cleanup ? "true" : "false") +
                    ',"recolour":' + (prefs.recolour ? "true" : "false") +
                    ',"rotStep":' + prefs.rotStep + ',"normalize":' + (prefs.normalize ? "true" : "false") + "}");
            f.close();
        } catch (e) {}
    })();
    var MACH = CFG.MACHINES[prefs.machine];

    // =========================================================================
    // Colours
    // =========================================================================
    function rgbOf(col) {
        if (!col) return null;
        try {
            if (col.typename === "RGBColor") return [Math.round(col.red), Math.round(col.green), Math.round(col.blue)];
            if (col.typename === "SpotColor") return rgbOf(col.spot.color);
            if (col.typename === "GrayColor") { var v = Math.round(255 * (1 - col.gray / 100)); return [v, v, v]; }
            // CMYK only counts as pure black (0/0/0/100), e.g. a global swatch defined in CMYK
            if (col.typename === "CMYKColor" && Math.round(col.cyan) === 0 && Math.round(col.magenta) === 0 &&
                Math.round(col.yellow) === 0 && Math.round(col.black) === 100) return [0, 0, 0];
        } catch (e) {}
        return null;
    }
    function isRGB(c, r, g, b) { return c && c[0] === r && c[1] === g && c[2] === b; }
    function colourName(col) {
        try {
            if (col.typename === "SpotColor") {
                var inner = col.spot.color, nm = "";
                try { nm = col.spot.name; } catch (e) {}
                return "swatch \"" + nm + "\" (" + colourName(inner) + ")";
            }
            if (col.typename === "CMYKColor") return "CMYK " + Math.round(col.cyan) + "/" + Math.round(col.magenta) + "/" +
                                                  Math.round(col.yellow) + "/" + Math.round(col.black);
            if (col.typename === "PatternColor") return "pattern fill";
            if (col.typename === "LabColor") return "Lab colour";
        } catch (e) {}
        var c = rgbOf(col);
        return c ? "RGB " + c.join(",") : "unknown colour";
    }
    // Paper key: "rgb:r,g,b" or "grad:r,g,b;r,g,b;..." (stops left to right)
    function paperKey(col) {
        if (!col) return null;
        if (col.typename === "GradientColor") {
            try {
                var st = col.gradient.gradientStops, arr = [], i;
                for (i = 0; i < st.length; i++) arr.push({ at: st[i].rampPoint, c: rgbOf(st[i].color) });
                arr.sort(function (a, b) { return a.at - b.at; });
                var parts = [];
                for (i = 0; i < arr.length; i++) { if (!arr[i].c) return null; parts.push(arr[i].c.join(",")); }
                return "grad:" + parts.join(";");
            } catch (e) { return null; }
        }
        var c = rgbOf(col);
        return c ? "rgb:" + c.join(",") : null;
    }

    // =========================================================================
    // Geometry sampling
    // =========================================================================
    function isClosed(path) {
        if (path.closed) return true;
        var pts = path.pathPoints, n = pts.length;
        if (n < 3) return false;
        var a = pts[0].anchor, z = pts[n - 1].anchor;
        return Math.abs(a[0] - z[0]) < 0.01 && Math.abs(a[1] - z[1]) < 0.01;
    }
    function decimate(r, tol) {
        if (tol <= 0 || r.length <= 8) return r;
        var t2 = tol * tol, out = [r[0], r[1]], lx = r[0], ly = r[1];
        for (var i = 2; i < r.length; i += 2) {
            var dx = r[i] - lx, dy = r[i + 1] - ly;
            if (dx * dx + dy * dy >= t2) { out.push(r[i], r[i + 1]); lx = r[i]; ly = r[i + 1]; }
        }
        return out.length >= 6 ? out : r;
    }
    // Read a path's points once: [ax, ay, lx, ly, rx, ry, ...] (anchor, left and right handle)
    function rawOf(path) {
        var pts = path.pathPoints, n = pts.length, out = new Array(n * 6), i, p, a, l, r;
        for (i = 0; i < n; i++) {
            p = pts[i]; a = p.anchor; l = p.leftDirection; r = p.rightDirection;
            out[6*i] = a[0]; out[6*i+1] = a[1]; out[6*i+2] = l[0]; out[6*i+3] = l[1]; out[6*i+4] = r[0]; out[6*i+5] = r[1];
        }
        return out;
    }
    function looksClosed(closed, raw) {
        if (closed) return true;
        var n = raw.length / 6;
        if (n < 3) return false;
        return Math.abs(raw[0] - raw[6*n-6]) < 0.01 && Math.abs(raw[1] - raw[6*n-5]) < 0.01;
    }
    function sampleRaw(raw, closed) {
        var n = raw.length / 6;
        if (n === 0) return null;
        var ring = [], segs = closed ? n : n - 1;
        for (var i = 0; i < segs; i++) {
            var P = 6 * i, Q = 6 * ((i + 1) % n);
            var x0 = raw[P], y0 = raw[P+1], x1 = raw[P+4], y1 = raw[P+5], x2 = raw[Q+2], y2 = raw[Q+3], x3 = raw[Q], y3 = raw[Q+1];
            ring.push(x0, y0);
            var straight = Math.abs(x1 - x0) < 1e-6 && Math.abs(y1 - y0) < 1e-6 && Math.abs(x2 - x3) < 1e-6 && Math.abs(y2 - y3) < 1e-6;
            if (!straight) for (var s = 1; s < CFG.CURVE_SAMPLES; s++) {
                var t = s / CFG.CURVE_SAMPLES, u = 1 - t;
                var a = u*u*u, b = 3*u*u*t, c = 3*u*t*t, d = t*t*t;
                ring.push(a*x0 + b*x1 + c*x2 + d*x3, a*y0 + b*y1 + c*y2 + d*y3);
            }
        }
        if (!closed) ring.push(raw[6*n-6], raw[6*n-5]);
        if (ring.length < 4) return null;
        return decimate(ring, SIMP);
    }
    function boundsRing(gb) { return [gb[0], gb[3], gb[2], gb[3], gb[2], gb[1], gb[0], gb[1]]; }

    // =========================================================================
    // Read one top-level object
    //   info.keys   : paper keys found (unique)
    //   info.lines  : has scoring / perforation / marking
    //   info.others : things it can't handle
    //   info.rings  : [{c, z, o, p}]  c = "cut" (paper outline) | "red" |
    //                 "blue" | "black" | "other";  o = object number
    //                 (sub-paths of one compound share it)
    // =========================================================================
    function newInfo() { return { keys: {}, nKeys: 0, lines: false, cut: false, others: [], rings: [], paths: [], obj: 0 }; }
    function addKey(info, k) { if (!info.keys[k]) { info.keys[k] = true; info.nKeys++; } }
    function addOther(info, txt) {
        for (var i = 0; i < info.others.length; i++) if (info.others[i] === txt) return;
        info.others.push(txt);
    }
    // Paper outlines are always sent (even tiny ones), so 3_ApplyNest can
    // match the engine's pink/green list to the paths one by one.
    // One path: remember its points for Cleanup (when that's on) and send its
    // outline for nesting (c = ring type, or null for invisible paths).
    // Paper outlines are always sent (even tiny ones), so 3_ApplyNest can
    // match the engine's pink/green list to the paths one by one.
    var CLEAN = prefs.cleanup;
    function addPath(info, path, st, c, o) {
        var raw = null, closed = false;
        try { raw = rawOf(path); closed = path.closed; } catch (e) {}
        if (CLEAN) info.paths.push({ s: st, z: closed, a: raw || [] });
        if (c === null) return;
        var p = null;
        try { p = raw ? sampleRaw(raw, closed) : null; } catch (e) {}
        var lc = st === "cutline";                          // outline drawn as a stroke, not a fill
        if (p) info.rings.push({ c: c, z: looksClosed(closed, raw), o: o, p: p, l: lc });
        else if (c === "cut") info.rings.push({ c: c, z: false, o: o, p: [], l: lc });
    }
    // Decide what a path's style means. Returns "paper" | "red" | "blue" | "black" | "none" | "other"
    function styleOf(path, info) {
        var filled = false, stroked = false, fc = null, sc = null;
        try { filled = path.filled; if (filled) fc = path.fillColor; } catch (e) {}
        try { stroked = path.stroked; if (stroked) sc = path.strokeColor; } catch (e) {}
        if (fc && fc.typename === "NoColor") filled = false;
        if (sc && sc.typename === "NoColor") stroked = false;
        if (filled) {
            var fr = rgbOf(fc);
            if (isRGB(fr, 0, 0, 0)) return "black";                    // engraving
            var k = paperKey(fc);
            if (k) { addKey(info, k); return "paper"; }
            addOther(info, "fill in " + colourName(fc));
            return "other";
        }
        if (stroked) {
            var s = rgbOf(sc);
            if (isRGB(s, 255, 0, 0)) return "red";
            if (isRGB(s, 0, 0, 255)) return "blue";
            if (isRGB(s, 0, 0, 0))   return "black";
            // already laser-prepped cut line (pink outer / green inner): an outline to nest
            if (isRGB(s, 255, 0, 255) || isRGB(s, 0, 255, 0)) return "cutline";
            addOther(info, "outline-only path in " + colourName(sc));
            return "other";
        }
        return "none";
    }
    function readItem(item, info) {
        var tn = item.typename, i, st, o;
        if (tn === "PathItem") {
            try { if (item.guides || item.clipping) return; } catch (e) {}
            st = styleOf(item, info);
            if (st === "none") { if (CLEAN) addPath(info, item, st, null, 0); return; }
            if (st === "red" || st === "blue" || st === "black") info.lines = true;
            if (st === "cutline") info.cut = true;
            o = info.obj++;
            addPath(info, item, st, (st === "paper" || st === "cutline") ? "cut" : st, o);
        } else if (tn === "CompoundPathItem") {
            if (!item.pathItems.length) { addOther(info, "compound path that can't be read (tick \"Normalize\" in step 1)"); return; }
            st = styleOf(item.pathItems[0], info);                  // all sub-paths share one style
            var subs = item.pathItems, nSub = subs.length;
            if (st === "none") { if (CLEAN) for (i = 0; i < nSub; i++) addPath(info, subs[i], st, null, 0); return; }
            if (st === "red" || st === "blue" || st === "black") info.lines = true;
            if (st === "cutline") info.cut = true;
            o = info.obj++;
            for (i = 0; i < nSub; i++) addPath(info, subs[i], st, (st === "paper" || st === "cutline") ? "cut" : st, o);
        } else if (tn === "GroupItem") {
            if (item.clipped) { addOther(info, "clipping mask"); info.rings.push({ c: "other", z: true, o: info.obj++, p: boundsRing(item.geometricBounds) }); return; }
            for (i = 0; i < item.pageItems.length; i++) readItem(item.pageItems[i], info);
        } else if (tn === "TextFrame") {
            info.lines = true;                                       // text = marking
            info.rings.push({ c: "black", z: true, o: info.obj++, p: boundsRing(item.geometricBounds) });
        } else {
            var names = { PlacedItem: "linked image", RasterItem: "embedded image", SymbolItem: "symbol (expand it)",
                          PluginItem: "blend / effect object (expand it)", MeshItem: "gradient mesh", GraphItem: "graph" };
            addOther(info, names[tn] || ("unsupported object (" + tn + ")"));
            info.rings.push({ c: "other", z: true, o: info.obj++, p: boundsRing(item.geometricBounds) });
        }
    }

    // =========================================================================
    // Collect sources
    // =========================================================================
    function skipLayer(name) { for (var i = 0; i < CFG.SKIP_LAYERS.length; i++) if (CFG.SKIP_LAYERS[i] === name) return true; return false; }
    function eligible(it) {
        if (it.parent.typename !== "Layer" || it.locked || it.hidden) return false;
        if (it.layer.locked || !it.layer.visible || skipLayer(it.layer.name)) return false;
        if (it.typename === "PathItem" && (it.guides || it.clipping)) return false;
        return true;
    }
    // Every top-level object, layer by layer (top to bottom). Only these carry
    // tags, so nothing nested inside groups has to be visited.
    var topItems = [];
    function collectTop(L) {
        var items = L.pageItems, n = items.length, k;
        for (k = 0; k < n; k++) topItems.push(items[k]);
        var subs = L.layers, ns = subs.length;
        for (k = 0; k < ns; k++) collectTop(subs[k]);
    }
    var docLayers = doc.layers, nDL = docLayers.length, pi, it;
    for (pi = 0; pi < nDL; pi++) collectTop(docLayers[pi]);

    var sources = [];
    var sel = doc.selection, nSel = sel.length;          // read the selection once
    if (nSel) {
        for (pi = 0; pi < nSel; pi++) {
            it = sel[pi];
            // if something inside a group is selected, take the whole top-level group
            while (it.parent.typename !== "Layer") it = it.parent;
            var dup = false;
            for (var q = 0; q < sources.length; q++) if (sources[q] == it) { dup = true; break; }
            if (!dup && !skipLayer(it.layer.name)) sources.push(it);
        }
    } else for (pi = 0; pi < topItems.length; pi++) {
        if (eligible(topItems[pi])) sources.push(topItems[pi]);
    }
    if (!sources.length) { alert("Nothing to nest. Select your artwork first."); return; }

    // ---- Normalize (silent): release and rebuild every compound path in the
    // parts, same as Normalize.jsx, so Shape Builder / boolean leftovers can be
    // read. Shapes and colours don't change.
    function normCompound(cp) {
        doc.selection = null;
        cp.selected = true;
        try { app.executeMenuCommand("noCompoundPath"); } catch (e) { doc.selection = null; return cp; }
        var rel = [], k;
        for (k = 0; k < doc.selection.length; k++) rel.push(doc.selection[k]);
        try { app.executeMenuCommand("compoundPath"); }
        catch (e) {
            // re-compound failed: keep the released pieces together in a group
            doc.selection = null;
            if (!rel.length) return null;
            var g = rel[0].parent.groupItems.add();
            g.move(rel[0], ElementPlacement.PLACEBEFORE);
            for (k = 0; k < rel.length; k++) rel[k].move(g, ElementPlacement.PLACEATEND);
            return g;
        }
        var made = doc.selection.length ? doc.selection[0] : null;
        doc.selection = null;
        return made || cp;
    }
    function normWalk(item) {                    // returns what now stands in its place
        var tn = item.typename;
        if (tn === "CompoundPathItem") return normCompound(item);
        if (tn === "GroupItem" && !item.clipped) {
            var kids = item.pageItems, nk = kids.length, list = [], k;
            for (k = 0; k < nk; k++) list.push(kids[k]);
            for (k = 0; k < list.length; k++) { try { normWalk(list[k]); } catch (e) {} }
        }
        return item;
    }
    if (prefs.normalize) {
        for (pi = 0; pi < sources.length; pi++) {
            try { var nw = normWalk(sources[pi]); if (nw) sources[pi] = nw; } catch (e) {}
        }
        try { doc.selection = null; } catch (e) {}
        // objects were rebuilt: read the layer contents again
        topItems = [];
        for (pi = 0; pi < nDL; pi++) collectTop(docLayers[pi]);
    }

    // clear stale tags, then tag the sources
    for (pi = 0; pi < topItems.length; pi++) {
        try { var nt = topItems[pi].note; if (nt && nt.indexOf("NEST_") === 0) topItems[pi].note = ""; } catch (e) {}
    }
    for (pi = 0; pi < sources.length; pi++) sources[pi].note = "NEST_" + pi;

    // stacking order: topItems is already top to bottom (0 = topmost)
    var zOf = {};
    for (pi = 0; pi < topItems.length; pi++) {
        var n2 = topItems[pi].note;
        if (n2 && n2.indexOf("NEST_") === 0) zOf[n2] = pi;
    }

    // =========================================================================
    // JSON (ExtendScript has no JSON object)
    // =========================================================================
    function num(v) { return String(Math.round(v * 1000) / 1000); }
    function esc(s) {
        return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ") + '"';
    }
    function num4(v) { return String(Math.round(v * 10000) / 10000); }
    function pathsJSON(paths) {
        var o = [];
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i], s = new Array(p.a.length);
            for (var j = 0; j < p.a.length; j++) s[j] = num4(p.a[j]);
            o.push('{"s":"' + p.s + '","z":' + (p.z ? 1 : 0) + ',"a":[' + s.join(",") + "]}");
        }
        return "[" + o.join(",") + "]";
    }
    function ringsJSON(rings) {
        var o = [];
        for (var i = 0; i < rings.length; i++) {
            var r = rings[i], s = new Array(r.p.length);
            for (var j = 0; j < r.p.length; j++) s[j] = num(r.p[j]);
            o.push('{"c":"' + r.c + '","z":' + (r.z ? 1 : 0) + ',"o":' + r.o + (r.l ? ',"l":1' : "") + ',"p":[' + s.join(",") + "]}");
        }
        return "[" + o.join(",") + "]";
    }

    var itemsJ = [], nParts = 0, nLines = 0, nOdd = 0;
    for (pi = 0; pi < sources.length; pi++) {
        var info = newInfo(), id = "NEST_" + pi;
        try { readItem(sources[pi], info); }
        catch (e) { addOther(info, "object that couldn't be read"); }
        if (!info.rings.length && !info.others.length) { sources[pi].note = ""; continue; }
        var keys = [];
        for (var kk in info.keys) if (info.keys.hasOwnProperty(kk)) keys.push(esc(kk));
        var others = [];
        for (var oo = 0; oo < info.others.length; oo++) others.push(esc(info.others[oo]));
        if (info.others.length) nOdd++; else if (keys.length || info.cut) nParts++; else nLines++;
        itemsJ.push('{"id":"' + id + '","zi":' + (zOf[id] !== undefined ? zOf[id] : 0) +
                    ',"keys":[' + keys.join(",") + '],"lines":' + (info.lines ? 1 : 0) + ',"cut":' + (info.cut ? 1 : 0) +
                    ',"others":[' + others.join(",") + '],"rings":' + ringsJSON(info.rings) +
                    (CLEAN ? ',"paths":' + pathsJSON(info.paths) : "") + "}");
    }

    var json = '{"version":2,"settings":{' +
        '"machine":' + esc(MACH.name) + ',"sheetWmm":' + MACH.w + ',"sheetHmm":' + MACH.h +
        ',"output":"' + prefs.output + '","labelMode":"' + prefs.label + '","overlaps":' + (prefs.overlaps ? "true" : "false") +
        ',"sortPaper":' + (prefs.sortPaper ? "true" : "false") + ',"cleanup":' + (prefs.cleanup ? "true" : "false") +
        ',"recolour":' + (prefs.recolour ? "true" : "false") +
        ',"sourceDoc":' + esc(doc.name) + '},' +
        '"spacingMM":' + CFG.SPACING + ',"marginMM":' + CFG.MARGIN + ',"rotationStep":' + prefs.rotStep +
        ',"timeLimitS":' + CFG.TIME_LIMIT_S + ',"items":[' + itemsJ.join(",") + "]}";

    var f = new File(CFG.OUT_FILE);
    f.encoding = "UTF-8";
    if (!f.open("w")) { alert("Could not write " + CFG.OUT_FILE); return; }
    f.write(json); f.close();

    alert("Exported " + itemsJ.length + " object(s) for " + MACH.name + ":\n" +
          "  " + nParts + " part(s)\n" +
          "  " + nLines + " loose line object(s)\n" +
          (nOdd ? "  " + nOdd + " object(s) with something unexpected (listed after step 3)\n" : "") +
          "\nNext: double-click 2_RunNest, then run 3_ApplyNest.jsx.");
}

// Run via a deferred BridgeTalk message (same as 3_ApplyNest.jsx): when the
// script is started from an Action, Illustrator holds a lock that makes the
// Release / Make Compound Path menu commands silently fail. The message tells
// Illustrator to run this same file again a moment later, once that lock is gone.
if ($.global.__NEST_EXPORT_NOW) {
    $.global.__NEST_EXPORT_NOW = false;
    nestExportMain();
} else if (typeof BridgeTalk === "undefined") {
    nestExportMain();
} else {
    var bt = new BridgeTalk();
    bt.target = "illustrator";
    bt.body = '$.global.__NEST_EXPORT_NOW = true; $.evalFile(new File("' + new File($.fileName).absoluteURI + '"));';
    bt.onError = function (errObj) { alert("1_ExportForNest failed to run: " + errObj.body); };
    bt.send();
}
