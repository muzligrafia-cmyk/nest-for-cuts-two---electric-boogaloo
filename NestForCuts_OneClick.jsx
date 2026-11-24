/*
================================================================================
 NestForCuts_OneClick.jsx - all three steps in one go
================================================================================
 Runs step 1 (1_ExportForNest.jsx, with its settings panel), then starts the
 nesting engine (nest.js) in the background with no console window, waits for
 it with a small progress window, and runs step 3 (3_ApplyNest.jsx).

 Keep this file in the same folder as 1_ExportForNest.jsx, nest.js,
 3_ApplyNest.jsx and swatches.cclibs. The separate steps still work on their
 own (1 -> double-click 2_RunNest.bat -> 3) if you ever need them.
================================================================================
*/
// #target illustrator
(function () {
    var dir = new File($.fileName).parent.fsName;
    var exportScript = new File(dir + "/1_ExportForNest.jsx");
    if (!exportScript.exists) {
        alert("Can't find 1_ExportForNest.jsx next to this script:\n" + dir);
        return;
    }
    // Tell step 1 to carry on into the engine and step 3 when it's done.
    $.global.__NEST_ONECLICK = { dir: dir };
    $.evalFile(exportScript);
})();
