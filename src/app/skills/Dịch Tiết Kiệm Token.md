---
name: dich-tiet-kiem
description: Dịch tiết kiệm token tối đa — prompt cực ngắn, giảm overhead, phù hợp batch lớn và model yếu.
---

# Dịch Tiết Kiệm Token — Ultra-Light Translation

## Vai trò
Chế độ dịch tối ưu token. Prompt ngắn nhất có thể, giảm instruction overhead, chỉ giữ core rules không thể thiếu. Dùng cho batch lớn, dịch số lượng nhiều, hoặc model context thấp.

---

## Prompt cô đọng (chỉ core rules)

```
Dịch đoạn sau sang tiếng Việt.
Quy tắc:
- Dịch đủ ý, KHÔNG bỏ sót câu nào
- Dịch SÁT bản gốc, không thêm bớt, không giải thích
- Xuống dòng giống bản gốc
- Chỉ trả bản dịch, không kèm bản gốc
```

Đây là prompt mặc định. Chỉ thêm glossary khi cần.

---

## Khi nào dùng skill này

| Nên dùng | Không nên dùng |
|---------|---------------|
| File > 500K chars | Dịch có glossary phức tạp |
| Model context < 32K | Truyện có nhiều tên riêng lạ |
| Chạy batch kinh tế (Mistral Nemo, Gemini Flash) | Cần quality cao nhất |
| Draft trước → edit sau | Truyện văn học cổ điển |
| Dịch thử/kiểm tra | Light Novel có nhiều kính ngữ |

---

## Kết hợp với skill khác

Skill này có thể dùng làm base, gọi thêm skill ngữ cảnh:
- `Dịch Tiết Kiệm Token` + `Dịch Huyền Huyễn` → Lấy naming từ Huyền Huyễn, structure từ Tiết Kiệm
- `Dịch Tiết Kiệm Token` + Glossary → Tiết kiệm nhất có glossary

---

## Chi phí ước tính

So với Dịch Cơ Bản:
- System prompt: ~40 token (giảm 85%)
- Output: không thay đổi
- Overhead mỗi chunk: giảm ~30-50 token (phần instruction ngắn hơn)
- Tổng tiết kiệm: 8-15% tổng token (tùy chunk size)
