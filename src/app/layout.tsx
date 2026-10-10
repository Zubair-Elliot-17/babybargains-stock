import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Fonts are bundled (SIL OFL, see ./fonts) so builds never depend on a network fetch.
const instrument = localFont({
  variable: "--font-instrument",
  src: [
    { path: "./fonts/instrument-sans-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/instrument-sans-latin-500-normal.woff2", weight: "500" },
    { path: "./fonts/instrument-sans-latin-600-normal.woff2", weight: "600" },
  ],
});
const plexMono = localFont({
  variable: "--font-plex-mono",
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500" },
  ],
});

export const metadata: Metadata = {
  title: "BabyBargains Stock",
  description: "Ledger-first stock control for a fictional chain of baby-goods shops.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" className={`${instrument.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
