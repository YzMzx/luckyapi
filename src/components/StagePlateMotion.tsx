import { Pause, Play } from "lucide-react";
import { useEffect } from "react";
import { usePlateMotion } from "@/hooks/usePlateMotion";

export function PlateMotionControl() {
  const { enabled, toggle } = usePlateMotion();
  useEffect(() => {
    document.documentElement.dataset.plateMotion = enabled ? "on" : "off";
    return () => {
      delete document.documentElement.dataset.plateMotion;
    };
  }, [enabled]);
  return (
    <button type="button" className="plate-motion-control" onClick={toggle}>
      {enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      {enabled ? "暂停动效" : "播放动效"}
    </button>
  );
}

export function PlateMotionRegion({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { enabled } = usePlateMotion();
  return (
    <div className={className} data-plate-motion={enabled ? "on" : "off"}>
      {children}
    </div>
  );
}
