import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
export const settingsSchema = z.object({ collectionEnabled: z.boolean().optional(), collectionTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), timezone: z.string().refine(value => IANAZone.isValidZone(value), "Fuseau IANA invalide").optional() }).strict();
export function nextCollection(time: string, timezone: string, now = new Date()): Date {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  const [hour, minute] = time.split(":").map(Number);
  for (let offset = 0; offset < 3; offset++) {
    const day = local.plus({ days: offset });
    const date = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour: hour!, minute: minute! }, { zone: timezone });
    // Fall-back overlaps run once at the first occurrence. Spring gaps shift forward.
    const first = date.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0]!;
    if (first.toMillis() > now.getTime()) return first.toJSDate();
  }
  throw new Error("Cannot determine next collection date");
}
