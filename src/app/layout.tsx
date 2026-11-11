import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Fonts are bundled (SIL OFL, see ./fonts) so builds never depend on a network fetch.
const geist = localFont({
  variable: "--font-geist",
  src: [{ path: "./fonts/geist-latin-wght-normal.woff2", weight: "100 900", style: "normal" }],
});
const geistMono = localFont({
  variable: "--font-geist-mono",
  src: [{ path: "./fonts/geist-mono-latin-wght-normal.woff2", weight: "100 900", style: "normal" }],
});

export const metadata: Metadata = {
  title: "BabyBargains Stock",
  description: "Ledger-first stock control for a fictional chain of baby-goods shops.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
