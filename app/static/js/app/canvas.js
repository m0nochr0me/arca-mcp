document.addEventListener("DOMContentLoaded", () => {
  const { createApp, ref, reactive, computed, onMounted, nextTick } = Vue;

  // Keep in sync with app/util/canvas.py
  const NODE_W = 260;
  const NODE_H = 120;

  // Default-placement tuning
  const GRID_GAP_X = 40;
  const GRID_GAP_Y = 40;
  const PER_ROW = 16; // unconnected nodes per grid row
  const COMP_GAP = 120; // gap between packed connected components
  const MIN_SCALE = 0.04; // zoom-out floor (guards against off-screen sprawl)
  const RENDER_MARGIN = 600; // screen-px halo around the viewport kept in the DOM
  const LOD_THRESHOLD = 0.05; // below this zoom, nodes render as bare blocks
  const LOD_MAX_NODES = 250; // above this many ON-SCREEN nodes, bare blocks too (fit-to-all)
  const LOD2_NODES = 800; // above this many visible nodes, collapse to aggregate paths
  const LOD2_EDGES = 1200; // ... or this many visible edges (edges dominate huge buckets)
  const NODE_TEXT_CLIP = 300; // display-only clip; the 260x120 box shows ~200 chars

  createApp({
    setup() {
      // Shared auth / namespace / bucket / toast state and API helper.
      const shared = ArcaShared.create(Vue);
      const {
        authKey, authKeyInput, namespace, namespaces, connected, buckets,
        error, success, flash, showError, api, loadNamespaces, loadBuckets,
        saveAuth, disconnectAuth, showNsForm, newNsName, createNamespace, canvasPosKey,
      } = shared;

      // ── Data ───────────────────────────────────────────────
      const activeBucket = ref(null);
      const nodes = ref([]);
      const edges = ref([]);

      // ── View transform (world -> screen) ───────────────────
      const view = reactive({ x: 0, y: 0, scale: 1 });
      // Throttled snapshot of `view` driving viewport culling only. Pan/zoom
      // mutate `view` every frame (cheap: one transform on the layer), but the
      // O(n) visible-set recompute is deferred to one rAF tick via this snapshot.
      const cullView = reactive({ x: 0, y: 0, scale: 1 });
      const wrap = ref(null);
      const wrapW = ref(0);
      const wrapH = ref(0);

      // ── Interaction state ──────────────────────────────────
      const drag = ref(null); // { id, dx, dy, sx, sy }
      let dragCtx = null; // imperative-drag scratch: { id, el, incident[], lastX, lastY }
      const movedDuringDrag = ref(false);
      const justDragged = ref(false);
      const panning = ref(null); // { sx, sy, ox, oy }
      const selectedEdge = ref(null);
      const linkSource = ref(null);
      const linkTarget = ref(null);
      const relType = ref("");

      // ── Editor modal ───────────────────────────────────────
      // editor: null | { mode: "add" | "edit", id, text, saving }
      const editor = ref(null);
      const editorField = ref(null);

      // ── UI state ───────────────────────────────────────────
      const maximized = ref(false);
      const loading = ref(false);

      // ── Derived ────────────────────────────────────────────
      const nodeMap = computed(() => {
        const m = {};
        for (const n of nodes.value) m[n.id] = n;
        return m;
      });

      const memoryCount = computed(() => nodes.value.filter(n => n.kind === "memory").length);
      const externalCount = computed(() => nodes.value.filter(n => n.kind === "external").length);
      const maxLabel = computed(() => (maximized.value ? "[>-<]" : "[<->]"));

      const gTransform = computed(() => `translate(${view.x},${view.y}) scale(${view.scale})`);
      const layerStyle = computed(() => ({
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
      }));

      function borderPoint(n, tx, ty) {
        const cx = n.x + n.width / 2;
        const cy = n.y + n.height / 2;
        const dx = tx - cx;
        const dy = ty - cy;
        if (!dx && !dy) return { x: cx, y: cy };
        const sx = dx ? (n.width / 2) / Math.abs(dx) : Infinity;
        const sy = dy ? (n.height / 2) / Math.abs(dy) : Infinity;
        const s = Math.min(sx, sy);
        return { x: cx + dx * s, y: cy + dy * s };
      }

      const edgeGeo = computed(() => {
        const out = [];
        for (const e of edges.value) {
          const a = nodeMap.value[e.fromNode];
          const b = nodeMap.value[e.toNode];
          if (!a || !b) continue;
          if (e.fromNode === e.toNode) {
            const x = a.x + a.width / 2;
            const y = a.y;
            out.push({
              id: e.id, fromNode: e.fromNode, toNode: e.toNode, external: e.external, label: e.label,
              d: `M ${x - 22},${y} C ${x - 46},${y - 56} ${x + 46},${y - 56} ${x + 22},${y}`,
              mx: x, my: y - 50,
            });
            continue;
          }
          const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
          const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          const p1 = borderPoint(a, bc.x, bc.y);
          const p2 = borderPoint(b, ac.x, ac.y);
          out.push({
            id: e.id, fromNode: e.fromNode, toNode: e.toNode, external: e.external, label: e.label,
            d: `M ${p1.x},${p1.y} L ${p2.x},${p2.y}`,
            mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2,
          });
        }
        return out;
      });

      // ── Viewport culling + level-of-detail ─────────────────
      // Only nodes/edges whose world rect intersects the viewport (plus a
      // screen-px halo) are kept in the DOM, so DOM size tracks what's on
      // screen rather than the bucket size.
      const viewBounds = computed(() => {
        const s = cullView.scale || 1;
        const m = RENDER_MARGIN;
        return {
          minX: (-m - cullView.x) / s,
          minY: (-m - cullView.y) / s,
          maxX: (wrapW.value + m - cullView.x) / s,
          maxY: (wrapH.value + m - cullView.y) / s,
        };
      });

      const visibleNodes = computed(() => {
        const b = viewBounds.value;
        // Interaction-critical nodes stay rendered even if scrolled out of view.
        const keep = new Set();
        if (drag.value) keep.add(drag.value.id);
        if (linkSource.value) keep.add(linkSource.value);
        if (linkTarget.value) keep.add(linkTarget.value);
        const out = [];
        for (const n of nodes.value) {
          if (keep.has(n.id) ||
              (n.x + n.width >= b.minX && n.x <= b.maxX && n.y + n.height >= b.minY && n.y <= b.maxY)) {
            out.push(n);
          }
        }
        return out;
      });

      const visibleIds = computed(() => {
        const s = new Set();
        for (const n of visibleNodes.value) s.add(n.id);
        return s;
      });

      // Nodes intersecting the actual viewport — no render-margin halo. The
      // level-of-detail decision counts these, not the margined set: otherwise
      // off-screen halo nodes force bare blocks at zooms where the few nodes
      // really on screen are perfectly readable.
      const onScreenIds = computed(() => {
        const s = cullView.scale || 1;
        const minX = -cullView.x / s;
        const minY = -cullView.y / s;
        const maxX = (wrapW.value - cullView.x) / s;
        const maxY = (wrapH.value - cullView.y) / s;
        const ids = new Set();
        for (const n of visibleNodes.value) {
          if (n.x + n.width >= minX && n.x <= maxX && n.y + n.height >= minY && n.y <= maxY) ids.add(n.id);
        }
        return ids;
      });

      // Bare blocks (no inner content) when the text would be unreadable (zoomed
      // out) OR when too many nodes are actually on screen for full-detail DOM
      // to hold 60fps. Past LOD_MAX_NODES on-screen each node is too small to
      // read anyway, so text appears exactly when it becomes legible.
      const lod = computed(() => view.scale < LOD_THRESHOLD || onScreenIds.value.size > LOD_MAX_NODES);

      // Halo (off-screen) nodes always render bare, so the full-detail DOM is
      // capped at what is actually on screen; text pops in at the screen edge
      // as nodes pan into view.
      function nodeLod(n) {
        return lod.value || !onScreenIds.value.has(n.id);
      }

      // Second LOD tier: past ~800 nodes / ~1200 edges even bare per-element DOM
      // lags (thousands of vnodes re-diffed per cull tick), so the whole scene
      // collapses into four aggregate <path> elements. Built from the FULL data
      // set — independent of the viewport — so panning/zooming rebuilds nothing.
      const lod2 = computed(
        () => visibleNodes.value.length > LOD2_NODES || visibleEdges.value.length > LOD2_EDGES
      );

      const lodNodeRects = computed(() => {
        let mem = "", ext = "";
        for (const n of nodes.value) {
          const seg = `M${n.x},${n.y}h${n.width}v${n.height}h${-n.width}Z`;
          if (n.kind === "external") ext += seg;
          else mem += seg;
        }
        return { mem, ext };
      });

      const lodEdgePaths = computed(() => {
        let internal = "", external = "";
        for (const e of edgeGeo.value) {
          if (e.external) external += e.d;
          else internal += e.d;
        }
        return { internal, external };
      });

      // Display-only clip: full text stays in state (the edit modal reads n.text),
      // but laying out multi-KB strings inside an overflow:hidden box is pure cost.
      function clipText(t) {
        return t.length > NODE_TEXT_CLIP ? t.slice(0, NODE_TEXT_CLIP) + "…" : t;
      }

      // ── Node search ────────────────────────────────────────
      const nodeQuery = ref("");
      const nodeMatches = ref([]);
      const nodeMatchPos = ref(-1);
      const foundId = ref(null);
      let lastNodeQuery = "";

      function resetNodeSearch() {
        nodeMatches.value = [];
        nodeMatchPos.value = -1;
        foundId.value = null;
        lastNodeQuery = "";
      }

      // Enter finds the first match and centers on it; Enter again cycles.
      function findNode() {
        const q = nodeQuery.value.trim().toLowerCase();
        if (!q) { resetNodeSearch(); return; }
        if (q !== lastNodeQuery) {
          lastNodeQuery = q;
          nodeMatches.value = nodes.value
            .filter(n => n.kind === "memory" && (n.text.toLowerCase().includes(q) || n.id.startsWith(q)))
            .map(n => n.id);
          nodeMatchPos.value = -1;
        }
        if (!nodeMatches.value.length) {
          foundId.value = null;
          showError("No nodes match");
          return;
        }
        nodeMatchPos.value = (nodeMatchPos.value + 1) % nodeMatches.value.length;
        const n = nodeMap.value[nodeMatches.value[nodeMatchPos.value]];
        if (!n) return;
        foundId.value = n.id;
        if (view.scale < 0.4) view.scale = 0.9; // zoom to readable before centering
        centerOn(n);
      }

      const visibleEdges = computed(() => {
        const ids = visibleIds.value;
        const sel = selectedEdge.value;
        return edgeGeo.value.filter(e => ids.has(e.fromNode) || ids.has(e.toNode) || e.id === sel);
      });

      const selectedEdgeInfo = computed(() => {
        const e = edges.value.find(x => x.id === selectedEdge.value);
        if (!e) return null;
        const target = nodeMap.value[e.toNode];
        const toShort = target && target.kind === "external"
          ? `${target.target_bucket || "?"} (${(target.target_id || "").slice(0, 8)})`
          : e.toNode.slice(0, 8);
        return { from: e.fromNode, label: e.label, toShort };
      });

      function nodeStyle(n) {
        return { left: `${n.x}px`, top: `${n.y}px`, width: `${n.width}px`, height: `${n.height}px` };
      }

      // ── Coordinate rulers ──────────────────────────────────
      const RULER_X = 30; // left ruler width (px)
      const RULER_Y = 16; // top ruler height (px)

      function niceStep(raw) {
        if (raw <= 0) return 100;
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = raw / pow;
        const step = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
        return step * pow;
      }

      function fmtCoord(v) {
        const r = Math.round(v);
        const s = Math.abs(r).toString().padStart(3, "0");
        return r < 0 ? `-${s}` : s;
      }

      const xTicks = computed(() => {
        const out = [];
        const W = wrapW.value;
        if (!W) return out;
        const step = niceStep(90 / view.scale);
        const worldLeft = -view.x / view.scale;
        const worldRight = (W - view.x) / view.scale;
        const start = Math.ceil(worldLeft / step) * step;
        for (let wx = start; wx <= worldRight; wx += step) {
          const sx = wx * view.scale + view.x;
          if (sx < RULER_X) continue;
          out.push({ pos: sx, label: fmtCoord(wx) });
        }
        return out;
      });

      const yTicks = computed(() => {
        const out = [];
        const H = wrapH.value;
        if (!H) return out;
        const step = niceStep(70 / view.scale);
        const worldTop = -view.y / view.scale;
        const worldBottom = (H - view.y) / view.scale;
        const start = Math.ceil(worldTop / step) * step;
        for (let wy = start; wy <= worldBottom; wy += step) {
          const sy = wy * view.scale + view.y;
          if (sy < RULER_Y) continue;
          out.push({ pos: sy, label: fmtCoord(wy) });
        }
        return out;
      });

      function measureWrap() {
        const w = wrap.value;
        if (!w) return;
        const rect = w.getBoundingClientRect();
        wrapW.value = rect.width;
        wrapH.value = rect.height;
      }

      // ── Culling throttle ───────────────────────────────────
      // Coalesce per-frame view changes into a single visible-set recompute.
      let cullRaf = 0;
      function scheduleCull() {
        if (cullRaf) return;
        cullRaf = requestAnimationFrame(() => {
          cullRaf = 0;
          cullView.x = view.x;
          cullView.y = view.y;
          cullView.scale = view.scale;
        });
      }

      function syncCull() {
        if (cullRaf) { cancelAnimationFrame(cullRaf); cullRaf = 0; }
        cullView.x = view.x;
        cullView.y = view.y;
        cullView.scale = view.scale;
      }

      // ── Position persistence (localStorage, per namespace+bucket) ──
      function posKey() {
        return canvasPosKey(activeBucket.value);
      }

      function loadPositions() {
        try {
          return JSON.parse(localStorage.getItem(posKey()) || "{}") || {};
        } catch {
          return {};
        }
      }

      function persistPositions() {
        if (!activeBucket.value || !nodes.value.length) return;
        const map = {};
        for (const n of nodes.value) map[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
        try {
          localStorage.setItem(posKey(), JSON.stringify(map));
        } catch {
          // storage full / unavailable — non-fatal
        }
      }

      // Place nodes that have no saved position into a tidy grid below the
      // already-positioned ones, so new memories don't land on top of others.
      function placeMissing(missing) {
        if (!missing.length) return;
        const placed = nodes.value.filter(n => !missing.includes(n));
        let baseX = 0, baseY = 0;
        if (placed.length) {
          baseX = Math.min(...placed.map(n => n.x));
          baseY = Math.max(...placed.map(n => n.y + n.height)) + GRID_GAP_Y;
        }
        missing.forEach((n, i) => {
          n.x = baseX + (i % PER_ROW) * (NODE_W + GRID_GAP_X);
          n.y = baseY + Math.floor(i / PER_ROW) * (NODE_H + GRID_GAP_Y);
        });
      }

      // ── Loading ────────────────────────────────────────────
      async function loadCanvas(focusId) {
        if (!activeBucket.value) return;
        loading.value = true;
        cancelLink();
        resetNodeSearch();
        selectedEdge.value = null;
        editor.value = null;
        try {
          const data = await api("GET", `/canvas?bucket=${encodeURIComponent(activeBucket.value)}`);
          nodes.value = (data.nodes || []).map(n => ({
            id: n.id, x: n.x, y: n.y, width: n.width, height: n.height,
            text: n.text, color: n.color || null,
            kind: n.arca.kind, bucket: n.arca.bucket || null,
            mem_kind: n.arca.mem_kind || null,
            created_at: n.arca.created_at || null,
            target_id: n.arca.target_id || null, target_bucket: n.arca.target_bucket || null,
          }));
          edges.value = (data.edges || []).map(e => ({
            id: e.id, fromNode: e.fromNode, toNode: e.toNode,
            label: e.label || "", external: !!(e.arca && e.arca.external),
          }));

          // Restore saved positions if any; otherwise auto-layout.
          const saved = loadPositions();
          if (nodes.value.some(n => saved[n.id])) {
            const missing = [];
            for (const n of nodes.value) {
              if (saved[n.id]) { n.x = saved[n.id].x; n.y = saved[n.id].y; }
              else missing.push(n);
            }
            placeMissing(missing);
            persistPositions();
            nextTick(fitView);
          } else {
            await relayout();
          }

          await nextTick();
          if (focusId) {
            const fn = nodes.value.find(x => x.id === focusId);
            if (fn) {
              foundId.value = fn.id;
              if (view.scale < 0.4) view.scale = 0.9;
              centerOn(fn);
            }
          }
        } catch (e) {
          showError("Failed to load canvas: " + e.message);
        } finally {
          loading.value = false;
        }
      }

      // ── Layout ─────────────────────────────────────────────
      const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

      // Force-directed (Fruchterman-Reingold) layout of *items*, with a gravity
      // term toward the centroid so disconnected components stay packed together
      // instead of drifting apart. Mutates each item's x/y in place. For large
      // components the O(n^2) iterations yield to the browser periodically so the
      // tab stays responsive instead of freezing on a big bucket.
      async function forceLayout(items) {
        const n = items.length;
        if (n === 0) return;
        if (n === 1) { items[0].x = 0; items[0].y = 0; return; }

        const pos = items.map(d => ({ x: d.x, y: d.y }));
        const index = {};
        items.forEach((d, i) => { index[d.id] = i; });
        const es = edges.value
          .map(e => [index[e.fromNode], index[e.toNode]])
          .filter(p => p[0] != null && p[1] != null && p[0] !== p[1]);

        const k = Math.max(NODE_W, NODE_H) * 1.2;
        const gravity = 0.06;
        let temp = k * 2;
        const iters = n > 200 ? 80 : 200;

        for (let it = 0; it < iters; it++) {
          const disp = pos.map(() => ({ x: 0, y: 0 }));
          let cx = 0, cy = 0;
          for (const p of pos) { cx += p.x; cy += p.y; }
          cx /= n; cy /= n;

          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              const dx = pos[i].x - pos[j].x;
              const dy = pos[i].y - pos[j].y;
              const dist = Math.hypot(dx, dy) || 0.01;
              const f = (k * k) / dist;
              const ux = dx / dist;
              const uy = dy / dist;
              disp[i].x += ux * f; disp[i].y += uy * f;
              disp[j].x -= ux * f; disp[j].y -= uy * f;
            }
          }
          for (const [a, b] of es) {
            const dx = pos[a].x - pos[b].x;
            const dy = pos[a].y - pos[b].y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const f = (dist * dist) / k;
            const ux = dx / dist;
            const uy = dy / dist;
            disp[a].x -= ux * f; disp[a].y -= uy * f;
            disp[b].x += ux * f; disp[b].y += uy * f;
          }
          for (let i = 0; i < n; i++) {
            disp[i].x += (cx - pos[i].x) * gravity;
            disp[i].y += (cy - pos[i].y) * gravity;
            const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
            pos[i].x += (disp[i].x / d) * Math.min(d, temp);
            pos[i].y += (disp[i].y / d) * Math.min(d, temp);
          }
          temp *= 0.97;
          if (n > 150 && (it & 7) === 7) await nextFrame();
        }

        items.forEach((d, i) => { d.x = Math.round(pos[i].x); d.y = Math.round(pos[i].y); });
      }

      // Split *items* into connected components (undirected) using edges.value.
      function connectedComponents(items) {
        const adj = {};
        const byId = {};
        for (const d of items) { adj[d.id] = []; byId[d.id] = d; }
        for (const e of edges.value) {
          if (adj[e.fromNode] && adj[e.toNode]) {
            adj[e.fromNode].push(e.toNode);
            adj[e.toNode].push(e.fromNode);
          }
        }
        const seen = new Set();
        const comps = [];
        for (const d of items) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          const stack = [d.id];
          const comp = [];
          while (stack.length) {
            const id = stack.pop();
            comp.push(byId[id]);
            for (const m of adj[id]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
          }
          comps.push(comp);
        }
        return comps;
      }

      // Unconnected nodes get a compact, ordered grid (rows of PER_ROW); the
      // connected graph is force-laid out and parked directly below it.
      async function relayout() {
        const ns = nodes.value;
        if (!ns.length) return;

        const deg = {};
        ns.forEach(d => { deg[d.id] = 0; });
        for (const e of edges.value) {
          if (deg[e.fromNode] != null) deg[e.fromNode]++;
          if (deg[e.toNode] != null) deg[e.toNode]++;
        }
        const isolated = ns.filter(d => deg[d.id] === 0);
        const connected = ns.filter(d => deg[d.id] > 0);

        const cellH = NODE_H + GRID_GAP_Y;
        isolated.forEach((d, i) => {
          d.x = (i % PER_ROW) * (NODE_W + GRID_GAP_X);
          d.y = Math.floor(i / PER_ROW) * cellH;
        });
        const isoRows = isolated.length ? Math.ceil(isolated.length / PER_ROW) : 0;
        const isoBottom = isoRows ? (isoRows - 1) * cellH + NODE_H : 0;

        if (connected.length) {
          // Lay out each connected component on its own so independent
          // components don't repel one another into a giant sprawl, then
          // shelf-pack the components into a compact, square-ish block parked
          // below the isolated grid.
          const boxes = [];
          for (const comp of connectedComponents(connected)) {
            await forceLayout(comp);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const d of comp) {
              minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
              maxX = Math.max(maxX, d.x + d.width); maxY = Math.max(maxY, d.y + d.height);
            }
            for (const d of comp) { d.x -= minX; d.y -= minY; }
            boxes.push({ comp, w: maxX - minX, h: maxY - minY });
          }
          boxes.sort((a, b) => b.h - a.h);
          const area = boxes.reduce((s, b) => s + (b.w + COMP_GAP) * (b.h + COMP_GAP), 0);
          const rowW = Math.sqrt(area) * 1.1;
          let x = 0, y = isoBottom ? isoBottom + GRID_GAP_Y : 0, rowH = 0;
          for (const b of boxes) {
            if (x > 0 && x + b.w > rowW) { x = 0; y += rowH + COMP_GAP; rowH = 0; }
            for (const d of b.comp) { d.x = Math.round(d.x + x); d.y = Math.round(d.y + y); }
            x += b.w + COMP_GAP;
            rowH = Math.max(rowH, b.h);
          }
        }

        persistPositions();
        nextTick(fitView);
      }

      function fitView() {
        const w = wrap.value;
        if (!w || !nodes.value.length) return;
        measureWrap();
        const rect = w.getBoundingClientRect();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes.value) {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + n.width);
          maxY = Math.max(maxY, n.y + n.height);
        }
        const pad = 80;
        const bw = (maxX - minX) + pad * 2;
        const bh = (maxY - minY) + pad * 2;
        const scale = Math.min(rect.width / bw, rect.height / bh, 1.4);
        view.scale = Math.max(scale, MIN_SCALE);
        view.x = rect.width / 2 - ((minX + maxX) / 2) * view.scale;
        view.y = rect.height / 2 - ((minY + maxY) / 2) * view.scale;
        syncCull();
      }

      function centerOn(n) {
        const w = wrap.value;
        if (!w) return;
        const rect = w.getBoundingClientRect();
        view.x = rect.width / 2 - (n.x + n.width / 2) * view.scale;
        view.y = rect.height / 2 - (n.y + n.height / 2) * view.scale;
        syncCull();
      }

      function toggleMaximize() {
        maximized.value = !maximized.value;
        nextTick(measureWrap);
      }

      // ── Pointer helpers ────────────────────────────────────
      function toWorld(ev) {
        const rect = wrap.value.getBoundingClientRect();
        return {
          x: (ev.clientX - rect.left - view.x) / view.scale,
          y: (ev.clientY - rect.top - view.y) / view.scale,
        };
      }

      function viewCenterWorld() {
        const rect = wrap.value.getBoundingClientRect();
        return {
          x: (rect.width / 2 - view.x) / view.scale,
          y: (rect.height / 2 - view.y) / view.scale,
        };
      }

      function startPan(ev) {
        panning.value = { sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
      }

      function onBgPointerDown(ev) {
        selectedEdge.value = null;
        startPan(ev);
      }

      function onEdgePointerDown(ev, e) {
        if (ev.button === 1) { startPan(ev); return; } // middle button pans from anywhere
        selectEdge(e);
      }

      function onNodePointerDown(ev, n) {
        if (ev.button === 1) { startPan(ev); return; } // middle button pans from anywhere
        if (linkSource.value) {
          if (n.kind === "external") { showError("Pick a memory node as the target"); return; }
          if (n.id === linkSource.value) { showError("Cannot link a node to itself"); cancelLink(); return; }
          linkTarget.value = n.id;
          return;
        }
        const w = toWorld(ev);
        movedDuringDrag.value = false;
        drag.value = { id: n.id, dx: w.x - n.x, dy: w.y - n.y, sx: ev.clientX, sy: ev.clientY };

        // Cache the DOM node + its incident edge paths so each drag frame mutates
        // only those elements directly. Without this, moving one node mutates
        // reactive state and forces an O(nodes+edges) recompute/re-diff every
        // pointermove — which is what makes dragging jank when everything is on
        // screen (e.g. 1500 nodes fully zoomed out).
        const edgeEls = {};
        if (wrap.value) wrap.value.querySelectorAll(".cedge").forEach(g => { edgeEls[g.dataset.eid] = g; });
        const incident = [];
        for (const e of edges.value) {
          if (e.fromNode !== n.id && e.toNode !== n.id) continue;
          const g = edgeEls[e.id];
          if (!g) continue;
          incident.push({
            e,
            line: g.querySelector(".cedge-line"),
            hit: g.querySelector(".cedge-hit"),
            label: g.querySelector(".cedge-label"),
          });
        }
        dragCtx = { id: n.id, el: ev.currentTarget, incident, lastX: null, lastY: null };
      }

      // Geometry for a single edge while its `id` endpoint sits at the live drag
      // position (ax, ay). Mirrors edgeGeo so imperative and reactive paths agree.
      function dragEdgeGeo(e, ax, ay) {
        const rectOf = (id) => {
          const m = nodeMap.value[id];
          return id === dragCtx.id ? { x: ax, y: ay, width: m.width, height: m.height } : m;
        };
        const a = rectOf(e.fromNode);
        const b = rectOf(e.toNode);
        if (e.fromNode === e.toNode) {
          const x = a.x + a.width / 2;
          const y = a.y;
          return { d: `M ${x - 22},${y} C ${x - 46},${y - 56} ${x + 46},${y - 56} ${x + 22},${y}`, mx: x, my: y - 50 };
        }
        const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
        const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        const p1 = borderPoint(a, bc.x, bc.y);
        const p2 = borderPoint(b, ac.x, ac.y);
        return { d: `M ${p1.x},${p1.y} L ${p2.x},${p2.y}`, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2 };
      }

      function dragMoveImperative(ax, ay) {
        if (!dragCtx) return;
        dragCtx.lastX = ax;
        dragCtx.lastY = ay;
        if (dragCtx.el) {
          dragCtx.el.style.left = `${ax}px`;
          dragCtx.el.style.top = `${ay}px`;
        }
        for (const it of dragCtx.incident) {
          const g = dragEdgeGeo(it.e, ax, ay);
          if (it.line) it.line.setAttribute("d", g.d);
          if (it.hit) it.hit.setAttribute("d", g.d);
          if (it.label) { it.label.setAttribute("x", g.mx); it.label.setAttribute("y", g.my); }
        }
      }

      function onNodeClick(n) {
        if (justDragged.value) { justDragged.value = false; return; }
        if (n.kind === "external" && !linkSource.value) openExternal(n);
      }

      function onPointerMove(ev) {
        if (drag.value) {
          if (Math.hypot(ev.clientX - drag.value.sx, ev.clientY - drag.value.sy) > 4) {
            movedDuringDrag.value = true;
          }
          const w = toWorld(ev);
          dragMoveImperative(w.x - drag.value.dx, w.y - drag.value.dy);
          return;
        }
        if (panning.value) {
          view.x = panning.value.ox + (ev.clientX - panning.value.sx);
          view.y = panning.value.oy + (ev.clientY - panning.value.sy);
          scheduleCull();
        }
      }

      function onPointerUp() {
        if (drag.value) {
          justDragged.value = movedDuringDrag.value;
          // The click that follows this pointerup consumes the flag; if no click
          // arrives (release landed off-node), don't let it eat a later one.
          if (justDragged.value) setTimeout(() => { justDragged.value = false; }, 0);
          // Commit the imperative position back to reactive state once, so edges
          // reconcile and the move persists. This is the only recompute a drag
          // triggers (one, on release — not one per frame).
          if (movedDuringDrag.value && dragCtx && dragCtx.lastX != null) {
            const n = nodeMap.value[dragCtx.id];
            if (n) { n.x = dragCtx.lastX; n.y = dragCtx.lastY; }
            persistPositions();
          }
          dragCtx = null;
        }
        drag.value = null;
        if (panning.value) syncCull();
        panning.value = null;
      }

      function onWheel(ev) {
        const rect = wrap.value.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.min(Math.max(view.scale * factor, MIN_SCALE), 3);
        const wx = (sx - view.x) / view.scale;
        const wy = (sy - view.y) / view.scale;
        view.x = sx - wx * newScale;
        view.y = sy - wy * newScale;
        view.scale = newScale;
        scheduleCull();
      }

      // ── Navigation to other buckets ────────────────────────
      function openExternal(n) {
        if (!n.target_bucket) { showError("Target memory no longer exists"); return; }
        activeBucket.value = n.target_bucket;
        loadCanvas(n.target_id);
      }

      // ── Add / edit (modal) / delete ────────────────────────
      function focusEditor() {
        nextTick(() => { if (editorField.value) editorField.value.focus(); });
      }

      function openAdd() {
        if (!activeBucket.value) return;
        editor.value = { mode: "add", id: null, text: "", saving: false };
        focusEditor();
      }

      function openEdit(n) {
        if (n.kind !== "memory") return;
        editor.value = { mode: "edit", id: n.id, text: n.text, saving: false };
        focusEditor();
      }

      // Guard against silently losing typed text on Escape / overlay click.
      async function closeEditor() {
        const ed = editor.value;
        if (!ed) return;
        const orig = ed.mode === "edit" ? (nodeMap.value[ed.id] || {}).text : "";
        if (ed.text.trim() && ed.text !== orig) {
          const ok = await window.ArcaConfirm.open({
            title: "Discard changes",
            message: "The editor has unsaved changes. Discard them?",
            confirmLabel: "Discard",
            tone: "danger",
          });
          if (!ok) return;
        }
        editor.value = null;
      }

      async function saveEditor() {
        const ed = editor.value;
        if (!ed) return;
        const content = ed.text.trim();
        if (!content || ed.saving) return;
        ed.saving = true;
        try {
          if (ed.mode === "add") {
            const data = await api("POST", "/memories", { content, bucket: activeBucket.value });
            const c = viewCenterWorld();
            nodes.value.push({
              id: data.memory_id, x: Math.round(c.x - NODE_W / 2), y: Math.round(c.y - NODE_H / 2),
              width: NODE_W, height: NODE_H, text: content, color: null,
              kind: "memory", bucket: activeBucket.value, created_at: new Date().toISOString(),
              target_id: null, target_bucket: null,
            });
            persistPositions();
            editor.value = null;
            flash("Memory added");
          } else {
            const n = nodeMap.value[ed.id];
            if (!n || content === n.text) { editor.value = null; return; }
            await api("PATCH", `/memories/${ed.id}`, { content });
            n.text = content;
            editor.value = null;
            flash("Memory updated");
          }
        } catch (e) {
          ed.saving = false;
          showError((ed.mode === "add" ? "Add" : "Update") + " failed: " + e.message);
        }
      }

      async function deleteNode(n) {
        const ok = await window.ArcaConfirm.open({
          title: "Delete memory",
          message: `Delete "${n.text.slice(0, 80)}${n.text.length > 80 ? "..." : ""}"? Connections will be cleaned up.`,
          confirmLabel: "Delete",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await api("DELETE", `/memories/${n.id}`);
          if (linkSource.value === n.id || linkTarget.value === n.id) cancelLink();
          nodes.value = nodes.value.filter(x => x.id !== n.id);
          edges.value = edges.value.filter(e => e.fromNode !== n.id && e.toNode !== n.id);
          pruneStubs();
          persistPositions();
          flash("Memory deleted");
        } catch (e) {
          showError("Delete failed: " + e.message);
        }
      }

      function pruneStubs() {
        const referenced = new Set(edges.value.map(e => e.toNode));
        nodes.value = nodes.value.filter(n => n.kind !== "external" || referenced.has(n.id));
      }

      // ── Connections ────────────────────────────────────────
      function startLink(n) {
        if (n.kind !== "memory") return;
        selectedEdge.value = null;
        linkSource.value = n.id;
        linkTarget.value = null;
        relType.value = "";
        flash("Select a target node");
      }

      function cancelLink() {
        linkSource.value = null;
        linkTarget.value = null;
        relType.value = "";
      }

      async function confirmLink() {
        const rel = relType.value.trim();
        if (!rel || !linkSource.value || !linkTarget.value) return;
        try {
          await api("POST", "/memories/connect", {
            source_id: linkSource.value,
            target_id: linkTarget.value,
            relationship_type: rel,
          });
          const id = `${linkSource.value}->${linkTarget.value}#${rel}`;
          if (!edges.value.some(e => e.id === id)) {
            edges.value.push({
              id, fromNode: linkSource.value, toNode: linkTarget.value, label: rel, external: false,
            });
          }
          flash("Connected");
          cancelLink();
        } catch (e) {
          showError("Connect failed: " + e.message);
        }
      }

      function selectEdge(e) {
        selectedEdge.value = selectedEdge.value === e.id ? null : e.id;
      }

      async function disconnectSelected() {
        const e = edges.value.find(x => x.id === selectedEdge.value);
        if (!e) return;
        const tgtNode = nodeMap.value[e.toNode];
        const target = tgtNode && tgtNode.kind === "external" ? tgtNode.target_id : e.toNode;
        try {
          await api("POST", "/memories/disconnect", {
            source_id: e.fromNode,
            target_id: target,
            relationship_type: e.label,
          });
          edges.value = edges.value.filter(x => x.id !== e.id);
          pruneStubs();
          selectedEdge.value = null;
          flash("Disconnected");
        } catch (err) {
          showError("Disconnect failed: " + err.message);
        }
      }

      // ── Lifecycle ──────────────────────────────────────────
      // Deep link: /canvas?bucket=<name>&focus=<memory-id> (e.g. the timeline's
      // "Map" action). Consumed by the first reload after buckets are known.
      const urlParams = new URLSearchParams(location.search);
      let pendingBucket = urlParams.get("bucket");
      let pendingFocus = urlParams.get("focus");

      async function reload() {
        localStorage.setItem("arca_namespace", namespace.value || "default");
        await Promise.all([loadNamespaces(), loadBuckets()]);
        if (buckets.value.length) {
          if (pendingBucket && buckets.value.includes(pendingBucket)) {
            activeBucket.value = pendingBucket;
          } else if (!activeBucket.value || !buckets.value.includes(activeBucket.value)) {
            activeBucket.value = buckets.value.includes("default") ? "default" : buckets.value[0];
          }
          const focus = pendingFocus;
          pendingBucket = null;
          pendingFocus = null;
          await loadCanvas(focus);
        } else {
          activeBucket.value = null;
          nodes.value = [];
          edges.value = [];
        }
      }

      shared.onReload = reload;
      shared.onNamespaceChange = reload;
      shared.onDisconnect = () => {
        activeBucket.value = null;
        nodes.value = [];
        edges.value = [];
      };

      onMounted(() => {
        window.addEventListener("keydown", (ev) => {
          if (ev.key !== "Escape") return;
          const dlg = document.getElementById("confirm-dialog");
          if (dlg && dlg.open) return; // the confirm dialog handles its own Escape
          if (editor.value) {
            // Consume the key: its browser close-request would otherwise instantly
            // cancel the confirm dialog that closeEditor may open synchronously.
            ev.preventDefault();
            closeEditor();
          } else if (linkSource.value) {
            cancelLink();
          } else if (selectedEdge.value) {
            selectedEdge.value = null;
          }
        });
        window.addEventListener("resize", measureWrap);
        nextTick(() => {
          measureWrap();
          if (authKey.value) reload();
        });
      });

      return {
        // Auth
        authKey, authKeyInput, namespace, namespaces, connected,
        saveAuth, disconnectAuth,
        // Data
        buckets, activeBucket, nodes, edges,
        memoryCount, externalCount,
        // View
        wrap, view, gTransform, layerStyle, nodeStyle, visibleNodes, visibleEdges, lod, nodeLod, clipText,
        lod2, lodNodeRects, lodEdgePaths,
        nodeQuery, nodeMatches, nodeMatchPos, foundId, findNode,
        showNsForm, newNsName, createNamespace,
        xTicks, yTicks, maximized, maxLabel, toggleMaximize,
        panning, linkSource, linkTarget, relType, selectedEdge, selectedEdgeInfo,
        // Pointer
        onBgPointerDown, onEdgePointerDown, onNodePointerDown, onNodeClick, onPointerMove, onPointerUp, onWheel,
        relayout, fitView,
        // Add / edit / delete
        editor, editorField, openAdd, openEdit, closeEditor, saveEditor, deleteNode,
        // Connections
        startLink, cancelLink, confirmLink, selectEdge, disconnectSelected, openExternal,
        // Loading
        loading, error, success,
        reload, loadCanvas,
      };
    },
  }).mount("#canvas-app");
});
