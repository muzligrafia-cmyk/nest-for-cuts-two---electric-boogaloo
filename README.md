# Nest For Cuts Two - Electric Boogaloo

Nest For Cuts, but on steroids. This one relies on using a swatches.cclib file that contains the material names and corresponding colors to cross-reference your exported vector objects, and separate them accordingly, before arranging them on a separate artboard per material. Also adds the material name on the artboard and can handle multiple cutting mat sizes (the ones I use as of now.)

Optional, but the script holds Normalize.jsx, Prep.jsx and also allows user to customize the angle at which Node tries rotations to fit elements. It's not quite all there yet, but it's a work in progress.

User also has the option to fully opt out from using material names and swatches, in which case previously prepped artwork can also be sorted - otherwise it gets flagged as not being in the cclib file.

The script also accounts for layer order and overlaps, so the user doesn't have to actually group scoring, perforation, marks or engraving to their respective cut shapes anymore.

Running the script takes a hot second for larger objects, but most of the calculation is done in Node.
