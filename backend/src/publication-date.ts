import { DateTime, FixedOffsetZone, IANAZone } from "luxon";

const months = new Map<string, number>(
  [
    ["janvier janv jan january", 1],
    ["fevrier fevr fev february feb", 2],
    ["mars march mar", 3],
    ["avril avr april apr", 4],
    ["mai may", 5],
    ["juin june jun", 6],
    ["juillet juill juil july jul", 7],
    ["aout august aug", 8],
    ["septembre september sept sep", 9],
    ["octobre october oct", 10],
    ["novembre november nov", 11],
    ["decembre december dec", 12],
  ].flatMap(([names, month]) =>
    String(names)
      .split(" ")
      .map((name) => [name, Number(month)] as const),
  ),
);

function normalizedText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clock(value: string, timezone: string) {
  const text = value
    .trim()
    .replace(/^(?:a|at)\s+/, "")
    .replace(/^t(?=\d)/, "")
    .replace(/(\d)\s*h\s*(\d{1,2})?/g, (_match, hour, minute) => `${hour}:${minute ?? "00"}`);
  if (!text) return { hour: 0, minute: 0, second: 0, millisecond: 0, zone: timezone };
  const match =
    /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{2})(?:[.,](\d{1,3}))?)?\s*(am|pm)?\s*(z|utc|gmt|cet|cest|(?:utc|gmt)?[+-]\d{1,2}(?::?\d{2})?)?$/.exec(
      text,
    );
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[5]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[5] === "pm" ? 12 : 0);
  }
  let zone: string | FixedOffsetZone = timezone;
  if (match[6]) {
    const offset = match[6].replace(/^(?:utc|gmt)(?=[+-])/, "");
    if (["z", "utc", "gmt"].includes(offset)) zone = "UTC";
    else if (offset === "cet" || offset === "cest")
      zone = FixedOffsetZone.instance(offset === "cet" ? 60 : 120);
    else {
      const parts = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(offset);
      if (!parts || Number(parts[2]) > 23 || Number(parts[3] ?? 0) > 59) return null;
      zone = FixedOffsetZone.instance(
        (parts[1] === "+" ? 1 : -1) * (Number(parts[2]) * 60 + Number(parts[3] ?? 0)),
      );
    }
  }
  if (hour > 23 || Number(match[2] ?? 0) > 59 || Number(match[3] ?? 0) > 59) return null;
  return {
    hour,
    minute: Number(match[2] ?? 0),
    second: Number(match[3] ?? 0),
    millisecond: Number((match[4] ?? "0").padEnd(3, "0")),
    zone,
  };
}

function calendarDate(year: number, month: number, day: number, suffix: string, timezone: string) {
  const time = clock(suffix, timezone);
  if (!time) return null;
  const { zone, ...parts } = time;
  const parsed = DateTime.fromObject({ year, month, day, ...parts }, { zone });
  return parsed.isValid ? parsed.toUTC().toISO() : null;
}

// Numeric dates use French day/month order. Month/day is accepted only when
// the second component > 12 makes that interpretation unambiguous. No year is inferred.
export function parsePublicationDate(
  value: string,
  timezone = "UTC",
  reference = new Date(),
): string | null {
  if (!value || value.length > 1024 || !IANAZone.isValidZone(timezone)) return null;
  const raw = normalizedText(value);
  if (!raw) return null;
  const options = { zone: timezone };
  // Luxon also accepts a bare year/month/time as ISO. Require a complete date
  // to prevent a page's year or reading duration from becoming a publication date.
  if (
    /^\d{4}-(?:\d{2}-\d{2}|\d{3}|W\d{2}-[1-7])(?:[T ].*)?$/i.test(raw) ||
    /^\d{8}(?:T.*)?$/i.test(raw)
  ) {
    const iso = DateTime.fromISO(raw.toUpperCase(), options);
    if (iso.isValid) return iso.toUTC().toISO();
    // "CET" is an explicit +01:00 offset. Luxon's IANA CET zone also uses
    // daylight saving; handle this abbreviation with the fixed-offset clock below.
    if (!/\b(?:CET|CEST)\b/i.test(raw)) {
      const sql = DateTime.fromSQL(raw, options);
      if (sql.isValid) return sql.toUTC().toISO();
    }
  }
  for (const parsed of [
    DateTime.fromRFC2822(raw, options),
    DateTime.fromRFC2822(raw.replace(/^(?:mon|tue|wed|thu|fri|sat|sun),\s*/i, ""), options),
    DateTime.fromHTTP(raw, options),
  ])
    if (parsed.isValid) return parsed.toUTC().toISO();

  let text = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\u2212/g, "-");
  text = text
    .replace(
      /^(?:(?:date\s+de\s+publication|publication|publiee?|parue?|modifiee?|mise?\s+en\s+ligne|mise?\s+a\s+jour|published|posted|updated)(?:\s+(?:le|on))?\s*[:\-–—]?\s*|le\s+)/,
      "",
    )
    // Keep the leading publication date/time when an update follows it.
    // A modification-only label was already removed by the prefix rule above.
    .replace(/(?:\s*[,;|•·–—]\s*|\s+)(?:modifiee?|mise?\s+a\s+jour|updated)\b.*$/, "")
    .replace(
      /\s+(?:[|•·–—]\s*)?(?:par\s+.+|by\s+.+|(?:temps\s+de\s+)?lecture\s*[:\-]?.*|\d+\s*min(?:utes)?(?:\s+de\s+lecture)?)$/,
      "",
    )
    .trim();
  // "Mar 8, 2026" is a month-first date, not an abbreviated Tuesday label.
  if (!/^[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}/.test(text))
    text = text.replace(
      /^(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lun|mar|mer|jeu|ven|sam|dim|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\.?[,\s]+/,
      "",
    );

  const relativeDay = /^(aujourd'hui|today|hier|yesterday|avant-hier)(?:\s+(.*))?$/.exec(text);
  if (relativeDay) {
    const now = DateTime.fromJSDate(reference, options);
    if (!now.isValid) return null;
    const day = now.minus({
      days: ["hier", "yesterday"].includes(relativeDay[1]!)
        ? 1
        : relativeDay[1] === "avant-hier"
          ? 2
          : 0,
    });
    return calendarDate(day.year, day.month, day.day, relativeDay[2] ?? "", timezone);
  }
  const relative =
    /^(?:il y a\s+)?(\d+)\s+(minutes?|mins?|heures?|hours?|jours?|days?|semaines?|weeks?|mois|months?|ans?|years?)(?:\s+ago)?$/.exec(
      text,
    );
  if (relative && (text.startsWith("il y a ") || text.endsWith(" ago"))) {
    const amount = Number(relative[1]);
    if (amount > 10000) return null;
    const unit = relative[2]!;
    const duration = /^min/.test(unit)
      ? { minutes: amount }
      : /^(heure|hour)/.test(unit)
        ? { hours: amount }
        : /^(jour|day)/.test(unit)
          ? { days: amount }
          : /^(semaine|week)/.test(unit)
            ? { weeks: amount }
            : /^(mois|month)/.test(unit)
              ? { months: amount }
              : { years: amount };
    const parsed = DateTime.fromJSDate(reference, options).minus(duration);
    return parsed.isValid ? parsed.toUTC().toISO() : null;
  }
  // Prefixes can precede an ISO machine date too.
  if (/^\d{4}-\d{2}-\d{2}t/.test(text)) {
    const parsed = DateTime.fromISO(text.toUpperCase(), options);
    if (parsed.isValid) return parsed.toUTC().toISO();
  }
  const yearFirst = /^(\d{4})([/.\- ])(\d{1,2})\2(\d{1,2})(?:\s+(.*))?$/.exec(text);
  if (yearFirst)
    return calendarDate(
      Number(yearFirst[1]),
      Number(yearFirst[3]),
      Number(yearFirst[4]),
      yearFirst[5] ?? "",
      timezone,
    );
  const dayFirst = /^(\d{1,2})([/.\- ])(\d{1,2})\2(\d{4})(?:\s+(.*))?$/.exec(text);
  if (dayFirst) {
    let day = Number(dayFirst[1]),
      month = Number(dayFirst[3]);
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return calendarDate(Number(dayFirst[4]), month, day, dayFirst[5] ?? "", timezone);
  }
  const namedDayFirst =
    /^(\d{1,2})(?:er|e|st|nd|rd|th)?[\s-]+([a-z]+)\.?[\s-]+(\d{4})(?:\s+(.*))?$/.exec(text);
  if (namedDayFirst) {
    const month = months.get(namedDayFirst[2]!);
    return month
      ? calendarDate(
          Number(namedDayFirst[3]),
          month,
          Number(namedDayFirst[1]),
          namedDayFirst[4] ?? "",
          timezone,
        )
      : null;
  }
  const namedMonthFirst =
    /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})(?:\s+(.*))?$/.exec(text);
  if (namedMonthFirst) {
    const month = months.get(namedMonthFirst[1]!);
    return month
      ? calendarDate(
          Number(namedMonthFirst[3]),
          month,
          Number(namedMonthFirst[2]),
          namedMonthFirst[4] ?? "",
          timezone,
        )
      : null;
  }
  return null;
}

export function parsePublicationDateCandidates(
  values: Array<string | null | undefined>,
  timezone = "UTC",
  reference = new Date(),
) {
  for (const value of values) {
    if (!value?.trim()) continue;
    const parsed = parsePublicationDate(value, timezone, reference);
    if (parsed) return parsed;
  }
  return null;
}

export function parsePublicationDateGroups(
  groups: Array<Array<string | null | undefined>>,
  timezone = "UTC",
  reference = new Date(),
) {
  const dates = new Set(
    groups
      .map((values) => parsePublicationDateCandidates(values, timezone, reference))
      .filter((date) => date !== null),
  );
  return dates.size === 1 ? [...dates][0]! : null;
}
