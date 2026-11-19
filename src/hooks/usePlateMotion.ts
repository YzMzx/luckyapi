import { useEffect, useState } from "react";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MOTION_EVENT = "lucky:plate-motion";
const MOTION_KEY = "lucky-plate-motion-paused";

function readPreference() {
  return (
    !window.matchMedia(MOTION_QUERY).matches &&
    localStorage.getItem(MOTION_KEY) !== "1"
  );
}

/** Keeps every badge collection and its visible pause control in sync. */
export function usePlateMotion() {
  const [enabled, setEnabled] = useState(readPreference);
  useEffect(() => {
    const media = window.matchMedia(MOTION_QUERY);
    const sync = () => setEnabled(readPreference());
    media.addEventListener("change", sync);
    window.addEventListener(MOTION_EVENT, sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener(MOTION_EVENT, sync);
    };
  }, []);
  const toggle = () => {
    const next = !readPreference();
    localStorage.setItem(MOTION_KEY, next ? "0" : "1");
    window.dispatchEvent(new Event(MOTION_EVENT));
  };
  return { enabled, toggle };
}
