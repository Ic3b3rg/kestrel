# T3 Code e GitHub CLI per una Kestrel V1 local-first

**Data:** 2026-08-26

**Domanda:** Kestrel può rimandare GitHub App, VPS e cloud, girare inizialmente sull'host dell'Operator e riusare l'autenticazione già posseduta da `gh`, come T3 Code?

**Verdetto:** sì per autenticazione e inbox; non basta, da solo, per una `Review Revision`.

**Esito della decisione:** la direzione è stata accettata il 2026-08-26 e registrata in [ADR 0002](../adr/0002-make-review-first-v1-local-first.md). La issue #33 è stata rebaselined local-first; i passaggi che descrivono il suo precedente conflitto VPS/GitHub App restano come contesto storico dello studio.

## Risposta breve

L'intuizione è corretta in un senso preciso: se Kestrel gira **nativamente sulla stessa macchina e con lo stesso utente OS** che ha già eseguito `gh auth login`, può delegare a GitHub CLI le richieste autenticate e leggere anche repository privati che quell'identità può già leggere. Questo evita, nella prima versione, di creare una GitHub App Kestrel e di implementare custodia, refresh e revoca del token. È esattamente il tipo di boundary usato da T3: il server esegue `gh` sull'host e la UI mostra versione, stato e account rilevati lì ([architettura](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/internals/overview.md#L5-L28), [guida Source Control](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/user/source-control.md#L56-L80)).

Ci sono però quattro limiti decisivi:

1. `gh` non aggira le policy aziendali. Il suo login web usa un'app OAuth GitHub; organizzazioni con restrizioni OAuth o SSO possono richiedere approvazione e autorizzazione SSO. Funziona quando **quel preciso login `gh`** ha già accesso, non per il solo fatto che l'utente vede il repository nel browser.
2. T3 mette in cache metadati di pull request e stato UI; non conserva un clone o uno snapshot Git verificato. La cache osservata non equivale alla `Review Revision` immutabile richiesta da Kestrel.
3. Un container locale o una VPS non vede automaticamente il `gh`, il Keychain e il profilo del laptop. “Locale nativo”, “Docker Compose locale” e “self-hosted su VPS” sono tre boundary diversi.
4. Al momento dello studio, il contratto normativo [#33](https://github.com/Ic3b3rg/kestrel/issues/33) prescriveva Docker Compose su Ubuntu VPS, GitHub App e assenza di fallback a user token, dichiarando il macOS locale fuori scope. Il necessario rebaseline è ora completato da [ADR 0002](../adr/0002-make-review-first-v1-local-first.md) e dalla nuova #33.

La raccomandazione è una V1 reversibile: **certificare prima Kestrel nativo sull'host dell'Operator, mantenere il percorso pubblico senza credenziali di #89 come `Provider Observation`, consegnare ogni review da `Local Repository Source`, e usare l'host `gh` soltanto per inbox e metadati privati.** Niente `Repository Provider Connection`, cache persistente sofisticata, webhook o GitHub App finché non servono. La review deve restare bloccata finché Kestrel non possiede e verifica gli exact base/head commit della `Review Revision`.

Questa nota riguarda il source control. Il boundary analogo per runtime e modelli resta fuori dal suo perimetro e non viene ripetuto qui.

## Fonti fissate

- T3 Code `main` ispezionato a [`a3a8cbd60539b4af4de8f96c892dbd07a2b6c041`](https://github.com/pingdotgg/t3code/commit/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041), del 2026-08-26.
- PR T3 [#8160](https://github.com/pingdotgg/t3code/pull/8160): `MERGED` il 2026-08-25; base tip (`baseRefOid`) `c034f51bb727de3d4888c74497b13e878ee65187`, head [`5284bbd90d3e835fa5dcf75ebcd5314ab95f0fa3`](https://github.com/pingdotgg/t3code/commit/5284bbd90d3e835fa5dcf75ebcd5314ab95f0fa3), squash merge [`3c75eb1132bb5d67cfa95ac6271ef68959f986c1`](https://github.com/pingdotgg/t3code/commit/3c75eb1132bb5d67cfa95ac6271ef68959f986c1).
- Kestrel: [`CONTEXT.md`](../../CONTEXT.md), [ADR 0001](../adr/0001-support-provider-backed-and-local-change-proposals.md), issue normativa [#33](https://github.com/Ic3b3rg/kestrel/issues/33), issue [#89](https://github.com/Ic3b3rg/kestrel/issues/89) e [#90](https://github.com/Ic3b3rg/kestrel/issues/90).
- GitHub: solo manuale ufficiale GitHub CLI e documentazione ufficiale GitHub API/policy, collegati vicino alle conclusioni.

## Che cosa fa davvero T3

### Boundary e autenticazione

T3 ha un solo execution boundary: il server possiede progetti, Git, filesystem, terminali e autenticazione dei provider; web, desktop e mobile sono client RPC. Anche in remoto, il login appartiene alla macchina che esegue il server, non al browser che lo controlla ([overview, righe 5-28](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/internals/overview.md#L5-L28), [remote, righe 10-49](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/internals/remote.md#L10-L49)). La guida richiede `gh >= 2.81.0`, `gh auth login` **sulla macchina del server** e un Rescan dopo il cambio credenziali ([setup GitHub](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/user/source-control.md#L68-L80), [setup server e troubleshooting](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/user/source-control.md#L134-L145)).

La discovery GitHub esegue due comandi:

```text
gh --version
gh auth status --json hosts
```

La specifica è nel [`GitHubSourceControlProvider`](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/sourceControl/GitHubSourceControlProvider.ts#L45-L105). Il parser considera autenticato un account con `state === "success"`, preferisce quello autenticato e `active`, poi il primo autenticato; normalizza host e login ([parser](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/sourceControl/gitHubAuthStatus.ts#L38-L71)). **Non analizza né mostra gli scope o `tokenSource`**, benché siano presenti nell'output corrente di `gh`; la UI mostra versione, “Authenticated” e account, con account oscurato fino alla richiesta dell'utente ([UI](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/settings/SourceControlSettings.tsx#L139-L168), [riga account/versione](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/settings/SourceControlSettings.tsx#L198-L320)). Il Rescan rifà la query verso l'environment selezionato ([pannello](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/settings/SourceControlSettings.tsx#L495-L586)).

Nel probe locale del 2026-08-26, con login e token omessi, `gh 2.86.0` ha riferito `tokenSource: keyring` e scope `admin:public_key`, `gist`, `read:org`, `repo`. È un'osservazione della macchina, non una proprietà universale di `gh`, ma rende concreto il limite: T3 mostra “Authenticated” senza mostrare che la credenziale effettiva è molto più ampia della sola lettura.

I probe hanno timeout di 5 secondi e output massimo di 8 KB; le normali chiamate `gh` hanno timeout predefinito di 30 secondi e output limitato ([discovery process](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/sourceControl/SourceControlProviderDiscovery.ts#L168-L276), [`VcsProcess`](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/vcs/VcsProcess.ts#L102-L187), [`GitHubCli.execute`](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/sourceControl/GitHubCli.ts#L326-L340)). Quando non viene passato un environment dedicato, il processo usa quello del server: quindi `PATH`, `HOME`/config, Keychain e variabili `GH_*` disponibili al processo determinano credenziali e host. La documentazione GitHub conferma che `GH_TOKEN`/`GITHUB_TOKEN` prevalgono sulle credenziali memorizzate, mentre `GH_HOST`, `GH_REPO` e `GH_CONFIG_DIR` cambiano risoluzione e configurazione ([environment di `gh`](https://cli.github.com/manual/gh_help_environment)).

Questo pattern evita che T3 implementi OAuth, ma non crea una sandbox read-only: T3 offre anche clone, publish, creazione e mutazioni di PR ([guida, righe 68-80](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/user/source-control.md#L68-L80), [azioni write nel provider](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/GitHubPullRequestCli.ts#L1675-L1755)). Copiarne l'intero sottosistema allargherebbe inutilmente l'autorità di Review First V1.

### Discovery delle PR: “dei progetti”, non dell'intero account

La pagina PR non interroga tutte le repository visibili all'account. `PullRequestService.listWorkspaceProjects` parte dallo snapshot dei **Project T3 già registrati**, ricava repository e host dalla `repositoryIdentity`/remote locale, elimina i worktree duplicati della stessa repository e mantiene distinti host diversi ([servizio](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L551-L618)). Solo quelle repository vengono interrogate. Questo corrisponde a “le PR dei miei progetti”, non a “tutte le mie PR GitHub”.

Per GitHub il provider:

- risolve il viewer con `gh api user --jq .login` e lo conserva per host; le PR usano `gh pr list --repo HOST/OWNER/REPO ... --json ...`, oppure una query GraphQL unica per più repository sullo stesso host ([comandi](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/GitHubPullRequestCli.ts#L1159-L1289));
- per `authored` aggiunge `--author <viewer>`; per `reviewing` aggiunge `review-requested:<viewer>`; la ricerca è `sort:updated-desc` ([filtri](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/GitHubPullRequestCli.ts#L682-L793));
- pagina per repository, raggruppa le letture per host quando il provider supporta search, degrada una repository guasta senza cancellare tutta la pagina e ordina il risultato aggregato per `updatedAt` ([orchestrazione](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L812-L905), [batch/pagination](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L907-L1120)).

Nella vista `All` la UI fa **tre letture**: feed, `authored`, `reviewing`. Le due letture personali servono a non perdere una PR personale più vecchia della prima pagina del feed ([route](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/routes/_chat.pull-requests.tsx#L638-L698)). Non è un semplice sort “mie per prime”: crea gruppi completi in ordine **Review requested → Authored → Others**, ordina i primi due per recenza, e se una PR è sia authored sia review-requested la assegna ad Authored per evitare duplicati ([grouping](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/pullRequest/pullRequestList.logic.ts#L367-L410)).

Una cautela da non copiare: il codice corrente passa sempre host esplicito a `--repo` e alle query GraphQL, ma il lookup del viewer usa `gh api user` senza `--hostname` ([host esplicito](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/GitHubPullRequestCli.ts#L894-L920), [viewer](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/GitHubPullRequestCli.ts#L1159-L1168)). Poiché il manuale `gh api` dichiara `github.com` come host predefinito, la correttezza multi-host/GHES di quel preciso lookup non è dimostrata. Kestrel dovrebbe usare sempre `gh api --hostname <host> user` e verificare account/host prima di ogni sincronizzazione sensibile.

## La PR #8160 e la cache: che cosa è stato davvero aggiunto

La [PR #8160](https://github.com/pingdotgg/t3code/pull/8160) è mergiata, ma **non introduce autenticazione, discovery PR, priorità o cache**. Queste superfici erano già presenti; per esempio le costanti principali della cache risalgono al commit [`cad2c93616a7c25110670c151a816d5c68341bd4`](https://github.com/pingdotgg/t3code/commit/cad2c93616a7c25110670c151a816d5c68341bd4), PR #4849.

#8160 aggiunge invece un legame persistente PR ↔ thread:

- `ThreadLinkedPullRequest` contiene soltanto `projectId`, `repository`, `number`, `url` ([schema](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/packages/contracts/src/orchestration.ts#L390-L410));
- il link viene serializzato nella colonna SQLite `linked_pull_request_json` ([migrazione](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/persistence/Migrations/042_ProjectionThreadLinkedPullRequest.ts#L1-L16), [persistenza](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/persistence/Layers/ProjectionThreads.ts#L19-L101));
- il menu contestuale collega o scollega un URL già riconducibile a un Project dell'environment ([UI](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/ChatMarkdown.tsx#L1745-L1792), [menu](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/ChatMarkdown.tsx#L2040-L2085));
- mentre il thread è visibile, il dettaglio live ha stale time 15 secondi e refresh ogni 30 secondi; il merge può quindi aggiornare/settle il thread ([atom](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/packages/client-runtime/src/state/pullRequests.ts#L29-L53), [guida thread](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/user/thread-sidebar.md#L7-L19)).

Il record persistito è quindi un **riferimento** alla PR. Titolo, stato, diff e codice vengono riletti dal provider; non sono contenuti nel record #8160.

### Inventario esatto della cache T3

| Livello | Storage e scope | TTL / refresh | Contenuto reale |
| --- | --- | --- | --- |
| Provider detection | Memoria del processo server, chiave `cwd` | 5 s; solo successi | Provider derivato dai remote locali ([registry](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/sourceControl/SourceControlProviderRegistry.ts#L28-L29), [cache](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/sourceControl/SourceControlProviderRegistry.ts#L248-L265)) |
| Viewer | Memoria del server, chiave host | 10 min; solo successi, failure non trattenuta; refresh globale la svuota | Login attivo per host ([codice](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L682-L735)) |
| Lista | Memoria del server | 30 s; failure TTL zero | Chiave: epoch, state, involvement, filtri posizionali, Project/Project list, host, limit, query, cursori ordinati ([chiave](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L1884-L1959)) |
| Detail / activity | Memoria del server, scope `Project + repository + PR` | 15 s; failure TTL zero | Metadati/detail e attività live ([cache](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L1961-L1989)) |
| Diff / stats | Memoria del server | diff PR 60 s; diff di un commit 10 min; stats 60 s; stale-diff window 10 min | Patch/file content richiesti e conteggi, non un repository ([costanti](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L89-L113), [chiavi](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L1991-L2057)) |
| Client queries | Memoria Atom per `environmentId + input` | list 30 s, detail/activity 15 s, diff/stats 60 s; idle TTL predefinito 5 min; linked detail refresh 30 s | Risposte RPC correnti ([query PR](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/packages/client-runtime/src/state/pullRequests.ts#L55-L120), [SWR](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/packages/client-runtime/src/state/runtime.ts#L481-L557)) |
| Snapshot browser | `localStorage`, chiave `t3.pullRequests.list:<environmentIds ordinati>` | **Nessun TTL**; render stale immediato, poi riconcilia col live | Fino a 99 righe feed e 99 per ciascuna partizione authored/reviewing; scarta errori, cursori e flag di troncamento ([schema/chiave](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/pullRequest/pullRequestList.logic.ts#L524-L591), [read/write](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/components/pullRequest/pullRequestList.logic.ts#L593-L647)) |
| Link #8160 | SQLite projection server | Persistente, senza TTL | Solo identità del link PR ↔ thread; il detail resta live |

L'invalidazione server usa epoch: refresh globale incrementa l'epoch delle liste e svuota i viewer; refresh di una PR incrementa il suo epoch; una mutazione invalida sia reference sia liste ([invalidazione](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L1848-L1865), [refresh/mutazioni](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/PullRequestService.ts#L2059-L2107)). La UI forza prima l'invalidazione server e poi rilegge feed, partizioni, stats e detail ([route](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/web/src/routes/_chat.pull-requests.tsx#L699-L727)). In caso offline, lo snapshot browser può mostrare righe vecchie, ma non è una fonte autorevole.

Non è stato trovato alcun uso di `gh api --cache`: il flag esiste nel [manuale ufficiale](https://cli.github.com/manual/gh_api), ma la cache qui è applicativa. Lo snapshot browser è per origin e set di environment, **non è esplicitamente chiavato per account GitHub**. Un cambio account può quindi lasciare per breve tempo una vista stale fino alla riconciliazione live.

Anche la cache server non include l'account nella chiave: il viewer è chiavato solo per host e la lista per host/Project/query/filtri. Dopo `gh auth switch`, un risultato dell'account precedente può quindi sopravvivere fino a invalidazione o TTL. L'assunzione T3 è coerente con un environment personale, ma Kestrel deve includere Project, route di `Provider Observation`, host e account osservato nella propria chiave.

## Perché questa non è una Review Revision

Il contratto Kestrel definisce una `Review Revision` come exact base/head commit pair più snapshot verificato e trattenuto ([`CONTEXT.md`](../../CONTEXT.md)). T3 non soddisfa questo contratto:

- la lista e il dettaglio T3 chiedono branch name e metadati, ma i campi JSON selezionati **omettono** `baseRefOid` e `headRefOid` ([campi](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/gitHubPullRequestJson.ts#L599-L603)); il manuale ufficiale conferma che `gh pr list --json` potrebbe restituirli, ma T3 non li chiede ([`gh pr list`](https://cli.github.com/manual/gh_pr_list));
- quando apre il contenuto di un file diff, T3 legge al momento `.base.sha` e `.head.sha`, poi scarica i due file via Contents API ([codice](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/apps/server/src/pullRequest/GitHubPullRequestCli.ts#L1069-L1157));
- nessuna delle cache sopra conserva l'object closure Git, un clone/worktree dedicato o uno snapshot immutabile. I Project T3 puntano a workspace locali già esistenti; la cache PR conserva risposte, non sorgente.

Inoltre GitHub avverte che `merge_commit_sha` prima del merge può essere un merge commit sintetico di test, non base o head ([REST Pull Requests](https://docs.github.com/en/rest/pulls/pulls)). Kestrel deve acquisire gli exact `base.sha`/`head.sha`, verificarne oggetti e integrità e trattenere lo snapshot prima di autorizzare una review. Copiare l'inbox di T3 senza questo gate produrrebbe solo un `Change Proposal` osservato senza `Review Revision`; la sorgente resterebbe non acquisita (`sourceAvailability: not_acquired`).

## Repository private aziendali, GHES, SSO e policy

### Che cosa funziona

Se, sullo stesso host e con lo stesso utente OS di Kestrel, questi comandi funzionano senza prompt:

```text
gh api --hostname <host> user --jq .login
gh api --hostname <host> repos/<owner>/<repo>/pulls/<number>
```

allora un adapter Kestrel a comandi fissi può leggere quella PR senza installare una GitHub App Kestrel. L'autorità resta quella dell'account `gh`: la CLI supporta `github.com`, host Enterprise e account multipli per host ([GitHub CLI Enterprise](https://cli.github.com/manual/index), [account/host attivo](https://cli.github.com/manual/gh_auth_status), [switch account](https://cli.github.com/manual/gh_auth_switch)). Questo è il vantaggio reale nel caso aziendale: molte aziende consentono già l'uso della CLI ufficiale mentre rifiutano l'installazione di una nuova GitHub App.

Nel modello Kestrel questa non è una `Local Repository Source`: è una `Provider Observation` esplicita, associata a Project, host, account osservato e capability disponibili, ma priva di token raw o autorità persistente. La `Local Repository Source` resta l'unico `Repository Access` autorevole per il codice; un account attivo diverso deve produrre `Needs authentication`, non retargeting silenzioso.

### Che cosa non è garantito

- `gh auth login` usa per default un web flow e conserva il token nel credential store, ma può ripiegare su file in chiaro; con `--with-token`, il PAT classico richiede almeno `repo`, `read:org`, `gist` ([manuale](https://cli.github.com/manual/gh_auth_login)). Lo scope OAuth `repo` concede pieno read/write sui repository pubblici e privati, non read-only ([scope ufficiali](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)). Riutilizzare `gh` elimina il lifecycle credenziale **gestito da Kestrel**, non rende la credenziale least-privilege.
- Le organizzazioni possono bloccare app OAuth non approvate ([restrizioni OAuth](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions)); con SSO bisogna avere una sessione attiva e autorizzare l'app per l'organizzazione ([SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-an-app-for-single-sign-on)). Il fatto che una nuova GitHub App Kestrel sia vietata non prova che GitHub CLI sia consentita, e viceversa.
- `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` o un `gh auth switch` possono cambiare l'identità effettiva. Host e account devono essere verificati a ogni operazione che osserva o acquisisce una revisione; non basta ricordare il risultato della schermata Settings.
- Le richieste condividono il rate budget personale. GitHub documenta in genere 5.000 richieste REST/ora per utente autenticato, oltre a secondary rate limit ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Cache breve, backoff e refresh manuale restano necessari.
- Il binario `gh` espone anche comandi write e perfino `gh auth token`. Un allowlist nel codice dà read-only **per comportamento**; solo un processo helper isolato con API stretta può avvicinarsi a un boundary di autorità. Non usare mai `--show-token`, `gh auth token` o `--verbose`.

## Tre deployment, tre risultati diversi

| Deployment | Riuso del login del laptop | Valutazione V1 |
| --- | --- | --- |
| Kestrel nativo sull'host | Sì, se stesso utente OS, `PATH`, config e Keychain | Percorso più semplice. Read-only per API/argv allowlist, non per hard isolation della credenziale. |
| Docker Compose locale | No, non automaticamente. Il container non vede binario, Keychain e config host | Non montare tutta `$HOME`, `.config/gh`, Keychain, SSH agent o Docker socket. Preferire helper host-side su Unix socket con metodi fissi, oppure rimandare Compose e certificare il native host. |
| VPS/self-hosted remoto | Usa il login **della VPS**, non quello del laptop/browser | Richiede `gh auth login`/secret lifecycle sul server. È ancora self-hosted, ma non è la semplificazione “usa ciò che ho già sul workstation”. |
| Futuro servizio cloud/multiutente | Non può ereditare credenziali arbitrarie dei client | Richiederà un vero broker/connection lifecycle; fuori dalla V1 proposta. |

T3 conferma il principio: l'environment remoto possiede auth e filesystem; il client hosted conserva solo il riferimento e si collega al server, senza fare da proxy credenziale ([remote](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/docs/internals/remote.md#L35-L49)). Un helper host-side Kestrel dovrebbe accettare strutture tipo `probe(host)`, `getPullRequest(host, owner, repo, number)` e, separatamente, primitive di acquisizione esatte; mai una stringa shell o argv arbitrari.

## Impatto sulle decisioni Kestrel

### Cosa resta valido

- [ADR 0002](../adr/0002-make-review-first-v1-local-first.md) risolve il modello: `Local Repository Source` è l'unico `Repository Access` autorevole della V1; GitHub pubblico e host `gh` sono `Provider Observation` esplicite che alimentano la stessa `Review Revision`/`Conceptual Review` contract.
- [#89](https://github.com/Ic3b3rg/kestrel/issues/89) va mantenuta intatta: URL pubblico canonico, nessuna auth, target API fisso, fallimento chiuso e refresh manuale. L'implementazione locale ispezionata a `7f38d88618e34e16c10f00a32541513b3bea29b2` valida `private: false`, base/head SHA a 40 caratteri, redirect manuale, body massimo 1 MiB e timeout 10 secondi in `apps/web/src/public-github.ts`; persiste però `sourceAvailability: "not_acquired"`. È correttamente un `Change Proposal` osservato, non ancora una `Review Revision`.
- [#90](https://github.com/Ic3b3rg/kestrel/issues/90) resta il percorso più corto per una review reale locale: `Local Repository Source` sotto root esplicite, exact committed base/head già presenti, nessun fetch/hook/credential/write. È particolarmente adatto alle policy aziendali che consentono un clone locale ma nessuna app provider.

### Conflitto normativo da risolvere

> Risolto il 2026-08-26: #33 ora adotta il contratto local-first descritto in ADR 0002. I requisiti elencati sotto documentano il contratto precedente.

All'inizio dello studio, la issue [#33](https://github.com/Ic3b3rg/kestrel/issues/33) era il contratto di implementazione e richiedeva:

- release Docker Compose certificata su Ubuntu Server 26.04 VPS x86-64;
- GitHub App customer-controlled, provider broker read-only, webhook e sincronizzazione;
- nessun anonymous/user-token fallback nel contratto GitHub;
- PWA online-only senza API response o dati applicativi in cache offline;
- `certified local macOS mode` fuori scope;
- “No product decision remains open”.

Ne seguiva che:

- **local-only/local-first non significa self-hosted VPS**;
- riusare `gh` come user-token connection e copiare il `localStorage` PR snapshot di T3 avrebbe violato la precedente #33;
- scegliere native-local-first richiedeva di aggiornare esplicitamente #33 e le sue release gate, non una modifica implementativa nascosta;
- l'ADR 0001 andava specializzato per chiarire se un Project provider-backed potesse acquisire exact commits da un `Local Repository Source` associato. ADR 0002 e `CONTEXT.md` hanno ora risolto questa ambiguità.

## Raccomandazione V1 semplice e reversibile

### Decisione accettata

Adottare **local-first, non cloud-first**, con un solo Operator e un solo host nativo certificato inizialmente. Usare un solo percorso di sorgente autorevole, affiancato da `Provider Observation` opzionali e visibili:

1. `local_repository` di #90 per ottenere `Review Revision` di repository pubblici o privati già clonati;
2. `public_github` di #89 come osservazione per open source senza credenziali;
3. aggiungere dopo il primo end-to-end una `Provider Observation` host `gh` per inbox/metadati privati e refresh manuale.

Il primo risultato utile al lavoro non richiede la GitHub App: l'Operator registra il clone aziendale, seleziona exact base/head e avvia la review. `gh` migliora poi il flusso scegliendo la PR e precompilando metadati, ma non diventa il custode dello snapshot.

### Tracer bullet minimo

1. **Rebaseline — completato il 2026-08-26:** #33 dichiara native-local come target iniziale, `Provider Observation` tramite host `gh` e cache PR solo in memoria. GitHub App/VPS restano percorso futuro.
2. **Probe read-only:** risolvere un executable `gh` esplicito; richiedere una versione minima; eseguire `gh auth status --active --hostname <host> --json hosts` e `gh api --hostname <host> user --jq .login`; registrare host, account, versione, capability e tempo del probe, mai token. Nessun account scelto implicitamente da “primo trovato”.
3. **Una PR, non un inbox universale:** da URL canonico o da un Project già registrato, eseguire un GET API fisso con host esplicito e output JSON validato; produrre lo stesso contratto provider-neutral Project/`Change Proposal` di #89. Se la `Provider Observation` scelta è pubblica, non provare `gh` come fallback; se usa host `gh`, non degradare ad anonymous.
4. **Acquisizione separata:** prima della review, richiedere che exact base/head esistano in una `Local Repository Source` autorizzata e verificata, oppure implementare in un ticket separato un fetch in quarantena a comandi fissi. La prima opzione è il percorso V1 deciso: ADR 0002 e `CONTEXT.md` associano metadati provider opzionali e sorgente locale allo stesso `Change Proposal`. Finché il gate locale non è completato, la PR resta `sourceAvailability: not_acquired`.
5. **Inbox solo dopo:** limitare la discovery alle repository dei Project, come T3. Fare feed + `authored` + `review-requested`, prima pagina e refresh manuale. Cache server in-memory 30 secondi, failure non cachate; niente snapshot `localStorage`, webhook, background polling o PR write nella V1.

Questo è un tracer verticale: una PR privata già accessibile via `gh`, un clone locale già autorizzato, una exact `Review Revision`, una `Conceptual Review`. GitLab, GHES certificato, account multipli sullo stesso host, VPS, GitHub App e sincronizzazione automatica restano estensioni dietro lo stesso port.

### Go / no-go

**Go** soltanto se:

- i probe e la lettura PR funzionano non-interattivamente sotto lo stesso utente OS del processo Kestrel;
- host e account corrispondono alla `Provider Observation` richiesta, SSO/OAuth policy consentono l'accesso e ogni drift fallisce chiuso;
- nessun log, errore, argv, audit o telemetria espone token/header sensibili;
- subprocess hanno argv allowlist, nessuna shell, JSON schema, max output, timeout, cancellazione con teardown dei discendenti e backoff sui rate limit;
- exact base/head vengono acquisiti, verificati e trattenuti prima della review;
- test negativi dimostrano zero provider write e zero modifica del clone dell'Operator;
- #33 mantiene il rebaseline local-first.

**No-go** se servono mount indiscriminati di home/Keychain/agent nel container, l'account attivo non è deterministico, la policy aziendale blocca GitHub CLI, la review partirebbe da soli metadati/cache, o la promessa “read-only” dipendesse soltanto dal fatto che il prodotto non espone ancora un pulsante write.

## Rischi da portare nel ticket, senza costruire un framework

| Rischio | Contromisura V1 |
| --- | --- |
| Versione/output `gh` cambia | Minimum version; usare solo `--json`/`--jq` o `gh api` con API version/header fisso; schema strict e fail closed; mai parsare output umano. |
| Subprocess bloccato o enorme | No shell; args composti dal codice; timeout e cancellation; limiti stdout/stderr; stdin per payload; kill process group/figli. |
| Token nei log | Vietare `--show-token`, `auth token`, `--verbose`; non loggare environment completo, stdin o stderr non redatto; test con canary secret. |
| Credenziale più ampia della feature | Dichiarare “read-only by behavior”, non “least-privilege credential”; helper host-side a metodi fissi; niente import del sottosistema write T3. |
| Env/account drift | Host sempre esplicito; account registrato e riconvalidato; gestire `GH_TOKEN` precedence; nessun fallback o switch automatico. |
| Rate limit condiviso | Cache breve in-memory, coalescing, refresh manuale, header quota/backoff; fallimento visibile. |
| SSO/OAuth revocato | Probe reale sulla repository, non solo `auth status`; `Needs authentication`; nessun 404 interpretato automaticamente come “inesistente”. |
| Boundary container/VPS | Native host iniziale o helper Unix isolato; mai mount di tutta home/Keychain/SSH agent/Docker socket. |
| Cache stale o cross-account | Key includa connection/host/account/Project/query; failure TTL zero; invalidazione manuale; niente browser persistence V1. |
| SHA osservato ma sorgente mancante | Stato separato; acquisizione quarantinata; verifica object type/closure/hash; nessuna review finché `Revision State != Available`. |
| Fork/private head | Acquisire attraverso l'autorità della base repository come già richiesto da #33; non assumere accesso diretto al fork. |

## Ledger delle conclusioni

| ID | Conclusione | Classificazione |
| --- | --- | --- |
| F-01 | T3 esegue `gh` sul server/environment e usa l'autenticazione presente lì | Fatto da sorgente |
| F-02 | Settings prova versione e `gh auth status --json hosts`, mostra stato/account, ma non valuta scope | Fatto da sorgente |
| F-03 | La lista PR parte dai Project/workspace T3 registrati e dai loro remote, non da tutte le repo dell'account | Fatto da sorgente |
| F-04 | “Mine first” è una tripla lettura e gruppi Review requested/Authored/Others, non un semplice sort | Fatto da sorgente |
| F-05 | Cache T3: server/client in-memory a TTL breve più snapshot `localStorage` senza TTL; failure server non cachate | Fatto da sorgente |
| F-06 | #8160 è mergiata e persiste soltanto un link PR ↔ thread; auth, discovery e cache preesistevano | Fatto da sorgente/cronologia Git |
| F-07 | T3 non conserva una `Review Revision`; perfino lista/detail omettono gli exact OID e il file content è letto live | Fatto da sorgente |
| F-08 | GitHub CLI può usare GitHub.com/GHES/account multipli, ma OAuth restrictions e SSO continuano ad applicarsi | Fatto da documentazione GitHub |
| E-01 | Il probe locale ha trovato credenziale in keyring con scope anche write-capable; T3 non li mostra | Osservazione locale riproducibile, non generalizzabile |
| I-01 | Se il comando `gh api` funziona sotto l'utente Kestrel sulla repo aziendale, Kestrel può leggere la stessa repo senza una propria GitHub App | Inferenza verificabile |
| I-02 | Riusare `gh` riduce credential lifecycle, ma non dà least privilege né isolamento dal token a un processo compromesso sullo stesso host | Inferenza di sicurezza supportata |
| R-01 | Certificare native-local + #89 + #90 prima; aggiungere host `gh` come `Provider Observation` esplicita e manuale | Raccomandazione accettata |
| R-02 | Rimandare cache persistente, webhook, GitHub App, VPS/cloud, provider write e discovery account-wide | Raccomandazione |
| N-01 | Che una specifica azienda consenta GitHub CLI OAuth/SSO e AI locale per una specifica repository | Non dimostrato; serve probe/policy reale |
| N-02 | Che l'attuale lookup viewer T3 senza `--hostname` sia corretto per ogni GHES/multi-host | Non dimostrato |
| D-01 | Un `Change Proposal` può avere metadati da `Provider Observation` e deve acquisire ogni `Review Revision` dalla `Local Repository Source` dello stesso Project | Decisione registrata in ADR 0002 |

## Riproduzione essenziale

```bash
git clone https://github.com/pingdotgg/t3code.git
git -C t3code checkout a3a8cbd60539b4af4de8f96c892dbd07a2b6c041

# Stato e portata della PR #8160
gh pr view 8160 --repo pingdotgg/t3code \
  --json state,headRefOid,baseRefOid,mergeCommit,mergedAt,files
git -C t3code diff --name-status \
  c034f51bb727de3d4888c74497b13e878ee65187 \
  5284bbd90d3e835fa5dcf75ebcd5314ab95f0fa3

# Discovery, PR scope e cache
rg -n "auth status|listWorkspaceProjects|LIST_CACHE_TTL|VIEWER_CACHE_TTL" \
  t3code/apps/server/src
rg -n "partitionPullRequestsWithPriority|t3.pullRequests.list" \
  t3code/apps/web/src
git -C t3code blame -L 89,113 -- \
  apps/server/src/pullRequest/PullRequestService.ts

# Probe sicuro su un host autorizzato: non aggiungere mai --show-token
gh --version
gh auth status --active --hostname github.com --json hosts
gh api --hostname github.com user --jq .login

# Su una repository di test autorizzata; non incollare output privato nei log
gh api --hostname github.com \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  repos/OWNER/REPO/pulls/NUMBER \
  --jq '{number,base:{ref:.base.ref,sha:.base.sha},head:{ref:.head.ref,sha:.head.sha}}'
```

Il codice T3 è MIT ([licenza al commit ispezionato](https://github.com/pingdotgg/t3code/blob/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041/LICENSE#L1-L13)); eventuale copia sostanziale deve conservarne notice e permesso. Per Kestrel conviene riusare l'idea e l'interfaccia minima, non importare un sottosistema progettato anche per scrivere sul provider.
