function escIcs(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export function buildICS({ apptId, data, ora, durataMin = 30, summary, description, location }) {
  const [y, mo, d] = (data || '').split('-');
  const [hh, mm] = (ora || '00:00').substring(0, 5).split(':');
  const dtLocal = `${y}${mo}${d}T${hh}${mm}00`;
  const totalMin = parseInt(hh, 10) * 60 + parseInt(mm, 10) + Math.max(1, Math.round(+durataMin || 30));
  const endH = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const endM = String(totalMin % 60).padStart(2, '0');
  const dtEnd = `${y}${mo}${d}T${endH}${endM}00`;

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const summaryLine = (summary || 'Visita medica').trim();
  const descLine    = (description || summaryLine).trim();

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Delphi~Med//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Rome',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${apptId || 'unknown'}@delphi-med.com`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=Europe/Rome:${dtLocal}`,
    `DTEND;TZID=Europe/Rome:${dtEnd}`,
    `SUMMARY:${escIcs(summaryLine)}`,
    `DESCRIPTION:${escIcs(descLine)}`,
    location ? `LOCATION:${escIcs(location)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}
