// ── SMS PROVIDER (Skebby) ─────────────────────────────────────────────────────
// Unico punto del codebase che parla col provider SMS. Nessuna dipendenza npm:
// solo fetch nativo. Il blocco nasce INERTE: senza env Skebby, smsEnabled() è
// false e sendSms() skippa in silenzio (non lancia mai).

export function smsEnabled() {
  return !!(process.env.SKEBBY_USER_KEY && process.env.SKEBBY_ACCESS_TOKEN);
}

// Normalizza un numero italiano a formato E.164 mobile (+393...), altrimenti null.
// Accetta SOLO mobili italiani: fissi, esteri e numeri malformati → null.
export function normalizeItMobile(raw) {
  if (!raw) return null;
  let s = String(raw);
  // togli tutto tranne cifre e un eventuale '+' iniziale
  const hasPlus = s.trim().startsWith('+');
  s = s.replace(/\D/g, '');
  if (hasPlus) s = '+' + s;
  // 00... → +...
  if (s.startsWith('00')) s = '+' + s.slice(2);

  if (s.startsWith('+')) {
    return /^\+393\d{8,9}$/.test(s) ? s : null;
  }
  // 39 + mobile nazionale (11-12 cifre). Va testato PRIMA del ramo nazionale,
  // ma senza startsWith: il fallimento deve cadere nel test successivo, perché
  // i mobili Wind Tre iniziano per 39x e sono a 10 cifre.
  if (/^393\d{8,9}$/.test(s)) return '+' + s;
  // mobile nazionale (9-10 cifre), incluso 390/391/392/393/397
  if (/^3\d{8,9}$/.test(s)) return '+39' + s;
  return null;
}

// Translittera gli accenti (é → e) ed elimina ogni carattere non GSM-7 base.
export function toGsm7(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
}

// Invia un SMS. Ritorna sempre un oggetto risultato, NON lancia mai.
export async function sendSms({ to, text }) {
  if (!smsEnabled()) return { ok: false, skipped: 'no_env' };
  const num = normalizeItMobile(to);
  if (!num) return { ok: false, skipped: 'not_mobile' };

  try {
    const r = await fetch('https://api.skebby.it/API/v1.0/REST/sms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user_key': process.env.SKEBBY_USER_KEY,
        'Access_token': process.env.SKEBBY_ACCESS_TOKEN
      },
      body: JSON.stringify({
        message_type: process.env.SKEBBY_MESSAGE_TYPE || 'GP',
        message: toGsm7(text),
        recipient: [num],
        ...(process.env.SKEBBY_SENDER ? { sender: process.env.SKEBBY_SENDER } : {})
      })
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* body non-JSON */ }
    if (r.ok && json && json.result === 'OK') {
      return { ok: true, orderId: json.order_id };
    }
    return { ok: false, error: (json && (json.result || json.error_message)) || r.status || 'send failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
