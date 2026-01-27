# RemindKanban

Lightweight Chrome extension để quản lý và nhắc nhở công việc theo Kanban trong khay (tray).

## Mô tả
RemindKanban cho phép bạn xem nhanh các thẻ Kanban, nhận nhắc nhở và tương tác trực tiếp từ khay hệ thống / popup trình duyệt.

## Tính năng
- Hiển thị bảng Kanban nhỏ gọn
- Nhắc nhở công việc (reminders/notifications)
- Tải lên/nhúng nhanh mà không cần mở tab đầy đủ

## Cài đặt (dev)
1. Clone repository:

```bash
git clone https://github.com/QuanCamile/RemindKanban.git
cd RemindKanban
```

2. Mở Chrome → `chrome://extensions` → bật `Developer mode` → `Load unpacked` → chọn thư mục dự án.

3. Chỉnh sửa file trong thư mục (`content.js`, `injected.js`, `manifest.json`, ...), sau đó reload extension.

## Cách sử dụng
- Mở popup extension từ thanh tiện ích của trình duyệt để xem/điều chỉnh thẻ Kanban.
- Tùy chỉnh cài đặt nhắc nhở trong mã nếu cần.

## Phát triển
- Không có bước build nếu bạn dùng mã nguồn trực tiếp; nếu thêm bundler (webpack/vite), tạo `dist/` và cập nhật `manifest.json`.
- Kiểm tra `manifest.json` trước khi đóng gói.

## Đóng gói
- Dùng tính năng `Pack extension` của Chrome để tạo file `.crx` hoặc zip để phân phối.

## License
Đề xuất: MIT — nếu bạn muốn, tôi có thể thêm file `LICENSE`.

## Liên hệ
Tạo issue hoặc pull request trên GitHub: https://github.com/QuanCamile/RemindKanban
