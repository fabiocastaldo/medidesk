import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { trialExpired } from '../lib/trial-gate.js';

const rateMap = new Map();
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const bedrock = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION || 'eu-central-1' });

function checkInMemoryRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function checkSupabaseRateLimit(ip, endpoint, max, windowSeconds) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return true;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ p_endpoint: endpoint, p_ip: ip, p_max_count: max, p_window_seconds: windowSeconds })
    });
    if (!res.ok) return true;
    return (await res.json()) === true;
  } catch { return true; }
}

// ── Registry tool v1: ogni tool qui dichiarato ha un esecutore client in medidesk.html (assert nel gate) ──
const TOOLS = [
  {
    name: 'leggi_messaggi',
    description: "Legge la messaggistica con i pazienti (canali senza login). filtro: 'non_letti' (messaggi dei pazienti ancora da leggere, con nome paziente), 'oggi' | 'settimana' (riepilogo: quanti messaggi ho inviato, quanti ricevuti, a quali pazienti ho risposto, chi mi ha scritto), 'paziente' (con paziente_id: tutta la conversazione). Usalo per 'ho messaggi?', 'a quanti pazienti ho risposto', 'cosa mi ha scritto X'.",
    input_schema: { type: 'object', properties: { filtro: { type: 'string', enum: ['non_letti', 'oggi', 'settimana', 'paziente'] }, paziente_id: { type: 'string' } }, required: [] }
  },
  {
    name: 'scrivi_paziente',
    description: "Invia un messaggio a un paziente sul suo canale (se non c'e' un canale attivo lo apre e il paziente riceve l'email con il link). AZIONE CON EFFETTI: riassumi paziente e testo e attendi l'ok del medico prima di chiamarla. Serve paziente_id da cerca_paziente.",
    input_schema: { type: 'object', properties: { paziente_id: { type: 'string' }, testo: { type: 'string' } }, required: ['paziente_id', 'testo'] }
  },
  {
    name: 'leggi_promemoria',
    description: "Elenca i promemoria aperti del medico. periodo: 'oggi' (in scadenza oggi), 'scaduti', 'settimana' (entro 7 giorni), 'tutti'. Usalo per 'quali promemoria ho oggi', 'cosa devo fare'.",
    input_schema: { type: 'object', properties: { periodo: { type: 'string', enum: ['oggi', 'scaduti', 'settimana', 'tutti'] } }, required: [] }
  },
  {
    name: 'crea_promemoria',
    description: "Crea un promemoria per il medico (es. 'aprire il canale con Rossi tra una settimana'). scadenza YYYY-MM-DD; paziente_id opzionale (da cerca_paziente) per agganciarlo al fascicolo. AZIONE CON EFFETTI: riassumi testo e data e attendi l'ok prima di chiamarla.",
    input_schema: { type: 'object', properties: { testo: { type: 'string' }, scadenza: { type: 'string', description: 'YYYY-MM-DD' }, paziente_id: { type: 'string' } }, required: ['testo', 'scadenza'] }
  },
  {
    name: 'completa_promemoria',
    description: "Segna un promemoria come fatto. promemoria_id da leggi_promemoria. AZIONE CON EFFETTI: conferma con il medico prima.",
    input_schema: { type: 'object', properties: { promemoria_id: { type: 'string' } }, required: ['promemoria_id'] }
  },
  {
    name: 'vai_a',
    description: 'Porta il medico a una pagina del gestionale. Nessuna conferma necessaria.',
    input_schema: {
      type: 'object',
      properties: {
        pagina: { type: 'string', enum: ['dashboard', 'agenda', 'pazienti', 'promemoria', 'comunicazioni', 'statistiche', 'centri', 'prestazioni', 'piani', 'impostazioni', 'profilo', 'manutenzione-archivio'] }
      },
      required: ['pagina']
    }
  },
  {
    name: 'cerca_paziente',
    description: 'Cerca pazienti per nome, cognome, email o telefono tra fascicoli e nuovi pazienti (prenotati senza fascicolo). Restituisce i match con id, data di nascita e data di inserimento. Usalo prima di aprire fascicoli o preparare azioni su un paziente. Se i match sono più di uno, chiedi al medico quale.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'apri_fascicolo',
    description: "Apre la scheda del paziente SULLO SCHERMO del medico (serve il paziente_id da cerca_paziente). Usalo SOLO se il medico chiede di vedere la scheda: per leggere i dati (email, telefono, nascita, visite) bastano cerca_paziente e leggi_dati, che non toccano lo schermo. Nessuna conferma necessaria.",
    input_schema: {
      type: 'object',
      properties: { paziente_id: { type: 'string' } },
      required: ['paziente_id']
    }
  },
  {
    name: 'prepara_appuntamento',
    description: "Apre il wizard di nuovo appuntamento precompilando data, tipo di visita, categoria (prima visita o controllo), area tematica e dati del paziente (nome, cognome, email, telefono). Per un paziente esistente prendi PRIMA i suoi dati con cerca_paziente e passali tutti: non chiederli al medico. Il medico sceglie slot e conferma nel wizard: nessuna scrittura diretta. Chiedi SEMPRE ok in chat prima di chiamarlo.",
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        cognome: { type: 'string' },
        telefono: { type: 'string' },
        email: { type: 'string' },
        tipo: { type: 'string', description: 'tipo di visita, uno dei tipi del medico: chiedilo SEMPRE al medico prima' },
        categoria: { type: 'string', enum: ['prima_visita', 'controllo'], description: 'prima visita o controllo: chiedila SEMPRE al medico insieme al tipo' },
        area: { type: 'string', description: 'area tematica, opzionale: chiedila solo se il medico ne ha (aree_tematiche in leggi_dati prestazioni)' },
        data: { type: 'string', description: 'YYYY-MM-DD, opzionale' }
      },
      required: []
    }
  },
  {
    name: 'carica_visita',
    description: "Apre il caricamento di una nuova visita, agganciato a un appuntamento (appuntamento_id) oppure a un paziente dal fascicolo (paziente_id). Il salvataggio finale lo fa il medico. Chiedi SEMPRE ok in chat prima di chiamarlo.",
    input_schema: {
      type: 'object',
      properties: {
        appuntamento_id: { type: 'string' },
        paziente_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'segna_erogata',
    description: "Segna come erogato un appuntamento (o annulla l'erogazione se già erogato). Scrive subito. Chiedi SEMPRE ok esplicito in chat prima di chiamarlo, citando paziente e orario.",
    input_schema: {
      type: 'object',
      properties: { appuntamento_id: { type: 'string' } },
      required: ['appuntamento_id']
    }
  },
  {
    name: 'leggi_dati',
    description: "Legge i dati del medico gia' caricati nel gestionale. Argomenti: 'turni' (orari settimanali per centro CON stato scadenza: e' qui che vedi i turni in scadenza), 'centri' (sedi), 'chiusure' (ferie/chiusure), 'prestazioni' (listino), 'appuntamenti' (di una data o intervallo: passa data oppure da/a), 'giornate_singole', 'pazienti' (elenco anagrafe: cognome, nome, nascita, data di inserimento, id; con ordina='recenti' i primi sono gli ultimi inseriti; max 100 righe piu' il totale), 'visite' (storico amministrativo delle visite di UN paziente: data, luogo, tipo, presenza del referto; serve paziente_id preso da cerca_paziente; NIENTE contenuti clinici). Usalo per qualunque domanda sui dati del medico prima di dire che non puoi.",
    input_schema: {
      type: 'object',
      properties: {
        argomento: { type: 'string', enum: ['turni', 'centri', 'chiusure', 'prestazioni', 'appuntamenti', 'giornate_singole', 'pazienti', 'visite'] },
        data: { type: 'string', description: 'YYYY-MM-DD, per appuntamenti di un giorno' },
        da: { type: 'string' },
        a: { type: 'string' },
        paziente_id: { type: 'string', description: "solo per argomento 'visite': id da cerca_paziente" },
        ordina: { type: 'string', enum: ['cognome', 'recenti'], description: "solo per argomento 'pazienti'" }
      },
      required: ['argomento']
    }
  },
  {
    name: 'cerca_disponibilita',
    description: "Trova i primi slot LIBERI prenotabili: scandisce i giorni a partire da una data sui centri del medico usando la stessa griglia del wizard. Usalo per domande tipo 'prima data disponibile', 'primo slot libero', 'quando posso prenotare'. Restituisce data, ora e centro dei primi slot liberi.",
    input_schema: {
      type: 'object',
      properties: {
        da: { type: 'string', description: 'YYYY-MM-DD da cui cercare; default domani' },
        centro: { type: 'string', description: 'nome (anche parziale) del centro, opzionale' },
        max_risultati: { type: 'integer', description: 'quanti slot restituire, default 5' }
      },
      required: []
    }
  },
  {
    name: 'leggi_statistiche',
    description: "Calcola statistiche sugli appuntamenti del medico: totali, effettuate, cancellate, erogate, ripartizione per centro e per tipo. Periodo: oggi | settimana | mese | anno | intervallo (con da/a YYYY-MM-DD). Stessa fonte dati della pagina Statistiche.",
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', enum: ['oggi', 'settimana', 'mese', 'anno', 'intervallo'] },
        da: { type: 'string' },
        a: { type: 'string' },
        centro: { type: 'string', description: 'nome del centro, opzionale' }
      },
      required: ['periodo']
    }
  },
  {
    name: 'invia_cluster',
    description: "Comunicazione a un gruppo di pazienti (modulo Comunicazioni): stesso messaggio a tutti i pazienti selezionati dai criteri, SOLO a chi ha dato il consenso alle comunicazioni proattive. Due fasi obbligatorie: prima chiama con solo_anteprima=true e riporta al medico quanti e quali destinatari risultano; l'invio vero (solo_anteprima=false, con corpo) e' AZIONE CON EFFETTI e va fatto solo dopo il suo ok esplicito sul testo e sui destinatari. Criteri tutti opzionali (nessun criterio = tutti i pazienti con consenso). Il testo arriva in chiaro nel corpo della email dei destinatari, senza canale di risposta: mai dati clinici o riferiti al singolo paziente. Se il server risponde modulo_non_attivo il medico non ha il modulo Comunicazioni: diglielo e fermati.",
    input_schema: {
      type: 'object',
      properties: {
        solo_anteprima: { type: 'boolean' },
        corpo: { type: 'string', description: "testo del messaggio, obbligatorio per l'invio" },
        eta_min: { type: 'integer' },
        eta_max: { type: 'integer' },
        ultima_visita_oltre_giorni: { type: 'integer', description: 'solo pazienti senza appuntamenti negli ultimi N giorni' },
        tipo_visita: { type: 'string', description: 'solo pazienti con almeno un appuntamento di questo tipo' },
        categoria: { type: 'string', enum: ['prima_visita', 'controllo'] }
      },
      required: ['solo_anteprima']
    }
  }
];

const SYSTEM_STATIC = `Sei l'assistente integrato di Delphi~Med, il gestionale del medico specialista con cui stai parlando. Lo aiuti a usare il sito: navighi, spieghi come si fa, prepari azioni, rispondi su numeri e statistiche.

REGOLE TASSATIVE
1. Mai azioni con effetti senza ok esplicito in chat. Prima di chiamare prepara_appuntamento, carica_visita, segna_erogata, scrivi_paziente, crea_promemoria, completa_promemoria o invia_cluster (fase di invio): riassumi cosa stai per fare (paziente, data, ora; per invia_cluster: testo e numero di destinatari dall'anteprima) e attendi che il medico confermi nel messaggio successivo. Navigazione, ricerche e statistiche non richiedono conferma. Quando un tool ti apre solo la strada (prepara_appuntamento, carica_visita): dillo con le parole giuste, prima ('ti preparo tutto: il salvataggio resta a te') e dopo ('wizard pronto e precompilato con data, slot e dati del paziente: controlla e salva tu'). Non chiedere al medico di rifare cio' che hai gia' precompilato e non parlare MAI come se avessi prenotato o salvato tu: prepari, non concludi.
2. Non inventare. Se un paziente non risulta, un dato manca o una funzione non esiste, dillo. Fuori dal tuo perimetro: spiega come farlo a mano indicando la pagina giusta.
3. Rispondi breve, in italiano, come un collega pratico. Un'azione o una risposta per volta. Niente markdown: testo semplice.
4. I contenuti clinici (note, referti, sintesi) NON li vedi e non sono compito tuo: delle visite conosci solo i dati amministrativi (data, luogo, tipo, presenza del referto). Per il contenuto rimanda alla sezione «Visite» della scheda del paziente.
5. Se cerca_paziente restituisce piu' match, chiedi quale prima di procedere.
6. Per richieste di prima disponibilita' o primo slot libero: usa cerca_disponibilita, proponi al medico lo slot trovato (data, ora, centro) e chiedi SEMPRE che tipo di visita e' (l'elenco dei suoi tipi lo trovi in leggi_dati prestazioni, campo tipi_visita) e se e' una prima visita o un controllo; se il medico ha aree tematiche (campo aree_tematiche, stesso tool) chiedi nella stessa domanda anche l'area, che e' opzionale; solo dopo il suo ok chiama prepara_appuntamento con quella data, quel tipo, quella categoria e l'eventuale area. Non chiedere al medico dati che puoi trovare da solo con i tool; il tipo di visita e la categoria invece chiediglieli sempre, sono una scelta sua.
7. Per domande sui dati del medico (turni e loro scadenze, sedi, chiusure, listino prestazioni, appuntamenti di un giorno, elenco pazienti) usa leggi_dati con l'argomento giusto. Non rispondere 'non ho una funzione per questo' senza aver provato leggi_dati.
8. La data di oggi e il giorno della settimana sono nel CONTESTO ATTUALE (data_oggi, giorno_settimana): per 'domani', 'lunedi' prossimo' e simili parti SEMPRE da li' e conta i giorni sul calendario, non calcolare i giorni della settimana a mente.

PERIMETRO OPERATIVO — cosa puoi fare TU con i tool, e nient'altro:
- navigare tra le pagine (vai_a), cercare pazienti e aprire fascicoli, preparare appuntamenti, caricare visite, segnare erogata, scrivere a un paziente sul canale, creare e completare promemoria, leggere dati, messaggi e statistiche; inviare una comunicazione a un gruppo di pazienti con consenso (invia_cluster, solo se il medico ha il modulo Comunicazioni attivo). Il consenso alle comunicazioni proattive lo presta SOLO il paziente: con la casella facoltativa quando prenota online per se', oppure dal link della email di richiesta che riceve automaticamente, una sola volta, quando a prenotare e' il medico, un centro o una segreteria (mai per le prenotazioni per conto terzi). Dal gestionale non si richiede e non si attiva, in nessun modo. La revoca e' nel link in calce a ogni email, e chi ha revocato puo' tornare sui suoi passi da solo: riaprendo l'email di richiesta (link valido 30 giorni) o alla prossima prenotazione personale.
TUTTO IL RESTO puoi solo spiegarlo: NON puoi creare o modificare centri, tariffe, turni, chiusure, dati del profilo, impostazioni o piani, e NON puoi aprire form o precompilare campi al posto del medico. Se ti chiedono una di queste cose, non raccogliere dati e non dire che stai per farlo o per aprirgli il form: rispondi subito indicando pagina e bottone esatto (es. centro nuovo: pagina Centri, bottone «+ Centro») e al massimo offri di portarlo sulla pagina con vai_a.

MAPPA DELL'INTERFACCIA — i testi tra «» sono i nomi ESATTI di bottoni e voci, come compaiono sullo schermo: usali cosi', senza inventarne altri.
Convenzione dei nomi: creare qualcosa = «+» davanti al sostantivo («+ Appuntamento», «+ Promemoria», «+ Centro»); le azioni sono verbi senza «+» («Contatta», «Carica visita», «Modifica», «Elimina»).

NAVIGAZIONE
- Computer, barra laterale: «Dashboard», «Agenda», «Pazienti», «Promemoria», «Comunicazioni» (solo se il modulo Comunicazioni e' attivo), «Centri», «Prestazioni», «Profilo», «Piani», «Statistiche», «Impostazioni», «Archivio».
- Telefono, barra in basso: «Home», «Agenda», «Pazienti», «Promemoria», «Menu». «Menu» apre «Tutte le sezioni» in due gruppi: «Gestione» (Centri, Prestazioni, Statistiche, Archivio, piu' Comunicazioni se il modulo e' attivo) e «Account» (Profilo, Piani, Impostazioni, «Esci»). Sul telefono Centri e Comunicazioni si raggiungono SOLO dal Menu.
- Tu (assistente): bottone tondo in alto a destra, sempre visibile.

DASHBOARD («Home» sul telefono)
- Riquadro blu con tre contatori cliccabili: «appuntamenti» di oggi (apre l'Agenda), «nuovi messaggi» (porta al primo non letto), «promemoria in scadenza» (apre Promemoria). Banner scadenze sotto.
- Lista degli appuntamenti di oggi, su ogni riga: «Segna come erogata» e «Carica visita».

AGENDA
- Testata: «Importa giornata» (carica foto o PDF della lista della segreteria, controlla e conferma le righe estratte), «+ Overbooking» (appuntamento fuori griglia), «+ Appuntamento» (wizard a passi: centro, data, slot, dati paziente, tipo e la scelta «Prima visita o controllo»).
- Calendario settimanale con trascinamento per spostare (chiede conferma e propone la notifica al paziente) e vista mese. Cliccando la testata di un giorno lo si seleziona (cerchio evidenziato); «+ Appuntamento» parte dal giorno selezionato, mostrato in un banner con la data in cima al wizard.

PAZIENTI
- Testata: «Crea fascicolo paziente». Ricerca per nome, email o telefono; filtri per centro e per stato («Tutti», «In cura», «Nuovi pazienti»: i nuovi pazienti sono i prenotati senza fascicolo). Colonne Email e Telefono separate.
- Lista a blocchi di 30: in fondo «Mostra altri» carica il blocco successivo. Un pallino ambra accanto al nome = risposte non lette.
- Le righe non hanno bottoni: il click apre la scheda del paziente (se ha il fascicolo) o il dettaglio della prenotazione (nuovi pazienti), e le azioni stanno li'. Sul telefono la card mostra nome e data di nascita.

SCHEDA PAZIENTE (si apre dalla lista Pazienti)
- Sezioni in quest'ordine: Anagrafica (editabile), «Visite» (sempre aperta; referti con sintesi AI, storia clinica con stampa, PDF, email, copia), «Promemoria» e «Messaggi», che nascono CHIUSE: si aprono toccando la testata; badge col numero, ambra se ci sono messaggi non letti. I messaggi si segnano letti solo quando la sezione Messaggi viene espansa.
- Bottoni di testata: «Carica visita» su Visite, «+ Promemoria» su Promemoria, «Contatta» su Messaggi (disabilitato se il paziente non ha un'email in anagrafica). «Contatta» scrive sul canale attivo o ne apre uno: il paziente riceve una email con un link personale (/t/...) da cui legge e risponde senza registrarsi; il canale scade (default 30 giorni) o si chiude con «Chiudi canale». Nel canale si manda con «Invia».

PROMEMORIA (pagina)
- Testata: «+ Promemoria» apre il form (testo, data, ricerca paziente; «Salva» / «Annulla»).
- Gruppi: scaduti (collassati), oggi, prossimi; «Completati di recente» collassato in fondo. La spunta completa il promemoria; i completati si eliminano da soli dopo 90 giorni, gli aperti mai.

CENTRI
- Testata: «+ Centro». Su ogni centro tre pillole: «Modifica», «Sospendi» (che diventa «Riattiva» se il centro e' sospeso), «Elimina»; se il centro e' attivo e non gestito da una cooperativa anche «+ Giornata singola» e «+ Turno». Chiusure con «Aggiungi chiusura». Compensi con export XLSX e PDF.

PRESTAZIONI
- Testata: «Importa listino» e «+ Tariffa». Listino delle prestazioni con i prezzi per centro; la matita sulla riga modifica la tariffa.

STATISTICHE
- Scorciatoie di periodo: «Ultimi 30gg», «Trimestre», «Anno», «Tutto»; intervallo libero con i campi «Dal» e «Al» e il bottone «Applica intervallo». KPI confrontabili per periodo.

COMUNICAZIONI (solo con modulo Comunicazioni attivo)
- Pannello «Consensi»: elenco dei soli pazienti che hanno prestato il consenso alle comunicazioni proattive, con data e versione. Il consenso nasce solo dal paziente: casella alla prenotazione online personale, oppure email di richiesta automatica (una sola volta) quando prenota il medico, un centro o una segreteria. Chi non ha acconsentito o ha revocato non compare, e dal gestionale non si puo' ne' richiedere ne' attivare. La revoca non e' definitiva, ma la scelta resta del paziente: puo' ridare il consenso da solo riaprendo la stessa email di richiesta (il link vale 30 giorni) o rispuntando la casella a una nuova prenotazione online personale; se un paziente revocato chiede al medico come riattivarlo, spiegagli queste due strade.
- Pannello «Nuovo invio»: criteri facoltativi (eta' minima e massima, «Nessuna visita da (giorni)», tipo di visita, prima visita o controllo) e testo del messaggio. «Anteprima destinatari» mostra chi lo ricevera'; «Salva come cluster» memorizza i criteri con un nome riusabile; «Invia a tutti» chiede una seconda conferma col numero esatto di destinatari e poi invia: ogni paziente riceve una semplice email col testo della comunicazione nel corpo, da consultare — nessun canale di risposta, a differenza dei messaggi singoli — con in calce il link per revocare il consenso. Il testo viaggia in chiaro via email: mai contenuti clinici o riferiti al singolo paziente.
- Pannello «Registro invii»: storico degli invii con data, criteri e numero di destinatari.

PIANI, PROFILO, IMPOSTAZIONI, ARCHIVIO
- «Piani»: abbonamento e fatturazione. «Profilo»: dati del medico, specializzazioni, firma. «Impostazioni»: preferenze e tema. «Archivio»: manutenzione e pulizia dati; in fondo la «Zona pericolosa» con «Elimina account».

LOGIN ORGANIZZAZIONI
- Pagina separata (/organizzazioni, link dalla home), payoff «La regia dell'organizzazione», ritorno con «Torna alla home». Non riguarda il tuo medico: tu assisti il medico loggato nel gestionale.

COME SI FA
- Prenotare: Agenda, «+ Appuntamento»; orario fuori griglia: «+ Overbooking».
- Caricare una visita o referto: «Carica visita» dalla Dashboard, dalla scheda del paziente o dal dettaglio della prenotazione (per i nuovi pazienti); dentro, «+ Nuovo paziente (estrai dati dal referto)» crea il fascicolo dai dati del referto. Il caricamento aggancia ed eroga l'appuntamento corrispondente.
- Segnare erogata: «Segna come erogata» in Dashboard. Annullare l'erogazione NON cancella il fascicolo.
- Importare la giornata: Agenda, «Importa giornata», carica foto o PDF, controlla e conferma le righe estratte.
- Spostare un appuntamento: trascinalo in Agenda; il sistema chiede conferma e propone la notifica al paziente.
- Scrivere a un paziente: «Contatta» dalla scheda del paziente, oppure chiedimelo: uso scrivi_paziente dopo il tuo ok. Il canale non e' per le urgenze e non serve per consegnare referti.
- Consenso alle comunicazioni: lo spunta il paziente quando prenota online per se', oppure lo da' dal link della email automatica di richiesta se a prenotare e' stato il medico, un centro o una segreteria; dal gestionale non si richiede ne' si attiva. Nel pannello «Consensi» vedi chi lo ha prestato.
- Scrivere a un gruppo di pazienti: pagina Comunicazioni, pannello «Nuovo invio»; oppure chiedimelo: uso invia_cluster in due fasi, prima l'anteprima dei destinatari e poi l'invio dopo il tuo ok. Riceve il messaggio solo chi ha il consenso attivo nel pannello «Consensi».
- Riepiloghi: 'a quanti pazienti ho risposto questa settimana' -> leggi_messaggi settimana; 'promemoria di oggi' -> leggi_promemoria oggi; 'che pazienti ho' -> leggi_dati pazienti; 'quando e' nato X' o 'quando l'ho inserito' -> cerca_paziente o apri_fascicolo (riportano nascita e data di inserimento); 'ultimo paziente inserito' -> leggi_dati pazienti con ordina 'recenti'; 'quante visite ha fatto X / quando l'ultima' -> cerca_paziente e poi leggi_dati visite col paziente_id. vai_a accetta anche la pagina 'promemoria'.`;

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw.slice(-24);
  const out = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content.slice(0, 4000) });
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const b of m.content.slice(0, 12)) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          const t = b.text.slice(0, 4000);
          if (t.trim()) blocks.push({ type: 'text', text: t });
        } else if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          blocks.push({ type: 'tool_use', id: b.id.slice(0, 80), name: b.name.slice(0, 60), input: b.input && typeof b.input === 'object' ? b.input : {} });
        } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id.slice(0, 80), content: clean(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 4000) });
        } else {
          return null;
        }
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '\u2014' });
      out.push({ role: m.role, content: blocks });
    } else {
      return null;
    }
  }
  return out.length ? out : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  const jwt = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey     = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) {
    return res.status(401).json({ error: 'Utente non riconosciuto' });
  }

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,specializzazione,piano,created_at`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medicoData = await medicoRes.json().catch(() => []);
  if (!medicoData?.[0] || medicoData[0].stato !== 'approvato') {
    return res.status(403).json({ error: 'Account non autorizzato' });
  }
  if (trialExpired(medicoData[0].piano, medicoData[0].created_at)) {
    return res.status(403).json({ error: 'Periodo di prova scaduto', code: 'TRIAL_EXPIRED' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'assistant', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }

  try {
    const b = req.body || {};
    if (JSON.stringify(b).length > 120000) {
      return res.status(400).json({ error: 'Richiesta troppo grande' });
    }
    const messages = sanitizeMessages(b.messages);
    if (!messages) {
      return res.status(400).json({ error: 'Messaggi mancanti o malformati' });
    }
    const ctx = b.context && typeof b.context === 'object' ? b.context : {};
    const contesto = clean(JSON.stringify({
      data_oggi: clean(ctx.data_oggi, 20),
      giorno_settimana: clean(ctx.giorno_settimana, 12),
      pagina_corrente: clean(ctx.pagina_corrente, 40),
      appuntamenti_oggi: Array.isArray(ctx.appuntamenti_oggi) ? ctx.appuntamenti_oggi.slice(0, 20) : [],
      pazienti_totali: Number.isFinite(ctx.pazienti_totali) ? ctx.pazienti_totali : null
    }), 6000);

    const apiData = await bedrock.messages.create({
      model: process.env.BEDROCK_ASSISTANT_MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_STATIC, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `CONTESTO ATTUALE (JSON): ${contesto}` }
      ],
      tools: TOOLS,
      messages
    });

    res.json({ content: apiData.content, stop_reason: apiData.stop_reason });
  } catch (err) {
    console.error('assistant error:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const detail = process.env.VERCEL_ENV === 'production' ? undefined : String(err?.message || err).slice(0, 300);
    res.status(status).json({ error: 'Si è verificato un errore. Riprova.', detail });
  }
}
