/**
 * formatMessengerTime — friendly, iMessage-style timestamp.
 *
 *   • Same day               → "2:14 PM"
 *   • Yesterday              → "Yesterday 2:14 PM"
 *   • Within the last 7 days → "Mon 2:14 PM"
 *   • Older                  → "Jun 12, 2:14 PM"
 *   • Different year         → "Jun 12 2024, 2:14 PM"
 *
 * Returns an empty string for unparseable input so callers can render
 * conditionally without extra null-checks.
 */
export function formatMessengerTime(input: string | number | Date): string {
  if (input == null) return '';
  const d = input instanceof Date ? input : new Date(input);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return '';

  const now = new Date();

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (sameDay(d, now)) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;

  const diffMs = now.getTime() - ms;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (diffMs > 0 && diffMs < sevenDaysMs) {
    const dow = d.toLocaleDateString(undefined, { weekday: 'short' });
    return `${dow} ${time}`;
  }

  const sameYear = d.getFullYear() === now.getFullYear();
  const dateStr = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${dateStr}, ${time}`;
}
