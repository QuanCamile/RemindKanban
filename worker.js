import htmlContent from './index.html';

let cachedAuth = null; // { token, tokenType, at }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://cds.hcmict.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      // ✅ allow extension send bearer + cds api key + refresh
      "Access-Control-Allow-Headers": "content-type, x-api-key, x-bearer, x-cds-api-key, x-refresh-token",
    };

    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers: corsHeaders });
    }



    if (url.pathname === "/events" && request.method === "POST") {
      // Worker API key (extension -> worker)
      const apiKey = request.headers.get("x-api-key");
      if (!apiKey || apiKey !== env.API_SECRET) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }

      const body = await request.json();
      const now = Date.now();

      // Accept eventType/action
      const eventTypeRaw = body.eventType ?? body.action ?? "";
      const eventType = String(eventTypeRaw).toUpperCase();

      const taskId = String(body.taskId ?? "").trim();
      if (!taskId) {
        return Response.json(
          { ok: false, message: "Missing taskId" },
          { headers: corsHeaders, status: 400 }
        );
      }

      const boardId = body.boardId != null ? String(body.boardId).trim() : null;

      const title = body.taskTitle
        ? String(body.taskTitle)
        : (body.taskName ? String(body.taskName) : null);

      // plannedHours + deadlineSeconds
      const plannedHours = Number(body.plannedHours ?? 8);
      const plannedHoursText = Number.isFinite(plannedHours) && plannedHours > 0 ? plannedHours : 8;

      const deadlineSeconds = Number.isFinite(Number(body.deadlineSeconds))
        ? Number(body.deadlineSeconds)
        : plannedHoursText * 3600;

      const warnBeforeSeconds = Number(body.warnBeforeSeconds ?? 5 * 60);
      const taskUrl = body.url ? String(body.url) : null;

      // ✅ Token & CDS API key from client (extension)
      const bearerFromClient =
        (request.headers.get("x-bearer") || "").trim() ||
        (String(body.authToken || "").trim()) ||
        null;

      const cdsApiKeyFromClient =
        (request.headers.get("x-cds-api-key") || "").trim() ||
        (String(body.cdsApiKey || "").trim()) ||
        null;

      const refreshFromClient =
        (request.headers.get("x-refresh-token") || "").trim() ||
        (String(body.refreshToken || "").trim()) ||
        null;

      // (debug logging removed) - keep main flow notifications only

      if (eventType === "START") {
        await ensurePauseColumns(env);

        let startedAt = Number(body.startedAt ?? now);

        // If there's an existing PAUSED row with remaining_ms, resume from remaining
        // unless the client explicitly provided a new duration (deadlineSeconds or plannedHours).
        let deadlineAt;
        const hasCustomDeadline = Object.prototype.hasOwnProperty.call(body, 'deadlineSeconds') || Object.prototype.hasOwnProperty.call(body, 'plannedHours');
        try {
          const existing = await runWithRetries(() => env.DB.prepare(`SELECT status, remaining_ms, deadline_at FROM tasks WHERE task_id=?`).bind(taskId).first()).catch(() => null);
          if (!hasCustomDeadline && existing && String(existing.status).toUpperCase() === 'PAUSED' && Number.isFinite(Number(existing.remaining_ms)) && Number(existing.remaining_ms) > 0) {
            // resume from remaining_ms (use current time as new start)
            deadlineAt = now + Number(existing.remaining_ms);
            startedAt = now;
          }
        } catch (e) {
          // ignore and fall back to computing from provided startedAt
        }

        if (!deadlineAt) {
          deadlineAt = startedAt + deadlineSeconds * 1000;
        }

        const warnAt = deadlineAt - warnBeforeSeconds * 1000;

        await runWithRetries(() => env.DB.prepare(`
          INSERT INTO tasks(
            task_id, title, status, started_at, deadline_at, warn_at,
            warned, closed, paused_at, remaining_ms, client_bearer, client_cds_api_key, client_refresh_token, task_url, board_id, updated_at
          )
          VALUES(?, ?, 'RUNNING', ?, ?, ?, 0, 0, NULL, NULL, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            title=excluded.title,
            status='RUNNING',
            started_at=excluded.started_at,
            deadline_at=excluded.deadline_at,
            warn_at=excluded.warn_at,
            warned=0,
            closed=0,
            paused_at=NULL,
            remaining_ms=NULL,
            client_bearer=excluded.client_bearer,
            client_cds_api_key=excluded.client_cds_api_key,
            client_refresh_token=excluded.client_refresh_token,
            task_url=excluded.task_url,
            board_id=excluded.board_id,
            updated_at=excluded.updated_at
        `).bind(taskId, title, startedAt, deadlineAt, warnAt, bearerFromClient, cdsApiKeyFromClient, refreshFromClient, taskUrl, boardId, now).run());

        const etaText = formatVNTime(deadlineAt);
        const remainMin = Math.max(0, Math.round((deadlineAt - now) / 60000));

        ctx.waitUntil(sendTelegram(
          env,
          `▶️ START: ${title ?? taskId}\n🕒 Dự kiến đóng: ${etaText}\n⏱️ Còn lại: ~${remainMin} phút${taskUrl ? `\n🔗 ${taskUrl}` : ""}`
        ));

        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (eventType === "PAUSE") {
        await ensurePauseColumns(env);

        // compute remaining_ms based on stored deadline_at (if any)
        let remainingMs = null;
        try {
          const row = await runWithRetries(() => env.DB.prepare(`SELECT deadline_at FROM tasks WHERE task_id=?`).bind(taskId).first()).catch(() => null);
          if (row && Number.isFinite(Number(row.deadline_at))) {
            remainingMs = Math.max(0, Number(row.deadline_at) - now);
          }
        } catch (e) { /* ignore */ }

        await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET status='PAUSED', paused_at=?, remaining_ms=?, warn_at=NULL, warned=0, updated_at=? WHERE task_id=?`)
          .bind(now, remainingMs, now, taskId).run());

        ctx.waitUntil(sendTelegram(
          env,
          `⏸️ PAUSE: ${title ?? taskId}${taskUrl ? `\n🔗 ${taskUrl}` : ""}`
        ));
        // also fetch step tasks and notify
        ctx.waitUntil(fetchAndNotifyTasks(env, taskId));
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (eventType === "DONE") {
        await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET status='CLOSED', closed=1, client_bearer=NULL, client_cds_api_key=NULL, client_refresh_token=NULL, updated_at=? WHERE task_id=?`)
          .bind(now, taskId).run());

        ctx.waitUntil(sendTelegram(env, `✅ DONE: ${title ?? taskId}`));
        // also fetch step tasks and notify
        ctx.waitUntil(fetchAndNotifyTasks(env, taskId));
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      return Response.json(
        { ok: false, message: "Unknown eventType", received: eventTypeRaw },
        { headers: corsHeaders, status: 400 }
      );
    }

    if (url.pathname === "/api/tasks") {
      const result = await getTasksData(env, null);
      if (result.ok) {
        return Response.json({ success: true, data: result }, { headers: corsHeaders });
      } else {
        return Response.json({ success: false, message: result.message }, { headers: corsHeaders, status: 500 });
      }
    }

    if (url.pathname === "/api/work/Task/DoingTask" && request.method === "POST") {
      let taskId = "Unknown";
      try {
        const body = await request.json().catch(() => ({}));
        taskId = body.taskId ?? body.task_id;
        if (!taskId) return Response.json({ success: false, message: "Missing taskId or task_id" }, { status: 400, headers: corsHeaders });

        let token = null, cdsApiKey = null, refreshToken = null, taskTitle = null;
        try {
          const row = await runWithRetries(() => env.DB.prepare(`SELECT title, client_bearer, client_cds_api_key, client_refresh_token FROM tasks WHERE task_id=?`).bind(taskId).first()).catch(() => null);
          if (row) {
            taskTitle = row.title;
            token = row.client_bearer;
            cdsApiKey = row.client_cds_api_key;
            refreshToken = row.client_refresh_token;
          } else if (cachedAuth && cachedAuth.token) {
            token = cachedAuth.token;
            cdsApiKey = cachedAuth.cdsApiKey;
            refreshToken = cachedAuth.refreshToken;
          } else {
            const anyRow = await runWithRetries(() => env.DB.prepare(`SELECT client_bearer, client_cds_api_key, client_refresh_token FROM tasks WHERE client_bearer IS NOT NULL OR client_cds_api_key IS NOT NULL LIMIT 1`).first()).catch(() => null);
            if (anyRow) {
              token = anyRow.client_bearer;
              cdsApiKey = anyRow.client_cds_api_key;
              refreshToken = anyRow.client_refresh_token;
            }
          }
        } catch (e) { /* ignore */ }

        await doingTaskWithTokenFirst(env, taskId, null, null, token, cdsApiKey, refreshToken);
        ctx.waitUntil(sendTelegram(env, `⏸️ Đã gửi lệnh Pause/Resume từ Dashboard: ${taskTitle ?? taskId}`));
        return Response.json({ success: true }, { headers: corsHeaders });
      } catch (e) {
        ctx.waitUntil(sendTelegram(env, `❌ Lỗi Pause/Resume từ Dashboard (Task ${taskId}): ${e.message}`));
        return Response.json({ success: false, message: e.message }, { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === "/") {
      return new Response(htmlContent, { 
        headers: { "content-type": "text/html;charset=UTF-8" } 
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  }
};

async function handleCron(env) {
  // Ensure DB schema has optional columns before running cron queries
  await ensurePauseColumns(env);
  // Cleanup old records from previous days (keep only today's records)
  await cleanupOldTasks(env);
  const now = Date.now();

  // 1) warn
  const warnRows = await env.DB.prepare(`
    SELECT task_id, title, deadline_at
    FROM tasks
    WHERE status='RUNNING' AND warned=0 AND warn_at <= ? AND paused_at IS NULL
  `).bind(now).all();

  for (const r of warnRows.results) {
    await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET warned=1, updated_at=? WHERE task_id=? AND status='RUNNING' AND paused_at IS NULL`)
      .bind(now, r.task_id).run());

    const remainMs = Number(r.deadline_at) - now;
    const remainMin = Math.max(0, Math.floor(remainMs / 60000));
    const etaText = formatVNTime(Number(r.deadline_at));

    await sendTelegram(
      env,
      `⏰ Sắp hết hạn: ${r.title ?? r.task_id}\n🕒 Dự kiến đóng: ${etaText}\n⏱️ Còn ~${remainMin} phút, cần đóng task!`
    );
  }

  // 2) close (auto-close BEFORE the actual deadline by env.AUTO_CLOSE_BEFORE_SECONDS)
  const autoCloseBeforeSeconds = Number(env.AUTO_CLOSE_BEFORE_SECONDS ?? 5 * 60);
  const closeThreshold = now + autoCloseBeforeSeconds * 1000;

  const closeRows = await env.DB.prepare(`
    SELECT task_id, title, client_bearer, client_cds_api_key, client_refresh_token, task_url, board_id
    FROM tasks
    WHERE status='RUNNING' AND closed=0 AND deadline_at <= ? AND paused_at IS NULL
  `).bind(closeThreshold).all();

  for (const r of closeRows.results) {
    // Try to call the closing API first; only mark CLOSED when it succeeds.
    let apiMsg = null;
    try {
      const resp = await doingTaskWithTokenFirst(
        env,
        r.task_id,
        r.task_url || null,
        r.board_id || null,
        (r.client_bearer || env.CLOSE_TASK_BEARER) || null,
        (r.client_cds_api_key || env.CDS_API_KEY) || null
      );
      const text = await resp.text().catch(() => "");
      apiMsg = `✅ DoingTask OK: HTTP ${resp.status}\n${text.slice(0,200)}`;

      // mark closed and clear client tokens only after success
      await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET status='CLOSED', closed=1, client_bearer=NULL, client_cds_api_key=NULL, client_refresh_token=NULL, updated_at=? WHERE task_id=?`)
        .bind(now, r.task_id).run());
    } catch (e) {
      apiMsg = `❌ DoingTask FAIL: ${String(e).slice(0,600)}`;
      // If the failure is an authentication error (HTTP 401), stop retrying
      // by marking the task as CLOSED and clearing client tokens so it won't
      // be retried on subsequent cron runs.
      try {
        const em = String(e || "").toLowerCase();
        if (em.includes('http 401') || em.includes('401')) {
          await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET status='CLOSED', closed=1, client_bearer=NULL, client_cds_api_key=NULL, client_refresh_token=NULL, updated_at=? WHERE task_id=?`)
            .bind(now, r.task_id).run());
          apiMsg += '\nAction: Stopped retries due to HTTP 401 (marked CLOSED).';
        }
      } catch (ee) {
        // ignore DB update errors to avoid breaking the cron loop
      }
      // otherwise leave task as RUNNING so it can be retried by later cron runs
    }

    await sendTelegram(env, `🔒 Auto close: ${r.title ?? r.task_id}\n${apiMsg}`);
    // notify latest tasks list for the step
    await fetchAndNotifyTasks(env, r.task_id);
  }

  // Fixed daily fetch: call GetTaskByStepInBoardWithEF at 11:25 Vietnam time (UTC+7)
  try {
    const tzOffset = 7 * 60 * 60 * 1000; // +7 hours
    const vn = new Date(now + tzOffset);
    const h = vn.getUTCHours();
    const m = vn.getUTCMinutes();
    if (h === 22 && m === 0) {
      // call without taskId to fetch general step list
      await fetchAndNotifyTasks(env, null);
    }
  } catch (e) {
    // ignore scheduling errors
  }
}

// Ensure optional columns for pause/resume exist. Ignore errors if they already do.
async function ensurePauseColumns(env) {
  try {
    await env.DB.prepare('ALTER TABLE tasks ADD COLUMN paused_at INTEGER').run();
  } catch (e) {
    // ignore if column exists or DB does not support
  }
  try {
    await env.DB.prepare('ALTER TABLE tasks ADD COLUMN remaining_ms INTEGER').run();
  } catch (e) {
    // ignore
  }
  try {
    await env.DB.prepare('ALTER TABLE tasks ADD COLUMN client_bearer TEXT').run();
  } catch (e) {
    // ignore
  }
  try {
    await env.DB.prepare('ALTER TABLE tasks ADD COLUMN client_cds_api_key TEXT').run();
  } catch (e) {
    // ignore
  }
  try {
    await env.DB.prepare('ALTER TABLE tasks ADD COLUMN client_refresh_token TEXT').run();
  } catch (e) {
    // ignore
  }
  try {
    await env.DB.prepare('ALTER TABLE tasks ADD COLUMN task_url TEXT').run();
  } catch (e) {
    // ignore
  }
  try {
    await env.DB.prepare('ALTER TABLE tasks ADD COLUMN board_id TEXT').run();
  } catch (e) {
    // ignore
  }
}

async function sendTelegram(env, text) {
  // Backwards-compatible: third `opts` parameter may include `parse_mode` (e.g. 'HTML')
  const opts = arguments[2] || {};
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  const body = { chat_id: env.TG_CHAT_ID, text };
  if (opts.parse_mode) body.parse_mode = opts.parse_mode;
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

// Fetch step list from CDS API and return structured data
async function getTasksData(env, taskId = null) {
  try {
    // try to read client tokens (including refresh token) from DB for the given taskId
    let token = null;
    let cdsApiKey = null;
    let refreshToken = null;
    try {
      if (taskId) {
        const row = await runWithRetries(() => env.DB.prepare(`SELECT client_bearer, client_cds_api_key, client_refresh_token FROM tasks WHERE task_id=?`).bind(taskId).first()).catch(() => null);
        if (row) {
          token = (row.client_bearer || null);
          cdsApiKey = (row.client_cds_api_key || null);
          refreshToken = (row.client_refresh_token || null);
        }
      }
    } catch (e) { /* ignore */ }
    const t = Date.now();
    const url = `https://api_cds.hcmict.io/api/work/Step/GetTaskByStepInBoardWithEF?boardID=189&searchText=&customerID=-1&creatorId=-1&assigneeID=1511&statusID=-1&ratingID=-1&t=${t}`;
    const headers = {
      "accept": "application/json",
      "origin": "https://cds.hcmict.io",
      "referer": "https://cds.hcmict.io",
      "x-request-timestamp": new Date().toISOString(),
    };

    // If no client tokens found for a specific task, try cachedAuth or any stored tokens in DB,
    // then fallback to environment values.
    if (!token && !cdsApiKey) {
      // try in-memory cache first
      if (cachedAuth && cachedAuth.token) {
        token = cachedAuth.token;
        cdsApiKey = cdsApiKey || cachedAuth.cdsApiKey || null;
        refreshToken = refreshToken || cachedAuth.refreshToken || null;
      } else {
        try {
          const anyRow = await runWithRetries(() => env.DB.prepare(`SELECT client_bearer, client_cds_api_key, client_refresh_token FROM tasks WHERE client_bearer IS NOT NULL OR client_cds_api_key IS NOT NULL LIMIT 1`).first()).catch(() => null);
          if (anyRow) {
            token = token || (anyRow.client_bearer || null);
            cdsApiKey = cdsApiKey || (anyRow.client_cds_api_key || null);
            refreshToken = refreshToken || (anyRow.client_refresh_token || null);
            // cache for subsequent cron runs
            try { cachedAuth = { token: token, cdsApiKey: cdsApiKey, refreshToken: refreshToken, at: Date.now() }; } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore DB read errors */ }
      }
    }

    const finalToken = (token && String(token).trim()) || (env.CLOSE_TASK_BEARER || "");
    const finalCdsKey = (cdsApiKey && String(cdsApiKey).trim()) || (env.CDS_API_KEY || "");
    if (finalToken) headers.authorization = `Bearer ${finalToken}`;
    if (finalCdsKey) headers['x-api-key'] = finalCdsKey;

    const apiBase = (env.API_BASE || "https://api_cds.hcmict.io").replace(/\/+$/, "");

    let res = await fetch(url, { method: "GET", headers });
    let ct = res.headers.get("content-type") || "";
    let bodyText = await res.text().catch(() => "");

    // If we get 401, notify and attempt to refresh or login
    if (!res.ok && res.status === 401) {
      try {
        await sendTelegram(env, `❗ HTTP 401 khi lấy step list${taskId ? ` (taskId ${taskId})` : ""} — thử khôi phục phiên...`);
      } catch (e) { /* ignore notify failure */ }

      const rt = refreshToken || (cachedAuth && cachedAuth.refreshToken) || null;
      let newToken = null;
      let newRefreshToken = null;

      // 1. Try Refresh Token First
      if (rt) {
        try {
          newToken = await refreshAccessToken(env, apiBase, rt, finalCdsKey, null, null).catch(() => null);
          if (newToken) {
            newRefreshToken = rt; // assuming it stays same if not returned
            await sendTelegram(env, `✅ Refresh token thành công.`).catch(()=>{});
          } else {
            await sendTelegram(env, `❌ Refresh token thất bại.`).catch(()=>{});
          }
        } catch (e) {
          await sendTelegram(env, `❌ Lỗi khi refresh token: ${String(e).slice(0,200)}`).catch(()=>{});
        }
      } else {
        await sendTelegram(env, `❗ Không có refresh token để thử.`).catch(()=>{});
      }

      // 2. Fallback to Auto Login
      if (!newToken && env.LOGIN_USERNAME && env.LOGIN_PASSWORD) {
        try {
          await sendTelegram(env, `🔄 Đang thử auto-login bằng biến môi trường (LOGIN_USERNAME)...`).catch(()=>{});
          const loginRes = await autoLogin(env, apiBase, null);
          if (loginRes && loginRes.token) {
            newToken = loginRes.token;
            newRefreshToken = loginRes.refreshToken || rt;
            await sendTelegram(env, `✅ Auto-login thành công.`).catch(()=>{});
          } else {
            await sendTelegram(env, `❌ Auto-login thất bại.`).catch(()=>{});
          }
        } catch (e) {
          await sendTelegram(env, `❌ Lỗi khi auto-login: ${String(e).slice(0,200)}`).catch(()=>{});
        }
      }

      // 3. Retry Request if token acquired
      if (newToken) {
        try {
          if (taskId) {
             await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET client_bearer=?, client_refresh_token=?, updated_at=? WHERE task_id=?`).bind(newToken, newRefreshToken, Date.now(), taskId).run());
          } else {
             await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET client_bearer=?, client_refresh_token=?, updated_at=? WHERE client_bearer IS NOT NULL OR client_cds_api_key IS NOT NULL`).bind(newToken, newRefreshToken, Date.now()).run());
          }
        } catch (e) { /* ignore DB write errors */ }
        
        try { cachedAuth = { token: newToken, cdsApiKey: finalCdsKey || null, refreshToken: newRefreshToken, at: Date.now() }; } catch (e) { /* ignore */ }

        await sendTelegram(env, `Thử lại lấy danh sách step bằng token mới...`).catch(()=>{});
        // retry the request with refreshed token
        headers.authorization = `Bearer ${newToken}`;
        res = await fetch(url, { method: "GET", headers });
        ct = res.headers.get("content-type") || "";
        bodyText = await res.text().catch(() => "");
      }
    }

    if (!res.ok) {
      await sendTelegram(env, `Không lấy được danh sách step: HTTP ${res.status} - ${bodyText.slice(0,400)}`);
      return { ok: false, message: "Fetch failed", status: res.status };
    }

    // Try to parse JSON from bodyText for clearer debug messages
    let data = null;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      await sendTelegram(env, `GetTaskByStepInBoardWithEF trả về không phải JSON (content-type: ${ct}): ${bodyText.slice(0,400)}`);
      return { ok: false, message: "Invalid JSON", data: bodyText };
    }

    // Some responses wrap the array inside an object { message, data: "[...json array...]" }
    if (!Array.isArray(data)) {
      // If data.data is a JSON string, try parsing that
      if (data && typeof data === 'object' && data.data) {
        if (typeof data.data === 'string') {
          try {
            const inner = JSON.parse(data.data);
            if (Array.isArray(inner)) {
              data = inner;
            } else if (inner && Array.isArray(inner.data)) {
              data = inner.data;
            }
          } catch (e) {
            // fallthrough to send dump below
          }
        } else if (Array.isArray(data.data)) {
          data = data.data;
        }
      }
    }

    if (!Array.isArray(data)) {
      // include a short dump to help diagnose wrapped responses
      const dump = typeof data === 'object' && data !== null ? JSON.stringify(data).slice(0,400) : String(data).slice(0,400);
      await sendTelegram(env, `GetTaskByStepInBoardWithEF trả về JSON nhưng không phải mảng: ${dump}`);
      return { ok: false, message: "Data is not an array", data: dump };
    }

    // prefer step_id 1341 if present, otherwise take first step with tasks
    let step = data.find((s) => Number(s.step_id) === 1341 && Array.isArray(s.tasks) && s.tasks.length > 0);
    if (!step) {
      step = data.find((s) => Array.isArray(s.tasks) && s.tasks.length > 0);
    }

    if (!step) {
      await sendTelegram(env, `GetTaskByStepInBoardWithEF: không tìm thấy step có tasks`);
      return { ok: false, message: "No steps with tasks found" };
    }

    const rows = step.tasks.map((task) => {
      const statusId = Number(task.status ?? task.statusId ?? -1);
      const trangThaiTask = Number(task.status_id -1);
      const runningFlagRaw = task.running_flag ?? task.running ?? task.runningFlag ?? task.runningFlagId ?? task.running_status ?? 0;
      const runningFlag = (function(raw) {
        if (raw === true) return 1;
        if (raw === false) return 0;
        if (raw == null) return 0;
        const s = String(raw).trim();
        if (s === '') return 0;
        const n = Number(s);
        if (Number.isFinite(n)) return n;
        // fallback: try to extract digits
        const m = s.match(/(-?\d+)/);
        return m ? Number(m[1]) : 0;
      })(runningFlagRaw);
      const statusMap = {
        0: "TẠO MỚI",
        1: "GIAO VIỆC",
        2: "ĐANG THỰC HIỆN",
        3: "HOÀN THÀNH",
        4: "ĐÓNG",
        5: "TẠM NGỪNG",
        6: "SẮP ĐẾN HẠN",
        7: "TRỄ HẠN",
        8: "CHƯA ĐÓNG",
        9: "MỞ LẠI",
        10: "CHỜ HOÀN THÀNH"
      };

      let st;
      if (runningFlag === 1) {
        st = "ĐANG THỰC HIỆN";
      } else if (runningFlag === 2) {
        st = "ĐÃ PAUSE";
      } else {
        st = "GIAO VIỆC";
      }

      return {
        id: String(task.task_id || ""),
        name: String(task.task_name || ""),
        status: st
      };
    });

    return {
      ok: true,
      step_name: step.step_name,
      step_id: step.step_id,
      tasks: rows
    };
  } catch (e) {
    await sendTelegram(env, `Lỗi khi fetch danh sách tasks: ${String(e).slice(0,200)}`);
    return { ok: false, message: String(e) };
  }
}

// Fetch step list from CDS API (fixed params) and notify Telegram with tasks list
async function fetchAndNotifyTasks(env, taskId = null) {
  const result = await getTasksData(env, taskId);
  if (!result.ok) return;

  const escapeHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  
  const rows = result.tasks;
  const idWidth = Math.max(4, ...rows.map(r => r.id.length));
  const nameMax = 40;
  const nameWidth = Math.max(6, Math.min(nameMax, ...rows.map(r => Math.min(nameMax, r.name.length))));
  const statusWidth = Math.max(6, ...rows.map(r => r.status.length));

  const pad = (s, w) => s.length >= w ? s : s + ' '.repeat(w - s.length);

  const header = pad('ID', idWidth) + ' | ' + pad('Task name', nameWidth) + ' | ' + pad('Status', statusWidth);
  const sep = '-'.repeat(idWidth) + '-+-' + '-'.repeat(nameWidth) + '-+-' + '-'.repeat(statusWidth);

  const linesTable = rows.map(r => {
    const name = r.name.length > nameWidth ? r.name.slice(0, nameWidth - 1) + '…' : r.name;
    return pad(escapeHtml(r.id), idWidth) + ' | ' + pad(escapeHtml(name), nameWidth) + ' | ' + pad(escapeHtml(r.status), statusWidth);
  });

  const tableText = `<pre>Danh sách tasks cho step "${escapeHtml(result.step_name)}" (step_id ${escapeHtml(result.step_id)})\n${header}\n${sep}\n${linesTable.join('\n')}</pre>`;
  await sendTelegram(env, tableText, { parse_mode: 'HTML' });
}

function formatVNTime(ms) {
  const d = new Date(ms);
  const vn = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())} ${pad(vn.getUTCDate())}/${pad(vn.getUTCMonth() + 1)}/${vn.getUTCFullYear()}`;
}

// Retry wrapper for transient D1/storage errors.
async function runWithRetries(fn, attempts = 3, baseDelay = 150) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      await new Promise((res) => setTimeout(res, baseDelay * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * ✅ Ưu tiên dùng token + cdsApiKey từ client (extension).
 * Nếu thiếu thì fallback env.CLOSE_TASK_BEARER + env.CDS_API_KEY.
 * (Auto-login có thể thêm lại sau; hiện tại bạn đã có token thật từ browser nên dùng cái đó là chuẩn nhất.)
 */
async function doingTaskWithTokenFirst(env, taskId, taskUrlFromEvent, boardId, bearerFromClient, cdsApiKeyFromClient, refreshFromClient) {
  const apiBase = (env.API_BASE || "https://api_cds.hcmict.io").replace(/\/+$/, "");

  // endpoint
  const doingPath = env.CLOSE_TASK_PATH || "/api/work/Task/DoingTask";
  const doingUrl = apiBase + doingPath;

  // token
  const token =
    (bearerFromClient || "").trim() ||
    (env.CLOSE_TASK_BEARER || "").trim() ||
    null;

  // cds api key (header x-api-key trong curl)
  const cdsApiKey =
    (cdsApiKeyFromClient || "").trim() ||
    (env.CDS_API_KEY || "").trim() ||
    null;

  if (!token) throw new Error("Missing token (x-bearer/authToken from client OR env.CLOSE_TASK_BEARER)");
  if (!cdsApiKey) throw new Error("Missing CDS api key (x-cds-api-key from client OR env.CDS_API_KEY)");

  // (optional) auth check bằng GetTaskInfo để debug nhanh (có boardId thì càng tốt)
  await authCheckByGetTaskInfo(env, apiBase, token, cdsApiKey, taskId, boardId, taskUrlFromEvent);

  // call DoingTask
  let resp = await callDoingTask(doingUrl, token, cdsApiKey, taskId, taskUrlFromEvent);
  if (resp.ok) return resp;

  // If 401, try refresh or auto login -> update DB -> retry once
  try {
    if (resp.status === 401) {
      let newToken = null;
      let newRefreshToken = null;

      if (refreshFromClient) {
        newToken = await refreshAccessToken(env, apiBase, refreshFromClient, cdsApiKey, taskId, taskUrlFromEvent).catch(() => null);
        if (newToken) newRefreshToken = refreshFromClient;
      }

      if (!newToken && env.LOGIN_USERNAME && env.LOGIN_PASSWORD) {
        const loginRes = await autoLogin(env, apiBase, taskUrlFromEvent).catch(() => null);
        if (loginRes && loginRes.token) {
          newToken = loginRes.token;
          newRefreshToken = loginRes.refreshToken || refreshFromClient;
        }
      }

      if (newToken) {
        // persist refreshed token to DB so future runs use it
        try {
          await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET client_bearer=?, client_refresh_token=?, updated_at=? WHERE task_id=?`).bind(newToken, newRefreshToken, Date.now(), taskId).run());
        } catch (e) {
          // ignore DB write errors but proceed with retry
        }

        // retry DoingTask with new token
        resp = await callDoingTask(doingUrl, newToken, cdsApiKey, taskId, taskUrlFromEvent);
        if (resp.ok) return resp;
      }
    }
  } catch (e) {
    // fall through to throw below
  }

  const text = await resp.text().catch(() => "");
  throw new Error(`HTTP ${resp.status} - ${text.slice(0, 800)}`);
}

// Attempt to refresh access token using provided refresh token.
// Returns new access token string or null on failure.
async function refreshAccessToken(env, apiBase, refreshToken, cdsApiKey, taskId, taskUrlFromEvent) {
  if (!refreshToken) return null;
  const path = env.REFRESH_TOKEN_PATH || "/api/auth/RefreshToken";
  const url = `${apiBase}${path}`;

  const origin = "https://cds.hcmict.io";
  const referer = taskUrlFromEvent || origin;

  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/plain, */*",
    "origin": origin,
    "referer": referer,
    "x-api-key": cdsApiKey || "",
    "x-request-timestamp": new Date().toISOString(),
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;
    // common fields: access_token, token, accessToken
    return j.access_token || j.token || (j.data && j.data.access_token) || j.accessToken || null;
  } catch (e) {
    return null;
  }
}

// Auto login using credentials from environment variables
async function autoLogin(env, apiBase, taskUrlFromEvent) {
  if (!env.LOGIN_USERNAME || !env.LOGIN_PASSWORD) return null;
  const path = env.LOGIN_PATH || "/api/auth/login";
  const url = `${apiBase}${path}`;

  const origin = "https://cds.hcmict.io";
  const referer = taskUrlFromEvent || origin;

  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/plain, */*",
    "origin": origin,
    "referer": referer,
    "x-request-timestamp": new Date().toISOString(),
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: env.LOGIN_USERNAME,
        password: env.LOGIN_PASSWORD,
        userName: env.LOGIN_USERNAME // For APIs that expect userName
      })
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;
    
    const token = j.access_token || j.token || (j.data && (j.data.access_token || j.data.token)) || j.accessToken || null;
    const refreshToken = j.refresh_token || j.refreshToken || (j.data && (j.data.refresh_token || j.data.refreshToken)) || null;
    
    return { token, refreshToken };
  } catch (e) {
    return null;
  }
}

async function authCheckByGetTaskInfo(env, apiBase, token, cdsApiKey, taskId, boardId, taskUrlFromEvent) {
  const t = String(taskId || "").trim();
  if (!t) return;

  const qs = new URLSearchParams();
  qs.set("taskId", t);
  if (boardId != null && String(boardId).trim()) qs.set("boardId", String(boardId).trim());

  const url = `${apiBase}/api/work/Task/GetTaskInfo?${qs.toString()}`;

  const origin = "https://cds.hcmict.io";
  const referer = taskUrlFromEvent || origin;

  const headers = {
    "accept": "application/json, text/plain, */*",
    "origin": origin,
    "referer": referer,
    "authorization": `Bearer ${token}`,
    "mac-address": "WEB",
    "x-api-key": cdsApiKey,
    "x-request-timestamp": new Date().toISOString(),
  };

  try {
    const r = await fetch(url, { method: "GET", headers });
    // intentionally not sending GetTaskInfo debug to Telegram (keep flow notifications only)
    await r.text().catch(() => "");
  } catch (e) {
    // ignore auth check errors silently
  }
}

async function callDoingTask(url, token, cdsApiKey, taskId, taskUrlFromEvent) {
  const taskIdNum = Number(taskId);
  const payload = { task_id: Number.isFinite(taskIdNum) ? taskIdNum : taskId };

  const origin = "https://cds.hcmict.io";
  const referer = taskUrlFromEvent || origin;

  // giống curl: ?t=...
  const u = new URL(url);
  u.searchParams.set("t", String(Date.now()));

  const headers = {
    "content-type": "application/json",
    "accept": "*/*",
    "origin": origin,
    "referer": referer,

    // ✅ quan trọng theo curl
    "authorization": `Bearer ${token}`,
    "mac-address": "WEB",
    "x-api-key": cdsApiKey,
    "x-request-timestamp": new Date().toISOString(),

    // optional, không bắt buộc nhưng có thể giúp vài gateway
    "cache-control": "no-cache",
    "pragma": "no-cache",
  };

  return fetch(u.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

// Delete tasks that are not from today (Vietnam timezone). Keep only records
// whose `updated_at` or `started_at` is today; older rows are removed to save storage.
async function cleanupOldTasks(env) {
  try {
    const now = Date.now();
    // Compute today's 00:00 in Vietnam timezone (UTC+7) as epoch ms.
    const tzOffset = 7 * 60 * 60 * 1000;
    const vn = new Date(now + tzOffset);
    const startOfTodayUtcMs = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - tzOffset;

    // Use COALESCE(updated_at, started_at, 0) so rows without updated_at use started_at.
    await runWithRetries(() => env.DB.prepare(
      `DELETE FROM tasks WHERE COALESCE(updated_at, started_at, 0) < ?`
    ).bind(startOfTodayUtcMs).run());
  } catch (e) {
    // ignore cleanup errors to avoid breaking cron; errors can be monitored separately
  }
}
