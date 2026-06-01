document.addEventListener("DOMContentLoaded", () => {
  const { createApp, ref, computed, onMounted, nextTick } = Vue;

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
      const newMemory = ref({ content: "", bucket: "" });
      const saving = ref(false);

      // ── Ingest document ────────────────────────────────────
      const showIngestForm = ref(false);
      const ingestFile = ref(null);
      const ingestBucket = ref("");
      const ingestReplace = ref(false);
      const ingesting = ref(false);
      const ingestDragging = ref(false);
      const ingestAvailable = ref(true);   // optimistic until /ingest/formats answers
      const supportedFormats = ref([]);    // file extensions the server can actually parse
      const acceptAttr = computed(() => supportedFormats.value.join(","));
      const formatsLabel = computed(() =>
        supportedFormats.value.length ? supportedFormats.value.join(", ") : ".txt, .md"
      );

      // ── Inline edit ────────────────────────────────────────
      const editingId = ref(null);
      const editContent = ref("");
      const editBucket = ref("");
      const updatingId = ref(null);

      // ── Connections ────────────────────────────────────────
      const expandedId = ref(null);
      const newEdge = ref({ targetId: "", relType: "" });

      // ── Bucket management ──────────────────────────────────
      const showBucketForm = ref(false);
      const newBucketName = ref("");
      const renamingBucket = ref(null);
      const renameBucketValue = ref("");

      // ── UI state ───────────────────────────────────────────
      const loading = ref(false);
      const searching = ref(false);
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

      // ── Namespaces ─────────────────────────────────────────

      async function loadNamespaces() {
        try {
          const data = await api("GET", "/namespaces");
          const list = data.namespaces || [];
          if (!list.includes(namespace.value)) list.push(namespace.value);
          namespaces.value = list.sort();
        } catch {
          // Namespace listing may fail if table is empty; keep current
        }
      }

      // ── Buckets ────────────────────────────────────────────

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

      async function createBucket() {
        const name = newBucketName.value.trim();
        if (!name) return;
        // Create an empty memory to initialise the bucket, then immediately delete it.
        // OR simpler: just add the bucket name to the local list and it will be
        // materialised when the first memory is added. For UX, we do the latter.
        if (buckets.value.includes(name)) {
          showError("Bucket already exists");
          return;
        }
        buckets.value.push(name);
        buckets.value.sort();
        newBucketName.value = "";
        showBucketForm.value = false;
        flash(`Bucket "${name}" ready`);
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
          await reload();
        } catch (e) {
          showError("Rename failed: " + e.message);
        }
      }

      async function clearBucket(name) {
        const ok = await window.PillbugDashboardConfirm.open({
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
          if (newMemory.value.bucket.trim()) body.bucket = newMemory.value.bucket.trim();
          await api("POST", "/memories", body);
          newMemory.value = { content: "", bucket: "" };
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

      function setIngestFile(f) {
        if (!f) return;
        const exts = supportedFormats.value;
        // Drag-and-drop bypasses the file picker's `accept`, so validate here too.
        if (exts.length && !exts.includes(extOf(f.name))) {
          showError(`Unsupported file type "${extOf(f.name) || f.name}". Supported: ${exts.join(", ")}`);
          return;
        }
        ingestFile.value = f;
      }

      function onIngestPick(e) {
        setIngestFile(e.target.files && e.target.files[0]);
        e.target.value = "";  // allow re-picking the same file later
      }

      function onIngestDrop(e) {
        ingestDragging.value = false;
        setIngestFile(e.dataTransfer.files && e.dataTransfer.files[0]);
      }

      async function ingestDocument() {
        if (!ingestFile.value) return;
        ingesting.value = true;
        try {
          const form = new FormData();
          form.append("file", ingestFile.value);
          if (ingestBucket.value.trim()) form.append("bucket", ingestBucket.value.trim());
          form.append("replace", String(ingestReplace.value));
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
          showIngestForm.value = false;
          ingestFile.value = null;
          ingestBucket.value = "";
          ingestReplace.value = false;
          if (data.skipped) {
            flash(`Unchanged — "${data.bucket}" already ingested`);
          } else {
            flash(`Ingested -> "${data.bucket}" (${data.chunks} chunk${data.chunks === 1 ? "" : "s"})`);
          }
          await loadBuckets();
          isSearchResult.value = false;
          selectBucket(data.bucket);  // jump straight to the per-document bucket
        } catch (e) {
          showError("Ingest failed: " + e.message);
        } finally {
          ingesting.value = false;
        }
      }

      async function deleteMemory(m) {
        const ok = await window.PillbugDashboardConfirm.open({
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
          loadBuckets();
        } catch (e) {
          showError("Delete failed: " + e.message);
        }
      }

      // ── Inline edit ────────────────────────────────────────

      function startEdit(m) {
        editingId.value = m.memory_id;
        editContent.value = m.content;
        editBucket.value = m.bucket;
      }

      function cancelEdit() {
        editingId.value = null;
        editContent.value = "";
        editBucket.value = "";
      }

      async function saveEdit(m) {
        const updates = {};
        if (editContent.value !== m.content) updates.content = editContent.value;
        if (editBucket.value !== m.bucket) updates.bucket = editBucket.value;
        if (!Object.keys(updates).length) {
          cancelEdit();
          return;
        }
        updatingId.value = m.memory_id;
        try {
          await api("PATCH", `/memories/${m.memory_id}`, updates);
          m.content = editContent.value;
          m.bucket = editBucket.value;
          cancelEdit();
          flash("Memory updated");
          loadBuckets();
        } catch (e) {
          showError("Update failed: " + e.message);
        } finally {
          updatingId.value = null;
        }
      }

      // ── Connections ────────────────────────────────────────

      function toggleConnections(m) {
        expandedId.value = expandedId.value === m.memory_id ? null : m.memory_id;
        newEdge.value = { targetId: "", relType: "" };
      }

      async function addEdge(m) {
        const targetId = newEdge.value.targetId.trim();
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
          newEdge.value = { targetId: "", relType: "" };
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
        memories.value = [];
        namespaces.value = ["default"];
      }

      // ── Lifecycle ──────────────────────────────────────────

      async function reload() {
        localStorage.setItem("arca_namespace", namespace.value || "default");
        page.value = 0;
        await loadNamespaces();
        await loadIngestFormats();
        await loadBuckets();
        await loadMemories();
      }

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
        showIngestForm, ingestFile, ingestBucket, ingestReplace, ingesting, ingestDragging,
        ingestAvailable, supportedFormats, acceptAttr, formatsLabel,
        onIngestPick, onIngestDrop, ingestDocument,
        // Inline edit
        editingId, editContent, editBucket, updatingId,
        startEdit, cancelEdit, saveEdit,
        // Connections
        expandedId, newEdge,
        toggleConnections, addEdge, removeEdge,
        // Bucket management
        showBucketForm, newBucketName, renamingBucket, renameBucketValue,
        createBucket, startRenameBucket, confirmRenameBucket, clearBucket,
        // Actions
        loading, searching, error, success,
        reload, loadBuckets, loadMemories,
        searchMemories, clearSearch, deleteMemory,
        selectBucket, formatDate,
      };
    },
  }).mount("#memory-app");
});
