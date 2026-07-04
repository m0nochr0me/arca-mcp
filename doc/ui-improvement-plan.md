# Web UI Improvement Plan

Audit of the web UI (`/memory`, `/canvas`) performed 2026-07-03 covering
[`app/templates/`](../app/templates/), [`app/static/js/app/`](../app/static/js/app/),
[`app/static/css/`](../app/static/css/), and the backing routes in
[`app/main.py`](../app/main.py) and [`app/util/canvas.py`](../app/util/canvas.py).

Context: the June canvas optimization pass (view culling via a throttled `cullView`
snapshot, `v-memo` on node/edge v-fors, imperative node drag, async force layout)
already brought normal interaction to 60 fps. The remaining measured ceiling was the
fit-to-all overview: ~600 full-detail DOM nodes above the LOD threshold at ~33 ms/frame.

## Status

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 1 | Perf & correctness quick wins | DONE (2026-07-03) |
| 2 | Consistency refactor & dedup | DONE (2026-07-03) |
| 3 | UX features | DONE (2026-07-03) |
| 4 | Deeper canvas perf | PARTIAL (2026-07-04): aggregate LOD tier added for very large buckets; Web Worker layout / server-side truncation still not needed |

## Results (measured 2026-07-03, headless chromium, 600 mocked nodes)

Same methodology as the June round (route-mocked `/v1/canvas`, seeded positions,
1440×900 viewport, frame deltas sampled via rAF during a 30-move background pan):

| Scenario | June baseline | After phases 1–3 |
| -------- | ------------- | ---------------- |
| Pan, fit-to-all (600 visible) | median 33 ms, 52/99 frames >32 ms | median 16.7 ms, 3/47 frames >32 ms |
| Pan, zoomed-in (full detail) | median 16.7 ms | median 16.7 ms, 0 jank |
| Node drag, fit-to-all | median 16.7 ms | median 16.7 ms, 0 jank |

The fit-to-all overview — the one remaining slow path — now holds 60 fps because the
count-based adaptive LOD switches 600 visible nodes to bare blocks (scale 0.15 is
above the 0.05 zoom threshold, so the old scale-only trigger never fired there).
Zooming in past the 250-visible cap restores full detail. Phase 4 (Web Worker layout,
canvas renderer, server-side truncation) is therefore not needed.

A functional pass (19 checks) covered: auth probe (bad key rejected, not persisted),
add/edit/search, connection picker, Map deep link, bucket rename layout-key
migration, pending-bucket persistence, namespace create/switch, canvas node search,
editor discard guard, drag persistence, ghost-anchor styling — zero console errors.

Extra fixes discovered during implementation:

- `.toast` was only styled in `memory.css`, so canvas-page toasts rendered in page
  flow below the canvas instead of as fixed overlays — moved to `app.css` with
  stacking (`.toast ~ .toast`) for simultaneous error+success.
- On the memory page the toasts lived inside the `v-if="authKey"` subtree, hiding
  auth errors on the login banner — moved to app level via the shared partial.
- Escape-to-close on the canvas editor must `preventDefault()`: the browser's
  close-request for that same Escape keydown otherwise instantly cancels the
  confirm dialog that `closeEditor()` opens synchronously.

## Follow-up round (2026-07-04)

Two field reports after the phases landed, both fixed and re-measured:

- **Canvas edge disconnect never worked** (pre-existing): the `.canvas-bar`
  overlays sit inside `.canvas-wrap`, whose `pointerdown` handler clears
  `selectedEdge` and starts a pan — so clicking "Disconnect" wiped the selection
  before the click fired and `disconnectSelected()` silently no-oped. The same
  bubbling made text selection in the relationship input pan the canvas. Fixed
  with `@pointerdown.stop` on all three bars; verified end-to-end (edge removed
  in UI and server-side).
- **Very large buckets (1581 nodes / ~3150 edges) still lagged at fit-to-all**:
  LOD1 keeps one DOM element per node/edge (~7,900 elements re-diffed per cull
  tick). Added an aggregate tier (`lod2`, > 800 visible nodes or > 1200 visible
  edges): the whole scene collapses into four `<path>` elements (memory/external
  nodes as rect paths, internal/external edges as merged line paths,
  `vector-effect: non-scaling-stroke`). The paths are built from the full data
  set, independent of the viewport, so pan/zoom rebuilds nothing. Individual
  node interaction is meaningless at that zoom anyway; zooming in restores the
  per-element tiers.

| Scenario (1581 nodes / 3161 edges) | After LOD2 |
| ---------------------------------- | ---------- |
| Pan, fit-to-all (aggregate tier) | median 16.7 ms, 0 jank |
| Pan, mid-zoom (338 bare-block nodes) | median 16.7 ms, 0 jank |
| Pan, zoomed-in (150 full-detail nodes) | median 16.7 ms, 0 jank |

Full 19-check functional suite and the 600-node measurements re-run clean after
the change (the 600-node case stays on the per-element LOD1 tier by design).

### LOD tuning + middle-button pan (second follow-up, same day)

- **Text appeared far too late when zooming in.** The bare-block decision counted
  the *margined* visible set: the 600-screen-px render halo inflated the count, so
  at perfectly readable zooms (e.g. scale 0.5 with only ~90 nodes truly on screen)
  the off-screen halo kept everything bare. Now `lod` counts only nodes
  intersecting the actual viewport (`onScreenIds`), and halo nodes always render
  bare via per-node `nodeLod(n)` — so the full-detail DOM stays capped at
  `LOD_MAX_NODES` regardless of the halo, and text appears exactly when it becomes
  legible (past 250 on-screen nodes each is under ~70 px wide, unreadable anyway).
  Text pops in at the screen edge as bare halo nodes pan into view — by design.
  Measured on the 1581-node mock at scale 0.48: 90 of 442 DOM nodes full detail
  (was 0 before), pan still 16.7 ms median / 0 jank at every tier.
- **Middle-button drag now pans from anywhere** — over nodes and edges too, not
  just empty background. `onNodePointerDown` / the new `onEdgePointerDown` route
  `button === 1` to `startPan()`; `@mousedown.middle.prevent` on the wrap
  suppresses Chromium's autoscroll. Left-button behavior is unchanged (drag node,
  select edge, pan background).

## Audit findings

### Performance

1. **Vue dev build in production.** `app/static/js/vendor/vue.global.js` (3.5.25) is
   the unminified development build: 572 KB, `[Vue warn]` machinery, dev-mode
   reactivity bookkeeping on every effect. The production build
   (`vue.global.prod.js`, ~160 KB) includes the same in-browser template compiler.
   Single biggest remaining perf lever; affects both pages.
2. **Fit-to-all overview.** The LOD trigger is scale-based
   (`view.scale < LOD_THRESHOLD`), but the cost driver is *visible node count*: a
   fit-to-all on a large bucket keeps hundreds of full-detail nodes in the DOM.
   Adaptive LOD (`scale < threshold` **or** `visibleNodes.length > cap`) fixes the
   overview without degrading normal zoom levels.
3. **Full memory content shipped as canvas node text.** `/v1/canvas` puts the whole
   `content` in each node's `text` although the 260×120 box clips at ~200 chars.
   ⚠️ The canvas edit modal uses `n.text` as the edit source, so *server-side*
   truncation would corrupt memories on save. Safe order: client-side display
   truncation first; server-side truncation only together with a
   fetch-full-content-on-edit endpoint.
4. **Force layout is O(n²) on the main thread.** It yields to rAF (no freeze) but a
   1000+ node bucket still costs seconds of staggered layout on every visit until
   positions are saved. Web Worker candidate (plain file, no build step).
5. **Canvas layouts live only in localStorage**, keyed by namespace + bucket name.
   Renaming a bucket loses the layout and orphans the old key.

### Bugs

- **`.btn.ghost` missing from CSS** — only `button.ghost` is defined, so the canvas
  "Ingest" *anchor* (`<a class="btn ghost">`) renders as a solid button.
- **"Create bucket" is a client-side fiction** — `createBucket()` pushes the name
  into the local array and flashes "Bucket ready"; any reload or namespace switch
  silently drops it (buckets materialize only when the first memory lands).
- **Success and error toasts overlap** — same fixed bottom-center position; also
  `showError`'s untracked timer dismisses a repeated error message early.
- **Memory-page inline edit never focuses** — dead `ref="editField"` in the
  template, never wired in JS (canvas editor does autofocus).
- **Canvas editor discards typed text silently** on Escape / overlay click.
- **`justDragged` can swallow one node click** when the drag release lands off-node.
- **Deleting a node during link mode** leaves `linkSource` pointing at a ghost.

### Duplication & dead weight

- **~200 lines copy-pasted between `memory.js` and `canvas.js`**: `api()`,
  `headers()`, `flash()`, `showError()`, `loadNamespaces()`, `loadBuckets()`,
  `saveAuth()`, `disconnectAuth()`; templates duplicate the auth banner, NS picker,
  and toast blocks. Drift already visible (NS select 160 px vs 150 px).
- **~230 lines of dead CSS in `app.css`** from another project: `.agent-*`,
  `.heartbeat`, `.cluster-*`, `.mini-event*`, `.status` pills, `.hero`, `.grid-2`,
  table styles — zero usages. The `window.PillbugDashboardConfirm` global is a
  naming leftover from the same source.
- **~40 inline `style="..."` attributes** in the templates.

### UX gaps

- **Bad auth keys accepted silently** — persisted to localStorage unvalidated;
  failures surface as raw `401: {"detail":...}` toasts.
- **Connections require pasting raw UUIDs** — no picker (`/memories/search` could
  back one); no node search on the canvas either (`centerOn()` exists, unwired).
- **Ingest provenance invisible** — the API returns `source` / `chunk_index` /
  `kind` per memory but the timeline renders chunks as anonymous entries; the canvas
  payload doesn't pass the row `kind` through, so document anchors look like
  regular nodes.
- Search relevance (`_distance`) dropped by `MemorySearchResult` (`extra="ignore"`).
- No way to create a namespace from the UI.
- `reload()` is a serial 4-request waterfall.
- No pinch-zoom on touch devices (wheel-only).
- A11y basics: dblclick-only edit, title-only `R`/`X`/`x`/`+` buttons, no focus
  trap in modals.

## Implementation phases

### Phase 1 — perf & correctness quick wins

- Swap vendored Vue to `vue.global.prod.js` (3.5.25).
- Adaptive LOD: `lod = scale < LOD_THRESHOLD || visibleNodes.length > LOD_MAX_NODES`.
- Fix `.btn.ghost` selector.
- Fix toast overlap (offset stacking) and track the `showError` timer.
- Parallelize `reload()` fetches (`Promise.all`).
- Client-side canvas node text display truncation (full text stays in state for the
  edit modal).

Verify: headless chromium at 600+ mocked nodes; re-measure fit-to-all frame times
against the June 33 ms baseline.

### Phase 2 — consistency refactor & dedup

- Extract `app/static/js/app/common.js` (api/auth/namespace/toast helpers, no build
  step — plain `window.Arca*` module) and a Jinja partial for the shared auth
  banner + toasts.
- Rename `PillbugDashboardConfirm` → `ArcaConfirm`.
- Purge dead CSS; consolidate recurring inline styles into utility classes.
- Inline-edit bucket becomes a dropdown matching the add form.
- Autofocus the inline edit textarea.
- Validate the auth key before persisting; friendly message on 401.
- Parse error `detail` from JSON error bodies for toasts.

Verify: both pages driven headless — auth, add, edit, search, ingest, canvas
link/drag flows, zero console errors.

### Phase 3 — UX features

- Canvas node search with center-and-highlight; `/canvas?bucket=X&focus=<id>` deep
  link; "show on canvas" action in the timeline.
- Connection picker backed by semantic search (replaces the raw-UUID input).
- Provenance chips in the timeline (`source · #chunk`, `kind`); pass row `kind`
  through the canvas payload and style document anchors distinctly.
- "+ new namespace" option in the NS dropdown (mirrors the bucket pattern).
- Migrate localStorage layout keys on bucket rename.
- Fix the phantom-bucket flow.

### Phase 4 — deeper canvas perf (gated)

Only if Phase 1 re-measurement still shows the overview below 60 fps:

- Force layout in a Web Worker (± spatial-grid repulsion approximation, ~O(n·k)).
- Intermediate LOD tier (header-only nodes).
- Server-side canvas text truncation + `GET /v1/memories/{id}` fetch-on-edit.
- Server-side position persistence (round-trip JSON Canvas x/y).
- Pinch-zoom for touch.

### Explicitly rejected

- WebGL / three.js / external graph libraries: the bottleneck is DOM/Vue reactivity,
  not the GPU, and the project has no build step (vendored `vue.global.js`).
  Re-affirmed from the June measurement round.
