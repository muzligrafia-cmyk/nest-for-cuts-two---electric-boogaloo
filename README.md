# Nest For Cuts Two - Electric Boogaloo

Nest For Cuts, but on steroids. This one relies on using a swatches.cclib file that contains the material names and corresponding colors to cross-reference your exported vector objects, and separate them accordingly, before arranging them on a separate artboard per material. Also adds the material name on the artboard and can handle multiple cutting mat sizes (the ones I use as of now.)

Optional, but the script holds Normalize.jsx, Prep.jsx and also allows user to customize the angle at which Node tries rotations to fit elements. It's not quite all there yet, but it's a work in progress.

User also has the option to fully opt out from using material names and swatches, in which case previously prepped artwork can also be sorted - otherwise it gets flagged as not being in the cclib file.

The script also accounts for layer order and overlaps, so the user doesn't have to actually group scoring, perforation, marks or engraving to their respective cut shapes anymore.

Running the script takes a hot second for larger objects, but most of the calculation is done in Node.

## One click (one-click branch)

Run `NestForCuts_OneClick.jsx` instead of the three separate steps:

1. Select your artwork in Illustrator.
2. Run `NestForCuts_OneClick.jsx` (File > Scripts > Other Script, or from an Action).
3. Choose your settings in the panel and click **Export**.
4. A small "Nesting... X s" window appears while the engine works in the background (a console window flashes once, then the engine runs minimized in the taskbar).
5. Step 3 runs by itself and shows the usual final alert.

Keep `NestForCuts_OneClick.jsx` in the same folder as `1_ExportForNest.jsx`, `nest.js`, `3_ApplyNest.jsx` and `swatches.cclibs`. Node.js must be installed (the same as for `2_RunNest.bat`). The three separate steps still work on their own.

Windows only for now.

## Fill existing sheets

With **Current document** chosen, tick **Fill existing sheets** to top up the sheets already in the file before new ones are made:

- A sheet is filled only if its artboard is the size of the machine you picked **and its label is still on the "Labels" layer**. The label tells the script which paper the sheet is. Labels are deleted before cutting, so a sheet without one counts as finished and is left alone.
- Parts already on the sheet stay exactly where they are. New parts of the same paper go into the gaps around them (and into their holes), with the usual spacing and margins.
- Whatever doesn't fit gets new sheets, numbered on from the existing ones ("Kraft (2)" is there, so the next one is "Kraft (3)").
- With **Sort by paper** off, new parts fill the old "paper name here" sheets.
- Untick it to always get fresh sheets. With **New document** it does nothing.
