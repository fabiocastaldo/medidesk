// api/avviso-sospensione.js
// Chiamato dal database (pg_net, trigger trg_medici_sospensione_avviso) nell'istante della sospensione di un medico.
// Nessun segreto: riceve solo l'id del medico, rilegge tutto dal database con la chiave di servizio e invia la mail
// solo se il medico e' davvero sospeso e la sospensione in corso non e' gia' stata avvisata (lib/sospensione.js).
// Risposta uniforme 200 { ok: true } per non rivelare quali id esistono; limite di richieste per IP (fail-closed).
import { Resend } from 'resend';
import { emailShell, emailTitle, esc } from '../lib/email-shell.js';
import { avvisaSospensione } from '../lib/sospensione.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !supabaseKey || !resendApiKey) return res.status(500).json({ error: 'Configurazione server mancante' });
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  try {
    const r = await fetch(`${base}/rpc/check_rate_limit`, { method: 'POST', headers,
      body: JSON.stringify({ p_endpoint: 'avviso-sospensione', p_ip: `ip:${ip}`, p_max_count: 20, p_window_seconds: 3600 }) });
    if (!r.ok || (await r.json()) !== true) return res.status(429).json({ error: 'Troppe richieste' });
  } catch { return res.status(429).json({ error: 'Troppe richieste' }); }

  const medicoId = String((req.body || {}).medico_id || '');
  if (UUID.test(medicoId)) {
    try {
      const esito = await avvisaSospensione({ base, headers, resend: new Resend(resendApiKey),
        shell: { emailShell, emailTitle, esc }, medicoId });
      console.log('[avviso-sospensione]', esito);
    } catch (e) { console.error('[avviso-sospensione]', e.message); }
  }
  return res.status(200).json({ ok: true });
}
