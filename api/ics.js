import { buildICS } from '../lib/ics-builder.js';

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
      `${base}/appuntamenti?id=eq.${encodeURIComponent(id)}&cancellation_token=eq.${encodeURIComponent(token)}&select=id,data,ora,centro_id,medico_id`,
      { headers }
    );
    const rows = await r.json();
    appt = Array.isArray(rows) ? rows[0] : null;
  } catch (_) {
    return res.status(500).send('Errore DB');
  }

  if (!appt) return res.status(404).send('Appuntamento non trovato');

  // Fetch centro for LOCATION
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

  // Fetch medico for SUMMARY/DESCRIPTION
  let medicoNome = '';
  if (appt.medico_id) {
    try {
      const r = await fetch(
        `${base}/medici?id=eq.${encodeURIComponent(appt.medico_id)}&select=titolo,nome,cognome`,
        { headers }
      );
      const rows = await r.json();
      const m = Array.isArray(rows) ? rows[0] : null;
      if (m) medicoNome = [m.titolo, m.nome, m.cognome].filter(Boolean).join(' ');
    } catch (_) {}
  }

  const ics = buildICS({ apptId: appt.id, data: appt.data, ora: appt.ora, medicoNome, location });

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="appuntamento.ics"');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(ics);
}
