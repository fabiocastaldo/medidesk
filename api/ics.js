function esc(s) {
  return String(s || '').replace(/[\\;,]/g, c => '\\' + c);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id, token } = req.query;
  if (!id || !token) return res.status(400).send('Parametri mancanti');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).send('Configurazione incompleta');

  const base = `${supabaseUrl}/rest/v1`;
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`
  };

  // Fetch appuntamento, validating token
  let appt;
  try {
    const r = await fetch(
      `${base}/appuntamenti?id=eq.${encodeURIComponent(id)}&cancellation_token=eq.${encodeURIComponent(token)}&select=id,data,ora,centro_id`,
      { headers }
    );
    const rows = await r.json();
    appt = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    return res.status(500).send('Errore DB');
  }

  if (!appt) return res.status(404).send('Appuntamento non trovato');

  // Fetch centro for location
  let location = '';
  if (appt.centro_id) {
    try {
      const r = await fetch(
        `${base}/centri?id=eq.${encodeURIComponent(appt.centro_id)}&select=nome,via,citta,provincia`,
        { headers }
      );
      const rows = await r.json();
      const c = Array.isArray(rows) ? rows[0] : null;
      if (c) {
        const addr = [c.via, c.citta, c.provincia].filter(Boolean).join(', ');
        location = [c.nome, addr].filter(Boolean).join(', ');
      }
    } catch (_) {}
  }

  // Build ICS
  const [y, m, d] = (appt.data || '').split('-');
  const [hh, mm] = (appt.ora || '00:00').substring(0, 5).split(':');
  const dtStart = `${y}${m}${d}T${hh}${mm}00`;
  const totalMin = parseInt(hh) * 60 + parseInt(mm) + 30;
  const endH = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const endM = String(totalMin % 60).padStart(2, '0');
  const dtEnd = `${y}${m}${d}T${endH}${endM}00`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Delphi~Med//IT',
    'BEGIN:VEVENT',
    `UID:${id}@delphi-med.com`,
    `DTSTART;TZID=Europe/Rome:${dtStart}`,
    `DTEND;TZID=Europe/Rome:${dtEnd}`,
    'SUMMARY:Visita medica',
    location ? `LOCATION:${esc(location)}` : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="visita_medica.ics"');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(lines);
}
