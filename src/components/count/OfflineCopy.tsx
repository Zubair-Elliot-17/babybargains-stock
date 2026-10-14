"use client";

import { useEffect, useState } from "react";

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Registers the service worker that keeps the count page openable offline (public/sw.js), and says so
// when this page is that saved copy: counts sent after it was saved are safe but not shown.
export function OfflineCopy() {
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js").catch(() => {}); // no worker: the page just can't open offline
    const sw = navigator.serviceWorker.controller;
    if (!sw) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      if (e.data?.fromCache) setCachedAt(e.data.cachedAt);
    };
    sw.postMessage({ type: "served?", url: location.href }, [channel.port2]);
    return () => channel.port1.close();
  }, []);
  if (cachedAt === null) return null;
  return (
    <p className="banner" role="status">
      No signal: this is the copy of this page saved at {time(cachedAt)}. Counts saved since then are safe but not shown.
      New counts wait on this phone and send when signal returns.
    </p>
  );
}
