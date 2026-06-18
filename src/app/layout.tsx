import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trình Dịch Truyện AI",
  description:
    "Dịch truyện chất lượng cao và viết tiếp truyện bằng AI (Grok, ChatGPT, Gemini, OpenRouter).",
  icons: {
    icon: "/book.ico",
    apple: "/book.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
