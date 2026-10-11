/** Use the browser's IANA zone, including daylight saving rules, rather than a fixed offset. */
export function browserTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return null;
    new Intl.DateTimeFormat("fr-FR", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
}
