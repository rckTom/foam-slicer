# Foam slicer

A static page that cuts a foam insert model (for a case, a drawer, a
transport box) into sheets for the laser cutter and nests them onto the foam.
Everything runs in the browser and nothing is uploaded.

- **Input:** STEP, BREP, or a FreeCAD `.FCStd`. The page reads the body's
  stored shape straight from the zip; when a document holds several bodies,
  it asks which one to use. OpenCascade runs as WebAssembly
  ([replicad-opencascadejs](https://www.npmjs.com/package/replicad-opencascadejs))
  in a worker.
- **Foam thicknesses:** list the thicknesses at hand (e.g. 10, 20, 50 mm).
  The worker samples the model on the grid the thicknesses share and
  measures how far the walls move between heights, separately for the outer
  outline and for the pockets. A sheet is cut flat, so that movement is its
  error. The page suggests the stack with the fewest sheets that keeps every
  sheet within the two tolerances (*Max error*: outline, pockets).
  - The **Stack** panel draws the sheets to scale. The strip beside it is the
    height profile: shaded where the walls move, a black line where they
    jump (a pocket floor), which is where a sheet should end.
  - Each sheet's dropdown, and the buttons in the panel below, show how every
    thickness would do there (✓ / ✗ with the wall movement). Picking one keeps
    the sheets below it and plans the ones above again. *↺ suggest* plans the
    whole stack again.
  - With mixed thicknesses, file names and engraved ids carry the thickness
    (`layer_03_z020_t30`, `L03 z20 t30`).
- **3D view:** the model as a ghost, with the sheets stacked inside it. The
  selected sheet shows its section plane and cut contour in red. Sheets above
  it can be faded, and the stack can be exploded.
- **Sheet view:** the selected sheet as the laser sees it. Cuts are red,
  engraving is blue, and the sheet below is shown dashed.
- **Loose pieces:** every sheet is split into its connected pieces. The
  largest is the sheet's main piece (`L04`). The others are loose (`L04-a`,
  `L04-b`, …) and have to be placed by hand:
  - A piece with nothing under it is *floating*.
  - Pieces that never touch the rest of the stack are reported as a
    separate part.
  - With *Engrave placement outlines* on, each loose piece's outline and id
    are engraved on the sheet it sits on.
- **Assembly view:** the stack bottom up, one card per sheet, with what
  goes where and what to glue onto what. It can be printed.
- **Report:** the checks from `slice.py`:
  - outlines that change within a sheet (fillets, draft),
  - pockets that change within a sheet,
  - pocket floors between sheet boundaries,
  - an uncut rest at the top.

  It also has the cut list.
- **Nest:** puts the pieces onto the foam. A search runs in a worker and
  keeps improving (a genetic search and a late acceptance hill climber over
  order, turns, splits and spot ranks, each layout packed bottom-left with
  MaxRects; a rank lets a part take the second or third best spot, which
  staggers columns that plain bottom-left would not). The view shows the best layout so far
  as it changes; it can be paused, resumed and restarted, zoomed and panned,
  and clicking a piece selects it everywhere. It stops by itself after 15 s
  without a better layout.
  - *Stock I have*: the raw pieces (thickness, width × length, count). Order
    of importance: least foam left unplaced, fewest stock pieces, fewest
    splits, fewest blanks, then the best offcut.
  - *Fixed width*: a width per thickness. What counts is the length used,
    then the number of blanks; a split has to save 10 % of the width in
    length. There is no offcut here: the rest of the roll stays on the roll.
  - The **offcut** (stock mode) is the largest rectangle left beyond the used area. It
    counts by its area, less 3 % for every corner beyond four (one straight
    cut leaves four; steps under 10 mm count as straight). The view shows it
    and the line to cut it off.
  - **Pocket drop-outs**: small pieces go into the foam that falls out of the
    pockets of bigger ones, by bounding box. If the host is not placed, they
    are packed like any other piece.
  - **Splits** (optional): a piece may be cut by straight seams, with at most
    *n* new edges on any part (1: one cut, two halves). Seams stay 15 mm clear
    of pockets and off arcs, and parts stay at least 40 mm wide. The bottom
    and / or top sheet can be kept whole. Parts are named `L05.1`, `L05.2`.
  - **Laser bed** (optional): pieces are grouped into blanks no larger than
    the bed, each cut down to what it holds. The search may also pick a
    smaller blank size that tiles the width (width / 2 … / 5). The blanks are
    packed onto the stock either way round, trying a few orders (touching;
    the edge margin inside each blank keeps the pieces off the hand cut). Each blank is one laser job; `nest_t10_1_plan.svg`
    shows where to cut them. Some cuts may have to stop at another cut.
  - Files: one DXF / SVG per stock piece (or per blank), the stock / blank
    outline grey on layer STOCK, cut red, engraving blue, plus `nest.txt`.
    Pieces inside drop-outs come first: keep "inner shapes first" on.
- **Output:** one DXF (R12, arcs as polyline bulges) and one SVG per sheet,
  in one shared frame so the sheets register, plus `cutlist.txt`. Use
  *Download sheets (.zip)* for all of them, or the DXF / SVG buttons for
  one sheet.

Sections are taken 0.01 mm inside each sheet, at its bottom by default,
the same way `slice.py` does it. Circles stay arcs. B-spline edges that are
arcs or lines within 0.01 mm become arcs or lines. Other curves become
polylines within 0.01 mm.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/, a static site (the wasm is 23 MB, 7 MB gzipped)
npm run check -- examples/transport_insert.FCStd /tmp/slices 10,20,50
                   # slice in node with the same code (stack as suggested for
                   # the thicknesses), print the profile and the cut list,
                   # write the laser files
OUT=/tmp/nest BED=600x400 SPLIT=1 npm run nestcheck -- \
    examples/transport_insert.FCStd stock 5 10 "10:1050x1690x2"
                   # run the nesting search for 5 s in node, write the jobs
                   # (roll mode: ... roll 5 10 "10:1000")
```

*Try the example* on the start page loads
[`examples/transport_insert.FCStd`](examples/transport_insert.FCStd), an
insert for a transport case: one PartDesign body, 150 mm high, cut from
fifteen 10 mm sheets. The build bundles it.

## Hosting

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds the page
on every push to `main` and publishes it on GitHub Pages (repository settings:
Pages → Source: GitHub Actions). `dist/` works from any subpath and any static
web server.

## License

GPL-3.0-only, see [LICENSE](LICENSE).
