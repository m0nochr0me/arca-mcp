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
          await loadBuckets();
          isSearchResult.value = false;
          if (targetBucket) selectBucket(targetBucket);
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
        showIngestForm, ingestFiles, ingestBucket, ingestNewBucket, ingestReplace,
        ingestCreateParent, ingestParentContent,
        ingesting, ingestProgress, ingestDragging,
        ingestAvailable, supportedFormats, acceptAttr, formatsLabel, ingestTotalKb, canIngest,
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
