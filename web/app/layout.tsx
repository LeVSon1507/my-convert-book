import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

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
    <html lang="vi" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
