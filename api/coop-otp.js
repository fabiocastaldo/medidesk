// api/coop-otp.js
// Gate alla sorgente per l'accesso operatori (art.29): il codice monouso viene
// richiesto a Supabase Auth SOLO se l'email è in segreterie con stato=attiva e la
// cooperativa è attiva. Altrimenti non parte nessuna email e non nasce nessuna utenza.
// Risposta parlante ma binaria (decisione di prodotto 01/09): 'codice inviato' oppure un unico
// messaggio di non autorizzazione. Il rate limit IP/email (contatore DB condiviso fra le istanze) mitiga l'enumerazione.
// L'iscrizione pubblica di GoTrue è chiusa (disable_signup): l'utenza al primo accesso
// nasce QUI, via admin API con service_role, e solo dopo il gate su segreterie. Nessun'altra scrittura.

const RATE_LIMIT_IP = 20;      // richieste per IP / ora
const RATE_LIMIT_EMAIL = 5;    // richieste per email / ora
const RATE_WINDOW_S = 3600;

// Contatore su DB (RPC check_rate_limit, chiavi 'ip:<ip>' e 'email:<email>'): vale per tutte
// le istanze serverless; fail-closed se il DB non risponde (26/09/2026), come negli altri endpoint.
async function checkSupabaseRateLimit(ip, endpoint, max, windowSeconds) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return false; // fail-closed
  try {
    const res = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ p_endpoint: endpoint, p_ip: ip, p_max_count: max, p_window_seconds: windowSeconds })
    });
    if (!res.ok) return false; // fail-closed: contatore non disponibile = richiesta respinta
    return (await res.json()) === true;
  } catch { return false; } // fail-closed (piano privacy riga 67)
}


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email non valida' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!(await checkSupabaseRateLimit(`ip:${ip}`, 'coop-otp', RATE_LIMIT_IP, RATE_WINDOW_S)) ||
      !(await checkSupabaseRateLimit(`email:${email}`, 'coop-otp', RATE_LIMIT_EMAIL, RATE_WINDOW_S))) {
    return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
  }

  // Lookup autorizzazione: email attiva in segreterie + cooperativa attiva.
  const segRes = await fetch(
    `${supabaseUrl}/rest/v1/segreterie?email=eq.${encodeURIComponent(email)}&select=id,stato,cooperative(stato)&order=stato.asc&limit=1`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  // Un solo messaggio per sconosciuta / sospesa / organizzazione non attiva (decisione 01/09):
  // l'oracolo resta binario (autorizzata-attiva vs no), il rate limit e' la mitigazione.
  if (!seg || seg.stato !== 'attiva' || seg.cooperative?.stato !== 'attiva') {
    return res.status(403).json({ error: 'Questa email non è autorizzata da nessuna organizzazione. Chiedi all\'amministratore di aggiungerti nella tab Segreteria.' });
  }

  {
    // GoTrue spedisce il codice (SMTP configurato nel progetto) a un utente ESISTENTE:
    // create_user a false, così non dipende dall'iscrizione pubblica (chiusa).
    const authHeaders = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
    const inviaOtp = () => fetch(`${supabaseUrl}/auth/v1/otp`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ email, create_user: false })
    }).catch(() => null);

    let otpRes = await inviaOtp();
    let otpErr = (otpRes && !otpRes.ok) ? await otpRes.text().catch(() => '') : '';
    // Primo accesso: GoTrue risponde 422 otp_disabled («Signups not allowed for otp») perché
    // l'utente non esiste. L'email ha già passato il gate su segreterie: la creo via admin API
    // (email confermata: il possesso della casella lo prova il codice stesso) e rimando il codice.
    if (otpRes && otpRes.status === 422 && /otp_disabled|signups? not allowed/i.test(otpErr)) {
      const creaRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ email, email_confirm: true })
      }).catch(() => null);
      // 422 = già registrato (corsa fra due richieste): si prosegue con l'invio.
      if (!creaRes || (!creaRes.ok && creaRes.status !== 422)) {
        const t = creaRes ? await creaRes.text().catch(() => '') : '';
        console.error('[coop-otp] creazione utente fallita', creaRes?.status, t.slice(0, 200));
        return res.status(502).json({ error: 'Invio del codice non riuscito. Riprova tra qualche minuto.' });
      }
      otpRes = await inviaOtp();
      otpErr = (otpRes && !otpRes.ok) ? await otpRes.text().catch(() => '') : '';
    }
    if (!otpRes || !otpRes.ok) {
      console.error('[coop-otp] invio fallito', otpRes?.status, otpErr.slice(0, 200));
      return res.status(502).json({ error: 'Invio del codice non riuscito. Riprova tra qualche minuto.' });
    }
  }

  return res.status(200).json({ ok: true, message: 'Codice inviato a ' + email + '. Controlla la posta: vale un\'ora.' });
}
