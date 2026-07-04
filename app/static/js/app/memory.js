document.addEventListener("DOMContentLoaded", () => {
  const { createApp, ref, computed, onMounted, nextTick } = Vue;

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
      const memories = ref([]);
      const isSearchResult = ref(false);
      const searchQuery = ref("");

      // ── Pagination (recent memories list) ──────────────────
      const page = ref(0);
      const pageSize = ref(50);
      const total = ref(0);
      const pageStart = computed(() => (total.value === 0 ? 0 : page.value * pageSize.value + 1));
      const pageEnd = computed(() => Math.min((page.value + 1) * pageSize.value, total.value));
      const hasPrevPage = computed(() => page.value > 0);
      const hasNextPage = computed(() => (page.value + 1) * pageSize.value < total.value);

      // ── Add memory ─────────────────────────────────────────
      const showAddForm = ref(false);
      const newMemory = ref({ content: "", bucket: "", newBucket: "" });
      const saving = ref(false);

      // ── Ingest document ────────────────────────────────────
      const showIngestForm = ref(false);
      const ingestFiles = ref([]);         // one or more selected files, ingested into one bucket
      const ingestBucket = ref("");        // "" = derive from file name, a bucket name, or "__new__"
      const ingestNewBucket = ref("");     // name typed when ingestBucket === "__new__"
      const ingestReplace = ref(false);
      const ingestCreateParent = ref(false);  // opt-in: anchor the chunks to a parent node
      const ingestParentContent = ref("");    // parent node content (blank → file name / bucket name)
      const ingesting = ref(false);
      const ingestProgress = ref("");      // "3 / 10" while a multi-file batch uploads
      const ingestDragging = ref(false);
      const ingestAvailable = ref(true);   // optimistic until /ingest/formats answers
      const supportedFormats = ref([]);    // file extensions the server can actually parse
      const acceptAttr = computed(() => supportedFormats.value.join(","));
      const formatsLabel = computed(() =>
        supportedFormats.value.length ? supportedFormats.value.join(", ") : ".txt, .md"
      );
      const ingestTotalKb = computed(() =>
        (ingestFiles.value.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)
      );
      // Resolved target bucket: "" means "let the server derive it from the file name".
      const ingestEffectiveBucket = computed(() =>
        ingestBucket.value === "__new__" ? ingestNewBucket.value.trim() : ingestBucket.value
      );
      // A target bucket is required when ingesting more than one file (no single filename to derive from).
      const canIngest = computed(() =>
        ingestFiles.value.length > 0 && !ingesting.value &&
        !(ingestBucket.value === "__new__" && !ingestNewBucket.value.trim()) &&
        !(ingestFiles.value.length > 1 && !ingestEffectiveBucket.value)
      );

      // ── Inline edit ────────────────────────────────────────
      const editingId = ref(null);
      const editContent = ref("");
      const editBucket = ref("");
      const editNewBucket = ref("");
      const updatingId = ref(null);

      // ── Connections ────────────────────────────────────────
      const expandedId = ref(null);
      const newEdge = ref({ query: "", targetId: "", relType: "" });
      const edgeResults = ref([]);
      const edgeSearching = ref(false);

      // ── Bucket management ──────────────────────────────────
      const showBucketForm = ref(false);
      const newBucketName = ref("");
      const renamingBucket = ref(null);
      const renameBucketValue = ref("");

      // ── UI state ───────────────────────────────────────────
      const loading = ref(false);
      const searching = ref(false);

      // ── Buckets ────────────────────────────────────────────

      // Buckets only materialize server-side when their first memory lands, so
      // UI-created names are tracked here and merged into every bucket refresh —
      // otherwise they'd silently vanish on the next reload.
      const pendingBuckets = new Set();

      function mergePendingBuckets() {
        for (const name of [...pendingBuckets]) {
          if (buckets.value.includes(name)) pendingBuckets.delete(name);
          else buckets.value.push(name);
        }
        if (pendingBuckets.size) buckets.value.sort();
      }

      async function refreshBuckets() {
        await loadBuckets();
        mergePendingBuckets();
      }

      async function createBucket() {
        const name = newBucketName.value.trim();
        if (!name) return;
        if (buckets.value.includes(name)) {
          showError("Bucket already exists");
          return;
        }
        pendingBuckets.add(name);
        buckets.value.push(name);
        buckets.value.sort();
        newBucketName.value = "";
        showBucketForm.value = false;
        flash(`Bucket "${name}" ready — it persists once a memory is added`);
      }

      function startRenameBucket(name) {
        renamingBucket.value = name;
        renameBucketValue.value = name;
      }

      async function confirmRenameBucket(oldName) {
        const newName = renameBucketValue.value.trim();
        if (!newName || newName === oldName) {
          renamingBucket.value = null;
          return;
        }
        try {
          await api("POST", "/buckets/rename", { old_name: oldName, new_name: newName });
          renamingBucket.value = null;
          flash(`Bucket renamed to "${newName}"`);
          if (activeBucket.value === oldName) activeBucket.value = newName;
          // Carry the canvas layout over to the renamed bucket.
          const savedLayout = localStorage.getItem(canvasPosKey(oldName));
          if (savedLayout) {
            localStorage.setItem(canvasPosKey(newName), savedLayout);
            localStorage.removeItem(canvasPosKey(oldName));
          }
          await reload();
        } catch (e) {
          showError("Rename failed: " + e.message);
        }
      }

      async function clearBucket(name) {
        const ok = await window.ArcaConfirm.open({
          title: "Clear bucket",
          message: `This will permanently delete ALL memories in "${name}". This cannot be undone.`,
          confirmLabel: "Clear all",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await api("DELETE", `/memories?bucket=${encodeURIComponent(name)}`);
          flash(`Bucket "${name}" cleared`);
          if (activeBucket.value === name) activeBucket.value = null;
          localStorage.removeItem(canvasPosKey(name));
          await reload();
        } catch (e) {
          showError("Clear failed: " + e.message);
        }
      }

      function selectBucket(b) {
        activeBucket.value = b;
        page.value = 0;
        if (isSearchResult.value) {
          searchMemories();
        } else {
          loadMemories();
        }
      }

      // ── Memories ───────────────────────────────────────────

      async function loadMemories() {
        loading.value = true;
        isSearchResult.value = false;
        try {
          const body = { n: pageSize.value, offset: page.value * pageSize.value };
          if (activeBucket.value) body.bucket = activeBucket.value;
          const data = await api("POST", "/memories/last", body);
          memories.value = data.results || [];
          total.value = data.total ?? memories.value.length;
        } catch (e) {
          showError("Failed to load memories: " + e.message);
        } finally {
          loading.value = false;
        }
      }

      function nextPage() {
        if (!hasNextPage.value) return;
        page.value++;
        loadMemories();
      }

      function prevPage() {
        if (!hasPrevPage.value) return;
        page.value--;
        loadMemories();
      }

      function changePageSize() {
        page.value = 0;
        loadMemories();
      }

      async function searchMemories() {
        if (!searchQuery.value.trim()) return;
        searching.value = true;
        try {
          const body = { query: searchQuery.value, top_k: 20 };
          if (activeBucket.value) body.bucket = activeBucket.value;
          const data = await api("POST", "/memories/search", body);
          memories.value = data.results || [];
          isSearchResult.value = true;
        } catch (e) {
          showError("Search failed: " + e.message);
        } finally {
          searching.value = false;
        }
      }

      function clearSearch() {
        searchQuery.value = "";
        isSearchResult.value = false;
        page.value = 0;
        loadMemories();
      }

      async function addMemory() {
        if (!newMemory.value.content.trim()) return;
        saving.value = true;
        try {
          const body = { content: newMemory.value.content };
          // Dropdown value is a bucket name, "" (default bucket), or "__new__" (use the typed name).
          const bucket = newMemory.value.bucket === "__new__"
            ? newMemory.value.newBucket.trim()
            : newMemory.value.bucket.trim();
          if (bucket) body.bucket = bucket;
          await api("POST", "/memories", body);
          newMemory.value = { content: "", bucket: "", newBucket: "" };
          showAddForm.value = false;
          flash("Memory saved");
          await reload();
        } catch (e) {
          showError("Failed to save: " + e.message);
        } finally {
          saving.value = false;
        }
      }

      // ── Ingest document ────────────────────────────────────

      async function loadIngestFormats() {
        try {
          const data = await api("GET", "/ingest/formats");
          ingestAvailable.value = data.available;
          supportedFormats.value = data.extensions || [];
        } catch {
          // Non-fatal: keep optimistic defaults so ingestion still works if the probe fails.
        }
      }

      function extOf(name) {
        const i = name.lastIndexOf(".");
        return i === -1 ? "" : name.slice(i).toLowerCase();
      }

      function setIngestFiles(fileList) {
        const incoming = Array.from(fileList || []);
        if (!incoming.length) return;
        const exts = supportedFormats.value;
        const accepted = [];
        const rejected = [];
        for (const f of incoming) {
          // Drag-and-drop bypasses the file picker's `accept`, so validate here too.
          if (exts.length && !exts.includes(extOf(f.name))) rejected.push(f.name);
          else accepted.push(f);
        }
        if (rejected.length) {
          showError(`Unsupported file type(s): ${rejected.join(", ")}. Supported: ${exts.join(", ")}`);
        }
        if (accepted.length) ingestFiles.value = accepted;
      }

      function onIngestPick(e) {
        setIngestFiles(e.target.files);
        e.target.value = "";  // allow re-picking the same file(s) later
      }

      function onIngestDrop(e) {
        ingestDragging.value = false;
        setIngestFiles(e.dataTransfer.files);
      }

      async function ingestDocument() {
        if (!ingestFiles.value.length) return;
        const files = ingestFiles.value.slice();
        const bucketOverride = ingestEffectiveBucket.value;
        if (files.length > 1 && !bucketOverride) {
          showError("Choose a target bucket for multiple files");
          return;
        }
        const createParent = ingestCreateParent.value;
        // Parent content defaults to the bucket name for a batch (no single filename to use);
        // for a lone file a blank content lets the server fall back to the file name.
        const parentContent = ingestParentContent.value.trim() || (files.length > 1 ? bucketOverride : "");

        ingesting.value = true;
        ingestProgress.value = "";
        let okCount = 0, skipCount = 0, chunkTotal = 0;
        const failures = [];
        let targetBucket = bucketOverride || null;
        let sharedParentId = null;  // first file creates the parent; the rest attach to it
        try {
          for (let i = 0; i < files.length; i++) {
            ingestProgress.value = files.length > 1 ? `${i + 1} / ${files.length}` : "";
            const form = new FormData();
            form.append("file", files[i]);
            if (bucketOverride) form.append("bucket", bucketOverride);
            // "Replace existing" clears the whole bucket; for a batch do it once (on the first
            // file) so later files append rather than wiping their predecessors.
            form.append("replace", String(ingestReplace.value && i === 0));
            if (!createParent) {
              form.append("parent", "false");
            } else if (sharedParentId) {
              form.append("parent_id", sharedParentId);  // share one parent across the batch
            } else if (parentContent) {
              form.append("parent_content", parentContent);
            }
            try {
              // Multipart upload: let the browser set Content-Type (with boundary), so we
              // can't reuse the JSON `api()` helper.
              const res = await fetch("/v1/ingest", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${authKey.value}`,
                  "X-Namespace": namespace.value || "default",
                },
                body: form,
              });
              if (!res.ok) {
                const detail = await res.text();
                throw new Error(`${res.status}: ${detail}`);
              }
              const data = await res.json();
              targetBucket = data.bucket;  // server-sanitized name (single file: derived from filename)
              chunkTotal += data.chunks;
              if (data.parent_id && !sharedParentId) sharedParentId = data.parent_id;
              if (data.skipped) skipCount++; else okCount++;
            } catch (e) {
              failures.push(`${files[i].name}: ${e.message}`);
            }
          }
        } finally {
          ingesting.value = false;
          ingestProgress.value = "";
        }

        // Reset the form before reporting / navigating.
        showIngestForm.value = false;
        ingestFiles.value = [];
        ingestBucket.value = "";
        ingestNewBucket.value = "";
        ingestReplace.value = false;
        ingestCreateParent.value = false;
        ingestParentContent.value = "";

        if (failures.length) {
          showError(`Ingest failed for ${failures.length} file(s): ${failures.join("; ")}`);
        }
        if (okCount || skipCount) {
          const parts = [];
          if (okCount) parts.push(`${okCount} ingested (${chunkTotal} chunk${chunkTotal === 1 ? "" : "s"})`);
          if (skipCount) parts.push(`${skipCount} unchanged`);
          flash(`${parts.join(", ")}${targetBucket ? ` → "${targetBucket}"` : ""}`);
          // Post-success refresh; loadBuckets / loadMemories handle their own errors so a
          // hiccup here never mislabels a successful ingest as a failure.
          await refreshBuckets();
          isSearchResult.value = false;
          if (targetBucket) selectBucket(targetBucket);
        }
      }

      async function deleteMemory(m) {
        const ok = await window.ArcaConfirm.open({
          title: "Delete memory",
          message: `Delete "${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}"? Connections will be cleaned up automatically.`,
          confirmLabel: "Delete",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await api("DELETE", `/memories/${m.memory_id}`);
          memories.value = memories.value.filter(x => x.memory_id !== m.memory_id);
          if (expandedId.value === m.memory_id) expandedId.value = null;
          if (total.value > 0) total.value--;
          flash("Memory deleted");
          // If we emptied a non-first page, step back so the list isn't blank.
          if (!isSearchResult.value && !memories.value.length && page.value > 0) {
            page.value--;
            loadMemories();
          }
          refreshBuckets();
        } catch (e) {
          showError("Delete failed: " + e.message);
        }
      }

      // ── Inline edit ────────────────────────────────────────

      function startEdit(m) {
        editingId.value = m.memory_id;
        editContent.value = m.content;
        editBucket.value = m.bucket;
        editNewBucket.value = "";
        nextTick(() => {
          const el = document.querySelector(".edit-textarea");
          if (el) el.focus();
        });
      }

      function cancelEdit() {
        editingId.value = null;
        editContent.value = "";
        editBucket.value = "";
        editNewBucket.value = "";
      }

      async function saveEdit(m) {
        // Dropdown value is a bucket name or "__new__" (use the typed name).
        const bucket = editBucket.value === "__new__" ? editNewBucket.value.trim() : editBucket.value;
        const updates = {};
        if (editContent.value !== m.content) updates.content = editContent.value;
        if (bucket && bucket !== m.bucket) updates.bucket = bucket;
        if (!Object.keys(updates).length) {
          cancelEdit();
          return;
        }
        updatingId.value = m.memory_id;
        try {
          await api("PATCH", `/memories/${m.memory_id}`, updates);
          m.content = editContent.value;
          if (updates.bucket) m.bucket = updates.bucket;
          cancelEdit();
          flash("Memory updated");
          refreshBuckets();
        } catch (e) {
          showError("Update failed: " + e.message);
        } finally {
          updatingId.value = null;
        }
      }

      // ── Connections ────────────────────────────────────────

      function toggleConnections(m) {
        expandedId.value = expandedId.value === m.memory_id ? null : m.memory_id;
        newEdge.value = { query: "", targetId: "", relType: "" };
        edgeResults.value = [];
      }

      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      // Resolve the link target: a pasted UUID is taken as-is; anything else is a
      // semantic search across the namespace, offering candidates to pick from.
      async function searchEdgeTargets(m) {
        const q = newEdge.value.query.trim();
        if (!q) return;
        if (UUID_RE.test(q)) {
          newEdge.value.targetId = q;
          edgeResults.value = [];
          return;
        }
        edgeSearching.value = true;
        try {
          const data = await api("POST", "/memories/search", { query: q, top_k: 5 });
          edgeResults.value = (data.results || []).filter(r => r.memory_id !== m.memory_id);
          if (!edgeResults.value.length) showError("No matching memories found");
        } catch (e) {
          showError("Search failed: " + e.message);
        } finally {
          edgeSearching.value = false;
        }
      }

      function pickEdgeTarget(r) {
        newEdge.value.targetId = r.memory_id;
      }

      async function addEdge(m) {
        const targetId = newEdge.value.targetId;
        const relType = newEdge.value.relType.trim();
        if (!targetId || !relType) return;
        try {
          await api("POST", "/memories/connect", {
            source_id: m.memory_id,
            target_id: targetId,
            relationship_type: relType,
          });
          m.connected_nodes = [...(m.connected_nodes || []), targetId];
          m.relationship_types = [...(m.relationship_types || []), relType];
          newEdge.value = { query: "", targetId: "", relType: "" };
          edgeResults.value = [];
          flash("Connected");
        } catch (e) {
          showError("Connect failed: " + e.message);
        }
      }

      async function removeEdge(m, targetId, relType) {
        try {
          await api("POST", "/memories/disconnect", {
            source_id: m.memory_id,
            target_id: targetId,
            relationship_type: relType,
          });
          const idx = m.connected_nodes.findIndex(
            (n, i) => n === targetId && m.relationship_types[i] === relType
          );
          if (idx !== -1) {
            m.connected_nodes.splice(idx, 1);
            m.relationship_types.splice(idx, 1);
          }
          flash("Disconnected");
        } catch (e) {
          showError("Disconnect failed: " + e.message);
        }
      }

      // ── Lifecycle ──────────────────────────────────────────

      async function reload() {
        localStorage.setItem("arca_namespace", namespace.value || "default");
        page.value = 0;
        // Independent fetches; each handles its own errors.
        await Promise.all([loadNamespaces(), loadIngestFormats(), refreshBuckets(), loadMemories()]);
      }

      // Switching namespace invalidates the bucket filter, search scope, and
      // any not-yet-materialized bucket names (they are per-namespace).
      function onNsChange() {
        activeBucket.value = null;
        isSearchResult.value = false;
        searchQuery.value = "";
        pendingBuckets.clear();
        reload();
      }

      shared.onReload = reload;
      shared.onNamespaceChange = onNsChange;
      shared.onDisconnect = () => {
        memories.value = [];
        activeBucket.value = null;
      };

      function formatDate(dt) {
        if (!dt) return "-";
        const d = new Date(dt);
        return d.toLocaleString(undefined, {
          month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
        });
      }

      onMounted(() => {
        // Hook from the canvas page: /memory#ingest opens the ingest panel.
        if (location.hash === "#ingest") showIngestForm.value = true;
        if (authKey.value) {
          nextTick(() => reload());
        }
      });

      return {
        // Auth
        authKey, authKeyInput, namespace, namespaces, connected,
        saveAuth, disconnectAuth,
        showNsForm, newNsName, createNamespace,
        // Data
        buckets, activeBucket, memories,
        isSearchResult, searchQuery,
        // Pagination
        page, pageSize, total, pageStart, pageEnd, hasPrevPage, hasNextPage,
        nextPage, prevPage, changePageSize,
        // Add memory
        showAddForm, newMemory, saving,
        addMemory,
        // Ingest document
        showIngestForm, ingestFiles, ingestBucket, ingestNewBucket, ingestReplace,
        ingestCreateParent, ingestParentContent,
        ingesting, ingestProgress, ingestDragging,
        ingestAvailable, supportedFormats, acceptAttr, formatsLabel, ingestTotalKb, canIngest,
        onIngestPick, onIngestDrop, ingestDocument,
        // Inline edit
        editingId, editContent, editBucket, editNewBucket, updatingId,
        startEdit, cancelEdit, saveEdit,
        // Connections
        expandedId, newEdge, edgeResults, edgeSearching,
        toggleConnections, addEdge, removeEdge, searchEdgeTargets, pickEdgeTarget,
        // Bucket management
        showBucketForm, newBucketName, renamingBucket, renameBucketValue,
        createBucket, startRenameBucket, confirmRenameBucket, clearBucket,
        // Actions
        loading, searching, error, success,
        reload, onNsChange, loadBuckets, loadMemories,
        searchMemories, clearSearch, deleteMemory,
        selectBucket, formatDate,
      };
    },
  }).mount("#memory-app");
});
