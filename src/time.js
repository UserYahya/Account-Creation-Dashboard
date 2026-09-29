// All times are stored as UTC ISO strings. Admins enter and read times in
// Bangladesh time (UTC+6, no daylight saving).

const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
const TIME_ZONE = 'Asia/Dhaka';

function nowIso() {
  return new Date().toISOString();
}

function isValidDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

// "2026-06-18T10:00" (Bangladesh time) -> "2026-06-18T04:00:00.000Z".
// Strings that already carry a timezone are parsed as-is.
function bdLocalToUtcIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  let date;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    date = new Date(v);
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(v)) {
    const withSeconds = v.length === 16 ? `${v}:00` : v;
    date = new Date(`${withSeconds.replace(' ', 'T')}+06:00`);
  } else {
    return null;
  }
  return isValidDate(date) ? date.toISOString() : null;
}

// UTC ISO -> "YYYY-MM-DDTHH:mm" in Bangladesh time (for datetime-local inputs)
function utcIsoToBdLocal(iso) {
  const date = new Date(iso);
  if (!isValidDate(date)) return '';
  return new Date(date.getTime() + BD_OFFSET_MS).toISOString().slice(0, 16);
}

// SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) -> ISO
function sqliteToIso(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(' ', 'T')}.000Z`;
  }
  const date = new Date(value);
  return isValidDate(date) ? date.toISOString() : null;
}

const formatters = new Map();
function formatter(style) {
  if (!formatters.has(style)) {
    const options = {
      datetime: { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
      date: { year: 'numeric', month: 'long', day: 'numeric' },
      short: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
      time: { hour: 'numeric', minute: '2-digit' }
    }[style] || {};
    formatters.set(style, new Intl.DateTimeFormat('bn-BD', { timeZone: TIME_ZONE, ...options }));
  }
  return formatters.get(style);
}

// Human-readable Bangla date in Bangladesh time
function formatBn(iso, style = 'datetime') {
  const date = new Date(iso);
  return isValidDate(date) ? formatter(style).format(date) : '-';
}

// Where an event is in its lifecycle
function eventPhase(event, now = new Date()) {
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  if (now < start) return 'upcoming';
  if (now > end) return 'finished';
  return 'ongoing';
}

function isRegistrationOpen(event, now = new Date()) {
  return eventPhase(event, now) === 'ongoing' && event.registration_active === 1;
}

module.exports = {
  TIME_ZONE,
  nowIso,
  bdLocalToUtcIso,
  utcIsoToBdLocal,
  sqliteToIso,
  formatBn,
  eventPhase,
  isRegistrationOpen
};
