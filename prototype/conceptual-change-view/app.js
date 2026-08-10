const review = {
  project: "Ic3b3rg / kestrel",
  pullRequest: "PR simulata 184",
  title: "Fissa la Conceptual Review alla revisione analizzata",
  base: "3f2a9b1",
  analyzedHead: "84f21c1",
  currentHead: "a91d7e4",
  newCommits: 3,
  intent:
    "Impedire che risultati prodotti su una revisione precedente siano presentati come correnti quando il Repository Provider segnala una nuova head.",
  overview:
    "La modifica lega ogni risultato della review alla coppia base/head analizzata. Se la head cambia durante l’analisi, Kestrel interrompe la pianificazione dei nuovi stadi, conserva quanto già prodotto e presenta la review come superseded. L’Operator può avviare esplicitamente una nuova review sulla revisione corrente.",
  acceptance: [
    "Ogni artefatto mantiene la coppia base/head esatta.",
    "Nessun nuovo stadio parte dopo il rilevamento della nuova head.",
    "I risultati parziali restano consultabili con il loro stato.",
    "Solo l’Operator avvia l’analisi della revisione corrente.",
  ],
  nodes: [
    {
      id: "provider-event",
      number: "01",
      title: "Ricevi nuova head",
      description:
        "Il Repository Provider comunica che la pull request ora punta a una revisione diversa.",
      state: "context",
      certainty: "verified",
      source: "lib/kestrel/providers/events.ex:72",
      evidence: "Fixture provider_event_head_changed.json",
      finding: "Nessun finding",
    },
    {
      id: "revision-guard",
      number: "02",
      title: "Confronta le revisioni",
      description:
        "Revision Guard confronta la head ricevuta con quella immutabilmente associata alla review.",
      state: "changed",
      certainty: "verified",
      source: "lib/kestrel/reviews/revision_guard.ex:41",
      evidence: "revision_guard_test.exs · 8 test superati",
      finding: "Il confronto usa l’identità provider-neutral della revisione.",
    },
    {
      id: "scheduler",
      number: "03",
      title: "Ferma nuovi stadi",
      description:
        "Lo scheduler non accoda ulteriori stadi obsoleti; l’operazione atomica in corso può terminare in sicurezza.",
      state: "changed",
      certainty: "inferred",
      source: "lib/kestrel/reviews/stage_scheduler.ex:88",
      evidence: "Test unitario presente; interleaving concorrente non coperto",
      finding: "Possibile finestra tra controllo della revisione e accodamento.",
    },
    {
      id: "preserve-results",
      number: "04",
      title: "Conserva i risultati",
      description:
        "Change Overview, evidenze e risultati specialistici già prodotti restano legati alla revisione originale.",
      state: "changed",
      certainty: "verified",
      source: "lib/kestrel/reviews/results.ex:119",
      evidence: "Persistence contract · test di regressione superato",
      finding: "La provenienza resta visibile dopo la supersessione.",
    },
    {
      id: "supersede",
      number: "05",
      title: "Marca superseded",
      description:
        "Il Work Item espone revisione analizzata, revisione corrente e numero di nuovi commit.",
      state: "changed",
      certainty: "verified",
      source: "lib/kestrel/reviews/review.ex:156",
      evidence: "State transition contract · audit event emesso",
      finding: "Lo stato non equivale a fallimento e non elimina risultati.",
    },
    {
      id: "operator-restart",
      number: "06",
      title: "Operator riavvia",
      description:
        "L’Operator sceglie se avviare una nuova review sulla head corrente; nessun lavoro AI riparte automaticamente.",
      state: "context",
      certainty: "verified",
      source: "app/reviews/review_actions.tsx:64",
      evidence: "Interaction contract · nessuna mutation automatica",
      finding: "Il nuovo avvio crea un risultato distinto e collegato.",
    },
  ],
  claims: [
    {
      id: "claim-revision",
      strength: "Verificato",
      tone: "verified",
      claim: "Tutti gli artefatti mostrati appartengono alla head 84f21c1.",
      flow: "Confronta le revisioni",
      evidence: "8 test + vincolo di persistenza",
      source: "revision_guard.ex:41",
    },
    {
      id: "claim-stop",
      strength: "Inferenza",
      tone: "inferred",
      claim: "Nessun nuovo stadio viene accodato dopo l’evento di cambio head.",
      flow: "Ferma nuovi stadi",
      evidence: "Test unitario; concorrenza non simulata",
      source: "stage_scheduler.ex:88",
    },
    {
      id: "claim-preserve",
      strength: "Verificato",
      tone: "verified",
      claim: "I risultati già prodotti restano consultabili e non diventano correnti.",
      flow: "Conserva i risultati",
      evidence: "Test di regressione + audit event",
      source: "results.ex:119",
    },
    {
      id: "claim-restart",
      strength: "Verificato",
      tone: "verified",
      claim: "La nuova head richiede un’azione esplicita dell’Operator.",
      flow: "Operator riavvia",
      evidence: "Interaction contract",
      source: "review_actions.tsx:64",
    },
  ],
};

const variants = {
  A: { name: "Percorso narrativo", render: renderNarrative },
  B: { name: "Graph centrale", render: renderGraphCockpit },
  C: { name: "Matrice delle claim", render: renderClaimLedger },
  D: { name: "Sintesi A + B", render: renderHybrid },
};

let selectedNodeId = "scheduler";
let selectedClaimId = "claim-stop";

function currentVariant() {
  const requested = new URLSearchParams(window.location.search)
    .get("variant")
    ?.toUpperCase();
  return variants[requested] ? requested : "A";
}

function icon(name) {
  const paths = {
    globe:
      '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path>',
    repo: '<path d="M4 4h6l2 2h8v14H4z"></path><path d="M8 11h8M8 15h5"></path>',
    pull: '<circle cx="6" cy="5" r="2"></circle><circle cx="18" cy="19" r="2"></circle><path d="M6 7v10a2 2 0 0 0 2 2h8M18 17V8a3 3 0 0 0-3-3h-3"></path>',
    comment:
      '<path d="M4 5h16v11H9l-5 4z"></path><path d="M8 9h8M8 12h5"></path>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"></path>',
    evidence:
      '<path d="M5 3h11l3 3v15H5z"></path><path d="M16 3v4h4M8 12l2 2 5-5"></path>',
    warning:
      '<path d="M12 3 2.8 20h18.4z"></path><path d="M12 9v5M12 17.5v.1"></path>',
    arrow: '<path d="m9 18 6-6-6-6"></path>',
    branch: '<circle cx="7" cy="5" r="2"></circle><circle cx="17" cy="8" r="2"></circle><circle cx="7" cy="19" r="2"></circle><path d="M7 7v10M9 10c4 0 3-2 6-2"></path>',
    search:
      '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path>',
  };
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}

function shell(content, variant) {
  return `
    <div class="app-shell variant-${variant.toLowerCase()}">
      <aside class="scope-rail" aria-label="Ambito Kestrel">
        <a class="brand-mark" href="#" aria-label="Kestrel home"><span>K</span></a>
        <nav>
          <a href="#" aria-label="Tutti i Project">${icon("globe")}</a>
          <a class="active" href="#" aria-label="Project Ic3b3rg kestrel">K</a>
          <a href="#" aria-label="Aggiungi Project">+</a>
        </nav>
        <button class="avatar" aria-label="Profilo Operator SC">SC</button>
      </aside>

      <div class="workspace">
        <header class="topbar">
          <div class="mobile-brand"><span>K</span> Kestrel</div>
          <div class="breadcrumbs">
            <span>${review.project}</span>
            <span class="crumb-separator">/</span>
            <span>${review.pullRequest}</span>
          </div>
          <div class="top-actions">
            <span class="simulated-label">Caso simulato</span>
            <button class="icon-button" aria-label="Cerca">${icon("search")}</button>
            <button class="icon-button" aria-label="Apri Review Thread">${icon("comment")}</button>
          </div>
        </header>

        <main id="review-content" tabindex="-1">
          ${revisionHeader()}
          ${content}
        </main>
      </div>

      ${prototypeSwitcher(variant)}
      <div class="toast" role="status" aria-live="polite"></div>
    </div>`;
}

function revisionHeader() {
  return `
    <section class="review-header" aria-labelledby="review-title">
      <div class="review-kicker">
        <span class="status-pill status-superseded">Superseded</span>
        <span>Conceptual Review</span>
        <span>Analisi parziale conservata</span>
      </div>
      <div class="review-title-row">
        <div>
          <h1 id="review-title">${review.title}</h1>
          <p>La review resta affidabile per la revisione che ha davvero analizzato.</p>
        </div>
        <button class="primary-action" data-action="restart-review">
          Avvia review su ${review.currentHead}
          ${icon("arrow")}
        </button>
      </div>
      <div class="revision-flightpath" aria-label="Traiettoria delle revisioni">
        <div class="revision-point base">
          <span class="point-dot"></span>
          <span class="point-label">Base</span>
          <code>${review.base}</code>
        </div>
        <div class="revision-leg analyzed">
          <span>Review analizzata</span>
        </div>
        <div class="revision-point analyzed">
          <span class="point-dot"></span>
          <span class="point-label">Head analizzata</span>
          <code>${review.analyzedHead}</code>
        </div>
        <div class="revision-leg diverged">
          <span>+${review.newCommits} commit</span>
        </div>
        <div class="revision-point current">
          <span class="point-dot"></span>
          <span class="point-label">Head corrente</span>
          <code>${review.currentHead}</code>
        </div>
      </div>
    </section>`;
}

function renderNarrative() {
  const nodes = review.nodes
    .map(
      (node) => `
        <button class="journey-node ${node.state} ${node.id === selectedNodeId ? "selected" : ""}"
          data-node="${node.id}" aria-pressed="${node.id === selectedNodeId}">
          <span class="node-number">${node.number}</span>
          <span class="node-title">${node.title}</span>
          <span class="node-state">${node.state === "changed" ? "Modificato" : "Contesto"}</span>
        </button>`,
    )
    .join("");

  const selected = nodeById(selectedNodeId);

  return shell(
    `<div class="narrative-layout">
      <nav class="section-index" aria-label="Sezioni della Conceptual Review">
        <span class="index-title">In questa review</span>
        <a class="active" href="#overview"><span>01</span> Sintesi</a>
        <a href="#intent"><span>02</span> Change Intent</a>
        <a href="#flow"><span>03</span> Flusso cambiato</a>
        <a href="#findings"><span>04</span> Rischio ed evidenze</a>
        <a href="#comments"><span>05</span> Review Thread</a>
        <button class="secondary-action" data-action="open-diff">Apri diff completo</button>
      </nav>

      <div class="narrative-document">
        <section id="overview" class="overview-lead">
          <div class="section-label">Change Overview · disponibile per prima</div>
          <h2>Una review obsoleta resta utile, ma non finge di essere corrente.</h2>
          <p>${review.overview}</p>
          <div class="overview-meta">
            <span>6 passaggi comportamentali</span>
            <span>4 modificati</span>
            <span>1 limite aperto</span>
          </div>
        </section>

        <section id="intent" class="document-section intent-section">
          <div class="section-heading">
            <div>
              <span class="section-label">Change Intent</span>
              <h2>Ciò che la modifica deve garantire</h2>
            </div>
            <span class="provenance-chip">Da PR + Work Item</span>
          </div>
          <p class="intent-statement">${review.intent}</p>
          <ul class="acceptance-list">
            ${review.acceptance.map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </section>

        <section id="flow" class="document-section flow-section">
          <div class="section-heading">
            <div>
              <span class="section-label">Focused Graph delta</span>
              <h2>Segui il comportamento che cambia</h2>
            </div>
            <div class="graph-legend">
              <span><i class="legend-dot changed"></i> Modificato</span>
              <span><i class="legend-dot context"></i> Contesto</span>
            </div>
          </div>
          <div class="journey-track" aria-label="Flusso comportamentale modificato">
            ${nodes}
          </div>
          ${nodeInspector(selected, "inline")}
        </section>

        <section id="findings" class="document-section finding-section">
          <div class="section-heading">
            <div>
              <span class="section-label">Finding principale</span>
              <h2>La concorrenza dello scheduler resta da dimostrare</h2>
            </div>
            <span class="risk-badge">High · provvisorio</span>
          </div>
          <p>Il controllo è presente, ma il test non forza l’interleaving tra evento provider e accodamento dello stadio successivo.</p>
          <div class="evidence-pair">
            <article>
              ${icon("evidence")}
              <div><strong>Ciò che sappiamo</strong><span>Test unitario superato e guardia visibile nel codice.</span></div>
            </article>
            <article class="gap">
              ${icon("warning")}
              <div><strong>Limite dichiarato</strong><span>Nessuna prova del comportamento sotto concorrenza reale.</span></div>
            </article>
          </div>
        </section>

        <section id="comments" class="document-section thread-section">
          <div class="thread-avatar">P</div>
          <div>
            <span class="section-label">Review Thread · Ferma nuovi stadi</span>
            <blockquote>“Cosa succede se la nuova head arriva dopo il controllo ma prima dell’enqueue?”</blockquote>
            <span class="thread-meta">Priya · ancorato a ${review.analyzedHead} · 12 minuti fa</span>
          </div>
          <button class="secondary-action" data-action="reply-thread">Rispondi nel thread</button>
        </section>
      </div>

      <aside class="attention-rail">
        <span class="section-label">La tua attenzione</span>
        <h3>1 punto da verificare</h3>
        <p>Lo scheduler potrebbe accodare uno stadio dopo il cambio di revisione.</p>
        <a href="#findings">Vai al finding ${icon("arrow")}</a>
        <hr />
        <div class="coverage-meter">
          <div><span>Copertura del cambiamento</span><strong>86%</strong></div>
          <div class="meter"><i style="width:86%"></i></div>
          <small>19/22 regioni cambiate mappate</small>
        </div>
      </aside>
    </div>`,
    "A",
  );
}

function renderGraphCockpit() {
  const selected = nodeById(selectedNodeId);
  return shell(
    `<div class="cockpit-layout">
      <aside class="flow-list-panel">
        <div class="panel-heading">
          <span class="section-label">Graph delta</span>
          <h2>2 flussi interessati</h2>
        </div>
        <button class="flow-list-item active">
          <span class="flow-symbol">01</span>
          <span><strong>Head cambia durante l’analisi</strong><small>4 nodi modificati · 1 finding</small></span>
        </button>
        <button class="flow-list-item">
          <span class="flow-symbol">02</span>
          <span><strong>Operator avvia la nuova review</strong><small>Solo contesto · nessun finding</small></span>
        </button>
        <div class="panel-block">
          <span class="section-label">Change Intent</span>
          <p>${review.intent}</p>
          <button class="text-action" data-action="show-intent">Leggi criteri di accettazione ${icon("arrow")}</button>
        </div>
        <div class="panel-block compact">
          <span class="section-label">Visibilità</span>
          <label><input type="checkbox" checked /> Contesto invariato</label>
          <label><input type="checkbox" checked /> Evidenze</label>
          <label><input type="checkbox" checked /> Link inferiti</label>
        </div>
      </aside>

      <section class="graph-stage" aria-labelledby="graph-title">
        <div class="graph-toolbar">
          <div>
            <span class="section-label">Flusso 01</span>
            <h2 id="graph-title">Head cambia durante l’analisi</h2>
          </div>
          <div class="graph-legend">
            <span><i class="legend-dot changed"></i> Modificato</span>
            <span><i class="legend-dot context"></i> Contesto</span>
            <span><i class="legend-line inferred"></i> Inferito</span>
          </div>
        </div>
        <div class="graph-canvas" aria-label="Graph comportamentale interattivo">
          <svg class="graph-links" viewBox="0 0 900 500" preserveAspectRatio="none" aria-hidden="true">
            <path class="verified" d="M110 250 C180 250 175 130 260 130" />
            <path class="verified" d="M365 130 C430 130 415 250 485 250" />
            <path class="inferred" d="M590 250 C655 250 640 125 715 125" />
            <path class="verified" d="M590 250 C655 250 640 380 715 380" />
            <path class="verified" d="M790 150 C820 210 820 300 790 355" />
          </svg>
          ${graphNode("provider-event", 10, 42)}
          ${graphNode("revision-guard", 26, 16)}
          ${graphNode("scheduler", 49, 42)}
          ${graphNode("preserve-results", 73, 15)}
          ${graphNode("supersede", 73, 68)}
          ${graphNode("operator-restart", 88, 42)}
          <div class="graph-annotation" style="--x:51%;--y:77%">
            <span>Copertura mancante</span>
            <strong>Interleaving scheduler</strong>
          </div>
          <div class="canvas-controls" aria-label="Controlli Graph">
            <button aria-label="Riduci">−</button><span>100%</span><button aria-label="Ingrandisci">+</button>
            <button data-action="center-graph">Centra</button>
          </div>
        </div>
      </section>

      <aside class="inspector-panel">
        ${nodeInspector(selected, "panel")}
      </aside>
    </div>`,
    "B",
  );
}

function renderClaimLedger() {
  const selected = review.claims.find((claim) => claim.id === selectedClaimId);
  return shell(
    `<div class="ledger-layout">
      <section class="ledger-intro">
        <div>
          <span class="section-label">Decision packet</span>
          <h2>Quattro claim descrivono il cambiamento</h2>
          <p>Parti da ciò che Kestrel afferma, poi attraversa flusso, prova e codice senza perdere la revisione di origine.</p>
        </div>
        <div class="ledger-summary">
          <div><strong>3</strong><span>verificate</span></div>
          <div class="attention"><strong>1</strong><span>inferenza</span></div>
          <div><strong>86%</strong><span>copertura</span></div>
        </div>
      </section>

      <div class="ledger-workspace">
        <section class="claims-table" aria-label="Matrice delle claim">
          <div class="claim-row claim-header" aria-hidden="true">
            <span>Forza</span><span>Claim</span><span>Flusso</span><span>Evidenza</span><span>Codice</span>
          </div>
          ${review.claims.map(claimRow).join("")}
        </section>

        <aside class="claim-detail">
          <div class="claim-detail-header">
            <span class="claim-strength ${selected.tone}">${selected.strength}</span>
            <span>Head ${review.analyzedHead}</span>
          </div>
          <h2>${selected.claim}</h2>
          <div class="trace-chain" aria-label="Catena di tracciabilità">
            <div><span>Change Intent</span><strong>Risultati mai presentati come correnti sulla revisione sbagliata</strong></div>
            <i>${icon("arrow")}</i>
            <div><span>Flusso</span><strong>${selected.flow}</strong></div>
            <i>${icon("arrow")}</i>
            <div><span>Evidenza</span><strong>${selected.evidence}</strong></div>
            <i>${icon("arrow")}</i>
            <div><span>Codice rilevante</span><strong>${selected.source}</strong></div>
          </div>
          <div class="claim-gap ${selected.tone === "inferred" ? "visible" : ""}">
            ${icon("warning")}
            <div><strong>Perché non è verificata</strong><p>Il test osserva l’esito sequenziale ma non controlla l’interleaving tra l’evento e l’accodamento.</p></div>
          </div>
          <div class="code-peek">
            <div class="code-peek-header"><span>${selected.source}</span><button data-action="open-code">Apri sorgente</button></div>
            <pre><code><span class="code-muted">// revisione attesa dalla review</span>
if current_head != review.analyzed_head {
  scheduler.stop_after_current_stage(review.id)
  review.mark_superseded(current_head)
}</code></pre>
          </div>
          <button class="thread-action" data-action="ask-claim">${icon("comment")} Chiedi a Kestrel su questa claim</button>
        </aside>
      </div>

      <section class="ledger-footer">
        <div>
          <span class="section-label">Risultato trasversale</span>
          <strong>Baseline security · nessun nuovo accesso a credenziali o egress</strong>
        </div>
        <button class="secondary-action" data-action="open-diff">Diff completo · 8 file</button>
      </section>
    </div>`,
    "C",
  );
}

function renderHybrid() {
  const selected = nodeById(selectedNodeId);

  return shell(
    `<div class="hybrid-layout">
      <nav class="section-index hybrid-index" aria-label="Sezioni della Conceptual Review sintetizzata">
        <span class="index-title">In questa review</span>
        <a class="active" href="#hybrid-overview"><span>01</span> Sintesi</a>
        <a href="#hybrid-intent"><span>02</span> Change Intent</a>
        <a href="#hybrid-graph"><span>03</span> Graph</a>
        <a href="#hybrid-evidence"><span>04</span> Evidenze</a>
        <a href="#hybrid-thread"><span>05</span> Review Thread</a>
        <button class="secondary-action" data-action="open-diff">Apri diff completo</button>
      </nav>

      <div class="hybrid-review">
        <section id="hybrid-overview" class="hybrid-opening">
          <div class="hybrid-lead">
            <span class="section-label">Change Overview · orientamento prima del Graph</span>
            <h2>Una review obsoleta resta utile, ma non finge di essere corrente.</h2>
            <p>${review.overview}</p>
            <div class="overview-meta">
              <span>6 passaggi comportamentali</span>
              <span>4 modificati</span>
              <span>1 limite aperto</span>
            </div>
          </div>
          <aside class="hybrid-attention">
            <div class="attention-signal">1</div>
            <div>
              <span class="section-label">La tua attenzione</span>
              <h3>Concorrenza dello scheduler</h3>
              <p>Il controllo esiste, ma manca una prova dell’interleaving reale.</p>
              <a href="#hybrid-evidence">Esamina il limite ${icon("arrow")}</a>
            </div>
          </aside>
        </section>

        <section id="hybrid-intent" class="hybrid-intent-panel">
          <div class="hybrid-intent-heading">
            <div>
              <span class="section-label">Change Intent</span>
              <h2>Ciò che questa modifica deve garantire</h2>
            </div>
            <span class="provenance-chip">Da PR + Work Item</span>
          </div>
          <p>${review.intent}</p>
          <div class="intent-chips">
            ${review.acceptance.map((item) => `<span>${item}</span>`).join("")}
          </div>
        </section>

        <section id="hybrid-graph" class="hybrid-graph-section">
          <header class="hybrid-graph-header">
            <div>
              <span class="section-label">Core della Conceptual Review · focused Graph delta</span>
              <h2>Head cambia durante l’analisi</h2>
              <p>Seleziona un nodo per attraversare comportamento, claim, evidenza e codice.</p>
            </div>
            <div class="hybrid-graph-actions">
              <div class="graph-legend">
                <span><i class="legend-dot changed"></i> Modificato</span>
                <span><i class="legend-dot context"></i> Contesto</span>
                <span><i class="legend-line inferred"></i> Inferito</span>
              </div>
              <button class="secondary-action" data-action="expand-graph">Espandi Graph</button>
            </div>
          </header>

          <div class="hybrid-graph-frame">
            <div class="graph-canvas hybrid-canvas" aria-label="Graph comportamentale interattivo">
              <svg class="graph-links" viewBox="0 0 900 500" preserveAspectRatio="none" aria-hidden="true">
                <path class="verified" d="M110 250 C180 250 175 130 260 130" />
                <path class="verified" d="M365 130 C430 130 415 250 485 250" />
                <path class="inferred" d="M590 250 C655 250 640 125 715 125" />
                <path class="verified" d="M590 250 C655 250 640 380 715 380" />
                <path class="verified" d="M790 150 C820 210 820 300 790 355" />
              </svg>
              ${graphNode("provider-event", 10, 42)}
              ${graphNode("revision-guard", 26, 16)}
              ${graphNode("scheduler", 49, 42)}
              ${graphNode("preserve-results", 73, 15)}
              ${graphNode("supersede", 73, 68)}
              ${graphNode("operator-restart", 88, 42)}
              <div class="graph-annotation" style="--x:51%;--y:77%">
                <span>Copertura mancante</span>
                <strong>Interleaving scheduler</strong>
              </div>
              <div class="canvas-controls" aria-label="Controlli Graph">
                <button aria-label="Riduci">−</button><span>100%</span><button aria-label="Ingrandisci">+</button>
                <button data-action="center-graph">Centra</button>
              </div>
            </div>

            <aside class="hybrid-node-panel" aria-label="Dettaglio del nodo selezionato">
              ${nodeInspector(selected, "hybrid")}
              <div class="hybrid-trace">
                <span class="section-label">Tracciabilità della claim</span>
                <div><i>Intent</i><strong>Risultati mai correnti sulla revisione sbagliata</strong></div>
                <div><i>Claim</i><strong>${selected.finding}</strong></div>
                <div><i>Prova</i><strong>${selected.evidence}</strong></div>
              </div>
            </aside>
          </div>
        </section>

        <section id="hybrid-evidence" class="hybrid-evidence-grid">
          <article class="hybrid-finding">
            <div class="hybrid-card-heading">
              <span class="section-label">Finding principale</span>
              <span class="risk-badge">High · provvisorio</span>
            </div>
            <h3>La concorrenza resta da dimostrare</h3>
            <p>Il test verifica la sequenza nominale, ma non forza il cambio head tra controllo ed enqueue.</p>
            <button class="text-action" data-action="open-code">Apri evidenza e codice ${icon("arrow")}</button>
          </article>
          <article class="hybrid-coverage">
            <div class="hybrid-card-heading">
              <span class="section-label">Copertura dichiarata</span>
              <strong>86%</strong>
            </div>
            <div class="meter"><i style="width:86%"></i></div>
            <p>19 di 22 regioni cambiate sono collegate al Graph. Tre restano non mappate e visibili come limite.</p>
          </article>
        </section>

        <section id="hybrid-thread" class="hybrid-thread">
          <div class="thread-avatar">P</div>
          <div>
            <span class="section-label">Review Thread · ancorato a Ferma nuovi stadi</span>
            <blockquote>“Cosa succede se la nuova head arriva dopo il controllo ma prima dell’enqueue?”</blockquote>
            <span class="thread-meta">Priya · revisione ${review.analyzedHead} · 12 minuti fa</span>
          </div>
          <button class="secondary-action" data-action="reply-thread">Rispondi nel thread</button>
        </section>
      </div>
    </div>`,
    "D",
  );
}

function graphNode(id, x, y) {
  const node = nodeById(id);
  return `
    <button class="canvas-node ${node.state} ${id === selectedNodeId ? "selected" : ""}"
      style="--x:${x}%;--y:${y}%" data-node="${id}" aria-pressed="${id === selectedNodeId}">
      <span class="canvas-node-top"><i>${node.number}</i><em>${node.certainty === "inferred" ? "Inferito" : node.state === "changed" ? "Modificato" : "Contesto"}</em></span>
      <strong>${node.title}</strong>
      ${id === "scheduler" ? '<span class="finding-pin">1</span>' : ""}
    </button>`;
}

function claimRow(claim) {
  return `
    <button class="claim-row ${claim.id === selectedClaimId ? "selected" : ""}"
      data-claim="${claim.id}" aria-pressed="${claim.id === selectedClaimId}">
      <span data-label="Forza"><i class="claim-strength ${claim.tone}">${claim.strength}</i></span>
      <span data-label="Claim"><strong>${claim.claim}</strong></span>
      <span data-label="Flusso">${claim.flow}</span>
      <span data-label="Evidenza">${claim.evidence}</span>
      <span data-label="Codice"><code>${claim.source}</code></span>
    </button>`;
}

function nodeInspector(node, mode) {
  return `
    <article class="node-inspector ${mode}">
      <div class="inspector-kicker">
        <span class="node-number">${node.number}</span>
        <span class="node-state ${node.state}">${node.state === "changed" ? "Comportamento modificato" : "Contesto invariato"}</span>
      </div>
      <h3>${node.title}</h3>
      <p>${node.description}</p>
      <dl>
        <div><dt>${icon("code")} Codice</dt><dd><button data-action="open-code">${node.source}</button></dd></div>
        <div><dt>${icon("evidence")} Evidenza</dt><dd>${node.evidence}</dd></div>
        <div><dt>${icon("warning")} Finding</dt><dd>${node.finding}</dd></div>
      </dl>
      <div class="inspector-actions">
        <button data-action="open-code">Vedi codice rilevante</button>
        <button data-action="ask-node">${icon("comment")} Chiedi su questo nodo</button>
      </div>
    </article>`;
}

function prototypeSwitcher(variant) {
  return `
    <div class="prototype-switcher" aria-label="Selettore variante del prototipo">
      <span class="prototype-flag">PROTOTIPO</span>
      <button data-switch="previous" aria-label="Variante precedente">←</button>
      <div aria-live="polite"><strong>${variant}</strong><span>${variants[variant].name}</span></div>
      <button data-switch="next" aria-label="Variante successiva">→</button>
    </div>`;
}

function nodeById(id) {
  return review.nodes.find((node) => node.id === id) ?? review.nodes[0];
}

function render() {
  const variant = currentVariant();
  document.querySelector("#app").innerHTML = variants[variant].render();
  document.title = `${variant} — ${variants[variant].name} · Kestrel prototype`;
}

function switchVariant(direction) {
  const keys = Object.keys(variants);
  const currentIndex = keys.indexOf(currentVariant());
  const offset = direction === "next" ? 1 : -1;
  const next = keys[(currentIndex + offset + keys.length) % keys.length];
  const url = new URL(window.location.href);
  url.searchParams.set("variant", next);
  window.history.replaceState({}, "", url);
  render();
}

function showToast(message) {
  const toast = document.querySelector(".toast");
  if (!toast) return;
  toast.textContent = `${message} — interazione simulata nel prototipo.`;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

document.addEventListener("click", (event) => {
  const switchButton = event.target.closest("[data-switch]");
  if (switchButton) {
    switchVariant(switchButton.dataset.switch);
    return;
  }

  const nodeButton = event.target.closest("[data-node]");
  if (nodeButton) {
    selectedNodeId = nodeButton.dataset.node;
    render();
    return;
  }

  const claimButton = event.target.closest("[data-claim]");
  if (claimButton) {
    selectedClaimId = claimButton.dataset.claim;
    render();
    return;
  }

  const action = event.target.closest("[data-action]");
  if (action) {
    const labels = {
      "restart-review": `Nuova review su ${review.currentHead}`,
      "open-diff": "Diff completo",
      "reply-thread": "Risposta al Review Thread",
      "show-intent": "Criteri di accettazione",
      "center-graph": "Graph centrato",
      "expand-graph": "Graph a tutto schermo",
      "open-code": "Codice alla revisione analizzata",
      "ask-node": "Nuovo Review Thread sul nodo",
      "ask-claim": "Nuovo Review Thread sulla claim",
    };
    showToast(labels[action.dataset.action] ?? "Azione");
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.matches("input, textarea, [contenteditable]") || target.closest("[contenteditable]"))
  ) {
    return;
  }
  if (event.key === "ArrowLeft") switchVariant("previous");
  if (event.key === "ArrowRight") switchVariant("next");
});

window.addEventListener("popstate", render);
render();
