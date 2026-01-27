(() => {
  if (window.__KANBAN_INJECTED_HOOKED__) return;
  window.__KANBAN_INJECTED_HOOKED__ = true;

  // Cache
  window.__KANBAN_CAPTURED_TOKEN__ = null;
  window.__KANBAN_CAPTURED_X_API_KEY__ = null;
  // last task cache
  window.__KANBAN_CAPTURED_LAST_TASK__ = { taskId: null, boardId: null, url: null, at: null };

  function postToContent(type, payload) {
    try {
      window.postMessage(
        { __KANBAN_BRIDGE__: true, type, ...payload, at: new Date().toISOString() },
        "*"
      );
    } catch {}
  }

  function cleanBearer(v) {
    return String(v || "").trim().replace(/^Bearer\s+/i, "");
  }

  function saveToken(token, reason) {
    try {
      const cleaned = cleanBearer(token);
      if (!cleaned) return;
      window.__KANBAN_CAPTURED_TOKEN__ = cleaned;
      postToContent("AUTH_TOKEN", { token: cleaned, reason: reason || null });
    } catch {}
  }

  function saveApiKey(apiKey, reason) {
    try {
      const v = String(apiKey || "").trim();
      if (!v) return;
      window.__KANBAN_CAPTURED_X_API_KEY__ = v;
      postToContent("X_API_KEY", { apiKey: v, reason: reason || null });
    } catch {}
  }

  function captureHeadersFromAny(headersLike, reason) {
    try {
      if (!headersLike) return;

      // Headers object
      if (typeof headersLike.get === "function") {
        const auth =
          headersLike.get("authorization") ||
          headersLike.get("Authorization") ||
          headersLike.get("x-bearer") ||
          headersLike.get("X-Bearer");
        const apiKey =
          headersLike.get("x-api-key") ||
          headersLike.get("X-API-KEY") ||
          headersLike.get("X-Api-Key");

        if (auth) saveToken(auth, reason);
        if (apiKey) saveApiKey(apiKey, reason);
        return;
      }

      // plain object
      if (typeof headersLike === "object") {
        const auth =
          headersLike.authorization ||
          headersLike.Authorization ||
          headersLike["authorization"] ||
          headersLike["Authorization"] ||
          headersLike["x-bearer"] ||
          headersLike["X-Bearer"];

        const apiKey =
          headersLike["x-api-key"] ||
          headersLike["X-API-KEY"] ||
          headersLike["X-Api-Key"] ||
          headersLike.xApiKey;

        if (auth) saveToken(auth, reason);
        if (apiKey) saveApiKey(apiKey, reason);
      }
    } catch {}
  }

  // try parse taskId/boardId from URL-like string
  function parseTaskParamsFromUrl(raw) {
    try {
      const u = new URL(raw, location.origin);
      // target path contains GetTaskInfo OR has taskId param
      const path = (u.pathname || "").toLowerCase();
      const q = u.searchParams;
      const maybeTid = q.get('taskId') || q.get('task_id') || q.get('id');
      const maybeBid = q.get('boardId') || q.get('board_id') || q.get('board');
      if (path.includes('gettaskinfo') || maybeTid) {
        return { taskId: maybeTid ? String(maybeTid).trim() : null, boardId: maybeBid ? String(maybeBid).trim() : null };
      }
    } catch {}
    // naive regex fallback
    try {
      const m = String(raw).match(/[?&](?:taskId|task_id|id)=([0-9]+)/i);
      const mb = String(raw).match(/[?&](?:boardId|board_id|board)=([0-9]+)/i);
      if (m) return { taskId: m[1], boardId: mb ? mb[1] : null };
    } catch {}
    return null;
  }

  function captureTaskFromUrlIfAny(raw) {
    try {
      const p = parseTaskParamsFromUrl(raw);
      if (!p) return;
      if (!p.taskId) return;
      // cache and post
      window.__KANBAN_CAPTURED_LAST_TASK__ = { taskId: String(p.taskId), boardId: p.boardId || null, url: String(raw), at: new Date().toISOString() };
      postToContent('TASK_ID_CAPTURED', { taskId: String(p.taskId), boardId: p.boardId || null, url: String(raw), at: window.__KANBAN_CAPTURED_LAST_TASK__.at });
    } catch {}
  }

  // =========================
  // 1) Hook Headers.set / append
  // =========================
  try {
    const _Headers_set = Headers.prototype.set;
    const _Headers_append = Headers.prototype.append;

    Headers.prototype.set = function (name, value) {
      try {
        const n = String(name || "").toLowerCase();
        if (n === "authorization" || n === "x-bearer") saveToken(value, "headers-set");
        if (n === "x-api-key") saveApiKey(value, "headers-set");
      } catch {}
      return _Headers_set.call(this, name, value);
    };

    Headers.prototype.append = function (name, value) {
      try {
        const n = String(name || "").toLowerCase();
        if (n === "authorization" || n === "x-bearer") saveToken(value, "headers-append");
        if (n === "x-api-key") saveApiKey(value, "headers-append");
      } catch {}
      return _Headers_append.call(this, name, value);
    };
  } catch {}

  // =========================
  // 2) Wrap Request ctor (fetch(Request))
  // =========================
  try {
    const _Request = Request;
    window.Request = function (input, init) {
      const req = new _Request(input, init);
      try {
        // headers passed in init or present on Request
        captureHeadersFromAny(init?.headers, "request-ctor.init");
        captureHeadersFromAny(req.headers, "request-ctor.req");
        // try parse url to capture taskId/boardId
        try { captureTaskFromUrlIfAny(input?.url || input); } catch {}
      } catch {}
      return req;
    };
    window.Request.prototype = _Request.prototype;
    window.Request.prototype.constructor = window.Request;
  } catch {}

  // =========================
  // 3) Hook fetch
  // =========================
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const req0 = args[0];
      const opts = args[1] || {};

      // fetch(Request)
      if (req0 && typeof req0 === "object" && req0.headers && typeof req0.headers.get === "function") {
        captureHeadersFromAny(req0.headers, "fetch.request.headers");
        try { captureTaskFromUrlIfAny(req0.url || req0); } catch {}
      }

      // fetch(url, {headers})
      if (opts && opts.headers) {
        captureHeadersFromAny(opts.headers, "fetch.opts.headers");
      }

      // fetch(urlString, ...)
      try {
        if (typeof req0 === 'string') {
          captureTaskFromUrlIfAny(req0);
        }
      } catch {}
    } catch {}

    return _fetch.apply(this, args);
  };

  // =========================
  // 4) Hook XHR setRequestHeader
  // =========================
  try {
    const _setReqHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      try {
        const h = String(header || "").toLowerCase();
        if (h === "authorization" || h === "x-bearer") saveToken(value, "xhr-setHeader");
        if (h === "x-api-key") saveApiKey(value, "xhr-setHeader");
      } catch {}
      return _setReqHeader.call(this, header, value);
    };
    // hook open/send to capture URL params
    try {
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
        try { this.__kanban_open_url = url; } catch {}
        return _open.apply(this, arguments);
      };
      const _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(body) {
        try { captureTaskFromUrlIfAny(this.__kanban_open_url); } catch {}
        return _send.apply(this, arguments);
      };
    } catch {}
  } catch {}

  // =========================
  // 5) Respond to content.js REQUEST_AUTH_TOKEN
  // =========================
  window.addEventListener("message", (ev) => {
    try {
      const d = ev.data;
      if (!d || d.__KANBAN_BRIDGE__ !== true) return;
      // respond to token request
      if (d.type === "REQUEST_AUTH_TOKEN") {
        if (window.__KANBAN_CAPTURED_TOKEN__) {
          postToContent("AUTH_TOKEN", { token: window.__KANBAN_CAPTURED_TOKEN__, reason: "request-reply" });
        }
        if (window.__KANBAN_CAPTURED_X_API_KEY__) {
          postToContent("X_API_KEY", { apiKey: window.__KANBAN_CAPTURED_X_API_KEY__, reason: "request-reply" });
        }
        return;
      }

      // respond to last task request - try cached, DOM scan, or URL
      if (d.type === "REQUEST_LAST_TASK") {
        // if we have cached last task, reply
        if (window.__KANBAN_CAPTURED_LAST_TASK__?.taskId) {
          postToContent("LAST_TASK", {
            taskId: window.__KANBAN_CAPTURED_LAST_TASK__.taskId,
            boardId: window.__KANBAN_CAPTURED_LAST_TASK__.boardId || null,
            url: window.__KANBAN_CAPTURED_LAST_TASK__.url || location.href,
            at: window.__KANBAN_CAPTURED_LAST_TASK__.at || new Date().toISOString(),
          });
          return;
        }

        // attempt to find taskId in DOM
        try {
          const attrCandidates = ['data-task-id','data-taskid','task-id','taskid','data-id'];
          let found = null;
          for (const a of attrCandidates) {
            const el = document.querySelector(`[${a}]`);
            if (el) {
              const v = el.getAttribute(a) || el.getAttribute('data-id') || el.getAttribute('id');
              if (v && String(v).trim()) { found = String(v).trim(); break; }
            }
          }

          // try parsing URL
          if (!found) {
            try {
              const u = new URL(location.href);
              found = u.searchParams.get('taskId') || u.searchParams.get('task_id') || u.searchParams.get('id') || null;
            } catch {}
          }

          if (found) {
            window.__KANBAN_CAPTURED_LAST_TASK__ = { taskId: String(found), boardId: null, url: location.href, at: new Date().toISOString() };
            postToContent("LAST_TASK", { taskId: String(found), boardId: null, url: location.href, at: window.__KANBAN_CAPTURED_LAST_TASK__.at });
            return;
          }
        } catch {}

        // no task found - reply with empty last task so content can handle fallback
        postToContent("LAST_TASK", { taskId: null, boardId: null, url: location.href, at: new Date().toISOString() });
        return;
      }
    } catch {}
  });

  // Try to capture taskId when user clicks on a task element (helps SPA interactions)
  try {
    document.addEventListener('click', (e) => {
      try {
        const card = e.target.closest('.task-card, .task, .kanban-card, .task-item') || e.target.closest('[data-task-id],[data-taskid],[task-id],[taskid],[data-id]');
        if (!card) return;

        const attrCandidates = ['data-task-id','data-taskid','task-id','taskid','data-id'];
        let tid = null;
        for (const a of attrCandidates) {
          const v = card.getAttribute?.(a) || card.dataset?.taskId || card.dataset?.taskid;
          if (v) { tid = String(v).trim(); break; }
        }

        // fallback: try links inside
        if (!tid) {
          const link = card.querySelector && card.querySelector('a[href], [data-url]');
          if (link) {
            const href = link.getAttribute('href') || link.getAttribute('data-url');
            try {
              const u = new URL(href, location.href);
              tid = u.searchParams.get('taskId') || u.searchParams.get('task_id') || u.searchParams.get('id') || null;
            } catch {
              const m = String(href).match(/[?&](?:taskId|task_id|id)=([0-9]+)/i);
              if (m) tid = m[1];
            }
          }
        }

        if (tid) {
          window.__KANBAN_CAPTURED_LAST_TASK__ = { taskId: String(tid), boardId: null, url: location.href, at: new Date().toISOString() };
          postToContent('TASK_ID_CAPTURED', { taskId: String(tid), boardId: null, url: location.href, at: window.__KANBAN_CAPTURED_LAST_TASK__.at });
        }
      } catch {}
    }, true);
  } catch {}

  console.log("[KANBAN injected] hook installed");

  // ==== proactive storage/cookie scan for tokens (help when network hooks miss) ====
  try {
    function scanForTokenAndApiKey() {
      try {
        const candidates = ['authToken','token','accessToken','access_token','id_token','jwt','authorization'];
        for (const src of [window.localStorage, window.sessionStorage]) {
          try {
            for (const k of Object.keys(src || {})) {
              try {
                const v = src.getItem(k);
                if (!v) continue;
                const keyLower = String(k || '').toLowerCase();
                if (candidates.includes(keyLower) || candidates.some(c=>keyLower.includes(c))) {
                  const cleaned = cleanBearer(v);
                  if (cleaned) saveToken(cleaned, 'storage-scan.'+k);
                }
                // also check if value looks like bearer
                if (typeof v === 'string' && /bearer\s+/i.test(v)) {
                  saveToken(v, 'storage-scan.value');
                }
                // possible x-api-key
                if (/^[0-9A-Fa-f\-]{20,}$/.test(String(v).trim())) {
                  saveApiKey(String(v).trim(), 'storage-scan.'+k);
                }
              } catch {}
            }
          } catch {}
        }

        // cookies
        try {
          const ck = document.cookie || '';
          if (ck) {
            const parts = ck.split(';').map(s=>s.trim());
            for (const p of parts) {
              const [k,v] = p.split('=');
              if (!k) continue;
              const keyLower = k.toLowerCase();
              if (candidates.includes(keyLower) || candidates.some(c=>keyLower.includes(c))) {
                saveToken(v, 'cookie.'+k);
              }
            }
          }
        } catch {}
      } catch {}
    }

    // run scan on install and a few times while SPA initializes
    scanForTokenAndApiKey();
    let scanTries = 0;
    const scanMax = 6;
    const scanInterval = setInterval(()=>{
      scanTries++;
      try { scanForTokenAndApiKey(); } catch {}
      if (scanTries>=scanMax) clearInterval(scanInterval);
    }, 700);
  } catch {}
})();
