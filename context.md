from pathlib import Path
md = r"""# Snapshot Context — Kanban Bridge (Extension ↔ Cloudflare Worker ↔ CDS API)

> **Ngày cập nhật:** 2026-01-28 (Asia/Ho_Chi_Minh)
> **Mục tiêu hiện tại:** Bấm **START** trên Kanban → extension gửi event → Worker nhận và xử lý (Telegram, lên lịch warn/auto-close tại deadline) → Worker gọi CDS API `DoingTask` khi đến thời hạn.
> **Trạng thái:** Worker đã cập nhật logic lưu token/tài nguyên client, xử lý pause/resume, và auto-close — nhưng cần đảm bảo `API_BASE` + environment credentials đúng để tránh WAF/Cloudflare/UI redirects.

---

## 1) Tổng quan luồng (End-to-end)
```markdown
# Snapshot Context — Kanban Bridge (Extension ↔ Cloudflare Worker ↔ CDS API)

> **Ngày cập nhật:** 2026-01-28 (Asia/Ho_Chi_Minh)
> **Mục tiêu:** START trên Kanban → extension gửi event → Worker nhận và xử lý (Telegram, lên lịch warn/auto-close tại deadline) → Worker gọi CDS API `DoingTask` khi đến thời hạn.

---

## Tóm tắt trạng thái hiện tại (cập nhật)

- `injected.js`: vẫn thu thập `taskId` và token từ trang (fetch/XHR hooks + storage/cookie) và gửi về `content.js`.
- `content.js`: gửi event `/events` tới Worker cùng `x-bearer` và `x-cds-api-key` khi có.
- `worker.js`: Nâng cấp lớn để phục vụ trực tiếp web dashboard (`GET /`) và cung cấp API nội bộ cho frontend (`/api/tasks`, `/api/work/Task/DoingTask`). Xử lý triệt để logic 401 token refresh và auto-login fallback bằng cách tận dụng thông tin tài khoản đăng nhập (`LOGIN_USERNAME`, `LOGIN_PASSWORD`).
- `index.html`: Được thiết kế lại toàn bộ với giao diện Glassmorphism cao cấp, hiển thị bảng danh sách các task đang thực hiện, tự động tải dữ liệu bằng AJAX, có hiệu ứng skeleton loading mượt mà, và bổ sung các nút hành động (Refresh, Pause).

Kết luận: Hệ thống nay không chỉ phục vụ Telegram Bot nhắc nhở mà còn tích hợp một Web Dashboard hoàn chỉnh để người dùng có thể theo dõi trực tiếp tình trạng các Task ở step đang quan tâm.

---

## Vấn đề còn lưu ý (cập nhật)

- Trước đây Worker có trả về HTML/Cloudflare challenge hoặc HTTP 405 khi gọi API — nguyên nhân chính thường là `API_BASE` trỏ sai (web UI host thay vì API host) hoặc WAF/Cloudflare redirect do request không có ngữ cảnh trình duyệt.
- Backend có thể yêu cầu header/cookie/session đặc thù; Worker hiện gửi các header giống curl/trình duyệt (`authorization`, `mac-address: WEB`, `origin`, `referer`, `x-api-key`, `x-request-timestamp`) nhưng vẫn có thể bị chặn.
- Bảo đảm Worker có credentials hợp lệ vào lúc cron chạy. Hai hướng:
  1. Tiếp tục truyền `x-bearer` + `x-cds-api-key` từ extension (không đảm bảo với SPA/timing).
  2. Thiết lập biến môi trường fallback trên Cloudflare Worker: `CLOSE_TASK_BEARER` và `CDS_API_KEY` (khuyến nghị cho auto-close ổn định).

---

## File/flow chính và vai trò (tóm tắt)

- `injected.js` — chạy trong page main world, hook network + scan storage, postMessage về `content.js`.
- `content.js` — content script, hiển thị modal, build payload, gửi POST `/events` tới Worker kèm `x-bearer`/`x-cds-api-key` khi có.
- `sw.js` — chuyển tiếp nếu cần từ background → Worker endpoint.
- `worker.js` — nhận event, lưu task, gửi Telegram, lên lịch `deadlineAt/warnAt`, `handleCron()` thực hiện auto-close bằng gọi `DoingTask`.

Additional change: `worker.js` now includes a daily cleanup step (`cleanupOldTasks`) that deletes `tasks` rows older than the current VN day (UTC+7). The cleanup runs at the start of the scheduled cron and ignores errors so the rest of the cron logic still runs. This helps limit D1 storage use for single-user setups.

Chi tiết thay đổi chính trong `worker.js` và `index.html`:
- **Web Dashboard:** `worker.js` giờ đây map HTML file từ `index.html` lên thư mục gốc `/`. Giao diện có nút Refresh và nút Pause. Khi nhấn Pause từ UI, Dashboard gọi một API proxy nội bộ `/api/work/Task/DoingTask`.
- **API Proxy an toàn:** `/api/work/Task/DoingTask` trên `worker.js` nhận `taskId`, sau đó tự động tìm token từ DB và đẩy lên hệ thống CDS, tránh lỗi CORS hay lộ Token của người dùng. Mỗi lần gửi Pause thành công hoặc lỗi từ Dashboard đều có thông báo bắn về Telegram.
- **Quy tắc Trạng thái:** Chuẩn hóa logic hiển thị trạng thái hoàn toàn theo biến `running_flag`: `1` -> ĐANG THỰC HIỆN, `2` -> ĐÃ PAUSE, `null`/`0` -> GIAO VIỆC. Các trạng thái này sẽ đồng bộ cả trên Dashboard và tin nhắn Telegram.
- **Thêm/đảm bảo các cột DB runtime:** `paused_at`, `remaining_ms`, `client_bearer`, `client_cds_api_key`, `client_refresh_token`, `task_url`, `board_id` (hàm `ensurePauseColumns`).
- `START`: lưu `started_at`, `deadline_at`, `warn_at`, `client_bearer`, `client_cds_api_key`, `task_url`, `board_id`. Nếu task đang `PAUSED` và không có override duration từ client, sẽ resume từ `remaining_ms`.
- `PAUSE`: lưu `paused_at` và `remaining_ms` (deadline - now), xóa `warn_at`/`warned` để cron không warn/close khi paused.
- Resume logic: nếu client gửi explicit `plannedHours` hoặc `deadlineSeconds` thì sẽ dùng giá trị mới và không resume từ `remaining_ms`.
- Auto-close: `handleCron()` gọi `ensurePauseColumns()` trước, gửi warn khi `warn_at` tới, và auto-close trước deadline. Khi auto-close hoặc Pause, Worker ưu tiên dùng `client_bearer`/`client_cds_api_key` lưu trong DB, nếu thiếu thì fallback tới `env.CLOSE_TASK_BEARER`/`env.CDS_API_KEY`.
- Xử lý Token: Nếu gặp 401 khi gọi API, Worker sẽ cố gắng `refreshAccessToken` bằng `client_refresh_token`. Nếu không có hoặc thất bại, sẽ fallback gọi `/api/account/Login` bằng `env.LOGIN_USERNAME` và `PASSWORD` để tự động lấy token mới cực kỳ kiên cố.

---

## Khuyến nghị hành động tiếp theo

1) Kiểm tra và đặt `API_BASE` trỏ đúng tới API host (ví dụ `https://api_cds.hcmict.io`) — đây là nguyên nhân thường gặp khiến Worker nhận HTML/Cloudflare challenge hoặc 405.
2) Thiết lập fallback env trên Cloudflare Worker:
   - `CLOSE_TASK_BEARER` = token dùng để gọi CDS API khi client token không có
   - `CDS_API_KEY` = backend API key tương tự header `x-api-key` trong curl của trình duyệt
3) Test nhanh: tạo task với `deadlineSeconds` ngắn (ví dụ 60s) để kiểm thử cron/auto-close và quan sát Telegram thông báo.
4) (Retention) Worker hiện xóa các bản ghi cũ (không phải ngày hôm nay) theo mặc định. Nếu bạn muốn thay đổi chính sách (giữ N ngày, dùng `deadline_at` thay vì `updated_at`, hoặc giữ `RUNNING` rows), chỉnh `cleanupOldTasks` trong `worker.js`.
5) Nếu server vẫn trả HTML/Cloudflare challenge/405: phối hợp với infra để whitelist Worker outbound hoặc cung cấp server-side API credentials; hoặc điều chỉnh backend để chấp nhận server-to-server calls.
6) (Optional) Thay `content_scripts.run_at` trong `manifest.json` sang `document_start` để tăng khả năng bắt token/taskId sớm với SPA.

---

## Kiểm tra nhanh (test checklist)

- [ ] Mở DevTools page: kiểm tra `window.__KANBAN_CAPTURED_TOKEN__` và `window.__KANBAN_CAPTURED_LAST_TASK__` có giá trị.
- [ ] Click START → content gửi event; Worker Telegram nhận START (có ETA).
- [ ] Kiểm tra `API_BASE` trên Worker: đảm bảo trỏ tới API host (không phải web UI).
- [ ] Thiết lập `CLOSE_TASK_BEARER`/`CDS_API_KEY` trên Worker → tạo task test với `deadlineSeconds` ngắn → quan sát cron auto-close và Telegram.

---

*End of snapshot.*
"""


