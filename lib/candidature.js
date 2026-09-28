// lib/candidature.js
// Candidature non approvate: cancellazione a 90 giorni (s59, 28/09/2026; piano privacy riga 43,
// Policy di conservazione rev2.3 § 2: «90 giorni dalla decisione o dall'ultimo contatto»).
// Chiamato da lib/conservazione.js, una volta al giorno, dentro il cron di api/send-reminders.
//
// Candidatura = riga medici con stato 'in_attesa' (l'esito negativo della verifica lascia il medico
// in attesa: non esiste uno stato «rifiutato»), senza eliminazione su richiesta in corso.
// Decorrenza = la più recente fra la registrazione (created_at) e l'ultimo esito della verifica
// registrato in audit_log (verifica_qualifica_negativa, esito_negativo_comunicato).
//
// Procedura come l'eliminazione su richiesta (lib/elimina-account.js), senza Stripe (un medico in
// attesa non ha abbonamenti) e senza mail: file sotto <user_id>/ nei tre bucket, utente Auth, cascata
// del database, verifica, traccia in audit_log con i soli conteggi. Le accettazioni restano (prova
// del contratto, nessuna FK); le righe di audit_log del medico restano con medico_id NULL.
import { contaRighe, cancellaFile } from './elimina-account.js';

const H24 = 86400000;
export const GIORNI_CANDIDATURA = 90;
export const MAX_CANDIDATURE_PER_GIRO = 5;
const EVENTI_ESITO = ['verifica_qualifica_negativa', 'esito_negativo_comunicato'];

export async function eseguiCandidature({ supabaseUrl, headers, dryRun = false, now = Date.now(), runErrors = [] }) {
  const base = `${supabaseUrl}/rest/v1`;
  const storageBase = `${supabaseUrl}/storage/v1`;
  const soglia = new Date(now - GIORNI_CANDIDATURA * H24).toISOString();

  // Condizione necessaria: registrazione oltre la soglia (l'ultimo esito non può precederla).
  const r = await fetch(`${base}/medici?stato=eq.in_attesa&deleted_at=is.null&created_at=lt.${encodeURIComponent(soglia)}` +
    `&select=id,user_id,created_at&order=created_at.asc&limit=50`, { headers });
  if (!r.ok) throw new Error(`medici ${r.status}`);
  const lista = await r.json();
  if (!Array.isArray(lista)) throw new Error('lettura medici non valida');

  const scaduti = [];
  for (const m of lista) {
    const a = await fetch(`${base}/audit_log?medico_id=eq.${encodeURIComponent(m.id)}&action=in.(${EVENTI_ESITO.join(',')})` +
      `&select=created_at&order=created_at.desc&limit=1`, { headers });
    if (!a.ok) throw new Error(`audit_log ${a.status}`);
    const ultimo = (await a.json())[0];
    if (ultimo && Date.parse(ultimo.created_at) >= now - GIORNI_CANDIDATURA * H24) continue; // esito recente: la decorrenza riparte da lì
    scaduti.push(m);
    if (scaduti.length >= MAX_CANDIDATURE_PER_GIRO) break;
  }
  if (dryRun) return scaduti.length;

  let cancellate = 0;
  for (const m of scaduti) {
    try {
      if (!m.user_id) throw new Error('user_id assente');
      const conteggi = {};
      for (const t of ['pazienti', 'visite', 'appuntamenti']) conteggi[`n_${t}`] = await contaRighe(base, headers, t, m.id);
      const nFile = await cancellaFile(storageBase, headers, m.user_id);
      const d = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(m.user_id)}`, { method: 'DELETE', headers });
      if (!d.ok && d.status !== 404) throw new Error(`auth delete ${d.status}`);
      if (d.status === 404) {
        const dm = await fetch(`${base}/medici?id=eq.${m.id}`, { method: 'DELETE', headers });
        if (!dm.ok) throw new Error(`medici delete ${dm.status}`);
      }
      const v = await fetch(`${base}/medici?id=eq.${m.id}&select=id`, { headers });
      if (!v.ok || (await v.json()).length) throw new Error('riga medici ancora presente dopo la cancellazione');
      await fetch(`${base}/audit_log`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          medico_id: null, action: 'candidatura_eliminata', target_type: 'account', target_id: m.id,
          details: { registrata_at: m.created_at, eseguita_at: new Date(now).toISOString(), giorni: GIORNI_CANDIDATURA, ...conteggi, n_file: nFile }
        })
      }).then(x => { if (!x.ok) console.error('[candidature] audit non scritto', x.status); })
        .catch(e => console.error('[candidature] audit:', e.message));
      cancellate++;
    } catch (e) {
      runErrors.push({ ramo: 'conservazione', ref: `candidatura ${m.id}`, msg: e.message });
      console.error('[candidature]', m.id, e.message);
    }
  }
  return cancellate;
}
