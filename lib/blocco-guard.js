// lib/blocco-guard.js — blocchi di cancellazione (legal hold), s84 20/10/2026; piano privacy riga 44; Policy di
// conservazione § 6 (motivo, dati, soggetto autorizzante, riesame, termine; mai conservazione indefinita).
// Tabella public.blocchi_cancellazione (DDL s84, service_role soltanto, sola aggiunta + revoca motivata una volta):
// un blocco attivo (non revocato, fino_al >= oggi) ferma ogni cancellazione automatica dell'account — eliminazione su
// richiesta (lib/elimina-account) e uscita alla cessazione (lib/uscita) — e il database la ferma comunque con la
// chiave esterna senza cascade; la funzione public.medico_in_blocco(uuid) è la stessa regola, per gli endpoint.
// Un blocco si apre su istruzione scritta del Titolare o del gestore (verbale) con un INSERT eseguito dal gestore;
// si chiude con la revoca motivata (UPDATE di revocato_il + revoca_motivo); il termine scaduto non cancella nulla da
// sé: il riesame è umano (riesame_il) e chi non rinnova il blocco lo lascia scadere.
// Qui: lettura del blocco attivo e traccia `cancellazione_sospesa_blocco` una sola volta per blocco (dedupe su
// audit_log, chiave = id del blocco), così il job non riempie il registro ogni sera.

export async function bloccoAttivo(base, headers, medicoId) {
  const oggi = new Date().toISOString().slice(0, 10);
  const r = await fetch(`${base}/blocchi_cancellazione?medico_id=eq.${medicoId}&revocato_il=is.null&fino_al=gte.${oggi}&select=id,dal,riesame_il,fino_al,autorizzato_da&order=fino_al.desc&limit=1`, { headers });
  if (!r.ok) throw new Error(`blocchi_cancellazione ${r.status}`);   // fail-closed: chi chiama non cancella senza risposta
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export async function tracciaBloccoSeNuova(base, headers, medicoId, blocco, contesto) {
  const t = await fetch(`${base}/audit_log?medico_id=eq.${medicoId}&action=eq.cancellazione_sospesa_blocco&select=details&limit=50`, { headers });
  if (!t.ok) throw new Error(`audit_log ${t.status}`);
  const gia = (await t.json()).some(x => x.details && Number(x.details.blocco_id) === Number(blocco.id) && x.details.contesto === contesto);
  if (gia) return false;
  const a = await fetch(`${base}/audit_log`, { method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ medico_id: medicoId, action: 'cancellazione_sospesa_blocco', target_type: 'account', target_id: String(medicoId),
      details: { blocco_id: blocco.id, contesto, dal: blocco.dal, riesame_il: blocco.riesame_il, fino_al: blocco.fino_al, autorizzato_da: blocco.autorizzato_da } }) });
  if (!a.ok) throw new Error(`traccia blocco ${a.status}`);
  return true;
}
