(() => {
  // Guard chống inject nhiều lần trong SPA
  if (window.__KANBAN_BRIDGE_LOADED__) return;
  window.__KANBAN_BRIDGE_LOADED__ = true;

  console.log("Kanban Bridge content.js LOADED (guarded)");

  const ENDPOINT = "https://kanban-agent.voanhquan-hcm.workers.dev/events";

  // =========================
  // Inject injected.js vào page (MAIN world)
  // =========================
  (function injectMainWorldHook() {
    const id = "__KANBAN_INJECTED_JS__";
    if (document.getElementById(id)) return;

    const s = document.createElement("script");
    s.id = id;
    s.src = chrome.runtime.getURL("injected.js");
    s.onload = () => {
      console.log("Injected main-world hook loaded");

      // Ask token & last task a few times (SPA init delay)
      try {
        window.postMessage({ __KANBAN_BRIDGE__: true, type: "REQUEST_AUTH_TOKEN" }, "*");
        window.postMessage({ __KANBAN_BRIDGE__: true, type: "REQUEST_LAST_TASK" }, "*");
      } catch { }

      let tries = 0;
      const maxTries = 6;
      const tId = setInterval(() => {
        tries++;
        try {
          window.postMessage({ __KANBAN_BRIDGE__: true, type: "REQUEST_AUTH_TOKEN" }, "*");
          window.postMessage({ __KANBAN_BRIDGE__: true, type: "REQUEST_LAST_TASK" }, "*");
        } catch { }
        if (tries >= maxTries) clearInterval(tId);
      }, 700);
    };
    (document.head || document.documentElement).appendChild(s);
  })();

  // =========================
  // State
  // =========================
  window.__KANBAN_LAST_TASK__ = { taskId: null, boardId: null, url: null, at: null };

  // UUID helper: use crypto.randomUUID if available, otherwise fallback
  function generateUUID() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) {
      /* ignore */
    }
    // fallback implementation (RFC4122 v4-like)
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // =========================
  // Receive from injected.js
  // =========================
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.__KANBAN_BRIDGE__ !== true) return;

    if (data.type === "TASK_ID_CAPTURED" || data.type === "LAST_TASK") {
      window.__KANBAN_LAST_TASK__ = {
        taskId: data.taskId || null,
        boardId: data.boardId || null,
        url: data.url || null,
        at: data.at || null,
      };
      console.log("[KANBAN content] received taskId:", window.__KANBAN_LAST_TASK__);
      return;
    }

    if (data.type === "X_API_KEY") {
      const apiKey = data.apiKey || data.apikey || null;
      if (!apiKey) return;
      try { window.__KANBAN_LAST_CDS_API_KEY__ = String(apiKey).trim(); } catch {}

      const storageArea =
        (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
      try {
        storageArea.set({ cdsApiKey: window.__KANBAN_LAST_CDS_API_KEY__ }, () => {
          try {
            console.log("[KANBAN content] saved cds api key (masked)", String(window.__KANBAN_LAST_CDS_API_KEY__).slice(0,6) + '...' );
          } catch {}
        });
      } catch {
        try { chrome.storage.local.set({ cdsApiKey: window.__KANBAN_LAST_CDS_API_KEY__ }); } catch {}
      }
      return;
    }

    if (data.type === "AUTH_TOKEN") {
      const token = data.token || null;
      if (!token) return;

      // Also expose in content script scope for short-term reads
      try { window.__KANBAN_LAST_AUTH_TOKEN__ = token; } catch {}

      const storageArea =
        (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;

      try {
        storageArea.set({ authToken: token }, () => {
          try {
            const masked = token.slice(0, 8) + "..." + token.slice(-6);
            console.log("[KANBAN content] saved auth token:", masked, data.reason || "");
          } catch {
            console.log("[KANBAN content] saved auth token:", !!token, data.reason || "");
          }
        });
      } catch {
        try { chrome.storage.local.set({ authToken: token }); } catch {}
      }
      return;
    }
  });

  // Request AUTH_TOKEN once from injected.js and wait up to timeoutMs
  function requestAuthTokenOnce(timeoutMs = 200) {
    return new Promise((resolve) => {
      // check storage first
      getStoredToken().then((stored) => {
        if (stored) return resolve(stored);

        // check in-memory captured by message handler
        const before = window.__KANBAN_LAST_AUTH_TOKEN__ || null;
        if (before) return resolve(before);

        let done = false;
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          resolve(window.__KANBAN_LAST_AUTH_TOKEN__ || null);
        }, timeoutMs);

        try { window.postMessage({ __KANBAN_BRIDGE__: true, type: "REQUEST_AUTH_TOKEN" }, "*"); } catch {}

        const poll = setInterval(() => {
          const v = window.__KANBAN_LAST_AUTH_TOKEN__ || null;
          if (v && !done) {
            done = true;
            clearTimeout(t);
            clearInterval(poll);
            resolve(v);
          }
        }, 30);

        setTimeout(() => clearInterval(poll), timeoutMs + 50);
      });
    });
  }

  // =========================
  // Token storage helpers
  // =========================
  function getStoredToken() {
    return new Promise((resolve) => {
      try {
        const storageArea =
          (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
        storageArea.get(["authToken"], (res) => resolve(res?.authToken || null));
      } catch {
        try {
          chrome.storage.local.get(["authToken"], (res) => resolve(res?.authToken || null));
        } catch {
          resolve(null);
        }
      }
    });
  }

  function getStoredCdsKey() {
    return new Promise((resolve) => {
      try {
        const storageArea = (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
        storageArea.get(["cdsApiKey"], (res) => resolve(res?.cdsApiKey || null));
      } catch {
        try { chrome.storage.local.get(["cdsApiKey"], (res) => resolve(res?.cdsApiKey || null)); } catch { resolve(null); }
      }
    });
  }

  // =========================
  // Post event to Worker
  // =========================
  async function postEvent(payload) {
    let token = await getStoredToken();

    // if not in storage, actively request from injected page script
    if (!token) {
      try { token = await requestAuthTokenOnce(300); } catch {}
    }

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": "quanva2309", // worker secret
    };

    // send bearer if have (worker may use it)
    if (token) headers["x-bearer"] = token;

    // include captured backend cds api key if available (from storage or recently captured)
    try {
      let cdsKey = await getStoredCdsKey();
      if (!cdsKey) cdsKey = window.__KANBAN_LAST_CDS_API_KEY__ || null;
      if (cdsKey) headers['x-cds-api-key'] = cdsKey;
    } catch {}

    const bodyPayload = { ...payload };
    if (token) bodyPayload.authToken = token;

    fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
    }).catch((err) => console.warn("Bridge fetch error:", err));
  }

  // =========================
  // Extract data from card
  // =========================
  function parseSpentHoursFromCard(card) {
    const el = card.querySelector(".task-footer .task-date span:last-child");
    if (!el) return null;

    const txt = (el.textContent || "").trim(); // "(5.85h)"
    const m = txt.match(/\((\d+(?:\.\d+)?)\s*h\)/i);
    if (!m) return null;

    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function extractTaskName(card) {
    const titleEl = card.querySelector(".task-title");
    const name = (titleEl?.textContent || "").trim();
    return name || "Untitled";
  }

  function extractTaskCode(card) {
    const codeEl = card.querySelector(".task-code");
    const code = (codeEl?.textContent || "").trim();
    return code || null;
  }

  // ✅ Fallback parse taskId from DOM / href / data-attrs
  function extractTaskIdFromCard(card) {
    if (!card) return null;
    // common data attributes
    const attrCandidates = [
      "data-task-id", "data-taskid", "task-id", "taskid", "data-id"
    ];
    for (const a of attrCandidates) {
      const v = card.getAttribute?.(a) || card.dataset?.[a.replace(/^data-/, '')];
      if (v && String(v).trim()) return String(v).trim();
    }

    // check id attribute
    if (card.id && String(card.id).trim()) return String(card.id).trim();

    // search inside card for any element with those attrs or common classes
    for (const a of attrCandidates) {
      const el = card.querySelector?.(`[${a}]`);
      const v = el?.getAttribute?.(a) || el?.dataset?.[a.replace(/^data-/, '')];
      if (v && String(v).trim()) return String(v).trim();
    }

    // common class names that may hold id
    const classCandidates = ['task-id', 'id', 'taskId', 'task_code', 'task-code'];
    for (const c of classCandidates) {
      const el = card.querySelector?.(`.${c}`);
      const v = el?.textContent || el?.getAttribute?.('data-id');
      if (v && String(v).trim()) {
        const m = String(v).match(/(\d{3,})/);
        if (m) return m[1];
      }
    }

    // parse from any link/button href containing taskId=
    const linkEls = card.querySelectorAll?.("a[href], button[data-href], [data-url]");
    if (linkEls && linkEls.length) {
      for (const el of linkEls) {
        const href = el.getAttribute("href") || el.getAttribute("data-href") || el.getAttribute("data-url");
        if (!href) continue;
        const tid = extractTaskIdFromUrl(href);
        if (tid) return tid;
      }
    }

    // try to find numeric id in visible text inside card
    try {
      const txt = (card.textContent || '').trim();
      const m = txt.match(/(?:task\s*#?|id[:#]?\s*)(\d{3,})/i);
      if (m) return m[1];
      const m2 = txt.match(/\b(\d{4,})\b/); // fallback: any long number
      if (m2) return m2[1];
    } catch { }

    return null;
  }

  function extractTaskIdFromUrl(raw) {
    try {
      const u = new URL(raw, location.origin);
      const tid = u.searchParams.get("taskId") || u.searchParams.get("task_id") || u.searchParams.get("id");
      return tid ? String(tid).trim() : null;
    } catch {
      // try regex fallback
      const m = String(raw).match(/[?&](taskId|task_id|id)=([0-9]+)/i);
      return m ? String(m[2]) : null;
    }
  }

  // ✅ Ask injected.js for last task and wait a bit
  function requestLastTaskOnce(timeoutMs = 200) {
    return new Promise((resolve) => {
      const before = window.__KANBAN_LAST_TASK__?.taskId || null;
      if (before) return resolve(before);

      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(window.__KANBAN_LAST_TASK__?.taskId || null);
      }, timeoutMs);

      try {
        window.postMessage({ __KANBAN_BRIDGE__: true, type: "REQUEST_LAST_TASK" }, "*");
      } catch { }

      // also resolve early if taskId appears
      const poll = setInterval(() => {
        const tid = window.__KANBAN_LAST_TASK__?.taskId || null;
        if (tid && !done) {
          done = true;
          clearTimeout(t);
          clearInterval(poll);
          resolve(tid);
        }
      }, 30);

      setTimeout(() => clearInterval(poll), timeoutMs + 50);
    });
  }

  // Xác định action dựa trên element click (icon ▶ / ❚❚)
  function getActionFromClickTarget(target) {
    const iconEl = target.closest(".task-date .icon");
    if (!iconEl) return null;

    const t = (iconEl.textContent || "").trim();
    if (t === "▶") return "START";
    if (t === "❚❚") return "PAUSE";
    return null;
  }

  // =========================
  // Modal nhập plannedHours
  // =========================
  function showPlannedModal({ taskName, spentHours, initialValue = "" }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,.35);
        display:flex; align-items:center; justify-content:center;
        z-index: 2147483647;
      `;

      const modal = document.createElement("div");
      modal.style.cssText = `
        width: 420px; max-width: calc(100vw - 32px);
        background: #fff; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.25);
        padding: 16px 16px 12px 16px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      `;

      modal.innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:8px;">Nhập Planned (hours)</div>
        <div style="font-size:13px;color:#444;margin-bottom:8px;line-height:1.35;">
          <div><b>Task:</b> <span id="kb_taskname"></span></div>
          <div><b>Spent:</b> <span id="kb_spent"></span></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
          <input id="kb_planned" type="text" inputmode="decimal" placeholder="VD: 2 hoặc 2.5"
            style="flex:1; padding:10px 12px; border:1px solid #ddd; border-radius:10px; font-size:14px; outline:none;" />
        </div>
        <div id="kb_err" style="min-height:18px; font-size:12px; color:#c00; margin-bottom:10px;"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button id="kb_cancel" style="padding:8px 12px; border-radius:10px; border:1px solid #ddd; background:#fff; cursor:pointer;">Cancel</button>
          <button id="kb_ok" style="padding:8px 12px; border-radius:10px; border:none; background:#111; color:#fff; cursor:pointer;">OK</button>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      modal.querySelector("#kb_taskname").textContent = taskName || "";
      modal.querySelector("#kb_spent").textContent = (spentHours ?? "?") + "h";

      const input = modal.querySelector("#kb_planned");
      const err = modal.querySelector("#kb_err");
      input.value = initialValue;
      input.focus();

      function cleanup(result) {
        overlay.remove();
        resolve(result);
      }

      function parseValue() {
        const raw = String(input.value || "").trim().replace(",", ".");
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0) return null;
        return v;
      }

      function onOk() {
        const v = parseValue();
        if (v === null) {
          err.textContent = "Planned(hours) phải là số > 0. Ví dụ: 2 hoặc 2.5";
          input.focus();
          input.select();
          return;
        }
        cleanup(v);
      }

      function onCancel() {
        cleanup(null);
      }

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) onCancel();
      });

      modal.querySelector("#kb_ok").addEventListener("click", onOk);
      modal.querySelector("#kb_cancel").addEventListener("click", onCancel);

      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter") onOk();
      });
    });
  }

  // =========================
  // Click listener START/PAUSE
  // =========================
  document.addEventListener(
    "click",
    async (e) => {
      let action = null;
      let cardEl = null;
      try {
        action = getActionFromClickTarget(e.target);
        console.log("[KANBAN] click listener fired", { target: e.target, action });
        if (!action) return;

        cardEl = e.target.closest(".task-card, .task, .kanban-card, .task-item");
        if (!cardEl) {
          console.warn("[KANBAN] Cannot find card element from click target.");
          return;
        }

        console.log("[KANBAN] found card element", cardEl);
      } catch (err) {
        console.error("[KANBAN] click handler top-level error", err);
        return;
      }

      const taskName = extractTaskName(cardEl);
      const spentHours = parseSpentHoursFromCard(cardEl);
      const taskCode = extractTaskCode(cardEl);

      console.log("[KANBAN] extracted", { taskName, spentHours, taskCode });

      // ✅ get taskId: prefer injected cached, fallback parse from DOM/url, finally request injected
      let taskId = window.__KANBAN_LAST_TASK__?.taskId || null;
      let boardId = window.__KANBAN_LAST_TASK__?.boardId || null;

      console.log("[KANBAN] initial cached taskId", window.__KANBAN_LAST_TASK__);

      // If START, show modal first so UI is responsive even when taskId detection lags
      let plannedHours = null;
      if (action === "START") {
        plannedHours = await showPlannedModal({ taskName, spentHours });
        console.log("[KANBAN] showPlannedModal result:", plannedHours);
        if (plannedHours === null) return;
      }

      if (!taskId) {
        taskId = extractTaskIdFromCard(cardEl) || extractTaskIdFromUrl(location.href);
        console.log("[KANBAN] after DOM/url extraction, taskId=", taskId);
      }
      if (!taskId) {
        // wait briefly for injected to respond
        console.log("[KANBAN] waiting for injected to reply REQUEST_LAST_TASK...");
        taskId = await requestLastTaskOnce(220);
        boardId = window.__KANBAN_LAST_TASK__?.boardId || boardId;
        console.log("[KANBAN] after requestLastTaskOnce, taskId=", taskId, "cached=", window.__KANBAN_LAST_TASK__);
      }

      if (!taskId) {
        console.warn("[KANBAN] Missing taskId. Not sending event.", { taskName, spentHours, taskCode, url: location.href, cached: window.__KANBAN_LAST_TASK__ });
        // proceed without taskId (still send event) so Worker can log/handle UI flow
        // If you'd rather block sending, change `false` to `true` to stop here.
        const blockIfNoTaskId = false;
        if (blockIfNoTaskId) return;

      }

      const plannedHoursNum = Number(plannedHours);
      const spentHoursNum = Number.isFinite(Number(spentHours)) ? Number(spentHours) : 0;

      // remaining = planned - spent
      const remainingHours = Math.max(0, plannedHoursNum - spentHoursNum);
      const deadlineSeconds = Math.round(remainingHours * 3600);

      if (action === "START") {
        const payload = {
          eventId: generateUUID(),
          eventType: "START",
          action: "START",

          at: new Date().toISOString(),
          startedAt: Date.now(),

          source: "extension",
          taskId,
          boardId,

          taskTitle: taskName,
          taskName,
          taskCode,

          spentHours: spentHoursNum,
          plannedHours: plannedHoursNum,
          deadlineSeconds,

          warnBeforeSeconds: 5 * 60,
          url: location.href,
        };

        console.log("Bridge event:", payload);
        postEvent(payload);
        return;
      }

      // ===== PAUSE =====
      const payload = {
        eventId: generateUUID(),
        eventType: "PAUSE",
        action: "PAUSE",
        at: new Date().toISOString(),
        source: "extension",
        taskId,
        boardId,
        taskTitle: taskName,
        taskName,
        taskCode,
        spentHours: Number.isFinite(Number(spentHours)) ? Number(spentHours) : 0,
        plannedHours: null,
        url: location.href,
      };

      console.log("Bridge event:", payload);
      postEvent(payload);
    },
    true
  );
})();
