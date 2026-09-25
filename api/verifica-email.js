// api/verifica-email.js
// POST { email } → invia un codice di 6 cifre all'indirizzo e restituisce la "sfida"
// firmata (lib/verifica-email.js) che il client ripresenta a create-booking(-centro)
// insieme al codice. Nessuna riga in DB oltre ai contatori di rate_limits.
// La mail contiene solo il codice: niente medico, niente tipo di visita (relazione BPM § 5.5).
import { createHash } from 'crypto';
import { Resend } from 'resend';
import { creaSfida, normEmail } from '../lib/verifica-email.js';
import { emailShell, emailTitle } from '../lib/email-shell.js';

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function sotto(supabaseUrl, key, endpoint, chiave, max, finestra) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ p_endpoint: endpoint, p_ip: chiave, p_max_count: max, p_window_seconds: finestra })
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch { return true; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SECRET_KEY;
  const secret      = process.env.CONSENSO_TOKEN_SECRET;
  const resendKey   = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !serviceKey || !secret || !resendKey) return res.status(500).json({ error: 'Configurazione server mancante' });

  const email = normEmail((req.body || {}).email).slice(0, 160);
  if (!isEmail(email)) return res.status(400).json({ error: 'Email non valida' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const eh = createHash('sha256').update(email).digest('hex').slice(0, 24);
  if (!(await sotto(supabaseUrl, serviceKey, 'verifica-email', ip, 10, 3600)) ||
      !(await sotto(supabaseUrl, serviceKey, 'verifica-email', `e:${eh}`, 5, 3600))) {
    return res.status(429).json({ error: 'Troppe richieste di codice. Riprova tra qualche minuto.' });
  }

  const { codice, sfida } = creaSfida(secret, email);
  const html = emailShell(
    emailTitle('Il tuo codice di verifica') +
    `<p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 20px;">Usa questo codice per confermare la prenotazione su Delphi~Med:</p>` +
    `<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0B2B4D;text-align:center;margin:0 0 20px;">${codice}</div>` +
    `<p style="font-size:13px;color:#555;line-height:1.6;margin:0;">Il codice vale 10 minuti. Se non hai richiesto tu questo codice, ignora questa email: nessuna prenotazione verr&agrave; registrata.</p>`
  );
  try {
    const { error } = await new Resend(resendKey).emails.send({
      from: 'noreply@delphi-med.com', to: [email],
      subject: `${codice} è il tuo codice di verifica Delphi~Med`, html
    });
    if (error) { console.error('[verifica-email] resend:', error.message); return res.status(502).json({ error: 'Invio del codice non riuscito, riprova' }); }
  } catch (e) {
    console.error('[verifica-email] resend:', e.message);
    return res.status(502).json({ error: 'Invio del codice non riuscito, riprova' });
  }
  return res.status(200).json({ ok: true, sfida });
}
