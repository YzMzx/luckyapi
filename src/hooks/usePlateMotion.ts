import { useEffect, useState } from "react";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MOTION_EVENT = "lucky:plate-motion";
const MOTION_KEY = "lucky-plate-motion-paused";

export function readPlateMotionPreference() {
  return (
    !window.matchMedia(MOTION_QUERY).matches &&
    localStorage.getItem(MOTION_KEY) !== "1"
  );
}

/** Shares one explicit motion choice across every badge view on the page. */
export function usePlateMotion() {
  const [enabled, setEnabled] = useState(readPlateMotionPreference);

  useEffect(() => {
    const media = window.matchMedia(MOTION_QUERY);
    const sync = () => setEnabled(readPlateMotionPreference());
    media.addEventListener("change", sync);
    window.addEventListener(MOTION_EVENT, sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener(MOTION_EVENT, sync);
    };
  }, []);

  const toggle = () => {
    const next = !readPlateMotionPreference();
    localStorage.setItem(MOTION_KEY, next ? "0" : "1");
    window.dispatchEvent(new Event(MOTION_EVENT));
  };

  return { enabled, toggle };
}
