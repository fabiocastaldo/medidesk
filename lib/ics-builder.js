function escIcs(s) {
  return String(s || '').replace(/[\\;,]/g, c => '\\' + c);
}

export function buildICS({ apptId, data, ora, medicoNome, location }) {
  const [y, mo, d] = (data || '').split('-');
  const [hh, mm] = (ora || '00:00').substring(0, 5).split(':');
  const dtStart = `${y}${mo}${d}T${hh}${mm}00Z`;
  const totalMin = parseInt(hh) * 60 + parseInt(mm) + 30;
  const endH = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const endM = String(totalMin % 60).padStart(2, '0');
  const dtEnd = `${y}${mo}${d}T${endH}${endM}00Z`;

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const summary = medicoNome ? `Visita medica - ${medicoNome}` : 'Visita medica';
  const description = medicoNome
    ? escIcs('Prenotazione confermata con ' + medicoNome)
    : 'Visita medica';

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Delphi~Med//IT',
    'BEGIN:VEVENT',
    `UID:${apptId || 'unknown'}@delphi-med.com`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escIcs(summary)}`,
    `DESCRIPTION:${description}`,
    location ? `LOCATION:${escIcs(location)}` : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}
