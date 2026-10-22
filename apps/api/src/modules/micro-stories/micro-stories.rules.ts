/** Schedule at 06:00 on a later local calendar day, including across DST changes. */
export function nextReviewAt(now: Date, days: number, timezone: string) {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) => Number(dateParts.find((item) => item.type === name)?.value);
  const target = Date.UTC(part('year'), part('month') - 1, part('day') + days, 6);
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const zone =
      offsetFormatter.formatToParts(new Date(instant)).find((item) => item.type === 'timeZoneName')
        ?.value ?? 'GMT';
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(zone);
    const minutes = match
      ? (Number(match[2]) * 60 + Number(match[3] ?? 0)) * (match[1] === '+' ? 1 : -1)
      : 0;
    instant = target - minutes * 60_000;
  }
  return new Date(instant);
}
