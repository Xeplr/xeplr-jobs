/**
 * "3 minutes ago", for the run history.
 *
 * Carried here rather than imported from a host: this package cannot depend on
 * xeplr-bi, and a shared date helper is not worth a package of its own. Lifted
 * verbatim from xeplr-bi's reportsList.js so the two read identically — if one
 * ever needs to change, both should.
 */
export function relativeTime(value, now) {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const seconds = Math.round(((now || Date.now()) - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
