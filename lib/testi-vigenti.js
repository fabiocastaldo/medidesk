// lib/testi-vigenti.js
// Testi legali in vigore e avvisi di servizio (s84, 20/10/2026; piano privacy righe 22 e 76; Termini rev 2.3
// artt. 6 e 11; V02 § 3-septvicies). Unica fonte, lato server, di versione e impronta dei testi che un medico
// accetta: la registrazione (api/register-doctor) e la riaccettazione (api/accettazioni) leggono da qui.
//
// Regola delle versioni (Termini art. 11): una modifica meramente formale è versionata e comunicata, non
// richiede nuova accettazione (sostanziale: false); una modifica sostanziale è proposta con almeno
// PREAVVISO_GIORNI di preavviso e richiede accettazione espressa: dalla pubblicazione alla decorrenza il
// medico vede l'avviso e può accettare; dalla decorrenza l'ingresso nel gestionale è bloccato finché non
// accetta (il blocco lato database — medico_puo_scrivere — è il ciclo B, su DDL). «In difetto non si applica
// al rapporto in corso»: chi non accetta resta alla versione accettata e in sola consultazione.
//
// Come si pubblica una versione sostanziale: (1) archiviare il testo in testi_legali (hash = sha256 del file
// servito, come oggi); (2) qui: versione, hash, decorrenza = data di pubblicazione + PREAVVISO_GIORNI (almeno),
// sostanziale: true; (2-bis) la stessa riga in public.testi_decorrenze (INSERT del gestore: documento, hash_testo,
// versione, sostanziale, decorrenza), letta da medico_puo_scrivere per la sola consultazione di chi non accetta —
// il cron verifica ogni sera che lib e tabella coincidano e altrimenti manda l'alert; (3) rilascio. Il cron invia l'avviso una volta per medico e per impronta (traccia
// avviso_testi_legali in audit_log) e un promemoria PROMEMORIA_GIORNI prima della decorrenza.
//
// Oggi (20/10/2026) i testi in vigore sono tos-0.2 e dpa-0.2, non sostanziali rispetto alle accettazioni
// precedenti (dal 27/09 cambiò solo il caricamento dei caratteri): nessun medico riceve avvisi né blocchi
// finché il bump dei testi rev 2.3 non li dichiara sostanziali con una decorrenza.

export const PREAVVISO_GIORNI = 30;
export const PROMEMORIA_GIORNI = 7;
const G = 86400000;

export const TESTI_VIGENTI = {
  tos: { nome: 'Termini di servizio', pagina: '/termini-di-servizio', versione: 'tos-0.2',
    hash: '08ecfbc8b6e9b170451d48d7733ba16291138a41ad1e854763a7bc66a4423786', decorrenza: null, sostanziale: false },
  dpa: { nome: 'Accordo sul trattamento dei dati (DPA)', pagina: '/dpa', versione: 'dpa-0.2',
    hash: '104d7931cc8c93eedfb5c0c24c59c0dcd7facf4808ffcbe68609933ca8fc3dd4', decorrenza: null, sostanziale: false }
};

// Avvisi di servizio (Termini art. 6: interruzioni programmate con almeno 48 ore di preavviso): compaiono nel
// gestionale tra `dal` e `al` e vanno per email una volta (traccia avviso_servizio in audit_log, chiave `id`).
// Esempio: { id: 'man-2026-11-02', titolo: 'Manutenzione programmata', testo: 'Domenica 2 novembre dalle 06:00
//   alle 07:00 UTC il servizio non sarà raggiungibile.', dal: '2026-10-30T00:00:00Z', al: '2026-11-02T07:00:00Z' }
export const AVVISI_SERVIZIO = [];

export function avvisiAttivi(now = Date.now(), avvisi = AVVISI_SERVIZIO) {
  return avvisi.filter(a => a && a.id && Date.parse(a.dal) <= now && now < Date.parse(a.al));
}

// Quali documenti il medico deve ancora accettare, dato l'elenco delle sue accettazioni (righe di
// accettazioni_legali: documento, hash_testo). Puro: nessuna rete.
export function statoAccettazioni(accettazioni, now = Date.now(), testi = TESTI_VIGENTI) {
  const fatte = new Set((accettazioni || []).map(a => `${a.documento}:${a.hash_testo}`));
  const da_accettare = [];
  for (const [documento, t] of Object.entries(testi)) {
    if (fatte.has(`${documento}:${t.hash}`)) continue;
    if (!t.sostanziale) continue;              // modifica formale: versionata e comunicata, nessuna riaccettazione
    const decorrenzaMs = t.decorrenza ? Date.parse(t.decorrenza) : null;
    da_accettare.push({ documento, nome: t.nome, pagina: t.pagina, versione: t.versione, hash: t.hash,
      decorrenza: t.decorrenza, bloccante: decorrenzaMs !== null && now >= decorrenzaMs });
  }
  const bloccante = da_accettare.some(d => d.bloccante);
  const decorrenze = da_accettare.map(d => d.decorrenza).filter(Boolean).sort();
  return { da_accettare, bloccante, prossima_decorrenza: decorrenze[0] || null };
}

// Fase dell'avviso per un documento sostanziale: 'avviso' dalla pubblicazione, 'promemoria' negli ultimi
// PROMEMORIA_GIORNI, 'scaduto' dalla decorrenza (il blocco parla da sé: niente altre email).
export function faseAvviso(decorrenza, now = Date.now()) {
  const d = Date.parse(decorrenza);
  if (!Number.isFinite(d)) return null;
  if (now >= d) return 'scaduto';
  if (now >= d - PROMEMORIA_GIORNI * G) return 'promemoria';
  return 'avviso';
}

export const dataIt = iso => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
