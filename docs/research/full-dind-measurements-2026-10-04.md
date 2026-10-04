# #142: prova completa con agente nativo e Docker-in-Docker, 4 ottobre 2026

La prova è arrivata dalla base originale a un’implementazione, ai nove controlli del controller e a
una review indipendente approvata. Durata totale, inclusa pulizia: **103 min 25.9 s**. Questo è un
risultato del runner sperimentale locale: non è una nuova esecuzione persistita nell’app, una
certificazione Factory pubblicata, una PR o un merge.

L’avvio non è stato completamente autonomo: ho dovuto ripristinare i parametri non segreti della
shell del runner sperimentale. Un percorso browser ha inoltre fallito una volta; il giro successivo
è passato sullo stesso codice. La causa di quell’intermittenza resta aperta.

## Identità e confini della prova

Gli harness e i dati grezzi sono snapshot sperimentali conservati nell'evidence root locale, fuori
dal repository. I percorsi `scripts/` citati identificano quei file di prova; non indicano nuovi
comandi supportati dall'applicazione né un runner DinD integrato in produzione.

- Caso: issue importata **#142, “0.2-01 — Riconoscere una PR documentale supportata”**; piano
  approvato versione 1, requisiti e nove comandi originali congelati.
- Feature: `01a0f7ee-bd85-7c5b-8ddd-0942adeadacd`; il run storico
  `01a0f904-c041-7bf5-99d5-43b50fa1ce3a` è stato usato come riferimento di lettura, non aggiornato
  né riutilizzato come nuovo record di esecuzione.
- Base del codice: `f0803bb3ff85e3d2b04743403b5a0361072f1a40`, prima dell’implementazione
  precedente. La vecchia patch non è stata copiata. Il clone contiene comunque gli oggetti e i
  riferimenti storici del repository: non è un esperimento cieco con una storia Git sterilizzata.
- Revisione finale sperimentale: `0e10e85eac58bcccf3537d03a2ad79b35d1ab7f4`; tree
  `136d3e4828f4d1ba5ec9ee83c0dd264d0fc1849a`. I checkpoint dei due giri hanno lo stesso tree: il
  secondo giro non ha corretto il codice.
- Esecuzione: 2026-10-04T11:32:33.737Z → 2026-10-04T13:15:59.628Z (UTC).
- Profilo reale conservato: `gpt-6.1-sol`, effort `low`, service tier `default`; nessun MCP
  aggiunto. Inferenza tramite il Codex autenticato dell’host, comandi nel job Linux locale.
- Host: Apple arm64, **24 GiB fisici**. Docker Desktop: VM Linux **7,748 GiB**, 12 CPU virtuali.
  Host Codex 0.160.0, executor Codex 0.155.1, Node del job 24.18.1, Engine esterno 29.7.2, interno
  29.8.2. Queste versioni sono fotografate in
  [versions.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/versions.json>);
  non è una certificazione universale di compatibilità tra versioni.
- Un job e un daemon privato, ciascuno limitato a **3 GiB, 512 PID e 2 CPU**, entrambi assegnati
  agli stessi core `0-1`: il budget CPU effettivamente condiviso è due core. `--init`, UID/GID 1000,
  heap Node dichiarato 2048 MiB, workspace e `/tmp` su volumi Linux. Memoria-swap dei container pari
  alla memoria, senza swap aggiuntivo del cgroup.
- Il daemon DinD è privilegiato, raggiungibile tramite socket Unix privato, senza montare il socket
  Docker dell’host né pubblicare una porta del daemon. Questo è un esperimento su un progetto
  fidato; non prova la sicurezza rispetto a codice ostile.
- La review ha contesto nuovo, filesystem e Git in sola lettura, nessuna rete e nessun socket
  Docker. Ispeziona codice, requisiti e risultati forniti dal controller; non riesegue il progetto.
- L’immagine esterna dell’executor e alcune cache dell’host erano già disponibili. “Da zero”
  riguarda il codice del task, non una macchina appena installata. Il daemon e i suoi volumi erano
  nuovi; il primo build interno del progetto era freddo.

## Risultato e tempi

L’implementazione introduce classificazione documentale completa dei due lati della revisione
trattenuta, associazione a digest e identità esatte, blocco dell’avvio e nuova verifica prima
dell’inferenza per PR esterne, dettaglio accessibile in PWA, regressioni e documentazione. Le review
Factory rimangono fuori dal blocco di eligibility documentale.

| Sessione               | Durata del turno | Comandi conclusi |
| ---------------------- | ---------------- | ---------------- |
| round-1-implementation | 67 min 37.3 s    | 118              |
| round-2-implementation | 11 min 22.4 s    | 57               |
| independent-review     | 1 min 32.1 s     | 8                |

La durata del turno comprende comandi, inferenza, rete, pianificazione e trasporto. Le notifiche
pubbliche `started/completed` di un comando breve possono essere emesse insieme dopo l’esecuzione:
l’unione dei loro intervalli in `publicCommandEventSpanUnionSeconds` non è la durata reale della
shell e non permette di isolare la latenza del modello. I comandi del controller hanno invece tempi
misurati dal processo chiamante. I comandi con exit nonzero includono regressioni inizialmente rosse
e ricerche senza risultati, oltre a errori reali: non equivalgono automaticamente a bug distinti.

| Controllo               | Giro 1         | Giro 2         |
| ----------------------- | -------------- | -------------- |
| npm run test (mirati)   | PASS · 72.3 s  | PASS · 68.0 s  |
| npm run test:black-box  | PASS · 69.6 s  | PASS · 65.6 s  |
| npm run test:browser    | FAIL · 152.8 s | PASS · 133.2 s |
| npm run contracts:check | PASS · 0.5 s   | PASS · 0.6 s   |
| npm run format:check    | PASS · 6.4 s   | PASS · 6.6 s   |
| npm run lint            | PASS · 37.9 s  | PASS · 36.9 s  |
| npm run typecheck       | PASS · 24.0 s  | PASS · 22.4 s  |
| npm run test (completi) | PASS · 224.6 s | PASS · 210.8 s |
| npm run build           | PASS · 20.5 s  | PASS · 23.4 s  |

Sul giro finale: **202 test mirati**, **3 test HTTP**, **5 percorsi browser**, **1.454 test della
suite completa riusciti**, con **8 test live opt-in esclusi dalla configurazione preesistente**. Non
sono stati aggiunti skip. Contratti, formattazione, lint, typecheck e build sono passati. La review
indipendente ha restituito `approved` senza findings:
[review.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/review.json>).

La verifica del controller è sequenziale e controlla che il sorgente resti pulito dopo ogni comando.
L’agente aveva eseguito anch’esso i nove comandi prima di consegnare: i tempi includono questa
duplicazione deliberata della prova, non sono il costo minimo di un futuro runner ottimizzato. Un
giro completo verde non dimostra l’assenza di intermittenze.

## Consumi misurati

| Misura                                                 | Valore          |
| ------------------------------------------------------ | --------------- |
| Picco simultaneo campionato job + daemon               | 4.845 GiB       |
| job: picco kernel di memoria addebitata                | 3.000 GiB       |
| job: picco PID                                         | 144 / 512       |
| job: eventi OOM / OOM kill / limite PID                | 0 / 0 / 0       |
| job: eventi al limite memory.max                       | 5136            |
| job: CPU cumulativa del cgroup                         | 2620.0 CPU-s    |
| daemon: picco kernel di memoria addebitata             | 3.000 GiB       |
| daemon: picco PID                                      | 239 / 512       |
| daemon: eventi OOM / OOM kill / limite PID             | 0 / 0 / 0       |
| daemon: eventi al limite memory.max                    | 2789            |
| daemon: CPU cumulativa del cgroup                      | 1112.5 CPU-s    |
| Host: picco RSS sommato controller e discendenti       | 301.3 MiB       |
| Host: picco RSS sommato osservatore e discendenti      | 57.5 MiB        |
| Review: picco kernel del container separato            | 79.0 MiB        |
| Review: picco PID                                      | 29              |
| VM Linux: minimo MemAvailable osservato                | 4.097 GiB       |
| Host: memory_pressure free, iniziale / minimo / finale | 43% / 33% / 41% |

Il picco simultaneo è il massimo di campioni accoppiati: non è la somma dei picchi indipendenti dei
due container. `memory.current` e `memory.peak` comprendono cache di file addebitata al cgroup. Il
limite raggiunto con recupero di memoria non è un evento OOM.

| Container, istante del massimo campionato dall’osservatore | Anonima   | File/cache | Kernel    |
| ---------------------------------------------------------- | --------- | ---------- | --------- |
| job · 2026-10-04T12:47:40.162Z                             | 2.008 GiB | 0.867 GiB  | 0.114 GiB |
| daemon · 2026-10-04T12:03:48.743Z                          | 0.367 GiB | 2.362 GiB  | 0.234 GiB |
| review · 2026-10-04T13:14:20.342Z                          | 0.058 GiB | 0.000 GiB  | 0.002 GiB |

Le categorie della tabella sono fotografie del massimo campionato dall’osservatore, non
necessariamente dell’istante esatto del picco kernel. `shmem`, file mappati e file attivi/inattivi
sono sottoinsiemi e non vanno sommati una seconda volta. Il daemon ha raggiunto il tetto soprattutto
con cache; il job ha avuto un carico maggiore di memoria anonima dei processi.

L’RSS dell’host somma processi e discendenti: può contare pagine condivise più volte ed escludere
processi staccati. Non va sommato ai cgroup e alla memoria dell’intera VM per ottenere un ipotetico
consumo fisico. Il supervisore Kestrel già attivo, PID 16670, è misurato separatamente in
`existingRuntimeRssGroup` di
[summary.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/summary.json>).

Lo swap è misurato a livello dell’intero Mac, con altre applicazioni e sessioni attive. Durante la
prova i contatori cumulativi sono aumentati di **12.056 GiB in lettura** e **11.945 GiB in
scrittura**: sono volumi cumulativi di I/O, non spazio di swap occupato e non consumo attribuibile
esclusivamente al task. Una lettura intermedia `sysctl vm.swapusage` riportava `7679.94M` usati
secondo `sysctl`; manca una baseline della stessa misura all’avvio. Letture intermedia/finale sono
conservate separatamente. Non considero quindi questa prova una dimostrazione che 16 GiB bastino o
che il computer resti sempre fluido.

Il daemon privato riportava durante i test 2,677 GB di immagini, 2,276 GB di build cache, 71,44 MB
di volumi interni e 12,75 MB di layer dei container. Sono categorie contabili Docker, con layer
condivisi: non sono una somma di spazio fisico unico sul Mac. Fotografia:
[private-storage-snapshot.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/private-storage-snapshot.json>).

CPU cumulativa, throttling, PSI di memoria/CPU, I/O, PID, stato VM e processi sono conservati nei
campioni. La frequenza richiesta è circa cinque secondi, con letture aggiuntive ai confini di fase;
i singoli snapshot non sono una transazione atomica e possono mancare picchi più brevi.
L’osservatore laterale è partito dopo i primi minuti e copre anche il container della review.

## Modello e quota

| Sessione               | Input cumulativo | Di cui in cache | Output | Di cui reasoning |
| ---------------------- | ---------------- | --------------- | ------ | ---------------- |
| round-1-implementation | 19,901,213       | 19,622,272      | 77,929 | 40,888           |
| round-2-implementation | 3,701,681        | 3,614,336       | 7,467  | 1,108            |
| independent-review     | 277,844          | 230,912         | 1,481  | 334              |

Sono gli ultimi contatori cumulativi di ciascun thread. L’input in cache è incluso nell’input, e il
reasoning è incluso nell’output: non si sommano una seconda volta. Non deduco prezzi da questi
contatori. Non si è verificato un blocco per quota del modello in questa prova; la gestione di una
quota esaurita non è stata esercitata.

## Errori e recuperi osservati

1. La policy nativa della shell `inherit:none` lasciava passare solo PATH/HOME/TMPDIR e ometteva i
   parametri dichiarati per Docker e Node. L’agente cercava il socket Docker predefinito
   inesistente. Si è verificato anche un comando con exit 134 prima del ripristino del profilo. Ho
   applicato nel solo job un bootstrap della shell con sei default non segreti: socket privato,
   Docker CLI, home dell’utente, tmp, heap Node e percorso browser. La prova di Docker e del tetto
   heap è registrata in
   [profile-restoration.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/profile-restoration.json>).
   Questo workaround temporaneo non è una modifica dell’adapter di produzione e non dimostra un
   avvio senza interventi tecnici.
2. Il primo build freddo dei servizi ha superato la deadline di setup della fixture, 180 secondi.
   L’agente ha poi completato la preparazione e rieseguito i controlli. Il controller prepara
   l’immagine prima degli hook. È distinto dal vecchio limite aggregato di 30 minuti.
3. I primi tentativi dell’agente includono regressioni rosse, errori di lint e una prova browser
   interrotta; tutti restano nei log. Gli esiti finali provengono dai comandi del controller, non
   dalla dichiarazione dell’agente.
4. Nel primo giro del controller, il percorso della correzione Factory ha ricevuto
   `503 SERVICE_UNAVAILABLE` — “GitHub could not verify the current head” — in **180,842 ms**. Il
   test ha poi atteso `executing` per 15 secondi. Il turno successivo e il secondo controller sono
   passati sullo stesso tree, senza una correzione del codice. La causa del rifiuto non è
   dimostrata; non lo classifico come risolto né come un timeout/OOM della macchina. Sono conservati
   screenshot, trace, risposta HTTP e campioni vicini al guasto:
   [round-1-browser-artifacts](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/round-1-browser-artifacts>),
   [browser-failure-http-evidence.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/browser-failure-http-evidence.json>),
   [browser-failure-resource-window.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/browser-failure-resource-window.json>).
   La causa interna completa del provider simulato non è stata trattenuta nei log dei servizi già
   eliminati: è un limite dell’instrumentazione attuale.
5. Nessuna decisione di prodotto è stata richiesta. Il turno iniziale è durato oltre un’ora e il
   ciclo completo oltre 30 minuti. I timeout dei singoli comandi e fixture sono rimasti; il limite
   aggregato fisso non è stato applicato.

## Cosa questi dati permettono di decidere

Questo caso prova che un agente nativo può implementare e verificare il progetto usando un daemon
DinD locale con budget espliciti. La review può leggere codice ed evidenze di esecuzione senza
tenere accesa una seconda copia dei servizi. Non serve dedurre da questo caso la necessità di un
servizio cloud di sandbox.

Le correzioni concrete da portare a un runner utilizzabile sono il passaggio esplicito e allowlisted
del profilo di esecuzione alla shell, la preparazione dei servizi separata dalla deadline delle
fixture e la raccolta dei log del provider prima della pulizia quando fallisce un controllo. La
ripetizione senza patch va esposta come retry e come intermittenza aperta, non presentata come
riparazione riuscita.

La capacità va misurata sull’intero host e sulla VM, oltre che sul singolo container. Un tetto di 3
GiB per componente ha permesso a questo task di terminare, ma sono stati osservati recuperi di
memoria e attività di swap della macchina: non è ancora un budget dinamico validato. I dati non
autorizzano ad aumentare concorrenza o limiti senza riservare memoria al sistema, al provider locale
eventuale e ai servizi del progetto.

Non sono stati provati Flutter, emulatori Android, KVM, inferenza locale, provider aziendali, MCP
numerosi, task concorrenti, arresto/crash del controller o macchine da 16 GiB. Il controllo di
pressione usato dal prototipo non è una policy adattiva generale. Non è stata esercitata la
pubblicazione, la creazione di una PR, la certificazione Factory formale o il merge; il task
originale nella UI non è stato marcato completato.

## Artefatti e stato finale

- Risultato, revisione e merge/publish flags:
  [outcome.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/outcome.json>).
- Sintesi numerica e metodologia:
  [summary.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/summary.json>);
  serie temporale esportabile:
  [resource-timeline.csv](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/resource-timeline.csv>).
- Protocollo e comandi:
  [manifest.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/manifest.json>),
  [events.jsonl](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/events.jsonl>),
  [results.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/results.json>);
  campioni principali e laterali nei rispettivi JSONL.
- Attività pubblica dei due agenti e della review, uso token e ciclo dei container: JSONL nel
  percorso della prova. I profili temporanei con credenziali e sessioni native sono stati rimossi;
  non viene pubblicato il ragionamento privato del modello.
- Implementazione conservata:
  [implementation.patch](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/implementation.patch>),
  [implementation.bundle](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/implementation.bundle>),
  archivi del sorgente e repository di controllo. La patch è rispetto alla base originale.
- Helper sperimentali nel checkout `kestrel-source-budget`, branch
  `fix/factory-runtime-observability`; nessun commit applicato al checkout operativo, nessuna PR
  creata, nessun push o merge di questa implementazione.
- Container, volumi e immagine personalizzata con owner `kestrel-dind-37956dee` rimossi; nessun
  prune globale. I processi della prova e i profili temporanei sono verificati separatamente dopo la
  pulizia. Log, bundle, repository di controllo e cache condivise dell’Engine esterno sono residui
  intenzionalmente conservati.
- Verifica della pulizia, swap finale e runtime:
  [cleanup-verification.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/cleanup-verification.json>).
  L’audit dei PID osservati trova soltanto numeri riutilizzati da processi di sistema diversi, non
  processi della prova ancora attivi:
  [owned-process-audit.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/owned-process-audit.json>).
- Il bundle Git è stato verificato con esito `0`; dimensioni e SHA-256 degli artefatti principali
  sono in
  [evidence-integrity.json](</Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/full-dind-20261004-a/evidence-integrity.json>).
- Runtime persistente distinto dalla prova: checkout `kestrel-runtime`, branch `runtime/current`,
  revisione 74c8fc5; nessun nuovo deploy o aggiornamento dello stato del task da questa prova. Il
  database persistente e il supervisore non sono stati sostituiti dal runner sperimentale.
