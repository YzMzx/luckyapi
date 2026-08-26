export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 8 * 60;
export const DEFAULT_BUSINESS_DAY_START_HOUR = 0;

export interface BusinessDayInfo {
  key: string;
  startsAt: Date;
  endsAt: Date;
}

export function businessDayInfo(
  now = new Date(),
  timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
  startHour = DEFAULT_BUSINESS_DAY_START_HOUR,
): BusinessDayInfo {
  if (!Number.isInteger(timezoneOffsetMinutes) || timezoneOffsetMinutes < -720 || timezoneOffsetMinutes > 840)
    throw new Error("timezoneOffsetMinutes must be an integer between -720 and 840");
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23)
    throw new Error("startHour must be an integer between 0 and 23");

  const shifted = new Date(now.getTime() + timezoneOffsetMinutes * 60_000 - startHour * 3_600_000);
  const key = shifted.toISOString().slice(0, 10);
  const [year, month, day] = key.split("-").map(Number);
  const startsAtMs = Date.UTC(year, month - 1, day, startHour) - timezoneOffsetMinutes * 60_000;
  return {
    key,
    startsAt: new Date(startsAtMs),
    endsAt: new Date(startsAtMs + 86_400_000),
  };
}

export function dollarsToCents(value: number): number {
  if (!Number.isFinite(value) || value < 0 || Math.round(value * 100) !== value * 100)
    throw new Error("amount must be non-negative with at most two decimal places");
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) throw new Error("amount is too large");
  return cents;
}

export function centsToDollars(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("invalid money units");
  return value / 100;
}

export interface WeightedReward {
  rewardUnits: number;
  probabilityPpm: number;
}

export function validateWeightedRewards(rewards: WeightedReward[], minUnits: number, maxUnits: number) {
  if (!rewards.length || rewards.length > 20) throw new Error("reward tiers must contain 1 to 20 items");
  let total = 0;
  for (const reward of rewards) {
    if (!Number.isSafeInteger(reward.rewardUnits) || reward.rewardUnits < minUnits || reward.rewardUnits > maxUnits)
      throw new Error("reward tier is outside the configured range");
    if (!Number.isInteger(reward.probabilityPpm) || reward.probabilityPpm < 0 || reward.probabilityPpm > 1_000_000)
      throw new Error("reward tier probability is invalid");
    total += reward.probabilityPpm;
  }
  if (total !== 1_000_000) throw new Error("reward tier probabilities must total 100%");
}

export function selectWeightedReward(
  randomInt: (maxExclusive: number) => number,
  rewards: WeightedReward[],
): WeightedReward {
  const roll = randomInt(1_000_000);
  let cursor = 0;
  for (const reward of rewards) {
    cursor += reward.probabilityPpm;
    if (roll < cursor) return reward;
  }
  throw new Error("invalid reward probabilities");
}

export function sanitizeAnnouncementText(value: string, maxLength: number): string {
  const cleaned = value
    .normalize("NFKC")
    // Deliberately strip C0 controls and bidi override/isolate controls from administrator-authored text.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/<\s*\/?\s*(?:script|iframe|object|embed|style|link|meta)\b[^>]*>/gi, "")
    .trim();
  if (!cleaned) throw new Error("content cannot be empty");
  if (cleaned.length > maxLength) throw new Error(`content cannot exceed ${maxLength} characters`);
  return cleaned;
}
