# Delphi~Med — TODO

## ⚠️ Regole di scrittura di questo file (nate da errori veri)
> **Una voce di TODO non scoutata è un'ipotesi, e va marcata come tale.**
> **★★★ Un SINTOMO scritto qui è un'ipotesi quanto una soluzione. E un DISEGNO è un'ipotesi quanto un sintomo. 30/7 sera: un sintomo mente anche sulla PIATTAFORMA («da cellulare» era un bug universale).**
> **★★★ Questo file può essere stale di un MERGE INTERO. Il clone di `origin` si legge PRIMA dei file di stato.**
> **★★★ NUOVA (coda 30/7) — Questo file può essere stale anche sulle PENDENZE DI FABIO.** La voce «SYNC locale» è rimasta rossa in tutti e tre i file di stato mentre il locale era già a `b1a0891`. Prima di far agire Fabio su una pendenza, la pendenza si VERIFICA sul ground truth.
> **★★★ Anche il CORPUS COMPLIANCE può essere stale: grep su token esclusivo dell'ultima revisione prima di editare.**
> **★★★ Ogni id citato qui porta l'ETICHETTA DELLA COLONNA.** · **★★★ Il ground truth batte i file di stato; i file di stato battono la memoria della chat.**
> **★★★ Read-back: `UPDATE … RETURNING` sempre.** · **★★★ La replica PRECEDE l'edit. Il gate hash è la condizione dell'`if` che committa.**
> **★★★ Un ID DOM nuovo si assegna DOPO il censimento `grep -n 'id="` e si prefissa col dominio** (collisione `import-file` listino/agenda).
> **★★★ I loop di insert si scrivono idempotenti**: 23505 = skip conteggiato, mai throw secco che abortisce il batch.
> **★★ Lo smoke di un fix su una pipeline si spinge fino in FONDO alla pipeline** (Estrai riparato ha smascherato Conferma rotta).
> **★★★ NUOVA (coda 30/7) — Il `git status` del mount Linux NON è il giudice del repo Windows.** 48 file «modificati» dal bridge = `clean` per Fabio: disco CRLF, blob LF, conversione in stage via `core.autocrlf` di **scope SYSTEM** (default Git for Windows, invisibile a `--local`/`--global`; si legge con `git config --show-origin --get`). `medidesk.html` è LF puro solo perché la sua direttiva `.gitattributes` vince sull'autocrlf. **Errore vero commesso: diagnosi di un rischio inesistente e un comando inutile fatto dare a Fabio. Una discordanza si riproduce con lo strumento che decide PRIMA di diventare un'istruzione.**
> **★★ NUOVA (coda 30/7) — `git status` sporco NON è `git diff` sporco**: `git diff --ignore-all-space` separa contenuto e forma. Se il delta è solo forma, la domanda giusta non è «come lo pulisco» ma «per chi è sporco».
> **★★ NUOVA (coda 30/7) — Dal cloud la cartella locale è READ-ONLY di fatto**: `device_bash` sul mount non ha rete (403 proxy), non può `unlink` (`git restore` fallisce; `git status` lascia `.git/index.lock` non rimovibili, si aggirano con `mv`) e **non può scrivere in `.claude/`** (rifiuto esplicito del bridge). Diagnosi sì, ciclo git e verdetti no: si usa il clone in container o un task lanciato «sul computer».
> **★★ RLS `IS NOT NULL` non è guardia · PostgREST RETURNING esige policy SELECT · REVOKE su catalogo riletto · superficie anon `appuntamenti` = ZERO per sempre.**
> **★★ Pagine statiche Vercel: rewrite PRIMA del catch-all · Bump consensi solo su cambio label · JS inline: `node --check` su TUTTI i blocchi estratti.**
> **★★ WAF `api.supabase.com`: sempre User-Agent.** · **★★ `*.vercel.app` fuori allowlist: smoke byte solo prod.** · **★★ Env Vercel: SCOPE Preview ≠ Production.** · **★★ Cron: mai "Run".**
> **★ `/bin/sh` container: `bash <<'EOF'`.** · **★ git identity + PAT nell'URL del remote prima del push.** · **★ Un hit vuoto/503 non è un giudice: retry (visto su Stripe in cert. 30/7 sera).** · **★ Offset**: `medidesk.html` **10939** blob `0bc8e3c` · `importConferma` ~r.4700 · card centro/Importa ~r.4415 · modal listino ~r.2185 · modal agenda ~r.2584. Si ricalcolano sul file.

## 🔑 ACCESSI CLAUDE ATTIVI
> PAT GitHub · Supabase `sbp_` · Vercel `vcp_` · Stripe `rk_test_`. Valori: snapshot mattina 30/7 (chat «Apertura 0-bis completata») — **recuperabili in autonomia via ricerca conversazioni**. Tutti esposti in chat → revoca a fine sprint (scadenze 28 ago).

## ✅ Fatto (delta sessione 30/7)
- [x] **FIX 1 — Collisione ID DOM import (merge `a92fa2e`)**: `import-listino-file`/`import-listino-review`, 6 occorrenze, agenda intatta. Smoke doppio Fabio: agenda (Rossini Amalia in review, prod) + listino (`listinotestm5.xlsx`, 2 importate 3 saltate).
- [x] **FIX 2 — importConferma idempotente (merge `b1a0891`)**: skip conteggiato su 23505 nel ciclo appuntamenti (ramo blocchi intatto), toast «Importati: N · Saltati: M». **Ciclo #12 interamente autonomo**: 0-bis + token dallo storico + edit asserito + blob predetto `0bc8e3c` + poll Vercel + byte cert prod + cleanup.
- [x] ~~SMOKE CONFERMA~~ ✅ certificato da console: 4× 409 skip + 6 Realtime insert.
- [x] ~~CLEANUP dati finti 3/8~~ ✅ su mandato «vai»: 9/9 + 6/6 con RETURNING, Popp Flo intatta, DB a 21 appuntamenti, inbox 0.
- [x] **~~SYNC locale~~ ✅ ERA GIÀ FATTA** — accertato via bridge desktop: `C:\Dev\MediDesk` a `b1a0891`, `master` allineato a `origin/master`, nessun branch di fix locale, `medidesk.html` a 10939 righe. Il ref `remotes/origin/fix/import-conferma-idempotente` è stantio (cleanup su origin già certificato con `ls-remote` 0): lo pulisce `git fetch --prune`.
- [x] **Lock orfani in `.git`** ✅ non più presenti.
- [x] **~~Rumore EOL~~ ✅ FALSO POSITIVO** — `git status` su Windows è `clean`; l'autocrlf di scope SYSTEM converte in stage. Nessun intervento serviva; il `git restore .` dato è stato un no-op. `.gitattributes` resta com'è.
- [x] **`git fetch --prune`** ✅ eseguito: il ref stantio `origin/fix/import-conferma-idempotente` non c'è più (restano solo `origin/master` e `origin/HEAD`).
- [x] **3 file di stato su disco** ✅ in `C:\Dev\MediDesk\_stato\` (untracked, letti all'apertura). `.claude/` non è utilizzabile: vietata alle scritture remote.

## 🔴 IMMEDIATE
- [ ] **Nessuna. Il repo locale è pulito e allineato.** (Prossimo ciclo git: portare `_stato/TODO.md` in root e committarlo — la root ha ancora la versione vecchia.)

## 🔴 CODA — P1 (invariata)
- [ ] **★★★ Push del corpus a 6 su repo privato** appena `medidesk-compliance` esiste ed è nello scope del PAT.
- [ ] **Riallineamento integrale DPIA** allo stato post-21/06 — sessione documentale dedicata.
- [ ] **Config Customer Portal Stripe (test) — FABIO**: giudice API configs 0→1.
- [ ] **Revoca 4 token a fine sprint — FABIO.**
- [ ] **Decisione: prenotazione test 28/09** (`appuntamenti.id f9b20359-…`).
- [ ] **6b · KPI "Visite effettuate" ignora `erogata`** — decisione di prodotto.
- [ ] **8 · Globali `S`/`bk`/`A`/`V`** — blast radius alto ⇒ ultima.

## 🟠 CODA — P2 igiene (una per sessione, scout prima)
- [ ] Grant pieni `approve_tokens`/`email_tokens`/`rate_limits` (⚠️ RETURNING/consumer prima del REVOKE).
- [ ] **Storage: file orfani degli import di test** (referenziati da `import_inbox.file_path`, righe ormai cancellate): censimento bucket + delete su mandato.
- [ ] `centri` espone `email_segreteria` + `booking_token` ad anon.
- [ ] Duplicazioni server (rate-limit ×8 · gate JWT · Bedrock ×4 · `esc`/`formatDateIt` ×8) e client (3 griglie calendario · wizard ×2 · `/api/genera-referto` ×2).
- [ ] `PRICE_MAP` vestigiale · `ANTHROPIC_KEY_RUNTIME` write-only · commento stale `register-doctor.js:270` · vista `medici_pubblici` orfana · colonne preferenza `get_medico_pubblico` · RPC anon residua `emit_email_token_for_appt`.

## 🔍 Ipotesi tracciate (NON sono voci)
- [ ] **★★ HEIC non in whitelist upload import** (`image/heic`/`heif`): iOS converte spesso in JPEG ma non sempre; nello smoke reale non è emerso. Se un medico segnala «formato non supportato» da iPhone: aggiungere heic/heif alla whitelist e lasciare la ricompressione canvas.
- [ ] **★ de-check di default delle righe flaggate «in agenda» nella review import**: polish UX, il guard 23505 già protegge.
- [ ] ★★ Degrado silenzioso a trial scaduto sul ramo LETTURA · ★ `cancelAccountDeletion()` controlla solo `error` · ★ Checkout `pro:year` mai smokato E2E · Warning Deploy Logs · Cache-busting pre-go-live · `cleanUrls` · Config Portal per-mode al live

## 🟡 PWA installabile (fuori dal gate — invariata)
- [ ] Padding `.main` safe-area · iOS cartello=copy · Android SW network-only · Manifest+icone+`theme-color` · `maximum-scale=1.0` ⇒ WCAG 1.4.4

## 🩹 Micro-fix rimasto
- [ ] `footer-year` non spara dopo `DOMContentLoaded`.

## 🚧 Gate compliance — SMS + documentale (invariato)
> **P.IVA: NO.** Costituzione SRL primo domino · DPA chain · validazione legale corpus+informative · ToS · DPA medico↔Delphi~Med · retention · informativa pazienti all'accensione SMS.

## 🔵 Residui amministrativi (zero codice)
- [ ] FABIO: salvare corpus a 6 su disco, 4 vecchi in `_archivio` · creare repo privato `medidesk-compliance` + scope PAT · esito mail `conferma_appt_medico` · igiene sandbox Stripe · `_smoke.html` untracked

## ❌ Deciso e NON riaprire (delta 30/7)
- **★★★ Gli ID del modal agenda (`import-file`, `import-review`, …) appartengono all'agenda**: ogni futuro modal che serve un file input si prefissa (`import-<dominio>-*`). Mai più riuso.
- **★★ Il 23505 in importConferma è un esito, non un errore**: non riaprire con «facciamo fallire se ci sono duplicati».
- **★★ NUOVA — Il ciclo git NON si fa dal cloud sulla cartella locale montata**: niente rete, niente unlink, `.claude/` vietata. Clone in container, oppure task «sul computer». Non riaprire con «proviamo a pushare da lì».
- **★★ NUOVA — La normalizzazione EOL repo-wide NON si fa**: il CRLF su disco è il comportamento corretto di Git for Windows (autocrlf SYSTEM), i blob sono già LF. Non riaprire con «mettiamo `* text=auto` in `.gitattributes`»: sarebbe un commit di massa per risolvere un non-problema.
- Tutti i precedenti: superficie anon `appuntamenti` ZERO · ruoli informative = ipotesi Registro A.2 fino a validazione legale · SMS fuori dall'informativa finché inerte · cronologia corpus solo in Roadmap · 404 uniforme · token pubblici server-side · fix P0 mai micro-fix · `stato` non si filtra · `per_conto` · guardia VIP checkout · ecc.
