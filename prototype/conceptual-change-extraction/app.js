// Three real-PR Conceptual Review variants, switchable via ?variant= on one throwaway page.

const CASE_ORDER = ["small-behavior", "large-cross-cutting", "docs-only"];
const VARIANTS = {
  A: "Racconto guidato",
  B: "Mappa visuale",
  C: "Esiti → prove",
};

const GRAPH_POSITIONS = {
  "small-behavior": {
    register: [12, 50],
    configure: [34, 50],
    fetch: [56, 50],
    evaluate: [78, 50],
    wait: [88, 24],
    report: [88, 76],
  },
  "large-cross-cutting": {
    "read-map": [12, 22],
    "route-request": [34, 22],
    "attach-token": [58, 22],
    "record-gateway": [82, 22],
    "prove-route": [88, 72],
    "migrate-callers": [12, 76],
    "build-request": [34, 76],
  },
};

const CASE_COPY = {
  "small-behavior": {
    tab: "Comando uptime",
    index: "01",
    eyebrow: "Nuovo comportamento",
    headline: "gh può aspettare che GitHub torni operativo",
    summary:
      "Un nuovo comando legge lo stato pubblico dei servizi senza dipendere dall’API autenticata di GitHub. Può informare una persona, produrre JSON oppure sospendere un’automazione fino al ripristino.",
    intent:
      "Rendere lo stato degli incidenti utilizzabile da persone e automazioni anche quando api.github.com è degradato.",
    status: {
      tone: "attention",
      kicker: "Punto da verificare",
      label: "Un nome errato può attendere per sempre",
      detail:
        "Con --watch, un componente inesistente resta “non operativo” e il comando non raggiunge mai l’errore che segnala il nome sconosciuto.",
    },
    nodeCopy: {
      register: ["Avvia gh uptime", "Il nuovo comando diventa disponibile nella CLI."],
      configure: ["Interpreta le opzioni", "Sceglie servizio, formato, attesa e comportamento d’uscita."],
      fetch: ["Legge lo stato pubblico", "Interroga GitHub Status con un client che non inietta il token gh."],
      evaluate: ["Valuta il servizio", "Filtra le righe informative e determina se il target è operativo."],
      wait: ["Attende il ripristino", "Se richiesto, ripete il controllo dopo l’intervallo configurato."],
      report: ["Restituisce il risultato", "Mostra testo o JSON e può produrre un exit code non-zero."],
    },
    outcomeCopy: [
      "Leggere lo stato senza inviare il token gh",
      "Servire persone e consumatori JSON",
      "Bloccare o sbloccare un’automazione",
    ],
    gaps: [
      "Nessuna CI della revisione esatta era disponibile al momento della cattura.",
      "Il comportamento reale e i limiti dell’endpoint pubblico non sono stati esercitati.",
      "Il contesto contiene patch e struttura del repository, non uno snapshot completo.",
    ],
    mechanics: {
      validation: "Entrambe le estrazioni superano i vincoli strutturali.",
      continuity: "2 nodi su 5 riusano un’identità; 2 corrispondenze restano ambigue.",
      alternative: "La seconda estrazione raggruppa diversamente ingresso, attesa e risultato.",
    },
  },
  "large-cross-cutting": {
    tab: "Routing API host",
    index: "02",
    eyebrow: "Modifica trasversale",
    headline: "Le richieste gh rispettano l’API host configurato",
    summary:
      "La PR introduce una superficie HTTP condivisa, collega l’endpoint configurato alle credenziali corrette e migra numerosi comandi che prima effettuavano richieste dirette.",
    intent:
      "Applicare api_host a quasi tutto il traffico API senza perdere streaming, header, redirect, scope ed errori specifici dei singoli comandi.",
    status: {
      tone: "danger",
      kicker: "Copertura parziale",
      label: "La modifica è troppo ampia per una sola lettura",
      detail:
        "66 file e 205.876 caratteri di diff superano il budget del prototipo. La mappa è utile per orientarsi, ma non prova che ogni chiamante sia stato migrato.",
    },
    nodeCopy: {
      "read-map": ["Risolvi l’API host", "La configurazione collega host canonico ed endpoint API alternativo."],
      "attach-token": ["Scegli la credenziale", "Il transport risale dall’API host all’host canonico prima di allegare il token."],
      "build-request": ["Preserva la richiesta", "Il client mantiene body, header, redirect, scope e accesso alla risposta."],
      "route-request": ["Instrada l’endpoint", "REST e GraphQL relativi vengono diretti verso api_host."],
      "migrate-callers": ["Migra i comandi", "Gist, release, repository, run e search usano il percorso condiviso."],
      "record-gateway": ["Osserva il gateway", "Un proxy TLS registra host, metodo, autenticazione ed esito."],
      "prove-route": ["Rileva gli aggiramenti", "La harness blocca github.com e rende visibile il traffico non instradato."],
    },
    outcomeCopy: [
      "Mappare endpoint e host in entrambe le direzioni",
      "Preservare le semantiche delle richieste speciali",
      "Migrare tutti i chiamanti rimasti",
      "Dimostrare il routing con la gateway harness",
    ],
    gaps: [
      "Solo un campione dei 66 file ha informato la lettura concettuale.",
      "I check risultano verdi, ma i loro log non dicono quali scenari gateway siano passati.",
      "Codespaces è esplicitamente escluso dalla PR.",
    ],
    mechanics: {
      validation: "Entrambe le estrazioni sono strutturalmente valide.",
      continuity: "La continuità dei nodi è media: raggruppamenti diversi restano plausibili.",
      alternative: "La seconda estrazione fonde configurazione e routing e riduce il Graph da 7 a 5 nodi.",
    },
  },
  "docs-only": {
    tab: "Solo documentazione",
    index: "03",
    eyebrow: "Nessun comportamento software",
    headline: "La modifica corregge la guida, non il software",
    summary:
      "Viene rimossa una sola menzione non pertinente a rebase-strategy. La Change Intent è chiara, ma non esiste codice eseguibile da trasformare in un flusso comportamentale.",
    intent:
      "Mantenere la guida sugli aggiornamenti delle dipendenze focalizzata sui controlli realmente pertinenti.",
    status: {
      tone: "calm",
      kicker: "Astensione corretta",
      label: "Nessun Graph da inventare",
      detail:
        "La Conceptual Review conserva intento, prova e copertura, dichiarando che non c’è un delta comportamentale del software.",
    },
    nodeCopy: {},
    outcomeCopy: ["Rimuovere il riferimento non pertinente"],
    gaps: [
      "La CI prova che alcuni job sono terminati, non che la comprensione dei lettori sia migliorata.",
      "Non è stata misurata la risposta di lettori reali.",
    ],
    mechanics: {
      validation: "L’estrazione che si astiene è valida.",
      continuity: "La seconda estrazione diverge perché tenta di creare un Graph del lettore.",
      alternative: "Il validatore rifiuta il Graph inventato: una modifica Markdown non prova comportamento eseguibile.",
    },
  },
};

const state = {
  variant: "A",
  caseKey: "small-behavior",
  selectedNode: null,
  detailsOpen: false,
  runs: null,
  fixtures: {},
};

const iconPaths = {
  arrow: '<path d="M5 12h14M14 6l6 6-6 6"/>',
  back: '<path d="M19 12H5m5 6-6-6 6-6"/>',
  branch: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="8" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 10c4 0 3-2 6-2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  evidence: '<path d="M5 3h11l3 3v15H5z"/><path d="M16 3v4h4M8 12l2 2 5-5"/>',
  graph: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 12h4c4 0 3-6 6-6M11 12c4 0 3 6 6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
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

function shortSha(value) {
  return value.slice(0, 7);
}

function fileName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1];
}

function currentReview() {
  const fixture = state.fixtures[state.caseKey];
  const drafts = state.runs.cases[state.caseKey];
  const copy = CASE_COPY[state.caseKey];
  const draft = drafts[0];
  const alternate = drafts[1];
  const nodes = draft.nodes.map((node) => {
    const localized = copy.nodeCopy[node.draft_id] ?? [node.label, node.description];
    return { ...node, title: localized[0], detail: localized[1] };
  });
  if (!state.selectedNode || !nodes.some((node) => node.draft_id === state.selectedNode)) {
    state.selectedNode = nodes[0]?.draft_id ?? null;
  }
  return { fixture, draft, alternate, copy, nodes };
}

function evidenceRecord(review, selector) {
  const fixture = review.fixture;
  const source = fixture.source;
  if (selector === "pr:body") {
    return { label: "Descrizione PR", detail: "Intent dichiarato dall’autore", url: source.url };
  }
  if (selector.startsWith("diff:")) {
    const path = selector.slice(5);
    const changed = fixture.files.find((item) => item.path === path);
    return {
      label: fileName(path),
      detail: path,
      url: changed?.blob_url ?? `${source.url}/files`,
    };
  }
  if (selector.startsWith("review-comment:")) {
    const id = Number(selector.slice("review-comment:".length));
    const comment = fixture.review_comments.find((item) => item.id === id);
    return {
      label: `Commento · ${fileName(comment?.path ?? "review")}`,
      detail: comment?.body ?? "Commento di review",
      url: comment?.url ?? source.url,
    };
  }
  if (selector.startsWith("check:")) {
    const id = Number(selector.slice(6));
    const check = fixture.test_evidence.check_runs.find((item) => item.id === id);
    return {
      label: check?.name ?? "Check provider",
      detail: check?.conclusion === "success" ? "Concluso con successo" : check?.conclusion ?? "Esito provider",
      url: check?.details_url ?? source.url,
    };
  }
  return { label: selector, detail: "Evidenza catturata", url: source.url };
}

function evidenceChips(review, selectors, limit = 4) {
  const unique = [...new Set(selectors)].slice(0, limit);
  return unique
    .map((selector) => {
      const evidence = evidenceRecord(review, selector);
      return `<a class="evidence-chip" href="${escapeHTML(safeGitHubUrl(evidence.url, review.fixture.source.url))}" target="_blank" rel="noreferrer" title="${escapeHTML(evidence.detail)}">${icon("evidence")}<span>${escapeHTML(evidence.label)}</span></a>`;
    })
    .join("");
}

function translatedStatus(status) {
  return {
    "Evidence found": "Evidenza trovata",
    "Gap found": "Lacuna trovata",
    Unclear: "Non chiaro",
  }[status] ?? status;
}

function statusClass(status) {
  return status === "Evidence found" ? "found" : status === "Gap found" ? "gap" : "unclear";
}

function findingFor(review) {
  return review.draft.claims.find((claim) => claim.kind === "finding") ?? null;
}

function translatedRiskLevel(level) {
  return { Low: "Basso", Medium: "Medio", High: "Alto" }[level] ?? level;
}

function localizedFinding(review, finding) {
  if (!finding) return null;
  if (review.fixture.case === "small-behavior") {
    return {
      title: "Con --watch, un componente sconosciuto non termina",
      body: "Il nome non viene validato prima del ciclo: resta non operativo e viene interrogato di nuovo finché qualcuno interrompe il comando.",
    };
  }
  return {
    title: "Un API host condiviso può selezionare il token sbagliato",
    body: "Se due host canonici puntano allo stesso api_host, la ricerca inversa sceglie il primo. Manca la prova che questa configurazione sia vietata altrove.",
  };
}

function renderTopbar(review) {
  const source = review.fixture.source;
  return `
    <header class="topbar">
      <a class="brand" href="?variant=${state.variant}&case=${state.caseKey}" aria-label="Kestrel Conceptual Review">
        <span class="brand-mark">K</span>
        <span><strong>Kestrel</strong><small>Conceptual Review · prototipo</small></span>
      </a>
      <div class="revision-lock" title="Questa pagina descrive solo la coppia base/head catturata">
        ${icon("lock")}
        <span><small>Input congelato</small><code>${shortSha(source.base_sha)} → ${shortSha(source.head_sha)}</code></span>
        <i>analisi statica</i>
      </div>
      <button class="quiet-button" type="button" data-action="details">${icon("info")} Dettagli estrazione</button>
    </header>`;
}

function renderCaseTabs(review) {
  return `
    <nav class="case-tabs" aria-label="Pull request reali">
      <div class="case-tabs-label"><span>Casi reali</span><strong>${escapeHTML(review.fixture.source.repository)}</strong></div>
      <div class="case-tab-list">
        ${CASE_ORDER.map((key) => {
          const copy = CASE_COPY[key];
          const selected = key === state.caseKey;
          return `<button type="button" class="case-tab ${selected ? "selected" : ""}" data-case="${key}" aria-pressed="${selected}"><span>${copy.index}</span>${copy.tab}</button>`;
        }).join("")}
      </div>
    </nav>`;
}

function renderReviewIdentity(review, compact = false) {
  const source = review.fixture.source;
  return `
    <div class="review-identity ${compact ? "compact" : ""}">
      <span class="provider-dot">GH</span>
      <div>
        <span>${escapeHTML(source.repository)} · PR ${source.pull_number}</span>
        <strong>${escapeHTML(source.title)}</strong>
      </div>
      <a href="${escapeHTML(safeGitHubUrl(source.url))}" target="_blank" rel="noreferrer">Apri su GitHub ${icon("arrow")}</a>
    </div>`;
}

function renderStatusCard(review) {
  const status = review.copy.status;
  const finding = findingFor(review);
  return `
    <aside class="status-card ${status.tone}">
      <div class="status-icon">${icon(status.tone === "calm" ? "check" : "warning")}</div>
      <span class="section-kicker">${status.kicker}</span>
      <h2>${status.label}</h2>
      <p>${status.detail}</p>
      ${
        finding
          ? `<div class="finding-signature"><span>${translatedRiskLevel(finding.risk_level)}</span><span>${finding.basis === "Model Judgment" ? "Giudizio del modello" : finding.basis}</span><span>${finding.evidence_sufficiency === "Limited" ? "Evidenza limitata" : "Evidenza sufficiente"}</span></div>`
          : `<div class="finding-signature clean"><span>Nessun Finding</span><span>Graph non applicabile</span></div>`
      }
    </aside>`;
}

function renderTrustLine(review) {
  const source = review.fixture.source;
  const checks = review.fixture.test_evidence.check_runs.length;
  return `
    <div class="trust-line">
      <span>${icon("lock")} Head ${shortSha(source.head_sha)}</span>
      <span>${icon("code")} ${source.changed_files} file cambiati</span>
      <span>${icon("check")} ${checks ? `${checks} check provider` : "nessuna CI disponibile"}</span>
      <span>${icon("info")} codice non eseguito</span>
    </div>`;
}

function renderVariantA(review) {
  const finding = findingFor(review);
  const findingCopy = localizedFinding(review, finding);
  return `
    <article class="variant variant-a">
      ${renderReviewIdentity(review)}
      <section class="story-hero">
        <div class="story-lead">
          <span class="section-kicker">${review.copy.eyebrow}</span>
          <h1>${review.copy.headline}</h1>
          <p class="lead-copy">${review.copy.summary}</p>
          <div class="intent-statement">
            <span>Change Intent</span>
            <p>${review.copy.intent}</p>
          </div>
        </div>
        ${renderStatusCard(review)}
      </section>
      ${renderTrustLine(review)}
      <section class="story-flow-section">
        <header class="section-heading">
          <div><span class="section-kicker">Il cambiamento in 30 secondi</span><h2>${review.nodes.length ? "Segui il comportamento" : "La review si ferma al punto giusto"}</h2></div>
          <span class="flow-count">${review.nodes.length ? `${review.nodes.length} passaggi` : "0 passaggi software"}</span>
        </header>
        ${
          review.nodes.length
            ? `<ol class="story-flow">${review.nodes
                .map(
                  (node, index) => `<li>
                    <span class="story-number">${String(index + 1).padStart(2, "0")}</span>
                    <div><h3>${node.title}</h3><p>${node.detail}</p></div>
                    <span class="certainty ${node.certainty}">${node.certainty === "verified" ? "Verificato" : "Inferito"}</span>
                  </li>`,
                )
                .join("")}</ol>`
            : `<div class="honest-empty">${icon("graph")}<div><strong>Nessun delta comportamentale</strong><p>Il diff modifica solo documentazione. Inventare nodi sul comportamento dei lettori trasformerebbe un’ipotesi in falsa evidenza.</p></div></div>`
        }
      </section>
      <section class="story-conclusion">
        <div class="evidence-summary">
          <span class="section-kicker">Cosa sappiamo</span>
          <h2>${review.draft.coverage.outcomes.filter((item) => item.status === "Evidence found").length} esiti hanno Evidence risolvibile</h2>
          ${review.draft.coverage.outcomes
            .map(
              (outcome, index) => `<div class="compact-outcome"><i class="${statusClass(outcome.status)}">${icon(outcome.status === "Evidence found" ? "check" : "warning")}</i><span><strong>${review.copy.outcomeCopy[index] ?? outcome.outcome}</strong><small>${translatedStatus(outcome.status)}</small></span></div>`,
            )
            .join("")}
        </div>
        <div class="gap-summary">
          <span class="section-kicker">Cosa non sappiamo</span>
          <h2>I limiti restano parte del risultato</h2>
          <ul>${review.copy.gaps.map((gap) => `<li>${gap}</li>`).join("")}</ul>
        </div>
        ${
          findingCopy
            ? `<div class="finding-card"><div>${icon("warning")}<span>Finding principale</span></div><h2>${findingCopy.title}</h2><p>${findingCopy.body}</p>${evidenceChips(review, finding.evidence)}</div>`
            : `<div class="finding-card empty"><div>${icon("check")}<span>Esito</span></div><h2>Nessun rischio software da classificare</h2><p>La modifica resta comprensibile attraverso intento ed Evidence, senza forzare un Graph vuoto.</p></div>`
        }
      </section>
    </article>`;
}

function renderGraphMap(review, selected) {
  const positions = GRAPH_POSITIONS[review.fixture.case];
  if (!positions) return "";
  const paths = review.draft.edges
    .map((edge) => {
      const from = positions[edge.from];
      const to = positions[edge.to];
      if (!from || !to) return "";
      const x1 = from[0] * 10;
      const y1 = from[1] * 5.2;
      const x2 = to[0] * 10;
      const y2 = to[1] * 5.2;
      const bend = Math.max(50, Math.abs(x2 - x1) * 0.45);
      const direction = x2 >= x1 ? 1 : -1;
      return `<path class="${edge.certainty}" d="M ${x1} ${y1} C ${x1 + bend * direction} ${y1}, ${x2 - bend * direction} ${y2}, ${x2} ${y2}" marker-end="url(#arrow-${edge.certainty})"/>`;
    })
    .join("");
  const nodes = review.nodes
    .map((node, index) => {
      const [x, y] = positions[node.draft_id];
      const selectedClass = selected?.draft_id === node.draft_id ? "selected" : "";
      return `<button type="button" class="graph-node ${selectedClass}" style="--x:${x}%;--y:${y}%" data-node="${node.draft_id}" aria-pressed="${selectedClass ? "true" : "false"}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${node.title}</strong><small>${node.certainty === "verified" ? "Verificato" : "Inferito"}</small></button>`;
    })
    .join("");
  return `<div class="graph-canvas"><svg class="graph-links" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-verified" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker><marker id="arrow-inferred" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${paths}</svg>${nodes}<div class="canvas-note">${icon("info")} La posizione aiuta a leggere; solo le linee dichiarano una relazione.</div></div>`;
}

function renderVariantB(review) {
  const selected = review.nodes.find((node) => node.draft_id === state.selectedNode) ?? null;
  const anchoredFinding = selected
    ? review.draft.claims.find((claim) => claim.kind === "finding" && claim.node === selected.draft_id)
    : null;
  const findingCopy = localizedFinding(review, anchoredFinding);
  return `
    <article class="variant variant-b">
      <div class="cockpit">
        <aside class="context-rail">
          ${renderReviewIdentity(review, true)}
          <span class="section-kicker">Change Overview</span>
          <h1>${review.copy.headline}</h1>
          <p>${review.copy.summary}</p>
          <div class="rail-intent"><span>Change Intent</span><p>${review.copy.intent}</p></div>
          <div class="rail-attention ${review.copy.status.tone}"><span>${review.copy.status.kicker}</span><strong>${review.copy.status.label}</strong></div>
          <a class="raw-link" href="${escapeHTML(safeGitHubUrl(`${review.fixture.source.url}/files`))}" target="_blank" rel="noreferrer">Diff completo, secondario ${icon("arrow")}</a>
        </aside>
        <section class="graph-stage">
          <header class="graph-header">
            <div><span class="section-kicker">Focused Graph delta</span><h2>${review.nodes.length ? "Il comportamento modificato" : "Nessun comportamento modificato"}</h2></div>
            <div class="legend"><span><i class="dot changed"></i>Modificato</span><span><i class="line verified"></i>Verificato</span><span><i class="line inferred"></i>Inferito</span></div>
          </header>
          ${
            review.nodes.length
              ? renderGraphMap(review, selected)
              : `<div class="graph-empty"><span>${icon("graph")}</span><h3>Graph non applicabile</h3><p>La revisione contiene una Change Intent e una prova editoriale, ma nessun flusso software da rappresentare.</p></div>`
          }
        </section>
        <aside class="node-inspector">
          ${
            selected
              ? `<span class="section-kicker">Nodo selezionato</span><div class="inspector-number">${String(review.nodes.indexOf(selected) + 1).padStart(2, "0")}</div><h2>${selected.title}</h2><p>${selected.detail}</p><div class="inspector-meta"><span class="certainty ${selected.certainty}">${selected.certainty === "verified" ? "Relazione verificata" : "Relazione inferita"}</span><span>Modificato</span></div><div class="inspector-evidence"><span>Evidence</span>${evidenceChips(review, selected.evidence)}</div>${
                  findingCopy
                    ? `<div class="inspector-finding"><span>${translatedRiskLevel(anchoredFinding.risk_level)} · ${anchoredFinding.evidence_sufficiency === "Limited" ? "provvisorio" : "supportato"}</span><strong>${findingCopy.title}</strong><p>${findingCopy.body}</p></div>`
                    : `<div class="inspector-clear">${icon("check")} Nessun Finding ancorato a questo passaggio</div>`
                }`
              : `<span class="section-kicker">Perché è vuoto</span><h2>Non tutto deve diventare un Graph</h2><p>La modifica è documentale. Il risultato più affidabile è dichiarare l’assenza di comportamento software, non simulare un percorso del lettore.</p><div class="inspector-evidence"><span>Evidence</span>${evidenceChips(review, review.draft.intent.outcomes.flatMap((item) => item.evidence))}</div>`
          }
        </aside>
      </div>
      ${renderTrustLine(review)}
    </article>`;
}

function relatedNodes(review, evidence) {
  const selectors = new Set(evidence);
  return review.nodes.filter((node) => node.evidence.some((selector) => selectors.has(selector)));
}

function renderVariantC(review) {
  const finding = findingFor(review);
  const findingCopy = localizedFinding(review, finding);
  const verifiedNodes = review.nodes.filter((node) => node.certainty === "verified").length;
  const inferredEdges = review.draft.edges.filter((edge) => edge.certainty === "inferred").length;
  return `
    <article class="variant variant-c">
      ${renderReviewIdentity(review)}
      <header class="ledger-hero">
        <div><span class="section-kicker">Change Intent → comportamento → Evidence</span><h1>${review.copy.headline}</h1><p>${review.copy.intent}</p></div>
        <div class="ledger-score ${review.copy.status.tone}"><span>${review.copy.status.kicker}</span><strong>${review.copy.status.label}</strong><small>${review.copy.status.detail}</small></div>
      </header>
      <section class="outcome-ledger">
        <header><span>Esito atteso</span><span>Stato</span><span>Comportamento collegato</span><span>Evidence</span></header>
        ${review.draft.coverage.outcomes
          .map((outcome, index) => {
            const nodes = relatedNodes(review, outcome.evidence);
            return `<article class="outcome-row"><div class="outcome-name"><span>${String(index + 1).padStart(2, "0")}</span><strong>${review.copy.outcomeCopy[index] ?? outcome.outcome}</strong></div><div><span class="coverage-status ${statusClass(outcome.status)}">${translatedStatus(outcome.status)}</span></div><div class="linked-behavior">${
              nodes.length
                ? nodes.slice(0, 3).map((node) => `<span>${icon("branch")}${node.title}</span>`).join("")
                : `<span class="not-applicable">${icon("graph")} Nessun Graph necessario</span>`
            }</div><div class="ledger-evidence">${evidenceChips(review, outcome.evidence, 3)}</div></article>`;
          })
          .join("")}
      </section>
      <section class="ledger-bottom">
        <div class="signal-card verified"><span class="signal-number">${verifiedNodes}</span><div><span>Passaggi verificati</span><p>Hanno almeno un riferimento risolvibile nella revisione catturata.</p></div></div>
        <div class="signal-card inferred"><span class="signal-number">${inferredEdges}</span><div><span>Relazioni inferite</span><p>Restano visibili e non vengono presentate come fatti deterministici.</p></div></div>
        <div class="signal-card gaps"><span class="signal-number">${review.copy.gaps.length}</span><div><span>Limiti dichiarati</span><p>${review.copy.gaps[0]}</p></div></div>
      </section>
      ${
        findingCopy
          ? `<section class="ledger-finding"><div><span>Finding principale</span><strong>${translatedRiskLevel(finding.risk_level)} · ${finding.basis === "Model Judgment" ? "Giudizio del modello" : finding.basis} · ${finding.evidence_sufficiency === "Limited" ? "Evidenza limitata" : "Evidenza sufficiente"}</strong></div><h2>${findingCopy.title}</h2><p>${findingCopy.body}</p>${evidenceChips(review, finding.evidence)}</section>`
          : `<section class="ledger-finding clean"><div><span>Conclusione</span><strong>Nessun Finding</strong></div><h2>La certezza nasce anche dal non inventare</h2><p>Intento e modifica editoriale sono supportati; un comportamento software non lo è.</p></section>`
      }
      ${renderTrustLine(review)}
    </article>`;
}

function renderDetails(review) {
  if (!state.detailsOpen) return "";
  const fixture = review.fixture;
  const source = fixture.source;
  const capture = fixture.capture_coverage;
  return `
    <div class="drawer-scrim" data-action="close-details"></div>
    <aside class="details-drawer" role="dialog" aria-modal="true" aria-labelledby="details-title">
      <header><div><span>Solo su richiesta</span><h2 id="details-title">Dettagli dell’estrazione</h2></div><button type="button" data-action="close-details" aria-label="Chiudi">${icon("close")}</button></header>
      <section><span class="drawer-label">Identità della revisione</span><dl><div><dt>Repository</dt><dd>${escapeHTML(source.repository)}</dd></div><div><dt>Base</dt><dd><code>${source.base_sha}</code></dd></div><div><dt>Head analizzata</dt><dd><code>${source.head_sha}</code></dd></div><div><dt>Catturata</dt><dd>${escapeHTML(new Date(fixture.captured_at).toLocaleString("it-IT"))}</dd></div></dl></section>
      <section><span class="drawer-label">Input disponibile</span><div class="drawer-metrics"><span><strong>${source.changed_files}</strong> file</span><span><strong>${capture.patch_chars.toLocaleString("it-IT")}</strong> caratteri diff</span><span><strong>${fixture.conversation_comments.length + fixture.review_comments.length}</strong> commenti</span><span><strong>${fixture.test_evidence.check_runs.length}</strong> check</span></div><p>${escapeHTML(capture.note)}</p></section>
      <section><span class="drawer-label">Stabilizzazione</span><div class="mechanic"><strong>Validazione</strong><p>${review.copy.mechanics.validation}</p></div><div class="mechanic"><strong>Identità dei nodi</strong><p>${review.copy.mechanics.continuity}</p></div><div class="mechanic"><strong>Seconda lettura</strong><p>${review.copy.mechanics.alternative}</p></div></section>
      <section class="drawer-warning">${icon("warning")}<p>Le due letture sono state prodotte nella stessa sessione e non misurano la varianza di un Model Provider. Questo pannello spiega i limiti; non è il percorso principale della review.</p></section>
      <footer><a href="${escapeHTML(safeGitHubUrl(source.url))}" target="_blank" rel="noreferrer">Pull request originale ${icon("arrow")}</a><a href="recorded_runs.json" target="_blank">Dati registrati ${icon("code")}</a></footer>
    </aside>`;
}

function renderSwitcher() {
  const localPreview = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  if (!localPreview && !window.location.pathname.includes("prototype")) return "";
  const keys = Object.keys(VARIANTS);
  const current = keys.indexOf(state.variant);
  const previous = keys[(current - 1 + keys.length) % keys.length];
  const next = keys[(current + 1) % keys.length];
  return `
    <div class="prototype-switcher" aria-label="Varianti del prototipo">
      <button type="button" data-variant="${previous}" aria-label="Variante precedente">${icon("back")}</button>
      <div><span>Prototipo UI</span><strong>${state.variant} — ${VARIANTS[state.variant]}</strong></div>
      <button type="button" data-variant="${next}" aria-label="Variante successiva">${icon("arrow")}</button>
    </div>`;
}

function render() {
  const review = currentReview();
  const variantRenderer = { A: renderVariantA, B: renderVariantB, C: renderVariantC }[state.variant];
  document.title = `${state.variant} — ${VARIANTS[state.variant]} · ${review.copy.tab} · Kestrel`;
  document.getElementById("app").innerHTML = `
    <div class="app-shell" data-active-variant="${state.variant}" data-active-case="${state.caseKey}">
      ${renderTopbar(review)}
      ${renderCaseTabs(review)}
      <main class="review-surface">${variantRenderer(review)}</main>
      ${renderDetails(review)}
      ${renderSwitcher()}
    </div>`;
  document.body.classList.toggle("drawer-open", state.detailsOpen);
}

function replaceLocation(next = {}) {
  if (next.variant) state.variant = next.variant;
  if (next.caseKey) {
    state.caseKey = next.caseKey;
    state.selectedNode = null;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("variant", state.variant);
  url.searchParams.set("case", state.caseKey);
  window.history.replaceState({}, "", url);
  render();
}

function cycleVariant(direction) {
  const keys = Object.keys(VARIANTS);
  const index = keys.indexOf(state.variant);
  replaceLocation({ variant: keys[(index + direction + keys.length) % keys.length] });
}

document.addEventListener("click", (event) => {
  const variant = event.target.closest("button[data-variant]");
  if (variant) {
    replaceLocation({ variant: variant.dataset.variant });
    return;
  }
  const caseButton = event.target.closest("[data-case]");
  if (caseButton) {
    replaceLocation({ caseKey: caseButton.dataset.case });
    return;
  }
  const node = event.target.closest("[data-node]");
  if (node) {
    state.selectedNode = node.dataset.node;
    render();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "details") {
    state.detailsOpen = true;
    render();
  } else if (action === "close-details") {
    state.detailsOpen = false;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
  if (editing) return;
  if (event.key === "ArrowLeft") {
    cycleVariant(-1);
  } else if (event.key === "ArrowRight") {
    cycleVariant(1);
  } else if (event.key === "Escape" && state.detailsOpen) {
    state.detailsOpen = false;
    render();
  }
});

async function boot() {
  try {
    const params = new URLSearchParams(window.location.search);
    const variant = params.get("variant")?.toUpperCase();
    const caseKey = params.get("case");
    state.variant = VARIANTS[variant] ? variant : "A";
    state.caseKey = CASE_ORDER.includes(caseKey) ? caseKey : CASE_ORDER[0];
    const [runs, ...fixtures] = await Promise.all([
      fetch("recorded_runs.json").then((response) => response.json()),
      ...CASE_ORDER.map((key) => fetch(`fixtures/${key}.json`).then((response) => response.json())),
    ]);
    state.runs = runs;
    CASE_ORDER.forEach((key, index) => {
      state.fixtures[key] = fixtures[index];
    });
    replaceLocation();
  } catch (error) {
    document.getElementById("app").innerHTML = `<main class="loading-shell error"><span class="loading-mark">!</span><h1>Il prototipo non si è caricato</h1><p>${escapeHTML(error.message)}</p><small>Avvialo tramite il server HTTP indicato nel README, non come file locale.</small></main>`;
  }
}

boot();
