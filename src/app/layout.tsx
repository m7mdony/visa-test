import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Liveness Automation UI",
  description: "Internal UI for generating and testing liveness sessions",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-zinc-50`}
      >
        <div className="min-h-screen bg-zinc-100/80 flex flex-col">
          <header className="border-b border-zinc-200 bg-white/90 backdrop-blur">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold tracking-tight text-zinc-900">
                  Liveness Admin
                </span>
              </div>
              <nav className="flex items-center gap-4 text-sm text-zinc-600">
                <Link
                  href="/generate"
                  className="hover:text-zinc-950 transition-colors"
                >
                  Generate link
                </Link>
                <Link
                  href="/test"
                  className="hover:text-zinc-950 transition-colors"
                >
                  Testing
                </Link>
                <Link
                  href="/logs"
                  className="hover:text-zinc-950 transition-colors"
                >
                  Logs
                </Link>
                <Link
                  href="/report"
                  className="hover:text-zinc-950 transition-colors"
                >
                  Report
                </Link>
                <Link
                  href="/approved-videos"
                  className="hover:text-zinc-950 transition-colors"
                >
                  Approved videos
                </Link>
                <Link
                  href="/session-videos"
                  className="hover:text-zinc-950 transition-colors"
                >
                  Session videos
                </Link>
                <Link
                  href="/vfs-logs"
                  className="hover:text-zinc-950 transition-colors"
                >
                  VFS logs
                </Link>
              </nav>
            </div>
          </header>
          <main className="mx-auto flex w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
            <div className="w-full rounded-2xl border border-zinc-200 bg-white shadow-sm px-4 py-5 sm:px-6 sm:py-6">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}

