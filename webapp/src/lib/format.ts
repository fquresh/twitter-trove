// Small helpers for formatting numbers and times consistently across views.

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

export function formatDate(sec: number | null): string {
  if (sec === null) return '';
  const d = new Date(sec * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(sec: number): string {
  const d = new Date(sec * 1000);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBucket(bucket: string): string {
  // Bucket keys look like "2024", "2024-03", "2024-W12", or "2024-03-15".
  if (/^\d{4}$/.test(bucket)) return bucket;
  if (/^\d{4}-W\d{2}$/.test(bucket)) return bucket.replace('-W', ' W');
  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const [y, m] = bucket.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
    });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const [y, m, d] = bucket.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return bucket;
}

// Render the Sunday-start week bucket (YYYY-MM-DD of the Sunday) as a tight
// "M/D-M/D 'YY" range covering Sun..Sat - readable at a glance on chart axes.
export function formatWeekRange(sundayBucket: string): string {
  const m = sundayBucket.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return sundayBucket;
  const sunday = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);
  const yy = String(saturday.getFullYear()).slice(-2);
  return `${sunday.getMonth() + 1}/${sunday.getDate()}-${saturday.getMonth() + 1}/${saturday.getDate()} '${yy}`;
}
