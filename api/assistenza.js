// api/assistenza.js
// Canale di assistenza fra chi usa Delphi~Med e il gestore (s57, 27/09/2026).
// Sostituisce la casella support@: tutto resta nel DB (tabelle assistenza_*, RLS senza policy,
// nessun grant ad anon/authenticated: ci passa solo questo endpoint con la chiave di servizio).
// Le email non portano mai il testo: al gestore un link con token, al richiedente senza login
// un link con token, al medico loggato solo l'avviso di una risposta (entra dal gestionale).
// Il token in chiaro esiste solo nell'email; a DB resta lo SHA-256. Alla chiusura tutti i
// token della conversazione sono revocati. I link seguono la conversazione: scadono 30 giorni dopo
// l'ultimo messaggio (ogni messaggio sposta in avanti la scadenza di tutti i link ancora vivi) e
// muoiono con la chiusura. Conservazione: lib/conservazione.js (chiusura d'ufficio dopo 30 giorni
// senza messaggi, cancellazione 12 mesi dopo la chiusura).
//
// POST { azione:'elenco' }                                   Bearer medico → { conversazioni:[…] }
// POST { azione:'apri', motivo, corpo }                      Bearer medico → { conversazione_id }
// POST { azione:'scrivi', conversazione_id, corpo }          Bearer medico → { ok }
// POST { azione:'codice', email }                            pubblico      → { sfida }
// POST { azione:'apri_pubblica', email, sfida, codice, motivo, corpo }     → { ok }
// POST { azione:'leggi_token', token }                       link          → { ruolo, conversazione, messaggi }
// POST { azione:'scrivi_token', token, corpo }               link          → { ok }
// POST { azione:'chiudi_token', token }                      link gestore  → { ok }

import { Resend } from 'resend';
import { createHash, randomBytes } from 'crypto';
import { richiediAal2 } from '../lib/aal-guard.js';
import { creaSfida, verificaCodice, nonceSfida, normEmail } from '../lib/verifica-email.js';

const SCOPO = 'assistenza-v1';
const MAX_CORPO = 4000;
const INATTIVITA_GIORNI = 30; // come la chiusura d'ufficio in lib/conservazione.js
export const MOTIVI = {
  accesso: 'Non riesco ad accedere',
  verifica_due_passaggi: 'Verifica in due passaggi / telefono perso',
  sospensione: 'Account sospeso',
  registrazione: 'Registrazione',
  sicurezza: 'Sospetto accesso non mio',
  altro: 'Altro'
};

const hashToken = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex');
const isEmail = (e) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) && e.length <= 254;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shell(titolo, corpoHtml) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="font-size:18px;font-weight:700;margin-bottom:12px">Delphi~Med</div>
  <div style="font-size:17px;font-weight:600;margin-bottom:10px">${esc(titolo)}</div>
  ${corpoHtml}
  <div style="font-size:12px;color:#888;margin-top:22px;line-height:1.5">Il testo della conversazione non viene mai inviato per email: resta nel servizio. Il link è personale, non inoltrarlo.</div>
</div>`;
}
const bottone = (link, etichetta) => `<div style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#0D5C8C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(etichetta)}</a></div>
  <div style="font-size:13px;color:#555;line-height:1.5">Se il pulsante non funziona, copia questo indirizzo nel browser:<br>${esc(link)}</div>`;
const para = (t) => `<div style="font-size:15px;line-height:1.55">${t}</div>`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const secret = process.env.CONSENSO_TOKEN_SECRET;
  const gestoreTo = process.env.ASSISTENZA_NOTIFICA_TO;
  if (!supabaseUrl || !serviceKey || !anonKey || !resendApiKey || !secret || !gestoreTo) {
    console.error('[assistenza] env vars mancanti');
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const base = `${supabaseUrl}/rest/v1`;
  const dbHeaders = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const sb = (path, opts = {}) => fetch(`${base}/${path}`, { ...opts, headers: { ...dbHeaders, ...(opts.headers || {}) } });
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'www.delphi-med.com').split(',')[0].trim();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const resend = new Resend(resendApiKey);

  const body = req.body || {};
  const azione = body.azione;
  const corpo = typeof body.corpo === 'string' ? body.corpo.trim() : '';
  if (corpo.length > MAX_CORPO) return res.status(400).json({ error: 'Messaggio troppo lungo (massimo 4000 caratteri)' });

  async function limite(chiave, endpoint, max, finestra) {
    try {
      const r = await fetch(`${base}/rpc/check_rate_limit`, {
        method: 'POST', headers: dbHeaders,
        body: JSON.stringify({ p_endpoint: endpoint, p_ip: chiave, p_max_count: max, p_window_seconds: finestra })
      });
      if (!r.ok) return false;
      return (await r.json()) === true;
    } catch { return false; } // fail-closed
  }

  async function audit(action, conversazioneId, details, medicoId = null) {
    try {
      const r = await sb('audit_log', {
        method: 'POST', headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ medico_id: medicoId, action, target_type: 'assistenza', target_id: String(conversazioneId), details })
      });
      if (!r.ok) console.error('[assistenza] audit_log', r.status);
    } catch (e) { console.error('[assistenza] audit_log:', e.message); }
  }

  async function nuovoToken(conversazioneId, destinatario) {
    const token = randomBytes(32).toString('base64url');
    const r = await sb('assistenza_token', {
      method: 'POST', headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ token_hash: hashToken(token), conversazione_id: conversazioneId, destinatario,
        expires_at: new Date(Date.now() + INATTIVITA_GIORNI * 86400000).toISOString() })
    });
    if (!r.ok) throw new Error('token_insert ' + r.status);
    return token;
  }

  async function invia(to, subject, html, conversazioneId, tipo, medicoId = null) {
    const { data, error } = await resend.emails.send({ from: 'noreply@delphi-med.com', to: [to], subject, html });
    if (error) throw new Error('resend ' + (error.message || 'errore'));
    await audit('email_inviata', conversazioneId, { tipo, to, resend_id: data?.id || null }, medicoId);
  }

  // Avviso al gestore: link con token nuovo (i precedenti restano validi fino alla chiusura).
  async function avvisaGestore(conv, tipo) {
    const token = await nuovoToken(conv.id, 'gestore');
    const titolo = tipo === 'apertura' ? 'Nuova richiesta di assistenza' : 'Nuovo messaggio nella richiesta di assistenza';
    await invia(gestoreTo, `${titolo} — ${MOTIVI[conv.motivo] || 'Assistenza'}`,
      shell(titolo, para(`Motivo: ${esc(MOTIVI[conv.motivo] || conv.motivo)}. Origine: ${conv.origine === 'gestionale' ? 'gestionale del medico' : 'pagina pubblica'}.`)
        + bottone(`https://${host}/a/${token}`, 'Apri la conversazione')),
      conv.id, `assistenza_${tipo}_gestore`, conv.medico_id);
  }

  // Avviso al richiedente dopo una risposta del gestore.
  async function avvisaRichiedente(conv) {
    if (conv.origine === 'gestionale') {
      await invia(conv.email, 'Hai una risposta dall\'assistenza Delphi~Med',
        shell('Hai una risposta dall\'assistenza',
          para('Per leggerla entra in Delphi~Med e apri la voce «Assistenza» del gestionale.')
          + bottone(`https://${host}/`, 'Entra in Delphi~Med')),
        conv.id, 'assistenza_risposta_medico', conv.medico_id);
    } else {
      const token = await nuovoToken(conv.id, 'richiedente');
      await invia(conv.email, 'Hai una risposta dall\'assistenza Delphi~Med',
        shell('Hai una risposta dall\'assistenza', para('Per leggerla e rispondere apri il link qui sotto.')
          + bottone(`https://${host}/a/${token}`, 'Apri la conversazione')),
        conv.id, 'assistenza_risposta_richiedente', conv.medico_id);
    }
  }

  async function leggiConv(id) {
    const r = await sb(`assistenza_conversazioni?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!r.ok) return null;
    return (await r.json().catch(() => []))[0] || null;
  }

  async function messaggi(convId) {
    const r = await sb(`assistenza_messaggi?conversazione_id=eq.${encodeURIComponent(convId)}&select=id,direzione,corpo,created_at,letto_at&order=created_at.asc`);
    return r.ok ? await r.json().catch(() => []) : [];
  }

  async function aggiungi(conv, direzione, testo) {
    const r = await sb('assistenza_messaggi', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ conversazione_id: conv.id, direzione, corpo: testo })
    });
    if (!r.ok) throw new Error('messaggio_insert ' + r.status);
    const riga = (await r.json())[0];
    const u = await sb(`assistenza_conversazioni?id=eq.${conv.id}&chiusa_at=is.null`, {
      method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ultimo_messaggio_at: riga.created_at })
    });
    if (!u.ok) throw new Error('ultimo_messaggio ' + u.status);
    // I link vivi della conversazione vivono quanto lei: 30 giorni dall'ultimo messaggio.
    const scade = new Date(new Date(riga.created_at).getTime() + INATTIVITA_GIORNI * 86400000).toISOString();
    const v = await sb(`assistenza_token?conversazione_id=eq.${conv.id}&revocato_at=is.null`, {
      method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ expires_at: scade })
    });
    if (!v.ok) throw new Error('scadenza_link ' + v.status);
    return riga;
  }

  async function segnaLetti(convId, direzione) {
    await sb(`assistenza_messaggi?conversazione_id=eq.${encodeURIComponent(convId)}&direzione=eq.${direzione}&letto_at=is.null`, {
      method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ letto_at: new Date().toISOString() })
    }).catch(() => null);
  }

  async function apriConversazione({ medicoId, email, origine, motivo, testo }) {
    const r = await sb('assistenza_conversazioni', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ medico_id: medicoId, email, origine, motivo })
    });
    if (!r.ok) throw new Error('conversazione_insert ' + r.status);
    const conv = (await r.json())[0];
    try {
      await aggiungi(conv, 'richiedente', testo);
      await avvisaGestore(conv, 'apertura');
    } catch (e) {
      // Rollback simmetrico: senza avviso al gestore la richiesta non esiste.
      await sb(`assistenza_conversazioni?id=eq.${conv.id}`, { method: 'DELETE' }).catch(() => null);
      throw e;
    }
    await audit('assistenza_aperta', conv.id, { origine, motivo }, medicoId);
    return conv;
  }

  const validaApertura = () => {
    if (!MOTIVI[body.motivo]) return 'Scegli il motivo della richiesta';
    if (!corpo) return 'Scrivi il messaggio';
    return null;
  };

  try {
    // ── Ingresso con link (gestore o richiedente senza login) ─────────────────────────
    if (azione === 'leggi_token' || azione === 'scrivi_token' || azione === 'chiudi_token') {
      if (!(await limite(`ip:${ip}`, 'assistenza-link', 60, 600))) return res.status(429).json({ error: 'Troppe richieste, riprova tra qualche minuto' });
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return res.status(401).json({ error: 'Link non valido' });
      const tr = await sb(`assistenza_token?token_hash=eq.${hashToken(token)}&select=conversazione_id,destinatario,expires_at,revocato_at`);
      const tok = tr.ok ? (await tr.json().catch(() => []))[0] : null;
      if (!tok || tok.revocato_at || new Date(tok.expires_at) < new Date()) return res.status(401).json({ error: 'Questo link non è più valido' });
      const conv = await leggiConv(tok.conversazione_id);
      if (!conv) return res.status(401).json({ error: 'Questo link non è più valido' });
      const gestore = tok.destinatario === 'gestore';

      if (azione === 'leggi_token') {
        await segnaLetti(conv.id, gestore ? 'richiedente' : 'gestore');
        const out = { ruolo: tok.destinatario, conversazione: {
          motivo: MOTIVI[conv.motivo] || conv.motivo, chiusa: !!conv.chiusa_at, created_at: conv.created_at } };
        if (gestore) {
          out.conversazione.email = conv.email;
          out.conversazione.origine = conv.origine;
          if (conv.medico_id) {
            const mr = await sb(`medici?id=eq.${conv.medico_id}&select=titolo,nome,cognome,stato`);
            const m = mr.ok ? (await mr.json().catch(() => []))[0] : null;
            if (m) out.conversazione.medico = { nome: [m.titolo, m.nome, m.cognome].filter(Boolean).join(' '), stato: m.stato };
          }
        }
        out.messaggi = await messaggi(conv.id);
        return res.status(200).json(out);
      }

      if (conv.chiusa_at) return res.status(409).json({ error: 'La conversazione è chiusa' });

      if (azione === 'chiudi_token') {
        if (!gestore) return res.status(403).json({ error: 'Operazione non permessa' });
        const pr = await sb(`assistenza_conversazioni?id=eq.${conv.id}&chiusa_at=is.null`, {
          method: 'PATCH', headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ chiusa_at: new Date().toISOString(), chiusa_da: 'gestore' })
        });
        if (!pr.ok) throw new Error('chiusura ' + pr.status);
        const rv = await sb(`assistenza_token?conversazione_id=eq.${conv.id}&revocato_at=is.null`, {
          method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ revocato_at: new Date().toISOString() })
        });
        if (!rv.ok) throw new Error('revoca ' + rv.status);
        await audit('assistenza_chiusa', conv.id, { da: 'gestore' }, conv.medico_id);
        return res.status(200).json({ ok: true });
      }

      // scrivi_token
      if (!corpo) return res.status(400).json({ error: 'Scrivi il messaggio' });
      if (!(await limite(`c:${conv.id}`, 'assistenza-scrivi', 30, 3600))) return res.status(429).json({ error: 'Troppi messaggi, riprova più tardi' });
      await aggiungi(conv, gestore ? 'gestore' : 'richiedente', corpo);
      if (gestore) await avvisaRichiedente(conv); else await avvisaGestore(conv, 'messaggio');
      return res.status(200).json({ ok: true });
    }

    // ── Ingresso pubblico (chi non può entrare nel gestionale) ────────────────────────
    if (azione === 'codice') {
      const email = normEmail(body.email).slice(0, 254);
      if (!isEmail(email)) return res.status(400).json({ error: 'Email non valida' });
      const eh = hashToken(email).slice(0, 24);
      if (!(await limite(`ip:${ip}`, 'assistenza-codice', 10, 3600)) || !(await limite(`e:${eh}`, 'assistenza-codice', 5, 3600))) {
        return res.status(429).json({ error: 'Troppe richieste di codice. Riprova tra qualche minuto.' });
      }
      const { codice, sfida } = creaSfida(secret, email, SCOPO);
      const { error } = await resend.emails.send({
        from: 'noreply@delphi-med.com', to: [email], subject: `${codice} è il tuo codice per l'assistenza Delphi~Med`,
        html: shell('Conferma il tuo indirizzo email', para('Usa questo codice per inviare la tua richiesta di assistenza:')
          + `<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0B2B4D;text-align:center;margin:18px 0">${codice}</div>`
          + para('Il codice vale 10 minuti. Se non hai chiesto tu assistenza, ignora questa email.'))
      });
      if (error) { console.error('[assistenza] codice resend:', error.message); return res.status(502).json({ error: 'Invio del codice non riuscito, riprova' }); }
      return res.status(200).json({ ok: true, sfida });
    }

    if (azione === 'apri_pubblica') {
      const email = normEmail(body.email).slice(0, 254);
      if (!isEmail(email)) return res.status(400).json({ error: 'Email non valida' });
      const err = validaApertura();
      if (err) return res.status(400).json({ error: err });
      const nonce = nonceSfida(body.sfida);
      if (!nonce) return res.status(400).json({ error: 'Richiedi un nuovo codice', motivo: 'sfida_non_valida' });
      if (!(await limite(`n:${nonce}`, 'assistenza-tentativi', 5, 900))) return res.status(429).json({ error: 'Troppi tentativi con questo codice. Richiedine uno nuovo.', motivo: 'tentativi' });
      const vc = verificaCodice(secret, body.sfida, body.codice, email, SCOPO);
      if (!vc.ok) return res.status(400).json({ error: vc.motivo === 'codice_scaduto' ? 'Codice scaduto: richiedine uno nuovo' : 'Codice non valido', motivo: vc.motivo });
      if (!(await limite(`e:${hashToken(email).slice(0, 24)}`, 'assistenza-apri', 3, 86400))) return res.status(429).json({ error: 'Hai già inviato diverse richieste oggi: attendi la risposta nel link ricevuto via email.' });
      const mr = await sb(`medici?email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
      const medicoId = mr.ok ? ((await mr.json().catch(() => []))[0]?.id || null) : null;
      const conv = await apriConversazione({ medicoId, email, origine: 'pubblica', motivo: body.motivo, testo: corpo });
      // Il richiedente riceve subito il suo link: può aggiungere messaggi e leggere la risposta.
      const token = await nuovoToken(conv.id, 'richiedente');
      await invia(email, 'Abbiamo ricevuto la tua richiesta — Assistenza Delphi~Med',
        shell('Abbiamo ricevuto la tua richiesta', para('Ti risponderemo nella conversazione: riceverai un avviso via email a ogni risposta. Da questo link puoi anche aggiungere messaggi.')
          + bottone(`https://${host}/a/${token}`, 'Apri la conversazione')),
        conv.id, 'assistenza_ricevuta', medicoId);
      return res.status(200).json({ ok: true });
    }

    // ── Medico nel gestionale ─────────────────────────────────────────────────────────
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticazione richiesta' });
    const jwt = authHeader.slice(7);
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey } }).catch(() => null);
    if (!userRes || !userRes.ok) return res.status(401).json({ error: 'Token non valido o scaduto' });
    const userData = await userRes.json().catch(() => null);
    const aalKo = richiediAal2(jwt, userData);
    if (aalKo) return res.status(aalKo.status).json({ error: aalKo.error, code: aalKo.code });
    if (!userData?.id) return res.status(401).json({ error: 'Utente non riconosciuto' });
    const mr = await sb(`medici?user_id=eq.${encodeURIComponent(userData.id)}&stato=eq.approvato&deleted_at=is.null&select=id,email`);
    const medico = mr.ok ? (await mr.json().catch(() => []))[0] : null;
    if (!medico) return res.status(403).json({ error: 'Account non autorizzato' });

    if (azione === 'elenco') {
      const r = await sb(`assistenza_conversazioni?medico_id=eq.${medico.id}&origine=eq.gestionale&select=id,motivo,chiusa_at,chiusa_da,created_at,ultimo_messaggio_at,assistenza_messaggi(id,direzione,corpo,created_at,letto_at)&order=ultimo_messaggio_at.desc&assistenza_messaggi.order=created_at.asc`);
      if (!r.ok) throw new Error('elenco ' + r.status);
      const conv = (await r.json()).map(c => ({ ...c, motivo_testo: MOTIVI[c.motivo] || c.motivo,
        messaggi: c.assistenza_messaggi || [], assistenza_messaggi: undefined }));
      const daLeggere = conv.filter(c => c.messaggi.some(m => m.direzione === 'gestore' && !m.letto_at)).map(c => c.id);
      if (body.segna_letti === true) for (const id of daLeggere) await segnaLetti(id, 'gestore');
      return res.status(200).json({ conversazioni: conv, non_letti: body.segna_letti === true ? 0 : daLeggere.length });
    }

    if (azione === 'apri') {
      const err = validaApertura();
      if (err) return res.status(400).json({ error: err });
      if (!(await limite(`medico:${medico.id}`, 'assistenza-apri', 10, 86400))) return res.status(429).json({ error: 'Troppe richieste aperte oggi' });
      const conv = await apriConversazione({ medicoId: medico.id, email: normEmail(userData.email || medico.email),
        origine: 'gestionale', motivo: body.motivo, testo: corpo });
      return res.status(200).json({ conversazione_id: conv.id });
    }

    if (azione === 'scrivi') {
      if (!corpo) return res.status(400).json({ error: 'Scrivi il messaggio' });
      const conv = await leggiConv(String(body.conversazione_id || ''));
      if (!conv || conv.medico_id !== medico.id || conv.origine !== 'gestionale') return res.status(404).json({ error: 'Conversazione non trovata' });
      if (conv.chiusa_at) return res.status(409).json({ error: 'La conversazione è chiusa' });
      if (!(await limite(`c:${conv.id}`, 'assistenza-scrivi', 30, 3600))) return res.status(429).json({ error: 'Troppi messaggi, riprova più tardi' });
      await aggiungi(conv, 'richiedente', corpo);
      await avvisaGestore(conv, 'messaggio');
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Azione non valida' });
  } catch (e) {
    console.error('[assistenza]', azione, e.message);
    return res.status(502).json({ error: 'Operazione non riuscita, riprova tra poco' });
  }
}
