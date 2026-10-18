// lib/mailer.js — adattatore di invio email (s79, 17/10/2026).
// Espone lo stesso contratto del client Resend (`mailer.emails.send(payload)` → `{ data: { id }, error }`)
// ma, quando nelle variabili d'ambiente ci sono le credenziali SES (SES_AWS_ACCESS_KEY_ID, SES_AWS_SECRET_ACCESS_KEY),
// spedisce con Amazon SES v2 in regione SES_REGION (predefinita eu-central-1, Francoforte) firmando le chiamate con
// SigV4 scritta a mano, sul modello di lib/backup-storage.js: nessuna dipendenza nuova.
// Senza credenziali SES (es. preview Vercel) resta il client Resend con la chiave passata: rollback a costo zero.
// Payload accettato: { from, to (stringa o array), subject, html, reply_to?, attachments?: [{ filename, content (base64), contentType? }] }.
// Con allegati l'email parte come MIME grezzo (SendEmail Content.Raw), altrimenti come Content.Simple.
import { createHash, createHmac } from 'crypto';
import { Resend } from 'resend';

const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const asciiOnly = (s) => /^[\x20-\x7e]*$/.test(s);
const rfc2047 = (s) => (asciiOnly(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const righe76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

export function firmaSes({ regione, keyId, secret, corpo, dataMs = Date.now() }) {
  const host = `email.${regione}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';
  const amzDate = new Date(dataMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const data = amzDate.slice(0, 8);
  const payload = Buffer.from(corpo, 'utf8');
  const payloadHash = sha256hex(payload);
  const h = { 'content-type': 'application/json', 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const nomi = Object.keys(h).sort();
  const canon = ['POST', path, '', nomi.map(n => `${n}:${h[n]}\n`).join(''), nomi.join(';'), payloadHash].join('\n');
  const scope = `${data}/${regione}/ses/aws4_request`;
  const daFirmare = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canon)].join('\n');
  const kFirma = hmac(hmac(hmac(hmac('AWS4' + secret, data), regione), 'ses'), 'aws4_request');
  const firma = createHmac('sha256', kFirma).update(daFirmare, 'utf8').digest('hex');
  const headers = { ...h, 'authorization': `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${nomi.join(';')}, Signature=${firma}` };
  delete headers.host;
  return { url: `https://${host}${path}`, headers, payload };
}

// MIME multipart/mixed: parte HTML + allegati base64. Solo per i payload con `attachments`.
export function costruisciMime({ from, to, subject, html, reply_to, attachments }) {
  const confine = 'dm-' + createHash('sha256').update(String(Date.now()) + subject).digest('hex').slice(0, 24);
  const testa = [
    `From: ${from}`,
    `To: ${arr(to).join(', ')}`,
    ...(reply_to ? [`Reply-To: ${arr(reply_to).join(', ')}`] : []),
    `Subject: ${rfc2047(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${confine}"`,
    '', `--${confine}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '', righe76(Buffer.from(html, 'utf8').toString('base64')),
  ];
  for (const a of attachments) {
    const nome = String(a.filename || 'allegato').replace(/["\r\n]/g, '');
    const contenuto = Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content);
    testa.push(`--${confine}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${nome}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${nome}"`,
      '', righe76(contenuto));
  }
  testa.push(`--${confine}--`, '');
  return testa.join('\r\n');
}

export function corpoSes(p) {
  const base = {
    FromEmailAddress: p.from,
    Destination: { ToAddresses: arr(p.to) },
    ...(p.reply_to ? { ReplyToAddresses: arr(p.reply_to) } : {}),
  };
  if (Array.isArray(p.attachments) && p.attachments.length) {
    return { ...base, Content: { Raw: { Data: Buffer.from(costruisciMime(p), 'utf8').toString('base64') } } };
  }
  return { ...base, Content: { Simple: {
    Subject: { Data: p.subject, Charset: 'UTF-8' },
    Body: { Html: { Data: p.html, Charset: 'UTF-8' } },
  } } };
}

export class MailerSes {
  constructor({ keyId, secret, regione }) {
    this.keyId = keyId; this.secret = secret; this.regione = regione;
    this.emails = { send: (p) => this.send(p) };
  }
  async send(p) {
    try {
      const corpo = JSON.stringify(corpoSes(p));
      const { url, headers, payload } = firmaSes({ regione: this.regione, keyId: this.keyId, secret: this.secret, corpo });
      const r = await fetch(url, { method: 'POST', headers, body: payload });
      const testo = await r.text();
      let j = null; try { j = JSON.parse(testo); } catch { /* corpo non JSON */ }
      if (!r.ok) return { data: null, error: { name: (j && j.__type) || 'ses_error', statusCode: r.status, message: (j && j.message) || testo.slice(0, 300) } };
      return { data: { id: j && j.MessageId }, error: null };
    } catch (e) {
      return { data: null, error: { name: 'ses_fetch_error', message: e && e.message ? e.message : String(e) } };
    }
  }
}

// Vero se esiste almeno un motore d'invio configurato: credenziali SES oppure chiave Resend.
// Gli endpoint lo usano nella guardia delle env al posto di `!resendApiKey`, così la chiave Resend può essere rimossa.
// Riga 16 / A04 § 5 (s82, 18/10/2026): nel registro delle operazioni il destinatario di un'email non è scritto in chiaro ma come
// pseudonimo «dominio#impronta» (dominio in chiaro, primi 8 esadecimali di SHA-256 dell'indirizzo normalizzato): la prova di consegna
// resta target_id + tipo + id del messaggio del fornitore; chi deve verificare un recapito ricalcola l'impronta. Stessa funzione per
// scrivere e per confrontare, così nessun punto di invio può divergere.
export function pseudonimoRecapito(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const dominio = e.includes('@') ? e.slice(e.lastIndexOf('@') + 1) : '';
  return `${dominio}#${createHash('sha256').update(e, 'utf8').digest('hex').slice(0, 8)}`;
}

export function mailerConfigurato(resendApiKey) {
  return !!((process.env.SES_AWS_ACCESS_KEY_ID && process.env.SES_AWS_SECRET_ACCESS_KEY) || resendApiKey);
}

// Punto d'ingresso usato dagli endpoint al posto di `new Resend(resendApiKey)`.
export function nuovoMailer(resendApiKey) {
  const keyId = process.env.SES_AWS_ACCESS_KEY_ID, secret = process.env.SES_AWS_SECRET_ACCESS_KEY;
  if (keyId && secret) return new MailerSes({ keyId, secret, regione: process.env.SES_REGION || 'eu-central-1' });
  return new Resend(resendApiKey);
}
