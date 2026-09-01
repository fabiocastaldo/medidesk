// api/coop-otp.js
// Gate alla sorgente per l'accesso operatori (art.29): il codice monouso viene
// richiesto a Supabase Auth SOLO se l'email è in segreterie con stato=attiva e la
// cooperativa è attiva. Altrimenti non parte nessuna email e non nasce nessuna utenza.
// Risposta parlante (decisione di prodotto 01/09: feedback esplicito per l'operatore; il rate limit
// IP/email resta l'unica mitigazione all'enumerazione delle email autorizzate).
// Nessuna scrittura su DB: la sola scrittura (utenza auth al primo accesso) è di GoTrue.

const rateMap = new Map();
const RATE_LIMIT_IP = 20;      // richieste per IP / ora
const RATE_LIMIT_EMAIL = 5;    // richieste per email / ora
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRate(key, limit) {
  const now = Date.now();
  const e = rateMap.get(key);
  if (!e || now > e.resetAt) { rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS }); return true; }
  if (e.count >= limit) return false;
  e.count++; return true;
}


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email non valida' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(`ip:${ip}`, RATE_LIMIT_IP) || !checkRate(`email:${email}`, RATE_LIMIT_EMAIL)) {
    return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
  }

  // Lookup autorizzazione: email attiva in segreterie + cooperativa attiva.
  const segRes = await fetch(
    `${supabaseUrl}/rest/v1/segreterie?email=eq.${encodeURIComponent(email)}&select=id,stato,cooperative(stato)&order=stato.asc&limit=1`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg) {
    return res.status(403).json({ error: 'Questa email non è autorizzata da nessuna organizzazione. Chiedi all\'amministratore di aggiungerti nella tab Segreteria.' });
  }
  if (seg.stato !== 'attiva') {
    return res.status(403).json({ error: 'La tua autorizzazione è sospesa. Rivolgiti all\'amministratore della tua organizzazione.' });
  }
  if (seg.cooperative?.stato !== 'attiva') {
    return res.status(403).json({ error: 'L\'organizzazione non è attiva.' });
  }

  {
    // GoTrue spedisce il codice (SMTP configurato nel progetto); create_user per il primo accesso.
    const otpRes = await fetch(`${supabaseUrl}/auth/v1/otp`, {
      method: 'POST',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, create_user: true })
    }).catch(() => null);
    if (!otpRes || !otpRes.ok) {
      const t = otpRes ? await otpRes.text().catch(() => '') : '';
      console.error('[coop-otp] invio fallito', otpRes?.status, t.slice(0, 200));
      return res.status(502).json({ error: 'Invio del codice non riuscito. Riprova tra qualche minuto.' });
    }
  }

  return res.status(200).json({ ok: true, message: 'Codice inviato a ' + email + '. Controlla la posta: vale un\'ora.' });
}
