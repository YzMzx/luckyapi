import { env } from "node:process";

/** Operators can suspend new orders without stopping existing settlement. */
export function sevenPickLaunchReady(): boolean {
  return env.SEVEN_PICK_ENABLED === "1";
}
