// lib/prenotazione-pr22.js
// Prenotazione pubblica rev 2.2 (s53, relazione BPM § 3.3; nota di consegna § 5).
// Niente consensi art. 6/9 alla prenotazione: chi prenota per se' prende visione
// dell'informativa (PR-SELF-2.2); chi prenota per altri dichiara il proprio rapporto
// con il paziente (PR-OTHER-2.2). La versione la decide il server, mai il client.
// Recapiti (email_paziente/telefono_paziente) = recapito verificato della prenotazione:
// del paziente se prenota per se', di chi prenota se per altri. L'email del paziente,
// quando c'e', sta in email_interessato e serve solo all'avviso una tantum.
import { verificaCodice, nonceSfida, TENTATIVI_MAX } from './verifica-email.js';

export const RUOLI = {
  genitore:            { perIlPaziente: 'un tuo genitore',                  etichetta: 'genitore' },
  figlio:              { perIlPaziente: 'tuo figlio o tua figlia',          etichetta: 'figlio/a' },
  coniuge:             { perIlPaziente: 'il tuo coniuge o convivente',      etichetta: 'coniuge o convivente' },
  fratello:            { perIlPaziente: 'tuo fratello o tua sorella',       etichetta: 'fratello o sorella' },
  altro_familiare:     { perIlPaziente: 'un tuo familiare',                 etichetta: 'altro familiare' },
  tutore:              { perIlPaziente: 'il tuo tutore o amministratore di sostegno', etichetta: 'tutore o amministratore di sostegno' },
  incaricato:          { perIlPaziente: 'una persona da te incaricata',     etichetta: 'persona incaricata' },
  operatore_struttura: { perIlPaziente: 'la segreteria della struttura',    etichetta: 'operatore della struttura' }
};
const RUOLI_MINORE = new Set(['genitore', 'tutore']);

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const nomeValido = (s) => !!s && !/[<>]/.test(s);

export function eta(isoNascita, oggi = new Date()) {
  const [y, m, d] = isoNascita.split('-').map(Number);
  let e = oggi.getUTCFullYear() - y;
  const mm = oggi.getUTCMonth() + 1, dd = oggi.getUTCDate();
  if (mm < m || (mm === m && dd < d)) e--;
  return e;
}

function dataNascitaValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return y >= 1900 && dt.getTime() <= Date.now();
}

// Ritorna { ok:false, status, error } oppure { ok:true, campi } con i campi da scrivere.
export function validaPrenotazione(b, { centroMode = false } = {}) {
  const perConto = centroMode ? true : b.per_conto === true;
  const nome = clean(b.nome, 80), cognome = clean(b.cognome, 80);
  const dataNascita = clean(b.data_nascita, 10);
  const email = clean(b.email, 160).toLowerCase();
  const tel = clean(b.tel, 40);
  if (!nomeValido(nome) || !nomeValido(cognome)) return { ok: false, status: 400, error: 'Nome e cognome del paziente obbligatori (senza < e >)' };
  if (!dataNascitaValida(dataNascita)) return { ok: false, status: 400, error: 'Data di nascita del paziente non valida' };
  if (!isEmail(email)) return { ok: false, status: 400, error: 'Email non valida' };
  if (tel.replace(/\D/g, '').length < 6) return { ok: false, status: 400, error: 'Telefono obbligatorio' };
  const minore = eta(dataNascita) < 18;

  const campi = {
    nome_paziente: nome, cognome_paziente: cognome, data_nascita_paziente: dataNascita,
    email_paziente: email, telefono_paziente: tel,
    per_conto: perConto,
    consenso_versione: perConto ? 'PR-OTHER-2.2' : 'PR-SELF-2.2',
    prenotante_nome: null, prenotante_cognome: null, prenotante_ruolo: null, email_interessato: null
  };
  if (!perConto) {
    if (minore) return { ok: false, status: 400, error: 'minore_senza_tutore' };
    return { ok: true, campi, minore };
  }
  const pn = clean(b.prenotante_nome, 80), pc = clean(b.prenotante_cognome, 80);
  const ruolo = clean(b.prenotante_ruolo, 30);
  if (!nomeValido(pn) || !nomeValido(pc)) return { ok: false, status: 400, error: 'Nome e cognome di chi prenota obbligatori (senza < e >)' };
  if (!RUOLI[ruolo] || (ruolo === 'operatore_struttura' && !centroMode)) return { ok: false, status: 400, error: 'Rapporto con il paziente non valido' };
  if (minore && !RUOLI_MINORE.has(ruolo) && ruolo !== 'operatore_struttura') return { ok: false, status: 400, error: 'minore_ruolo' };
  if (b.dichiarazione !== true) return { ok: false, status: 400, error: 'Dichiarazione di chi prenota mancante' };
  let emailInt = clean(b.email_interessato, 160).toLowerCase();
  if (emailInt && !isEmail(emailInt)) return { ok: false, status: 400, error: "Email del paziente non valida" };
  // niente avviso al paziente se minore, sotto tutela o se l'indirizzo coincide con quello di chi prenota
  if (minore || ruolo === 'tutore' || emailInt === email) emailInt = '';
  Object.assign(campi, { prenotante_nome: pn, prenotante_cognome: pc, prenotante_ruolo: ruolo, email_interessato: emailInt || null });
  return { ok: true, campi, minore };
}

// Limite tentativi (per nonce) + verifica del codice. Ritorna { ok } | { ok:false, status, error }.
export async function controllaCodice({ supabaseUrl, serviceKey, secret, sfida, codice, email }) {
  const nonce = nonceSfida(sfida);
  if (!nonce) return { ok: false, status: 400, error: 'verifica_mancante' };
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
      body: JSON.stringify({ p_endpoint: 'pr-codice', p_ip: `n:${nonce}`, p_max_count: TENTATIVI_MAX, p_window_seconds: 900 })
    });
    if (!r.ok) return { ok: false, status: 503, error: 'Servizio temporaneamente non disponibile, riprova tra qualche minuto' };
    if ((await r.json()) !== true) return { ok: false, status: 429, error: 'troppi_tentativi' };
  } catch { return { ok: false, status: 503, error: 'Servizio temporaneamente non disponibile, riprova tra qualche minuto' }; } // fail-closed
  const v = verificaCodice(secret, sfida, codice, email);
  if (!v.ok) return { ok: false, status: 400, error: v.motivo };
  return { ok: true };
}
