# Contratto Codex locale per Factory

**Ispezione:** 2026-09-07, `codex-cli 0.153.4`; `codex --help`,
`codex app-server --help` e schema pubblico già generato in
`/tmp/kestrel-factory-codex-schema`. Nessuna inferenza, thread avviato, lettura di
config/auth personali o modifica dell'host. I riscontri sorgente usano il tag
ufficiale `rust-v0.153.4`.

## Sandbox e risultato

`thread/start` accetta `cwd`, `sandbox: "read-only" | "workspace-write"`,
`approvalPolicy: "never"`, `approvalsReviewer: "user"` e override `config`.
Avviare thread distinti per pianificazione ed esecuzione. Nel secondo, impostare
`config.sandbox_workspace_write` con `writable_roots: []`, `network_access: false`,
`exclude_tmpdir_env_var: true`, `exclude_slash_tmp: true`: il workspace primario
è il `cwd` Kestrel. Controllare la risposta **prima** dell'inferenza: `cwd`
esatto, policy di approvazione, reviewer e `sandbox` normalizzata; rifiutare
scritture, rete o radici ulteriori non autorizzate.
[Schema richiesta](/tmp/kestrel-factory-codex-schema/v2/ThreadStartParams.json),
[risposta](/tmp/kestrel-factory-codex-schema/v2/ThreadStartResponse.json),
[config versione installata](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/config.schema.json).

`turn/start` richiede `threadId` e `input: [{type:"text",text:"..."}]`. Ripetere
la policy esatta mediante `sandboxPolicy`:

```json
{"type":"readOnly","networkAccess":false}
```

```json
{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,
 "excludeTmpdirEnvVar":true,"excludeSlashTmp":true}
```

La risposta del turno contiene `turn`, senza eco della policy: non può
certificare una successiva espansione dei permessi. Il risultato di
`thread/start` è una dichiarazione di configurazione, non una prova OS.
Lo schema stabile locale non espone `access`/`readOnlyAccess`, presenti invece
nella documentazione live: non inviarli presumendo che siano applicati.
Read-only non significa letture limitate al repository né invisibilità delle
credenziali sul filesystem.
[Schema turno](/tmp/kestrel-factory-codex-schema/v2/TurnStartParams.json),
[documentazione live](https://learn.chatgpt.com/docs/app-server#sandbox-read-access-readonlyaccess).

Passare `outputSchema` a ogni turno che deve produrre piano/review. Accettare
solo un turno `completed`, raccogliere gli `agentMessage` completati e validare
nuovamente JSON, schema e riferimenti di evidenza. `phase="final_answer"`
identifica il finale; `phase=null` significa sconosciuta, quindi serve una
regola esplicita per i modelli legacy. I delta non autorizzano pubblicazione.
[Schema notifiche](/tmp/kestrel-factory-codex-schema/v2/TurnCompletedNotification.json),
[output strutturato](https://learn.chatgpt.com/docs/app-server#start-a-turn).

### Riscontro live dello schema del piano, #212

Il 2026-09-07 sono state eseguite inferenze su fixture temporanee con `0.153.4`
e il modello di catalogo `gpt-6-astra`. Lo schema minimo `{ok:string}` completa
in circa quattro secondi. Lo schema completo del piano con il pattern NUL
`^[^\0]*$` riproduce invece l'interruzione dello stream (`responseStreamDisconnected`)
e non completa entro il limite della prova. Cambiando soltanto le due occorrenze
in `^[^\x00]*$`, lo stesso piano viene prodotto e validato in circa otto secondi.
È un riscontro di compatibilità del decoder, non una rimozione del controllo:
il parser continua a rifiutare byte NUL, schemi invalidi e grafi non validi.
La verifica HTTP ripete chat, generazione, persistenza e approvazione;
`factory-plan.test.ts` copre gli argomenti esatti e il rifiuto dei NUL.

La documentazione descrive il sottoinsieme JSON Schema e il supporto di `pattern`,
ma non promette compatibilità con ogni escape accettato da JavaScript. Il caso
sopra è stato quindi verificato sul percorso App Server effettivamente usato.
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas).

## Override di processo e limite MCP

Base supportata, **insufficiente da sola per eliminare MCP configurati**:

```sh
codex app-server --listen stdio:// --strict-config \
  --disable apps --disable plugins --disable hooks \
  --disable browser_use --disable browser_use_external \
  -c 'web_search="disabled"' -c 'allow_login_shell=false'
```

Sono override del processo: lasciare `CODEX_HOME` e custodia del login a Codex.
Apps opera fuori dal controllo di rete dei comandi sandboxati; disabilitarlo
esplicitamente. I flag canonici `apps`, `plugins`, `hooks` sono presenti nel
registro della versione installata.
[Flag](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/features/src/lib.rs),
[riferimento configurazione](https://learn.chatgpt.com/docs/config-file/config-reference).

Per ogni server MCP effettivo occorre `-c 'mcp_servers.ID.enabled=false'`.
**`-c 'mcp_servers={}'` non cancella le voci ereditate**: gli override diventano
un layer e le tabelle sono unite ricorsivamente. Anche `apps._default.enabled=false`
ammette override specifici; preferire il flag globale Apps.
[Merge](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/merge.rs#L95-L133),
[layer CLI](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/loader/mod.rs#L440-L449).

**Percorso di integrazione:** processo stdio dedicato, `initialize`,
`initialized`, poi `config/read` con `{cwd: workspace, includeLayers:false}`,
prima di creare thread. Il reader carica i layer, applica requisiti esatti e
serializza la configurazione; i relativi handler non avviano client MCP.
L'adapter estrae soltanto le chiavi `config.mcp_servers` e scarta il payload;
mai log, persistenza, estrazione di token o esposizione alla UI. Passare poi
`thread/start.config.mcp_servers` come oggetto `{ID:{enabled:false}}` per ogni
ID: la forma annidata preserva i nomi letterali. Il sorgente converte questi
override JSON in TOML e li accoda agli override CLI **prima** di
`start_thread`; il runtime MCP della sessione usa avvio eager.
[Reader](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/config_manager_service.rs#L114-L174),
[override](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/config_manager.rs#L186-L254),
[avvio thread](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/thread_processor.rs#L1315-L1444),
[MCP sessione](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/mcp_runtime.rs#L383-L400).

Questo rende possibile un inventario dinamico senza cambiare custodia del login.
Resta da provare che una modifica ai layer tra lettura e avvio, oppure una
policy gestita, non reintroduca server. I metodi MCP espliciti possono avere
effetti fuori dal thread: non usarli per il preflight. Nessuna prova reale
di avvio isolato è stata eseguita; il client deve fallire chiuso se non riesce
a verificare l'inventario e le policy richieste.

Per planning con Markdown già materializzato, `--disable shell_tool` elimina
la registrazione shell/exec, ma **non garantisce assenza di strumenti**:
`apply_patch` è registrato separatamente e restano utility e contributori.
Read-only impedisce scritture, non rimuove quel tool. Il solo flag non certifica
quindi un percorso “nessun tool”.
[Registrazione strumenti](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/spec_plan.rs#L1027-L1242).

## Richieste del runtime

Persistire `item/tool/requestUserInput` come domanda di dominio; rispondere
`{answers:{questionId:{answers:["..."]}}}` solo con una risposta acquisita.
Per approval inattese, salvare il gate e interrompere: command/file approval
accetta `{decision:"cancel"}`; permissions approval restituisce
`{permissions:{},scope:"turn"}` senza nuove concessioni, seguito da
`turn/interrupt`; elicitation MCP accetta `{action:"cancel"}`. Non autorizzare
modifiche persistenti alle policy. Gli ID JSON-RPC valgono per quella connessione:
dopo restart riprendere dal gate durevole con una nuova operazione controllata.
[Richieste pubbliche](/tmp/kestrel-factory-codex-schema/ServerRequest.json),
[risposta permessi](/tmp/kestrel-factory-codex-schema/PermissionsRequestApprovalResponse.json).
