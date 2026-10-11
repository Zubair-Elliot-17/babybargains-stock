"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./count.module.css";

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

// Camera scan via the browser's BarcodeDetector; typed search stays the fallback.
export function Scanner({ onResult, onClose }: { onResult: (value: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const callback = useRef(onResult); // parent re-renders must not restart the camera
  useEffect(() => {
    callback.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    const Ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = new Ctor({ formats: ["code_128", "ean_13", "qr_code", "code_39"] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then(async (s) => {
        stream = s;
        if (stopped || !video.current) return;
        video.current.srcObject = s;
        await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) return callback.current(found[0].rawValue);
          timer = window.setTimeout(tick, 250);
        };
        void tick();
      })
      .catch(() => setError("Camera unavailable or permission denied. Type the product name or SKU instead."));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className={styles.scanner} role="dialog" aria-label="Scan a label">
      {error ? <p className="banner banner-error" role="alert">{error}</p> : <video ref={video} className={styles.video} muted playsInline />}
      <button className={`btn ${styles.bigButton}`} onClick={onClose}>{error ? "Type instead" : "Cancel"}</button>
    </div>
  );
}
