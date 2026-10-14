"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const enabled = () => "serviceWorker" in navigator && process.env.NODE_ENV === "production"; // dev chunks must not be cached
export const SAVE_COPY_EVENT = "bb:save-copy"; // CountScreen fires it after counts send, so the copy stays current

// Keeps the count page openable offline (public/sw.js): asks the worker to save each page this clerk
// opens, and says so when the page on screen is that saved copy. While it is, <html data-offline-copy>
// holds the save time, so the count screen can ask "add or replace?" for counts it can't see.
export function OfflineCopy({ sessionExpiresAt }: { sessionExpiresAt: number }) {
  const path = usePathname();
  const [copy, setCopy] = useState<{ path: string; cachedAt: number } | null>(null);
  const cachedAt = copy?.path === path ? copy.cachedAt : null; // a client-side move to another page is live

  useEffect(() => {
    if (!enabled()) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {}); // no worker: the page just can't open offline
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: "save", url: location.href, expiresAt: sessionExpiresAt }));
      }, 1000);
    };
    window.addEventListener(SAVE_COPY_EVENT, save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(SAVE_COPY_EVENT, save);
    };
  }, [sessionExpiresAt]);

  useEffect(() => {
    if (!enabled()) return;
    const sw = navigator.serviceWorker.controller;
    if (sw) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        if (!e.data?.fromCache) {
          setCopy(null); // e.g. back on a page first opened from the copy, now live
          return void window.dispatchEvent(new Event(SAVE_COPY_EVENT)); // live page: save it
        }
        setCopy({ path, cachedAt: e.data.cachedAt });
      };
      sw.postMessage({ type: "served?", url: location.href }, [channel.port2]);
      return () => channel.port1.close();
    }
    window.dispatchEvent(new Event(SAVE_COPY_EVENT)); // first visit: not controlled yet, but save it
  }, [path]);

  useEffect(() => {
    if (cachedAt === null) delete document.documentElement.dataset.offlineCopy;
    else document.documentElement.dataset.offlineCopy = time(cachedAt);
  }, [cachedAt]);

  if (cachedAt === null) return null;
  return (
    <p className="banner" role="status">
      Offline copy of this page, saved at {time(cachedAt)}. Counts saved since then are safe but not shown here.
      New counts wait on this phone and send when signal returns.
    </p>
  );
}
