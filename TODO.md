# Delphi~Med — Roadmap & TODO

## Decisioni di design

### Filosofia del prodotto
- **Strumento del medico, non marketplace.** Delphi~Med è un'agenda digitale personale per il medico specialista libero professionista: gestisce appuntamenti, pazienti e studio in più ambulatori. Non è una piattaforma pubblica di ricerca medici.
- **No recensioni pubbliche.** Il profilo del medico esiste per la pagina di prenotazione condivisa direttamente ai pazienti (link/WhatsApp/QR). La home pubblica ha una barra di ricerca per nome/specializzazione, ma l'acquisizione parte sempre dal medico.
- **Single-file HTML.** Nessun build system, nessun framework: tutto in `medidesk.html` per massima portabilità e semplicità di deployment.
- **Offline-first con sync Supabase.** Lo stato vive in `localStorage` (`medidesk_v2`) e viene sincronizzato su Supabase quando online.
- **Pricing futuro**: ~19-29€/mese.

### Scelte tecniche principali
- **Supabase EU (Frankfurt)** per auth, DB PostgreSQL e storage foto.
- **RLS** su tutte le tabelle; funzioni SECURITY DEFINER per operazioni anon (prenotazione, ricerca pubblica, slug).
- **UUID** come chiave primaria; comparazioni sempre via `String(a)===String(b)`.
- **Slug univoco** generato automaticamente dal trigger `medici_auto_slug()` con cascata: nome-cognome → +spec → +provincia → +albo → fallback random 3 char.
- **Deploy**: solo `git push origin master` → Vercel rileva e pubblica automaticamente. NON usare `npx vercel --prod`.

### Funzioni SQL SECURITY DEFINER
- `generate_unique_slug(nome, cognome, specializzazione, provincia, albo, id)` → genera slug univoco con cascata; usata dal trigger `medici_auto_slug()`
- `search_medici_pubblici(p_query)` → ricerca pubblica su nome/cognome/specializzazione/specializzazioni[]; ritorna citta[] — riscritta 18/05 per query multi-token (tokenizzazione sugli spazi, AND tra token, OR tra campi)
- `get_slot_occupati(p_medico_id)` → slot prenotati del medico; usata da `bkInit` per bloccare slot occupati
- `get_dati_notifica_cancellazione(p_appt_id, p_token)` → ritorna (notifica_cancellazione, centro_nome, centro_email), autorizzata dal possesso del token di cancellazione

---

## ✅ Completato — sessione 2026-05-18 (legenda settimana + orari + apertura agenda)

### Migliorie UI
- [x] Legenda centri sotto il calendario settimanale: `renderWeekLegend(days)` popola `#week-legend-container` con i centri che hanno turni nella settimana corrente o appuntamenti registrati; riusa classi CSS `month-legend` già esistenti
- [x] `showPage('agenda')` chiama `setAgendaView('week')` invece di `renderAgenda()` — elimina il caso in cui lo stato salvato `'ferie'` o `'month'` lasciava `#view-week` visibile ma vuoto

### Bug fix — Normalizzazione orari HH:MM
- [x] **Pagina cancellazione paziente** (`loadCancelPage`): `appt.ora` normalizzato a HH:MM prima di costruire `apptDate` — fix si propaga a preview HTML e mail al centro via `window._cancelApptData`
- [x] **Turni medico loggato** (`loadCentriFromDB`): `inizio`/`fine` passano per `.substring(0,5)` nel map dei turni
- [x] **Turni medico pubblico** (`bkInit`): stessa normalizzazione nel map inline dei centri pubblici

---

## ✅ Completato — sessione 2026-05-18 (notifica cancellazione centro + realtime UPDATE agenda)

### Bug risolti

| Data | Bug | Causa | Fix |
|------|-----|-------|-----|
| 18/05 | Email cancellazione centro non partiva | sendNotificaCentroAnonimo faceva SELECT dirette su medici/centri bloccate da RLS in modalità anonima | nuova RPC SECURITY DEFINER get_dati_notifica_cancellazione(appt_id, token) |
| 18/05 | Agenda medico non aggiornata live alla cancellazione paziente | canale realtime ascoltava solo INSERT | aggiunto handler UPDATE con toast su transizione attivo→cancellato |
| 18/05 | Email cancellazione centro non partiva (paziente cancella) | sendNotificaCentroAnonimo faceva SELECT dirette su medici/centri bloccate da RLS in modalità anonima | nuova RPC SECURITY DEFINER get_dati_notifica_cancellazione(appt_id, token) |
| 18/05 | Agenda medico non aggiornata live alla cancellazione paziente | canale realtime ascoltava solo INSERT | aggiunto handler UPDATE con toast su transizione attivo→cancellato |
| 18/05 | Codice cancellazione mostrato in chiaro al paziente | retaggio iniziale, ridondante visto che esiste il bottone "Cancella" nella mail | rimosso box token dalla schermata conferma + dal template mail in api/send-email.js |
| 18/05 | Testo mail cancellazione centro diceva "dal paziente" anche se cancellava il medico | sendNotificaCentro aveva il testo errato | corretto in "dal medico" |
| 18/05 | Appuntamenti cancellati non visibili come tali nella vista Mese | renderMonthView non applicava la classe appt-cancelled né il filtro | uniformato comportamento alla vista Settimana con badge "Cancellato" e barrato |
| 18/05 | Ricerca medici pubblica non funzionava con stringhe miste ("fabio c") | la RPC search_medici_pubblici cercava il pattern intero in un singolo campo | riscritta con tokenizzazione sugli spazi e AND tra token / OR tra campi |
| 18/05 | Conflitti ferie ↔ appuntamenti non segnalati | nessun controllo in saveChiusura | confirm() che elenca i conflitti prima di salvare |
| 18/05 | Eliminazione appuntamenti era hard-delete (rischio cancellazioni accidentali) | DELETE fisico dal DB | passato a soft-delete con cancelled=true, allineato al flusso paziente |

---

## ✅ Completato — sessione 2026-05-18 (bug fix mapping appuntamenti)

### Bug fix critico — Appuntamenti cancellati appaiono come attivi
- [x] `loadAppuntamentiFromDB()`: aggiunto mapping di `cancelled: a.cancelled === true` e `cancelledAt: a.cancelled_at || null` — prima questi campi erano omessi, `S.appuntamenti[].cancelled` era sempre `undefined`, il guard `!a.cancelled` passava per tutti gli appuntamenti cancellati (visibili in agenda, slot marcati occupati invece di liberi)
- [x] `cancellation_token` non mappato: non viene mai letto da `S.appuntamenti[]` (usato solo come variabile locale in `confirmBooking()` e come filtro DB diretto in `loadCancelPage()`)

---

## ✅ Completato — sessione 2026-05-18 (bug fix + UX cancellazione)

### Bug fix A — Notifiche email segreteria mai inviate
- [x] `loadMedicoFromDB()`: aggiunge lettura di `notifica_nuova_prenotazione`, `notifica_cancellazione`, `notifica_appuntamento_manuale` dal DB e li scrive in `S.settings.*` — prima i 3 toggle erano sempre `undefined` e il guard in `sendNotificaCentro()` bloccava ogni invio
- [x] `bkInit()` (flusso pubblico): i 3 flag letti dall'oggetto medico fetchato via `get_medico_pubblico` → `S.settings.notif*` valorizzati anche senza medico loggato
- [x] UI `loadSettings()`: 3° toggle usa `=== true` (semantica opt-in esplicita, allineata ai default DB)

### Bug fix B — Slot prenotati appaiono come liberi nella pagina pubblica
- [x] Normalizzazione ora `"HH:MM:SS"` → `"HH:MM"` via `.substring(0,5)` in entrambi i punti che popolano `bk.slotOccupati` (`bkInit` + `confirmBooking` catch `isSlotTaken`) — prima il confronto con `minToTime()` falliva sempre

### Miglioria mail conferma paziente — link cancellazione
- [x] `api/send-email.js`: aggiunto bottone CTA "Cancella l'appuntamento" con URL `https://delphi-med.com/?cancel=<token>` (via `encodeURIComponent`)
- [x] Paragrafo persuasivo "Se non puoi venire, ti chiediamo gentilmente di cancellare..." sopra al bottone
- [x] Rimosso codice di cancellazione in chiaro dalla mail (token resta solo nell'URL del link)
- [x] Rimossa frase errata "rispondi a questa email per cancellare"

### Miglioria UI notifiche profilo medico
- [x] Rimosso `<p>` obsoleto "Le email reali verranno attivate allo Step 7 con Resend" (Step 7 completato)
- [x] Aggiunto hint "💾 Ricorda di salvare il profilo per applicare le modifiche" sotto i 3 toggle

### UX pagina di cancellazione
- [x] Pagina pre-cancellazione (`loadCancelPage`): "Vuoi cancellare questo appuntamento?" → testo persuasivo "Se non puoi venire..." con stile coerente al tema
- [x] Pagina post-cancellazione (`cancelBookingByToken`): titolo "Appuntamento cancellato", testo "Hai liberato uno slot per un altro paziente. Grazie.", pulsante "Torna alla home" → `https://delphi-med.com`

---

## ✅ Completato — sessione 2026-05-18 (Step 7b+7c)

### Step 7c — Reminder email 24h prima della visita (Vercel Cron)
- [x] `api/send-reminders.js`: query appuntamenti domani (Europe/Rome, robusto al cambio ora legale), batch fetch centri+medici, invia via `www.delphi-med.com/api/send-email`, aggiorna `reminder_sent=true` solo in caso di successo
- [x] `vercel.json`: cron `0 17 * * *` (19:00 CEST / 17:00 UTC)
- [x] `CRON_SECRET` configurato su Vercel (Production + Development) via CLI
- [x] Verifica: 401 senza auth, 200 con secret → `{"processed":1,"sent":1,"errors":0,"date":"2026-05-18"}`
- [x] Fix URL interno: `www.delphi-med.com` (evita redirect 308 che fa cadere l'header Authorization)

### Step 7b — Email notifica segreteria centro
- [x] `buildEmailHtml(plainText, headerLabel)`: converte testo plain in HTML con header teal Delphi~Med, escape XSS, footer disclaimer
- [x] `sendNotificaCentro()`: rimosso placeholder `console.log`/`showToast`, ora chiama `/api/send-email` con header contestuale (Nuova prenotazione / Nuovo appuntamento / Cancellazione)
- [x] `sendNotificaCentroAnonimo()`: stesso fix per cancellazione pubblica via token
- [x] I 4 call site esistenti restano invariati (`confirmBooking`, inserimento manuale, ripristino, cancellazione anonima)

### Bug fix prenotazione pubblica
- [x] Auto-capitalize `bk-nome`/`bk-cognome` al blur nella pagina prenotazione pubblica: estratta `setupCapitalizeListeners()` (con guard `dataset.capListener`) chiamata sia da `init()` che da `showBookingView()`
- [x] Race condition doppia prenotazione stesso slot: `confirmBooking()` intercetta errore Postgres `23505`, aggiorna `slotOccupati` localmente, ricarica slot freschi dal DB e riporta l'utente allo step 3 con toast esplicativo

---

## ✅ Completato — sessione 2026-05-17 (notte)

### Profilo medico — Altre specializzazioni
- [x] Costante `SPECIALIZZAZIONI_UFFICIALI` (53 voci) estratta dal form di registrazione; usata sia da `#reg-specializzazione` che dal profilo
- [x] `#setting-spec` (specializzazione principale) convertita da input libero a `<select>` a 53 voci
- [x] Nuovo campo "Altre specializzazioni" nel profilo: area chip `#spec-altre-list` + tendina `#setting-spec-altre-select`
- [x] `renderSpecAltre()`: ridisegna chip ed esclude dalla tendina le voci già usate (principale + altre)
- [x] `addSpecAltra()` / `removeSpecAltra()`: aggiunge/rimuove chip con aggiornamento tendina
- [x] `onSpecPrincChange()`: se la nuova principale era già tra le altre, la rimuove con toast
- [x] `loadSettings()`: popola `specAltre` da `data.specializzazioni` (esclude la principale)
- [x] `saveSettings()`: scrive `specializzazioni: [...new Set([spec, ...specAltre])]` deduplicato su Supabase

### Centri — Modifica centro
- [x] Bottone ✏️ aggiunto a ogni card centro (sia attivi che disattivati), a sinistra di ⏸/▶
- [x] `openEditCentro(id)`: popola la modale con i dati del centro e cambia titolo/bottone in "Modifica / Salva modifiche"
- [x] `openAddCentro()`: resetta il form e ripristina "Aggiungi centro / Salva centro"
- [x] `closeCentroModal()`: azzera `_centroEditId` — usato da ×, Annulla e dopo il salvataggio
- [x] `saveCentro()`: gestisce INSERT (nuovo) e UPDATE (modifica) preservando turni, giornate singole e stato attivo
- [x] `resetCentroForm()`: utility estratta per il reset del form centro

---

## ✅ Completato — sessione 2026-05-17 (sera)

### Merge e deploy
- [x] Merge `feat-specializzazione-centri` → `master` (fast-forward, 3 commit) e push su origin; branch eliminato in locale e remote
- [x] Step 5 prenotazione (`bk-step-5`): bottone "Prenota un altro appuntamento" → link "Torna alla home" che reindirizza a https://delphi-med.com

### Dominio
- [x] `delphi-med.it` configurato e funzionante: record A `@` → `76.76.21.21` + CNAME `www` → `8d5de3516bd187e8.vercel-dns-017.com` su Cloudflare (Proxy: DNS only)

### Bug risolti
- [x] Email approvazione tardiva: l'email al medico ora arriva senza necessità di refresh
- [x] Errori 406 al login post-approvazione risolti
- [x] 409 Conflict su `ensureMedicoRecord` risolto

---

## ✅ Completato — sessione 2026-05-17 (schema DB + frontend)

### Wipe e migrazione schema DB
- [x] Wipe totale dati eseguito (tabelle svuotate, si riparte da zero)
- [x] `centri`: rimosso campo `indirizzo`, aggiunti `via`, `citta`, `provincia`, `cap`
- [x] `medici`: aggiunti `specializzazione` (TEXT), `specializzazioni` (TEXT[]), `slug`
- [x] `medici`: aggiunti `notifica_cancellazione_medico` (bool, default true), `nascondi_cancellati` (bool, default false) — 18/05
- [x] Funzione SQL `generate_unique_slug()` con cascata estesa (SECURITY DEFINER)
- [x] Trigger `medici_auto_slug()` BEFORE INSERT/UPDATE: genera slug e mantiene `specializzazioni[]` coerente
- [x] Funzione `search_medici_pubblici(p_query)`: cerca su nome/cognome/specializzazione/specializzazioni[], ritorna citta[]
- [x] View `medici_pubblici`: filtra stato='approvato' AND slug IS NOT NULL AND specializzazione IS NOT NULL
- [x] `add-medici-approval.sql` eseguito (campi approvazione, stato default 'approvato' per account legacy) ✅

### Bug risolti
- [x] Flash dashboard durante registrazione → flag `_isRegistering` + guard in `onAuthStateChange`
- [x] Box "Registrazione inviata!" non appariva → gestione deterministica SIGNED_OUT post-signUp
- [x] Capitalize automatico nome/cognome → `onblur` inline sugli input HTML
- [x] Rebrand completo "Delphi Med" → "Delphi~Med" ovunque (HTML + email admin + email approvazione)
- [x] Bug ricerca medici non visibili: trigger slug bloccato da RLS → fix SECURITY DEFINER
- [x] Bug omonimia (es. "Mario Rossi"): cascata slug nome-cognome → +spec → +provincia → +albo

### Branch `feat-specializzazione-centri` (commit `fb125aa`, da mergiare su master)
- [x] Form registrazione: tendina "Specializzazione" obbligatoria (53 voci ufficiali italiane)
- [x] `signUp()`: lettura, validazione e INSERT di `specializzazione` in tabella `medici`
- [x] Modale "Aggiungi centro": 4 campi separati via/città/provincia (110 sigle)/CAP al posto di "indirizzo"
- [x] `saveCentro()`: INSERT con nuovi campi separati + indirizzo composto per retrocompatibilità locale
- [x] `loadCentriFromDB()`: mappa via/citta/provincia/cap dal DB, compone stringa indirizzo
- [x] `homeSearch()`: mostra specializzazione(i) + città dei centri (max 2 + contatore)
- [x] `saveSettings()`: `confirm()` esplicito se nome/cognome/specializzazione cambiano (impatto slug)
- [x] Auto-capitalize `onblur` su nome centro e via nella modale centro

---

## ✅ Completato — sessione 2026-05-16 (onboarding medici)

### Registrazione medico con approvazione manuale
- [x] Form registrazione con campi obbligatori: nome, cognome, CF, n° ordine, provincia ordine
- [x] Validazione password forte: 8+ caratteri, maiuscola, minuscola, numero, carattere speciale — indicatore visivo in tempo reale
- [x] `supabase.auth.signOut()` dopo `signUp()` per bloccare il login automatico
- [x] INSERT in `medici` con tutti i campi + `stato: 'in_attesa'`; tipi visita default creati contestualmente
- [x] Email di notifica all'admin con dati medico e link di approvazione
- [x] Endpoint `api/approve-doctor.js`: PATCH `stato = 'approvato'` + invio email di benvenuto al medico
- [x] Blocco login per medici con `stato = 'in_attesa'`
- [x] Messaggio post-registrazione inline (success box) con pulsante "Torna alla home"
- [x] Link a Termini di servizio e Privacy policy nel form

### Infrastruttura email
- [x] Dominio `delphi-med.com` verificato su Resend
- [x] Mittente: `noreply@delphi-med.com`
- [x] `api/send-email.js` con modalità generica `{to, subject, html}`
- [x] `SUPABASE_SERVICE_ROLE_KEY` configurata in Vercel

---

## ✅ FEATURE COMPLETATE OGGI (18 maggio 2026)

**Sezione Impostazioni** (branch feat/impostazioni → master)
- Nuova pagina dedicata accanto a Profilo, con icona ⚙️ in sidebar desktop e top-bar mobile
- 5 toggle: nuova prenotazione online, cancellazione paziente, cancellazione medico (nuovo), appuntamento manuale, nascondi cancellati (nuovo, persistente)
- Sezione Aspetto: toggle tema scuro uniforme con gli altri
- Sezione Esporta dati: download backup JSON completo (profilo + centri + turni + appuntamenti + pazienti + visite + chiusure + tipi_visita + aree_tematiche)
- Auto-save su ogni toggle, niente bottone Salva
- Toggle "Cancellazione medico" separato dal toggle paziente: ora la mail al centro su cancellazione del medico è governata da notifica_cancellazione_medico

**Notifiche email espansive**
- Inserimento manuale appuntamento → mail anche al paziente (oltre al centro)
- Cancellazione manuale appuntamento → mail al paziente + mail al centro
- Cancellazione manuale → ora richiede conferma con preview di paziente, data, ora
- Ferie → invio automatico mail ai centri con email_segreteria
- Nuovo template lato server: cancellazione_medico in api/send-email.js

**Nuove RPC SQL aggiunte a Supabase**
- get_dati_notifica_cancellazione(p_appt_id, p_token) — già listata nella sezione SQL del riassunto
- search_medici_pubblici(p_query) — riscritta per gestire query multi-token

**Nuove colonne aggiunte alla tabella medici**
- notifica_cancellazione_medico BOOLEAN DEFAULT TRUE
- nascondi_cancellati BOOLEAN DEFAULT FALSE

---

## ⚠️ Problemi aperti (noti, non ancora risolti)

*(nessun problema aperto noto al momento)*

---

## 🔜 Prossime priorità

### Contenuti legali
- [ ] Sostituire placeholder `termini-di-servizio.html` con testo reale
- [ ] Sostituire placeholder `privacy-policy.html` con testo reale

### Email e notifiche (Step 7)
- [ ] **Step 7d** — notifiche al medico (3 toggle già in profilo)

### Step 4.8 — Pulizia e hardening
- [ ] Rimuovere `save()` / `load()` da localStorage dove non più necessario
- [ ] Loading states / skeleton UI durante le fetch DB
- [ ] Toast errori Supabase più descrittivi
- [ ] Rimuovere `console.log` di debug in produzione

### Sicurezza
- [ ] Verificare copertura RLS completa (medico non legge dati di altri medici)
- [ ] Rate limiting sulla policy anon INSERT appuntamenti
- [ ] Scadenza sessione Supabase: gestire refresh automatico

---

## 📅 Da fare in seguito

### Prodotto
- [ ] Logo grafico Delphi~Med
- [ ] **Step 8** — indirizzo email personale medico + agente AI che legge mail centri
- [ ] **Step 9** — pagamenti Stripe (abbonamenti mensili ~19-29€/mese)
- [ ] **Step 10** — PWA + Capacitor per app store iOS/Android

### Pagamenti (lungo termine)
- [ ] Stripe: pagamento anticipato alla prenotazione, rimborsi, policy cancellazione
- [ ] Ricevuta fiscale / fattura (valutare Fatture in Cloud)

### Multi-device e PWA
- [ ] Manifest PWA per installazione mobile
- [ ] Service Worker per offline completo
- [ ] Push notifications native

### Funzionalità backlog
- [ ] Multi-medico / studio associato
- [ ] Calendario Google / iCal sync
- [ ] Import pazienti da CSV
- [ ] Statistiche avanzate (trend, revenue, pazienti nuovi vs ricorrenti)
- [ ] Template referti personalizzabili
- [ ] Firma digitale referti PDF

---

## ⚠️ Note operative

- **Confirm email DISATTIVATO** su Supabase: `signOut()` dopo `signUp()` compensa il login automatico
- **`SUPABASE_SERVICE_ROLE_KEY`** richiesta in Vercel per `approve-doctor.js` (bypass RLS)
- **Deploy**: solo `git push origin master` — NON `npx vercel --prod`
- **`config.js`** mai committato (in `.gitignore`)
- **Branch attivo**: nessuno — tutto su `master`

---

*Ultimo aggiornamento: 2026-05-19 — Sezione Impostazioni completa (toggle auto-salvanti, tema, esporta dati, separazione cancellazione medico/paziente)*

---

## 📝 NOTE OPERATIVE / RUNBOOK

Cose che non sono task ma è utile ricordare quando qualcosa va storto o serve fare debug.

### Logs e debugging
- **Log RPC e query Supabase**: Supabase Dashboard → Database → Logs → Postgres Logs
- **Log Edge Functions / API Vercel**: Vercel Dashboard → progetto medidesk → Logs
- **Log invio email Resend**: Resend Dashboard → Logs (vedi delivery, bounce, errori)
- **Log cron Vercel**: Vercel Dashboard → progetto → Cron Jobs → vedi ultime esecuzioni

### Monitoraggio realtime
- Console browser medico durante il funzionamento: cerca `[Realtime] Status:`
  - `SUBSCRIBED` = OK
  - `CHANNEL_ERROR` o `TIMED_OUT` = problema rete o config
- Eventi attesi: `[Realtime] Nuova prenotazione: <id>` su INSERT, `[Realtime] Update appuntamento: <id>` su UPDATE

### Switch ora legale/solare per cron
- 26 ottobre 2026 (CEST → CET): cambiare `vercel.json` da `"0 17 * * *"` a `"0 18 * * *"`
- Ultima domenica di marzo 2027 (CET → CEST): tornare a `"0 17 * * *"`

### File single-source-of-truth
- Codice app: `medidesk.html` (tutto in un file)
- Endpoint API: `api/send-email.js`, `api/approve-doctor.js`, `api/send-reminders.js`
- Deploy: solo `git push origin master` — MAI `npx vercel --prod`

### Skin / palette colori personalizzabili (futuro)

Idea: il medico può scegliere il colore primario/secondario dell'app tra alcune palette predefinite.

Decisioni di design già prese:
- Opzione A scelta: palette predefinite curate (es. "Verde clinico" default, "Blu professionale", "Viola neuro", "Bordeaux", "Grigio minimal"), no color picker libero per evitare accoppiamenti illeggibili
- Implementazione: sovrascrittura delle CSS variables (--accent, --accent2) a runtime via document.documentElement.style.setProperty()
- Persistenza: 2 colonne nuove sulla tabella medici (accent_color, accent2_color)
- Posizione UI: sezione "Aspetto" in Impostazioni, sotto il toggle tema scuro

Quando rilasciare: dopo Step 8 (AI inbound) e Step 9 (Stripe). Tenere come materiale per mail di marketing/engagement ("Personalizza il tuo Delphi~Med!").

Costo stimato: ~60 righe codice, 1-2 ore di lavoro.

### Area Account (futuro, dopo Stripe)

Funzionalità core da implementare:
- Gestione abbonamento collegata a Step 9/Stripe: piano attivo, prossimo rinnovo, storico pagamenti, fatture scaricabili, cambio metodo di pagamento, upgrade/downgrade, pausa abbonamento
- Eliminazione profilo con doppia conferma (digitare email o password)
- Backup dati proattivo PRIMA dell'eliminazione (è già implementato Esporta dati, va integrato nel flusso)
- Cambio email account
- Cambio password
- Sessioni attive con logout da tutti i dispositivi
- Export dati GDPR-compliant (già parzialmente coperto da Esporta dati)
- Possibilità di "pausa account" come alternativa all'eliminazione

Decisioni importanti su "elimina profilo":
- GDPR richiede eliminazione effettiva, ma fatture e dati sanitari hanno periodi minimi di conservazione (10 anni)
- Probabile soft-delete di 30 giorni con possibilità di ripristino, poi cancellazione fisica
- Per i dati dei pazienti serve flusso di export PDF prima dell'eliminazione (responsabilità del medico come titolare del trattamento)
- Non basta un checkbox di conferma: digitare l'email o inserire la password

Quando affrontare: dopo Step 9/Stripe. Senza gestione abbonamento attiva, mezza Area Account non avrebbe nulla da mostrare.
