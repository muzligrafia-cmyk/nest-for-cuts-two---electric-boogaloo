# Changelog

All notable changes to Nest For Cuts Two - Electric Boogaloo.

## Unreleased (one-click branch)

### Added
- **One click.** `NestForCuts_OneClick.jsx` runs step 1 (with its panel),
  starts the engine hidden in the background, shows a small "Nesting… X s"
  window while it waits, then runs step 3 automatically. One script, one
  final alert. If Node.js is missing, the engine fails or it doesn't finish
  in time, an alert says so instead of hanging. The three separate steps
  still work as before.

### Changed
- Default rotation is 45° steps (90°, 10° and Auto are still in the panel).
- Default machine is Trotec 300; GCC (Mercury III) is kept as a legacy option.
- The engine writes its result in one go (temporary file, then renamed), so
  a script waiting for it can never read a half-written file.

## 2026-11-24

### Added
- **Auto rotation.** A fourth choice in step 1's Rotation panel. Step 2 nests
  the job at 90°, 45° and 10° steps at the same time (three copies of the
  engine side by side) and keeps the tightest result: fewest parts left over,
  then fewest sheets, then the least space used on each paper's last sheet.
  Takes about as long as the 10° run on its own. The step 2 window and the
  step 3 alert say which one was kept and what the others gave.
- Short hints next to each rotation choice (boxy / diagonal and fan shapes /
  organic).

### Changed
- **Live text is no longer carried onto the sheets.** Point, area and path
  text is not treated as a loose marking line, and is stripped from parts it
  is grouped with. Only outlined (expanded) text travels with its part, as
  engraving / marking. In "New document" mode the copies simply lose the
  text; in "Current document" mode it stays in the design where it was.
  Step 1's and step 3's alerts say how many text boxes were left out.
- **Built-in Cleanup updated to Cleanup.js V2.3 (Refined Laser Janitor).**
  Specks are only removed if they are cuts. Because Cleanup runs before the
  laser recolour, a "cut" here means a paper-filled outline or an already
  pink / green line. Tiny engraving, marking, scoring and perforation bits are
  kept. Paths with 0-1 anchor points are still removed whatever they are.
- The final alert in step 3 now also reports how many tiny non-cut items
  Cleanup kept.

### Fixed
- **Red scoring lines came out blue.** Illustrator's scripting engine reads a
  chained shortcut (`a ? b : c ? d : e`) the wrong way round, so the line
  colour picker in `3_ApplyNest.jsx` returned blue for red. It is now a plain
  if / else. No other chained shortcuts exist in the scripts.

## 2026-11-22

### Added
- First upload of the three-step pipeline: `1_ExportForNest.jsx` →
  `2_RunNest.bat` (`nest.js`) → `3_ApplyNest.jsx`.
- Paper sorting against `swatches.cclibs` ("Paper Swatches" folder), one run
  of sheets per paper, labelled "Series – Paper" (Arial 35 pt, 1 cm from the
  top-left corner, on the "Labels" layer). Overflow continues on extra sheets.
- Machine sheet sizes: GCC (Mercury III), Trotec 300, Dömpi (Trotec 400).
- Output to the current document or a new document (sent across in one copy).
- Label space kept free as a text box or a full-width strip.
- Optional steps: Normalize compound paths, Sort by paper, Clean up
  (Cleanup.js rules, worked out in Node), Recolour for laser (Prep.js rules,
  pink / green decided in Node).
- Rotation choice: 90°, 45° or 10° steps, after straightening each part.
- "Count for overlaps": loose scoring, perforation, marking and #000
  engraving travel with the paper part they sit on (stacking order aware).
- Already-prepped (pink / green) artwork can be nested with sorting off;
  loose holes stay with their part.
- Hole filling: smaller parts are nested inside the holes of bigger ones.
