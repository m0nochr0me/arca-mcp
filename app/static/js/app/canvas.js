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

  createApp({
    setup() {
      // ── Auth & connection ──────────────────────────────────
      const authKey = ref(localStorage.getItem("arca_auth_key") || "");
      const authKeyInput = ref("");
      const namespace = ref(localStorage.getItem("arca_namespace") || "default");
      const namespaces = ref([localStorage.getItem("arca_namespace") || "default"]);
      const connected = ref(false);

      // ── Data ───────────────────────────────────────────────
      const buckets = ref([]);
      const activeBucket = ref(null);
      const nodes = ref([]);
      const edges = ref([]);

      // ── View transform (world -> screen) ───────────────────
      const view = reactive({ x: 0, y: 0, scale: 1 });
      const wrap = ref(null);
      const wrapW = ref(0);
      const wrapH = ref(0);

      // ── Interaction state ──────────────────────────────────
      const drag = ref(null); // { id, dx, dy, sx, sy }
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
      const error = ref(null);
      const success = ref(null);
      let successTimer = null;

      function flash(msg) {
        success.value = msg;
        clearTimeout(successTimer);
        successTimer = setTimeout(() => { success.value = null; }, 2500);
      }

      function showError(msg) {
        error.value = msg;
        setTimeout(() => { if (error.value === msg) error.value = null; }, 5000);
      }

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
              id: e.id, external: e.external, label: e.label,
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
            id: e.id, external: e.external, label: e.label,
            d: `M ${p1.x},${p1.y} L ${p2.x},${p2.y}`,
            mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2,
          });
        }
        return out;
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

      // ── Position persistence (localStorage, per namespace+bucket) ──
      function posKey() {
        return `arca_canvas_pos:${namespace.value || "default"}:${activeBucket.value}`;
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

      // ── API helper ─────────────────────────────────────────
      function headers() {
        return {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authKey.value}`,
          "X-Namespace": namespace.value || "default",
        };
      }

      async function api(method, path, body) {
        const opts = { method, headers: headers() };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const res = await fetch(`/v1${path}`, opts);
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`${res.status}: ${detail}`);
        }
        return res.json();
      }

      // ── Loading ────────────────────────────────────────────
      async function loadNamespaces() {
        try {
          const data = await api("GET", "/namespaces");
          const list = data.namespaces || [];
          if (!list.includes(namespace.value)) list.push(namespace.value);
          namespaces.value = list.sort();
        } catch {
          // ignore — table may be empty
        }
      }

      async function loadBuckets() {
        try {
          const data = await api("GET", "/buckets");
          buckets.value = data.buckets || [];
          connected.value = true;
        } catch (e) {
          connected.value = false;
          if (authKey.value) showError("Failed to load buckets: " + e.message);
        }
      }

      async function loadCanvas(focusId) {
        if (!activeBucket.value) return;
        loading.value = true;
        cancelLink();
        selectedEdge.value = null;
        editor.value = null;
        try {
          const data = await api("GET", `/canvas?bucket=${encodeURIComponent(activeBucket.value)}`);
          nodes.value = (data.nodes || []).map(n => ({
            id: n.id, x: n.x, y: n.y, width: n.width, height: n.height,
            text: n.text, color: n.color || null,
            kind: n.arca.kind, bucket: n.arca.bucket || null,
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
            relayout();
          }

          await nextTick();
          if (focusId) {
            const fn = nodes.value.find(x => x.id === focusId);
            if (fn) centerOn(fn);
          }
        } catch (e) {
          showError("Failed to load canvas: " + e.message);
        } finally {
          loading.value = false;
        }
      }

      // ── Layout ─────────────────────────────────────────────
      // Force-directed (Fruchterman-Reingold) layout of *items*, with a gravity
      // term toward the centroid so disconnected components stay packed together
      // instead of drifting apart. Mutates each item's x/y in place.
      function forceLayout(items) {
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
      function relayout() {
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
          const boxes = connectedComponents(connected).map(comp => {
            forceLayout(comp);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const d of comp) {
              minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
              maxX = Math.max(maxX, d.x + d.width); maxY = Math.max(maxY, d.y + d.height);
            }
            for (const d of comp) { d.x -= minX; d.y -= minY; }
            return { comp, w: maxX - minX, h: maxY - minY };
          });
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
      }

      function centerOn(n) {
        const w = wrap.value;
        if (!w) return;
        const rect = w.getBoundingClientRect();
        view.x = rect.width / 2 - (n.x + n.width / 2) * view.scale;
        view.y = rect.height / 2 - (n.y + n.height / 2) * view.scale;
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

      function onBgPointerDown(ev) {
        selectedEdge.value = null;
        panning.value = { sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
      }

      function onNodePointerDown(ev, n) {
        if (linkSource.value) {
          if (n.kind === "external") { showError("Pick a memory node as the target"); return; }
          if (n.id === linkSource.value) { showError("Cannot link a node to itself"); cancelLink(); return; }
          linkTarget.value = n.id;
          return;
        }
        const w = toWorld(ev);
        movedDuringDrag.value = false;
        drag.value = { id: n.id, dx: w.x - n.x, dy: w.y - n.y, sx: ev.clientX, sy: ev.clientY };
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
          const n = nodeMap.value[drag.value.id];
          if (n) { n.x = w.x - drag.value.dx; n.y = w.y - drag.value.dy; }
          return;
        }
        if (panning.value) {
          view.x = panning.value.ox + (ev.clientX - panning.value.sx);
          view.y = panning.value.oy + (ev.clientY - panning.value.sy);
        }
      }

      function onPointerUp() {
        if (drag.value) {
          justDragged.value = movedDuringDrag.value;
          if (movedDuringDrag.value) persistPositions();
        }
        drag.value = null;
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

      function closeEditor() {
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
            closeEditor();
            flash("Memory added");
          } else {
            const n = nodeMap.value[ed.id];
            if (!n || content === n.text) { closeEditor(); return; }
            await api("PATCH", `/memories/${ed.id}`, { content });
            n.text = content;
            closeEditor();
            flash("Memory updated");
          }
        } catch (e) {
          ed.saving = false;
          showError((ed.mode === "add" ? "Add" : "Update") + " failed: " + e.message);
        }
      }

      async function deleteNode(n) {
        const ok = await window.PillbugDashboardConfirm.open({
          title: "Delete memory",
          message: `Delete "${n.text.slice(0, 80)}${n.text.length > 80 ? "..." : ""}"? Connections will be cleaned up.`,
          confirmLabel: "Delete",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await api("DELETE", `/memories/${n.id}`);
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

      // ── Auth ───────────────────────────────────────────────
      function saveAuth() {
        if (!authKeyInput.value.trim()) return;
        authKey.value = authKeyInput.value.trim();
        authKeyInput.value = "";
        localStorage.setItem("arca_auth_key", authKey.value);
        reload();
      }

      function disconnectAuth() {
        authKey.value = "";
        localStorage.removeItem("arca_auth_key");
        connected.value = false;
        buckets.value = [];
        nodes.value = [];
        edges.value = [];
        namespaces.value = ["default"];
      }

      // ── Lifecycle ──────────────────────────────────────────
      async function reload() {
        localStorage.setItem("arca_namespace", namespace.value || "default");
        await loadNamespaces();
        await loadBuckets();
        if (buckets.value.length) {
          if (!activeBucket.value || !buckets.value.includes(activeBucket.value)) {
            activeBucket.value = buckets.value.includes("default") ? "default" : buckets.value[0];
          }
          await loadCanvas();
        } else {
          activeBucket.value = null;
          nodes.value = [];
          edges.value = [];
        }
      }

      onMounted(() => {
        window.addEventListener("keydown", (ev) => {
          if (ev.key !== "Escape") return;
          if (editor.value) closeEditor();
          else if (linkSource.value) cancelLink();
          else if (selectedEdge.value) selectedEdge.value = null;
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
        wrap, view, gTransform, layerStyle, nodeStyle, edgeGeo,
        xTicks, yTicks, maximized, maxLabel, toggleMaximize,
        panning, linkSource, linkTarget, relType, selectedEdge, selectedEdgeInfo,
        // Pointer
        onBgPointerDown, onNodePointerDown, onNodeClick, onPointerMove, onPointerUp, onWheel,
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
