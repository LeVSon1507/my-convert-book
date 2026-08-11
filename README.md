This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Auth Configuration (Google OAuth + Firebase)

App hiện đang hỗ trợ:

- Email/Password đăng nhập cơ bản
- Google Social Login (OAuth)
- Quản lý hồ sơ account tại `/account`

### 1. Bật Google Provider trong Firebase

1. Vào Firebase Console -> Authentication -> Sign-in method.
2. Enable provider `Google`.
3. Thêm domain local/dev vào Authorized domains (ví dụ `localhost`).

### 2. Kiểm tra Firebase Web Config

Đảm bảo endpoint `/api/firebase-config` trả đủ các field:

- `apiKey`
- `authDomain`
- `projectId`
- `messagingSenderId`
- `appId`

Nếu thiếu một trong các field trên, auth client sẽ không khởi tạo được.

### 3. Firestore Rules (tối thiểu)

Vì app ghi hồ sơ người dùng vào collection `users/{uid}`, rules cần cho phép user chỉ đọc/ghi document của chính họ.

## Optional Later: Gmail SMTP (nếu cần gửi mail thủ công)

Hiện tại auth mail có thể dùng cơ chế managed của Firebase Auth.
Nếu sau này bạn muốn tự gửi email bằng Gmail SMTP (Nodemailer), cấu hình biến môi trường:

- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=465`
- `SMTP_SECURE=true`
- `SMTP_USER=your_gmail@gmail.com`
- `SMTP_PASS=<gmail_app_password>`
- `SMTP_FROM=your_gmail@gmail.com`

Lưu ý Gmail App Password yêu cầu bật 2-Step Verification cho tài khoản Gmail.
