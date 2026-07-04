// Shared state and helpers for the memory / canvas dashboards.
// Plain script (no build step): exposes window.ArcaShared. Each page calls
// ArcaShared.create(Vue) inside its setup() and spreads the result into scope,
// then assigns the page hooks:
//   shared.onReload     — called after a key is accepted (full page data load)
//   shared.onDisconnect — called on disconnect (clear page-specific state)
window.ArcaShared = {
  create(Vue) {
    const { ref } = Vue;

    // ── Auth & connection ──────────────────────────────────
    const authKey = ref(localStorage.getItem("arca_auth_key") || "");
    const authKeyInput = ref("");
    const namespace = ref(localStorage.getItem("arca_namespace") || "default");
    const namespaces = ref([namespace.value]);
    const connected = ref(false);
    const buckets = ref([]);

    // ── Toasts ─────────────────────────────────────────────
    const error = ref(null);
    const success = ref(null);
    let successTimer = null;
    let errorTimer = null;

    function flash(msg) {
      success.value = msg;
      clearTimeout(successTimer);
      successTimer = setTimeout(() => { success.value = null; }, 2500);
    }

    function showError(msg) {
      error.value = msg;
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => { error.value = null; }, 5000);
    }

    // ── API helper ─────────────────────────────────────────
    function headers() {
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authKey.value}`,
        "X-Namespace": namespace.value || "default",
      };
    }

    // Surface the JSON `detail` when the error body has one; raw text otherwise.
    async function errorDetail(res) {
      const text = await res.text();
      try {
        const detail = JSON.parse(text).detail;
        if (typeof detail === "string" && detail) return `${res.status}: ${detail}`;
      } catch {
        // not JSON
      }
      return `${res.status}: ${text}`;
    }

    async function api(method, path, body) {
      const opts = { method, headers: headers() };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(`/v1${path}`, opts);
      if (!res.ok) throw new Error(await errorDetail(res));
      return res.json();
    }

    // ── Namespaces & buckets ───────────────────────────────
    async function loadNamespaces() {
      try {
        const data = await api("GET", "/namespaces");
        const list = data.namespaces || [];
        if (!list.includes(namespace.value)) list.push(namespace.value);
        namespaces.value = list.sort();
      } catch {
        // Namespace listing may fail if the table is empty; keep current
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

    // A namespace materializes when its first memory is written; switching to a
    // fresh name is all "creation" means. loadNamespaces keeps the selected name
    // listed even while it is still empty.
    const showNsForm = ref(false);
    const newNsName = ref("");

    function createNamespace() {
      const name = newNsName.value.trim();
      if (!name) return;
      newNsName.value = "";
      showNsForm.value = false;
      if (!namespaces.value.includes(name)) {
        namespaces.value.push(name);
        namespaces.value.sort();
      }
      namespace.value = name;
      if (shared.onNamespaceChange) shared.onNamespaceChange();
    }

    // localStorage key for a bucket's canvas layout. Shared so the memory page
    // can migrate / drop the layout when a bucket is renamed or cleared.
    function canvasPosKey(bucket) {
      return `arca_canvas_pos:${namespace.value || "default"}:${bucket}`;
    }

    // ── Auth ───────────────────────────────────────────────
    async function saveAuth() {
      const key = authKeyInput.value.trim();
      if (!key) return;
      // Probe before persisting so a mistyped key isn't silently stored.
      try {
        const res = await fetch("/v1/buckets", {
          headers: {
            "Authorization": `Bearer ${key}`,
            "X-Namespace": namespace.value || "default",
          },
        });
        if (res.status === 401 || res.status === 403) {
          showError("Invalid API key");
          return;
        }
        if (!res.ok) {
          showError("Connect failed: " + (await errorDetail(res)));
          return;
        }
      } catch (e) {
        showError("Cannot reach server: " + e.message);
        return;
      }
      authKey.value = key;
      authKeyInput.value = "";
      localStorage.setItem("arca_auth_key", key);
      if (shared.onReload) shared.onReload();
    }

    function disconnectAuth() {
      authKey.value = "";
      localStorage.removeItem("arca_auth_key");
      connected.value = false;
      buckets.value = [];
      namespaces.value = ["default"];
      if (shared.onDisconnect) shared.onDisconnect();
    }

    const shared = {
      authKey, authKeyInput, namespace, namespaces, connected, buckets,
      error, success, flash, showError,
      api, loadNamespaces, loadBuckets, saveAuth, disconnectAuth,
      showNsForm, newNsName, createNamespace, canvasPosKey,
      onReload: null,
      onDisconnect: null,
      onNamespaceChange: null,
    };
    return shared;
  },
};
