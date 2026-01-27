let cachedAuth = null; // { token, tokenType, at }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://cds.hcmict.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      // ✅ allow extension send bearer + cds api key
      "Access-Control-Allow-Headers": "content-type, x-api-key, x-bearer, x-cds-api-key",
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
            warned, closed, paused_at, remaining_ms, client_bearer, client_cds_api_key, task_url, board_id, updated_at
          )
          VALUES(?, ?, 'RUNNING', ?, ?, ?, 0, 0, NULL, NULL, ?, ?, ?, ?, ?)
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
            task_url=excluded.task_url,
            board_id=excluded.board_id,
            updated_at=excluded.updated_at
        `).bind(taskId, title, startedAt, deadlineAt, warnAt, bearerFromClient, cdsApiKeyFromClient, taskUrl, boardId, now).run());

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
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (eventType === "DONE") {
        await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET status='CLOSED', closed=1, client_bearer=NULL, client_cds_api_key=NULL, updated_at=? WHERE task_id=?`)
          .bind(now, taskId).run());

        ctx.waitUntil(sendTelegram(env, `✅ DONE: ${title ?? taskId}`));
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      return Response.json(
        { ok: false, message: "Unknown eventType", received: eventTypeRaw },
        { headers: corsHeaders, status: 400 }
      );
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
  const now = Date.now();

  // 1) warn
  const warnRows = await env.DB.prepare(`
    SELECT task_id, title, deadline_at
    FROM tasks
    WHERE status='RUNNING' AND warned=0 AND warn_at <= ?
  `).bind(now).all();

  for (const r of warnRows.results) {
    await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET warned=1, updated_at=? WHERE task_id=?`)
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
    SELECT task_id, title, client_bearer, client_cds_api_key, task_url, board_id
    FROM tasks
    WHERE status='RUNNING' AND closed=0 AND deadline_at <= ?
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
      await runWithRetries(() => env.DB.prepare(`UPDATE tasks SET status='CLOSED', closed=1, client_bearer=NULL, client_cds_api_key=NULL, updated_at=? WHERE task_id=?`)
        .bind(now, r.task_id).run());
    } catch (e) {
      apiMsg = `❌ DoingTask FAIL: ${String(e).slice(0,600)}`;
      // leave task as RUNNING so it can be retried by later cron runs
    }

    await sendTelegram(env, `🔒 Auto close: ${r.title ?? r.task_id}\n${apiMsg}`);
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
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text })
  });
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
async function doingTaskWithTokenFirst(env, taskId, taskUrlFromEvent, boardId, bearerFromClient, cdsApiKeyFromClient) {
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
  const resp = await callDoingTask(doingUrl, token, cdsApiKey, taskId, taskUrlFromEvent);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} - ${text.slice(0, 800)}`);
  }
  return resp;
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
