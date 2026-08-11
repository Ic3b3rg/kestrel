// Throwaway Conceptual Review prototype: orientation first, code review second.

const CASE_ORDER = ["small-behavior", "large-cross-cutting", "docs-only"];

const CONCEPTUAL = {
  "small-behavior": {
    short: "Comando uptime",
    kind: "Nuovo comando CLI",
    summary:
      "La descrizione propone un comando gh uptime per consultare lo stato pubblico di GitHub, produrre un risultato leggibile o JSON e, se richiesto, attendere il ripristino del servizio.",
    declaredIntent:
      "Permettere a persone e automazioni di reagire agli incidenti anche quando l’API principale di GitHub è degradata.",
    scope: ["ingresso CLI", "stato pubblico", "attesa e output"],
    flows: [
      {
        id: "command",
        label: "Comando gh uptime",
        detail: "Nuovo punto di ingresso e nuove opzioni per uso umano o automatico.",
        area: "pkg/cmd/uptime",
        position: [12, 50],
      },
      {
        id: "status",
        label: "Stato pubblico",
        detail: "Lettura dei componenti dal servizio pubblico GitHub Status.",
        area: "client HTTP pubblico",
        position: [35, 50],
      },
      {
        id: "decision",
        label: "Servizio operativo?",
        detail: "Interpretazione dello stato del componente scelto.",
        area: "valutazione del componente",
        position: [58, 50],
      },
      {
        id: "wait",
        label: "Attesa opzionale",
        detail: "Ripetizione del controllo quando viene usata la modalità watch.",
        area: "ciclo --watch",
        position: [82, 25],
      },
      {
        id: "output",
        label: "Testo, JSON, exit code",
        detail: "Restituzione del risultato al terminale o all’automazione chiamante.",
        area: "render e contratto di uscita",
        position: [82, 75],
      },
    ],
    edges: [
      ["command", "status"],
      ["status", "decision"],
      ["decision", "wait"],
      ["decision", "output"],
      ["wait", "status", "return"],
    ],
    verify: [
      {
        title: "Confine di autenticazione",
        detail: "Controllare che il client pubblico non invii le credenziali gh.",
      },
      {
        title: "Attesa e terminazione",
        detail: "Verificare nomi sconosciuti, condizioni di uscita e intervallo di polling.",
      },
      {
        title: "Contratto di output",
        detail: "Controllare coerenza tra testo, JSON ed exit code.",
      },
    ],
    areas: [
      "pkg/cmd/uptime",
      "render output",
      "registrazione root",
      "test uptime",
    ],
  },
  "large-cross-cutting": {
    short: "Routing API host",
    kind: "Modifica trasversale",
    summary:
      "La descrizione propone una superficie HTTP condivisa che faccia rispettare api_host, scelga le credenziali associate e migri i comandi che costruiscono richieste direttamente.",
    declaredIntent:
      "Applicare l’host API configurato al traffico della CLI senza perdere le semantiche specifiche dei singoli comandi.",
    scope: ["configurazione host", "client HTTP", "chiamanti CLI", "harness di test"],
    flows: [
      {
        id: "config",
        label: "Configura api_host",
        detail: "Associazione tra host canonico ed endpoint API alternativo.",
        area: "internal/config",
        position: [12, 50],
      },
      {
        id: "route",
        label: "Instrada la richiesta",
        detail: "REST e GraphQL dovrebbero usare l’endpoint configurato.",
        area: "api client",
        position: [34, 50],
      },
      {
        id: "credential",
        label: "Sceglie il token",
        detail: "La credenziale dovrebbe restare legata all’host canonico corretto.",
        area: "transport autenticato",
        position: [56, 50],
      },
      {
        id: "callers",
        label: "Migra i comandi",
        detail: "I chiamanti diretti dovrebbero passare dalla nuova superficie condivisa.",
        area: "pkg/cmd e internal",
        position: [80, 25],
      },
      {
        id: "gateway",
        label: "Osserva il traffico",
        detail: "Una harness dovrebbe rendere visibili eventuali richieste che aggirano api_host.",
        area: "acceptance harness",
        position: [80, 75],
      },
    ],
    edges: [
      ["config", "route"],
      ["route", "credential"],
      ["credential", "callers"],
      ["credential", "gateway"],
    ],
    verify: [
      {
        title: "Mappatura host e credenziali",
        detail: "Controllare ambiguità quando più host condividono lo stesso endpoint API.",
      },
      {
        title: "Semantiche delle richieste",
        detail: "Verificare body, header, redirect, scope ed errori dei casi speciali.",
      },
      {
        title: "Copertura della migrazione",
        detail: "Cercare chiamanti rimasti fuori dalla superficie HTTP condivisa.",
      },
      {
        title: "Perimetro dichiarato",
        detail: "Confermare l’esclusione esplicita del percorso Codespaces.",
      },
    ],
    areas: [
      "internal/config",
      "api client",
      "pkg/cmd/*",
      "acceptance harness",
    ],
  },
  "docs-only": {
    short: "Solo documentazione",
    kind: "Correzione editoriale",
    summary:
      "La descrizione propone di rimuovere dalla guida sugli aggiornamenti delle dipendenze un riferimento a rebase-strategy ritenuto non pertinente.",
    declaredIntent:
      "Mantenere la guida focalizzata sui controlli effettivamente utili per gli aggiornamenti delle dipendenze.",
    scope: ["guida dipendenze", "contenuto editoriale"],
    flows: [],
    edges: [],
    verify: [
      {
        title: "Perimetro della modifica",
        detail: "Confermare che non siano coinvolti esempi, link o istruzioni correlate.",
      },
      {
        title: "Coerenza editoriale",
        detail: "Controllare che la rimozione non lasci un passaggio incompleto o ambiguo.",
      },
    ],
    areas: [
      "guida dependency security",
    ],
  },
};

const state = {
  view: "inbox",
  caseKey: null,
  selectedFlow: null,
  handoffOpen: false,
  fixtures: {},
};

const iconPaths = {
  arrow: '<path d="M5 12h14M14 6l6 6-6 6"/>',
  back: '<path d="M19 12H5m5 6-6-6 6-6"/>',
  branch:
    '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 12h4c4 0 3-6 6-6M11 12c4 0 3 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  github:
    '<path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.9-1.29 2.74-1.02 2.74-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M10 6h3a5 5 0 0 1 5 5v6"/>',
  sparkle:
    '<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3ZM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Zm13-1 .9 2.6 2.6.9-2.6.9L18 20l-.9-2.6-2.6-.9 2.6-.9L18 13Z"/>',
  warning: '<path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5M12 17.5v.1"/>',
};

function icon(name, className = "") {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeGitHubUrl(value, fallback = "#") {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function formatNumber(value) {
  return Number(value).toLocaleString("it-IT");
}

function shortSha(value) {
  return String(value).slice(0, 7);
}

function currentReview() {
  const caseKey = state.caseKey ?? CASE_ORDER[0];
  return {
    caseKey,
    fixture: state.fixtures[caseKey],
    concept: CONCEPTUAL[caseKey],
  };
}

function renderTopbar({ concept = false } = {}) {
  return `
    <header class="topbar">
      <button class="brand" type="button" data-action="inbox" aria-label="Torna alle pull request">
        <span class="brand-mark">K</span>
        <span><strong>Kestrel</strong><small>${concept ? "Conceptual Review" : "Pull requests"}</small></span>
      </button>
      ${
        concept
          ? `<div class="phase-pill">${icon("sparkle")}<span><small>FASE 1 DI 2</small><strong>Orientamento preliminare</strong></span></div>`
          : `<div class="inbox-context"><span class="pulse"></span>3 PR reali catturate</div>`
      }
      <div class="manual-ai">${icon("lock")}<span><strong>AI su richiesta</strong><small>Nessuna analisi automatica</small></span></div>
    </header>`;
}

function renderInboxRow(caseKey) {
  const fixture = state.fixtures[caseKey];
  const source = fixture.source;
  const concept = CONCEPTUAL[caseKey];
  return `
    <button class="pr-row" type="button" data-open-case="${caseKey}" aria-label="Richiedi review concettuale per ${escapeHTML(source.title)}">
      <span class="provider-icon">${icon("github")}</span>
      <span class="pr-copy">
        <span class="pr-meta">${escapeHTML(source.repository)} · #${source.pull_number} · ${source.draft ? "Draft" : "Aperta"}</span>
        <strong>${escapeHTML(source.title)}</strong>
        <small>${escapeHTML(concept.kind)} · aperta da ${escapeHTML(source.author)}</small>
      </span>
      <span class="pr-stats">
        <span><strong>${source.changed_files}</strong> file</span>
        <span class="plus">+${formatNumber(source.additions)}</span>
        <span class="minus">−${formatNumber(source.deletions)}</span>
      </span>
      <span class="request-action"><small>SU RICHIESTA</small><strong>Review concettuale ${icon("arrow")}</strong></span>
    </button>`;
}

function renderInbox() {
  document.title = "Pull requests · Kestrel";
  return `
    <div class="app-shell inbox-shell">
      ${renderTopbar()}
      <main class="inbox-page">
        <section class="inbox-hero">
          <div>
            <span class="eyebrow">PR inbox</span>
            <h1>Capisci il cambiamento<br />prima di iniziare la review.</h1>
          </div>
          <p>Scegli una pull request. Kestrel preparerà soltanto una mappa orientativa: nessun Finding, nessuna conclusione e nessun verdetto prima della review del codice.</p>
        </section>
        <section class="inbox-panel" aria-labelledby="open-pr-title">
          <header class="inbox-panel-header">
            <div><span class="eyebrow">Repository osservati</span><h2 id="open-pr-title">Pull request aperte</h2></div>
            <div class="list-key"><span>${icon("sparkle")} richiesta manuale</span><span>${icon("code")} review separata</span></div>
          </header>
          <div class="pr-list">${CASE_ORDER.map(renderInboxRow).join("")}</div>
        </section>
        <aside class="flow-boundary">
          <span class="boundary-step active"><i>1</i><span><strong>Review concettuale</strong><small>Che cosa sembra toccare la PR?</small></span></span>
          <span class="boundary-line"></span>
          <span class="boundary-step"><i>2</i><span><strong>Review del codice</strong><small>È corretto, sicuro e provato?</small></span></span>
          <p>Le due fasi hanno scopi diversi. La prima orienta; solo la seconda può sostenere conclusioni.</p>
        </aside>
      </main>
    </div>`;
}

function graphPath(from, to, returnEdge = false) {
  const x1 = from[0] * 10;
  const y1 = from[1] * 5.2;
  const x2 = to[0] * 10;
  const y2 = to[1] * 5.2;
  if (returnEdge) {
    return `M ${x1} ${y1} C ${x1 - 60} 40, ${x2 + 80} 40, ${x2} ${y2}`;
  }
  const bend = Math.max(45, Math.abs(x2 - x1) * 0.42);
  const direction = x2 >= x1 ? 1 : -1;
  return `M ${x1} ${y1} C ${x1 + bend * direction} ${y1}, ${x2 - bend * direction} ${y2}, ${x2} ${y2}`;
}

function renderGraph(review) {
  const { concept } = review;
  if (!concept.flows.length) {
    return `
      <div class="graph-empty">
        <span>${icon("branch")}</span>
        <h3>Nessun flusso software dichiarato</h3>
        <p>La PR è documentale. Questa panoramica segnala l’area editoriale coinvolta senza inventare un comportamento del software.</p>
      </div>`;
  }

  if (!state.selectedFlow || !concept.flows.some((flow) => flow.id === state.selectedFlow)) {
    state.selectedFlow = concept.flows[0].id;
  }
  const positions = Object.fromEntries(concept.flows.map((flow) => [flow.id, flow.position]));
  const paths = concept.edges
    .map(([fromId, toId, kind]) => {
      const from = positions[fromId];
      const to = positions[toId];
      return `<path class="${kind === "return" ? "return" : "candidate"}" d="${graphPath(from, to, kind === "return")}" marker-end="url(#arrow-map)"/>`;
    })
    .join("");
  const nodes = concept.flows
    .map(
      (flow) => `
        <button class="flow-node ${state.selectedFlow === flow.id ? "selected" : ""}" type="button" data-flow="${flow.id}" style="--x:${flow.position[0]}%;--y:${flow.position[1]}%" aria-pressed="${state.selectedFlow === flow.id}">
          <span>${icon("branch")}</span><strong>${flow.label}</strong><small>da verificare</small>
        </button>`,
    )
    .join("");
  return `
    <div class="graph-canvas">
      <svg class="graph-links" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true">
        <defs><marker id="arrow-map" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>
        ${paths}
      </svg>
      ${nodes}
    </div>`;
}

function renderFlowInspector(review) {
  if (!review.concept.flows.length) {
    return `<div class="selection-strip empty">${icon("info")}<span><strong>Astensione intenzionale</strong><small>La review del codice potrà comunque controllare il contenuto editoriale.</small></span></div>`;
  }
  const selected = review.concept.flows.find((flow) => flow.id === state.selectedFlow) ?? review.concept.flows[0];
  return `
    <div class="selection-strip">
      <span class="selection-icon">${icon("branch")}</span>
      <span><small>AREA SELEZIONATA</small><strong>${selected.label}</strong></span>
      <p>${selected.detail}</p>
      <span class="selection-area"><small>ZONA PROBABILE</small><strong>${selected.area}</strong></span>
    </div>`;
}

function renderSummaryPanel(review) {
  const { concept, fixture } = review;
  const source = fixture.source;
  return `
    <aside class="summary-panel">
      <span class="eyebrow">Sintesi della descrizione PR</span>
      <p class="summary-copy">${concept.summary}</p>
      <div class="declared-intent">
        <span>DICHIARAZIONE DELLA PR</span>
        <p>${concept.declaredIntent}</p>
      </div>
      <div class="scope-block">
        <span>AMBITI MENZIONATI</span>
        <div>${concept.scope.map((item) => `<i>${item}</i>`).join("")}</div>
      </div>
      <div class="orientation-input">
        ${icon("lock")}
        <span><strong>Richiesta manualmente</strong><small>Revisione ${shortSha(source.base_sha)} → ${shortSha(source.head_sha)}</small></span>
      </div>
    </aside>`;
}

function renderReviewPlan(review) {
  const { concept, fixture } = review;
  const source = fixture.source;
  return `
    <aside class="review-plan">
      <header><span class="eyebrow">Quando apri il codice</span><h2>Verifica questi punti</h2></header>
      <ol class="verify-list">
        ${concept.verify
          .map(
            (item, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${item.title}</strong><p>${item.detail}</p></div></li>`,
          )
          .join("")}
      </ol>
      <div class="areas-block">
        <span>ZONE DA APRIRE</span>
        <div>${concept.areas
          .map(
            (area) => `<a href="${escapeHTML(safeGitHubUrl(`${source.url}/files`, source.url))}" target="_blank" rel="noreferrer">${icon("code")}<span>${escapeHTML(area)}</span></a>`,
          )
          .join("")}</div>
      </div>
      <div class="not-a-verdict">${icon("warning")}<p><strong>Non è un verdetto.</strong> Sono indicazioni per iniziare la review, non problemi confermati.</p></div>
    </aside>`;
}

function renderHandoff() {
  if (!state.handoffOpen) return "";
  return `
    <div class="modal-scrim" data-action="close-handoff"></div>
    <section class="handoff-modal" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
      <button class="modal-close" type="button" data-action="close-handoff" aria-label="Chiudi">${icon("close")}</button>
      <span class="modal-icon">${icon("code")}</span>
      <span class="eyebrow">Fase 2 di 2</span>
      <h2 id="handoff-title">Qui inizierebbe la review vera.</h2>
      <p>L’AI leggerebbe il codice in profondità e collegherebbe ogni eventuale Finding a prove verificabili. Solo in questa fase potrebbero comparire rischi, Evidence e conclusioni.</p>
      <div class="modal-comparison">
        <span><small>APPENA FATTO</small><strong>Orientamento</strong><i>Flussi e punti da controllare</i></span>
        ${icon("arrow")}
        <span><small>PASSAGGIO SUCCESSIVO</small><strong>Review del codice</strong><i>Verifica e Findings</i></span>
      </div>
      <button class="primary-button" type="button" data-action="close-handoff">Torna alla panoramica</button>
      <small class="prototype-limit">La review completa è fuori dal perimetro di questo prototipo.</small>
    </section>`;
}

function renderConcept() {
  const review = currentReview();
  const { fixture, concept } = review;
  const source = fixture.source;
  document.title = `Review concettuale · ${concept.short} · Kestrel`;
  return `
    <div class="app-shell concept-shell">
      ${renderTopbar({ concept: true })}
      <main class="concept-page">
        <header class="pr-header">
          <button class="back-button" type="button" data-action="inbox">${icon("back")} Tutte le PR</button>
          <div class="pr-title-block">
            <span>${escapeHTML(source.repository)} · PR #${source.pull_number} · titolo originale</span>
            <h1>${escapeHTML(source.title)}</h1>
            <p>aperta da ${escapeHTML(source.author)} · ${source.changed_files} file · <i>+${formatNumber(source.additions)}</i> <b>−${formatNumber(source.deletions)}</b></p>
          </div>
          <a class="github-link" href="${escapeHTML(safeGitHubUrl(source.url))}" target="_blank" rel="noreferrer">${icon("github")} Apri su GitHub ${icon("arrow")}</a>
        </header>
        <section class="orientation-notice">
          ${icon("info")}
          <p><strong>Questa schermata serve solo a orientarti.</strong> Riassume ciò che la PR dichiara e indica dove guardare; non stabilisce se il codice sia corretto.</p>
        </section>
        <section class="concept-workspace">
          ${renderSummaryPanel(review)}
          <section class="map-panel">
            <header>
              <div><span class="eyebrow">Mappa orientativa</span><h2>${concept.flows.length ? "Flussi probabilmente toccati" : "Area interessata"}</h2></div>
              <span class="unverified-badge"><i></i> Non verificato</span>
            </header>
            ${renderGraph(review)}
            ${renderFlowInspector(review)}
          </section>
          ${renderReviewPlan(review)}
        </section>
        <footer class="review-handoff">
          <div>${icon("sparkle")}<span><strong>Hai una mappa, non una conclusione.</strong><small>Il codice viene analizzato in profondità solo nel passaggio successivo.</small></span></div>
          <button class="secondary-button" type="button" data-action="inbox">Cambia PR</button>
          <button class="primary-button" type="button" data-action="full-review">Avvia review del codice ${icon("arrow")}</button>
        </footer>
      </main>
      ${renderHandoff()}
    </div>`;
}

function render() {
  document.getElementById("app").innerHTML = state.view === "concept" ? renderConcept() : renderInbox();
  document.body.classList.toggle("modal-open", state.handoffOpen);
}

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const caseKey = params.get("case");
  state.view = params.get("view") === "concept" && CASE_ORDER.includes(caseKey) ? "concept" : "inbox";
  state.caseKey = state.view === "concept" ? caseKey : null;
  state.selectedFlow = null;
  state.handoffOpen = false;
}

function navigate({ view, caseKey = null }, { replace = false } = {}) {
  state.view = view;
  state.caseKey = view === "concept" ? caseKey : null;
  state.selectedFlow = null;
  state.handoffOpen = false;
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  if (state.caseKey) url.searchParams.set("case", state.caseKey);
  else url.searchParams.delete("case");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
  window.scrollTo(0, 0);
  render();
}

document.addEventListener("click", (event) => {
  const caseButton = event.target.closest("[data-open-case]");
  if (caseButton) {
    navigate({ view: "concept", caseKey: caseButton.dataset.openCase });
    return;
  }

  const flowButton = event.target.closest("[data-flow]");
  if (flowButton) {
    state.selectedFlow = flowButton.dataset.flow;
    render();
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "inbox") {
    navigate({ view: "inbox" });
  } else if (action === "full-review") {
    state.handoffOpen = true;
    render();
  } else if (action === "close-handoff") {
    state.handoffOpen = false;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.handoffOpen) {
    state.handoffOpen = false;
    render();
  }
});

window.addEventListener("popstate", () => {
  readRoute();
  render();
});

async function boot() {
  try {
    const fixtures = await Promise.all(
      CASE_ORDER.map((caseKey) => fetch(`fixtures/${caseKey}.json`).then((response) => {
        if (!response.ok) throw new Error(`Fixture ${caseKey} non disponibile`);
        return response.json();
      })),
    );
    CASE_ORDER.forEach((caseKey, index) => {
      state.fixtures[caseKey] = fixtures[index];
    });
    readRoute();
    navigate({ view: state.view, caseKey: state.caseKey }, { replace: true });
  } catch (error) {
    document.getElementById("app").innerHTML = `<main class="loading-shell error"><span class="loading-mark">!</span><h1>Il prototipo non si è caricato</h1><p>${escapeHTML(error.message)}</p><small>Avvialo tramite il server HTTP indicato nel README, non come file locale.</small></main>`;
  }
}

boot();
