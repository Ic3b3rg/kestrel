# Human-in-the-loop per Factory 0.1

**Data:** 2026-09-07. Fonti circoscritte: materiale pubblico di Matt Pocock su
AI Hero e un articolo scientifico originale. Le applicazioni sotto sono
interpretazioni per la [specifica approvata](../factory-v01/spec.md), non nuovi
requisiti né condizioni per interrompere l'implementazione.

## Dal metodo didattico al comportamento del prodotto

Matt descrive il passaggio da osservare una singola esecuzione a delegare lavoro
AFK, usando problemi concreti incontrati dall'agente per migliorare issue,
istruzioni e feedback. Il suo laboratorio mantiene una sola attività per run e
combina test, typecheck e commit. È una guida pratica, non una dimostrazione
statistica di affidabilità. Per Kestrel questo sostiene Work Item piccoli,
criteri verificabili e una prova del percorso completo su repository
disposable. Il piano già approvato autorizza poi le attività ammissibili;
l'osservazione iniziale non impone presenza umana permanente.
[Running Your AFK Agent](https://www.aihero.dev/running-your-afk-agent-a9l1u).

Il materiale HITL di Matt presenta l'azione sensibile prima dell'esecuzione e
permette approvazione o feedback. Traduzione per Kestrel: mostrare una domanda
con ragione, effetto concreto e autorità coinvolta, poi registrare la decisione
prima della ripresa. La persistenza in PostgreSQL, il legame alla versione
approvata e il consumo una sola volta della decisione discendono dal contratto
Kestrel di approvazione immutabile e recupero senza doppia esecuzione: la pagina
didattica non dimostra queste garanzie. Ricaricare o chiudere
il browser non risponde al gate.
[Human-in-the-Loop Skill Building](https://www.aihero.dev/workshops/human-in-the-loop-skill-building-xlo4o).

La lezione non giustifica nuove conferme per ogni comando. La Factory ha già
definito i punti decisionali: approvazione del piano, questioni che ne cambiano
scope o limiti, selezione delle correzioni e approvazione del merge esatto.
Le normali riparazioni tecniche restano autonome entro il piano. Un gate blocca
il Project interessato; il secondo Project continua.
[Autorità e limiti Factory](../factory-v01/spec.md#implementation-decisions).

## Verifica e review

Il materiale TDD richiede test sul comportamento osservabile e valori attesi
derivati dalla specifica o da esempi indipendenti; denuncia i test che ricreano
il calcolo dell'implementazione. Applicazione: una regressione alla volta sul
confine autenticato Factory, poi il percorso reale del browser e del runtime.
Un test verde che controlla soltanto i dettagli interni non prova recupero,
ordine delle dipendenze o autorità. I confini di verifica sono già concordati
nella specifica; l'agente può procedere senza una nuova intervista.
[The /tdd Skill](https://www.aihero.dev/skills-tdd).

Matt separa conformità alla specifica e standard del repository, richiede un
riferimento Git fisso e cita la fonte di ogni rilievo. Avverte inoltre che le
conclusioni degli agenti richiedono controllo e che ripetere review e riparazioni
non garantisce convergenza. Applicazione: una review separata, legata a base/head,
con riferimenti risolvibili; gli esiti dichiarano anche lacune. Dopo la
pubblicazione decide l'Operator quali correzioni richiedere. Una nuova modifica
produce una nuova revisione e invalida la precedente approvazione di merge.
Il modello non può approvare le proprie modifiche tramite un ciclo automatico.
[The /code-review Skill](https://www.aihero.dev/skills-code-review).

## Un contributo empirico, con limiti espliciti

Buçinca, Malaya e Gajos, *To Trust or to Think* (2021), confrontano interventi
che stimolano una valutazione deliberata con semplici spiegazioni dell'AI e
una condizione senza AI, in un esperimento con 199 partecipanti. Riportano
minore eccesso di fiducia con gli interventi, accompagnato da peggiori giudizi
soggettivi per quelli più efficaci e benefici diversi secondo la motivazione
cognitiva dei partecipanti.
[Articolo originale, abstract](https://arxiv.org/abs/2102.09692).

È evidenza su decisioni assistite da AI, non una validazione di coding agent o
di Kestrel. L'inferenza utile è progettare la review perché l'Operator possa
valutare requisiti, evidenze e lacune prima del merge, evitando che una
spiegazione convincente sembri una prova. Il risultato non autorizza pause
artificiali, conferme ripetute o gate aggiuntivi: il costo di interazione va
concentrato nelle decisioni già previste. Per verificare la UI basta osservare
se l'Operator riesce a trovare l'evidenza, riconoscere una lacuna e scegliere
una correzione sulla revisione corretta; non dichiarare un miglioramento
empirico finché non è stato misurato.
