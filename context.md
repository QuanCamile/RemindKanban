from pathlib import Path
md = r"""# Snapshot Context — Kanban Bridge (Extension ↔ Cloudflare Worker ↔ CDS API)

> **Ngày cập nhật:** 2026-01-27 (Asia/Ho_Chi_Minh)
> **Mục tiêu hiện tại:** Bấm **START** trên Kanban → extension gửi event → Worker nhận và xử lý (Telegram, lên lịch warn/auto-close tại deadline) → Worker gọi CDS API `DoingTask` khi đến thời hạn.
> **Trạng thái:** Worker đã cập nhật logic lưu token/tài nguyên client, xử lý pause/resume, và auto-close — nhưng cần đảm bảo `API_BASE` + environment credentials đúng để tránh WAF/Cloudflare/UI redirects.

---

## 1) Tổng quan luồng (End-to-end)
```markdown
# Snapshot Context — Kanban Bridge (Extension ↔ Cloudflare Worker ↔ CDS API)

> **Ngày cập nhật:** 2026-01-27 (Asia/Ho_Chi_Minh)
> **Mục tiêu:** START trên Kanban → extension gửi event → Worker nhận và xử lý (Telegram, lên lịch warn/auto-close tại deadline) → Worker gọi CDS API `DoingTask` khi đến thời hạn.

---

## Tóm tắt trạng thái hiện tại (cập nhật)

- `injected.js`: vẫn thu thập `taskId` và token từ trang (fetch/XHR hooks + storage/cookie) và gửi về `content.js`.
- `content.js`: gửi event `/events` tới Worker cùng `x-bearer` và `x-cds-api-key` khi có; đã cải thiện fallback để bắt token sớm hơn.
- `worker.js`: cập nhật nhiều thay đổi quan trọng (mô tả bên dưới).

Kết luận: extension cố gắng forward token/key; Worker có thể tự động đóng task nhưng cần cấu hình `API_BASE` đúng và/hoặc biến môi trường server credentials để tránh bị redirect/Cloudflare/UI.

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

Chi tiết thay đổi chính trong `worker.js`:
- Thêm/đảm bảo các cột DB runtime: `paused_at`, `remaining_ms`, `client_bearer`, `client_cds_api_key`, `task_url`, `board_id` (hàm `ensurePauseColumns`).
- `START`: lưu `started_at`, `deadline_at`, `warn_at`, `client_bearer`, `client_cds_api_key`, `task_url`, `board_id`. Nếu task đang `PAUSED` và không có override duration từ client, sẽ resume từ `remaining_ms`.
- `PAUSE`: lưu `paused_at` và `remaining_ms` (deadline - now), xóa `warn_at`/`warned` để cron không warn/close khi paused.
- Resume logic: nếu client gửi explicit `plannedHours` hoặc `deadlineSeconds` thì sẽ dùng giá trị mới và không resume từ `remaining_ms`.
- Auto-close: `handleCron()` gọi `ensurePauseColumns()` trước, gửi warn khi `warn_at` tới, và auto-close trước deadline theo `AUTO_CLOSE_BEFORE_SECONDS` (mặc định 300s). Khi auto-close, Worker sẽ ưu tiên dùng `client_bearer`/`client_cds_api_key` lưu trong DB, nếu thiếu thì fallback `env.CLOSE_TASK_BEARER`/`env.CDS_API_KEY`.
- Khi gọi `DoingTask`, Worker giờ gọi API trước, và chỉ mark `CLOSED` (và xóa client token) khi API trả OK. Nếu API lỗi, task vẫn để `RUNNING` để cron thử lại.
- Debug: đã có debug tạm để chẩn đoán, tuy nhiên sau khi xác định `API_BASE` là nguyên nhân chính, hầu hết tin nhắn debug Telegram đã bị loại bỏ; Worker bây giờ chỉ gửi thông báo chính (START/PAUSE/DONE/warn/auto-close kết quả).

---

## Khuyến nghị hành động tiếp theo

1) Kiểm tra và đặt `API_BASE` trỏ đúng tới API host (ví dụ `https://api_cds.hcmict.io`) — đây là nguyên nhân thường gặp khiến Worker nhận HTML/Cloudflare challenge hoặc 405.
2) Thiết lập fallback env trên Cloudflare Worker:
   - `CLOSE_TASK_BEARER` = token dùng để gọi CDS API khi client token không có
   - `CDS_API_KEY` = backend API key tương tự header `x-api-key` trong curl của trình duyệt
3) Test nhanh: tạo task với `deadlineSeconds` ngắn (ví dụ 60s) để kiểm thử cron/auto-close và quan sát Telegram thông báo.
4) Nếu server vẫn trả HTML/Cloudflare challenge/405: phối hợp với infra để whitelist Worker outbound hoặc cung cấp server-side API credentials; hoặc điều chỉnh backend để chấp nhận server-to-server calls.
5) (Optional) Thay `content_scripts.run_at` trong `manifest.json` sang `document_start` để tăng khả năng bắt token/taskId sớm với SPA.

---

## Kiểm tra nhanh (test checklist)

- [ ] Mở DevTools page: kiểm tra `window.__KANBAN_CAPTURED_TOKEN__` và `window.__KANBAN_CAPTURED_LAST_TASK__` có giá trị.
- [ ] Click START → content gửi event; Worker Telegram nhận START (có ETA).
- [ ] Kiểm tra `API_BASE` trên Worker: đảm bảo trỏ tới API host (không phải web UI).
- [ ] Thiết lập `CLOSE_TASK_BEARER`/`CDS_API_KEY` trên Worker → tạo task test với `deadlineSeconds` ngắn → quan sát cron auto-close và Telegram.

---

*End of snapshot.*
"""


