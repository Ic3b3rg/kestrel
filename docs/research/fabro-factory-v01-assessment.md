# Fabro come riferimento per Factory 0.1

**Data:** 2026-09-07. **Domanda:** Fabro riduce il lavoro necessario per la
[Factory 0.1 approvata](../factory-v01/spec.md)?

**Fonte fissata:** Fabro `main` a
[`2f326a13c4c04e5f655d8d7c35a065653a411999`](https://github.com/fabro-sh/fabro/commit/2f326a13c4c04e5f655d8d7c35a065653a411999),
commit del 2026-09-06. Ispezione circoscritta di README, documentazione pubblica,
handler dei gate e validazione dei backend; nessuna installazione o esecuzione.

**Valutazione:** conviene riprendere alcuni meccanismi, mantenendo il servizio
Factory TypeScript/PostgreSQL e Codex App Server. Fabro offre un orchestratore
con molte funzioni utili, ma l'ispezione non dimostra che introdurlo
come dipendenza riduca il lavoro di consegna. La sua adozione aggiungerebbe un
servizio e una traduzione di stato mentre resterebbero da realizzare autorità
del piano, esclusione per Project, Conceptual Review e merge vincolato alla
revisione. Questa è una valutazione architetturale, non una misura sperimentale
di tempi o affidabilità.

## Meccanismi applicabili

| Area | Fonte Fabro e applicazione a Kestrel |
| --- | --- |
| Coda durevole | L'API restituisce subito l'identità della run; una richiesta di avvio la rende eseguibile e lo scheduler usa FIFO con limite globale. La documentazione corrente assegna a SQLite eventi e proiezione, aggiornati nella stessa transazione. Riprendere accettazione persistita prima del lavoro e pubblicazione degli eventi dopo commit. Kestrel deve aggiungere il proprio claim transazionale e l'esclusione per Project: le fonti esaminate non provano questi vincoli specifici. [Ciclo server](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/reference/server-operations.mdx#L101-L165). |
| Checkpoint e recupero | Fabro salva nodo successivo, risultati, contatori dei tentativi e firme degli errori. Una ripresa di uno stage interrotto crea una nuova identità con riferimento allo stage precedente. Questo suggerisce tentativi immutabili e ripresa esplicita dei Work Item. I commit Git e il collegamento SHA sono però best effort: il checkpoint durevole resta disponibile anche se falliscono. Kestrel deve verificare codice e risultati prima di avanzare i dipendenti. [Checkpoint](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/execution/checkpoints.mdx#L56-L127). |
| Gate umani | Le domande derivano dalle uscite del nodo; il codice distingue risposta, interruzione e timeout. È utile conservare domanda, decisione e collegamento allo stage. Fabro permette anche una scelta predefinita allo scadere del tempo e `--auto-approve`. Per Kestrel un gate deve restare pendente fino alla decisione esplicita e riferirsi alla versione dell'autorità interessata. [Contratto](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/workflows/human-in-the-loop.mdx#L125-L179), [handler](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/lib/components/fabro-workflow/src/handler/human.rs#L299-L362). |
| Esecuzione indipendente dal browser | Il server ammette ed esegue le run e offre eventi alla UI; il browser può quindi essere un osservatore riconnettibile. Su laptop il README precisa che il lavoro si ferma durante lo sleep. È lo stesso limite operativo della Factory locale: servizio persistente e stato leggibile dopo reconnect, senza promessa di esecuzione a macchina spenta. [Server](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/reference/server-operations.mdx#L141-L165), [README](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/README.md#running-fabro). |
| Retry condizionali | Fabro distingue errori transitori, deterministici, budget e cancellazione; ha livelli di retry indipendenti e circuit breaker basati su firme persistite. Riprendere classificazione e limiti complessivi per evitare che un riavvio azzeri il budget. Configurare recuperi solo entro piano e durata approvati; esaurimento, permessi irrisolti e cambi di requisiti richiedono un gate. Le policy Fabro possono anche promuovere fallimenti o risultati parziali: non costituiscono evidenza di accettazione per Kestrel. [Failure policy](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/execution/failures.mdx#L8-L158), [circuit breaker](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/execution/failures.mdx#L259-L303). |
| Codex locale | I backend documentati sono `api` e `acp`; ACP delega autenticazione e strumenti al processo. La validazione respinge esplicitamente `backend="codex"`. Queste interfacce non offrono direttamente il contratto App Server scelto da [ADR 0003](../adr/0003-use-codex-app-server-for-the-subscription-route.md): servirebbe integrare un adapter o un ponte aggiuntivo, con relativo collaudo. [Backend](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/core-concepts/agents.mdx#L19-L73), [validazione](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/lib/components/fabro-validate/src/rules/backend_valid.rs#L216-L228). |

## Due grafi con responsabilità diverse

Il grafo DOT di Fabro descrive il processo da eseguire: pianificazione, scelta
umana, implementazione e transizioni. È utile come riferimento per il motore
dei Work Item. Il [Graph di Kestrel](../../CONTEXT.md) spiega invece il
comportamento della modifica e collega requisiti, Behavioral Steps, Evidence e
problemi alla coppia base/head. Un nodo “verify succeeded” può fornire un
record da ispezionare, ma non dimostra da solo che ogni requisito sia coperto.
La UI di orchestrazione non sostituisce quindi la Conceptual Review.
[Esempio Fabro](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/README.md#example-workflow).

Un altro limite concreto riguarda il workspace: Fabro documenta `local` come
privo di isolamento. I worktree partono dal `HEAD` committato e preservano i
file sporchi originali; per Kestrel resta indispensabile una policy runtime
che imponga i confini di scrittura.
[Sandbox](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/administration/sandboxing.mdx#L6-L12),
[worktree](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/docs/public/execution/checkpoints.mdx#L75-L90).

Per la consegna, questi riferimenti possono migliorare i test già previsti:
interrompere una run dopo una verifica persistita, riavviare senza eseguire due
volte lo stesso Work Item, mantenere il gate dopo reconnect e ricostruire il
budget residuo. Un checkpoint non rende idempotente una scrittura GitHub dal
risultato incerto: Kestrel deve continuare a riconciliare l'identità dell'operazione
prima di ritentare issue, PR o merge. Questa ispezione non certifica recupero
multi-processo, isolamento o pubblicazioni esterne di Fabro; sono aspetti non
eseguiti e non misurati.
[Verifiche Factory](../factory-v01/spec.md#testing-decisions).

La [licenza primaria](https://github.com/fabro-sh/fabro/blob/2f326a13c4c04e5f655d8d7c35a065653a411999/LICENSE.md)
è MIT, copyright Qlty Software Inc.; richiede di includere gli avvisi di copyright
e permesso nelle copie o porzioni sostanziali. Questa nota propone riuso di
idee; non importa codice né autorizza una migrazione.
