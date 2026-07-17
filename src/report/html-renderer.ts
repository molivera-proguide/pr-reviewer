import type { Evidence, Finding, ReviewCoverage, ReviewReport } from "../domain/contracts.ts";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function severityLabel(severity: Finding["severity"]): string {
  return severity.toUpperCase();
}

function renderEvidence(evidence: readonly Evidence[]): string {
  return evidence
    .map(
      (item) => `
        <figure class="evidence">
          <figcaption><span>${escapeHtml(item.path)}</span><span>L${item.startLine}–${item.endLine}</span><code>${escapeHtml(item.revision.slice(0, 12))}</code></figcaption>
          <pre><code>${escapeHtml(item.excerpt)}</code></pre>
        </figure>`,
    )
    .join("");
}

function renderFinding(finding: Finding, index: number): string {
  return `
    <article class="finding finding--${finding.severity}">
      <header>
        <span class="finding__index">${String(index + 1).padStart(2, "0")}</span>
        <div>
          <div class="eyebrow"><span class="severity">${severityLabel(finding.severity)}</span> · ${escapeHtml(finding.impact ?? "legacy")} · ${escapeHtml(finding.category)} · ${Math.round(finding.confidence * 100)}% confianza</div>
          <h3>${escapeHtml(finding.claim)}</h3>
        </div>
      </header>
      ${renderEvidence(finding.evidence)}
      <p class="action"><strong>Acción sugerida</strong>${escapeHtml(finding.suggestedAction)}</p>
      ${finding.criterionIds.length === 0 ? "" : `<p class="criteria">Criterios: ${finding.criterionIds.map(escapeHtml).join(", ")}</p>`}
    </article>`;
}

function renderCoverageRow(item: ReviewCoverage): string {
  const locations = item.evidence
    .map((evidence) => `${escapeHtml(evidence.path)}:${evidence.startLine}`)
    .join(" · ");
  return `<tr>
    <td><code>${escapeHtml(item.criterionId)}</code></td>
    <td>${escapeHtml(item.description)}</td>
    <td><span class="coverage coverage--${item.status}">${escapeHtml(item.status.replaceAll("_", " "))}</span></td>
    <td>${locations || escapeHtml(item.notes)}</td>
  </tr>`;
}

function renderSliceRows(report: ReviewReport): string {
  if (report.slices.length === 0) {
    return '<tr><td colspan="9" class="empty">No se registraron slices de código.</td></tr>';
  }
  return report.slices
    .map(
      (slice) => `<tr>
    <td><code>${escapeHtml(slice.id)}</code></td>
    <td>${escapeHtml(slice.kind ?? "implementation")}</td>
    <td><span class="coverage coverage--${slice.status === "completed" ? "covered" : "not_verifiable"}">${escapeHtml(slice.status)}</span></td>
    <td>${escapeHtml(slice.assessmentStatus ?? (slice.status === "completed" ? "complete" : "gapped"))}</td>
    <td>${slice.acceptedCriteria ?? 0} / ${slice.assignedCriteria ?? 0}</td>
    <td>${escapeHtml(slice.failureKind ?? "—")}</td>
    <td>${slice.attempts}</td>
    <td>${slice.inputTokens} / ${slice.outputTokens}</td>
    <td>${slice.requestIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(" · ") || "—"}</td>
  </tr>`,
    )
    .join("");
}

function renderAttemptRows(report: ReviewReport): string {
  if (report.attemptDiagnostics.length === 0) {
    return '<tr><td colspan="8" class="empty">No se registraron diagnósticos de agentes.</td></tr>';
  }
  return report.attemptDiagnostics
    .map(
      (attempt) => `<tr>
    <td>${escapeHtml(attempt.role)}</td>
    <td><code>${escapeHtml(attempt.model ?? report.model)}</code></td>
    <td>${escapeHtml(attempt.sliceId ?? "—")}</td>
    <td>${attempt.attempt}</td>
    <td>${escapeHtml(attempt.status)}</td>
    <td>${escapeHtml(attempt.failureKind ?? attempt.stopReason ?? "—")}</td>
    <td>${attempt.inputTokens} / ${attempt.outputTokens}<small>cache ${attempt.cacheReadInputTokens ?? 0} · thinking ${attempt.thinkingTokens ?? 0}</small></td>
    <td>${attempt.requestId === null ? "—" : `<code>${escapeHtml(attempt.requestId)}</code>`}</td>
  </tr>`,
    )
    .join("");
}

function renderList(items: readonly string[], empty: string): string {
  if (items.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function verdictClass(verdict: ReviewReport["verdict"]): string {
  if (verdict === "RIESGO_BLOQUEANTE") return "blocking";
  if (verdict === "REQUIERE_DECISION") return "decision";
  return "clear";
}

export function renderReportHtml(report: ReviewReport): string {
  const reviewScope = report.reviewScope ?? "implementation";
  const scopeLabel = reviewScope === "test_only" ? "PR test-only" : "Revisión de implementación";
  const feature = report.feature?.directory ?? "No resuelta";
  const artifactsLoaded = report.artifacts.filter(
    (artifact) => artifact.status === "loaded",
  ).length;
  const critical = report.findings.filter((finding) => finding.severity === "critical").length;
  const high = report.findings.filter((finding) => finding.severity === "high").length;
  const failedAttempts = report.attemptDiagnostics.filter(
    (attempt) => attempt.status === "failed",
  ).length;
  const modelSummary = report.models
    ? `${report.models.explorer} / ${report.models.orchestrator}`
    : report.model;
  const cacheReadTokens = report.usage.cacheReadInputTokens ?? 0;
  const thinkingTokens = report.usage.thinkingTokens ?? 0;
  const costAmount = report.costEstimate?.amount.toFixed(4) ?? "—";
  const failedCostAmount = report.costEstimate?.failedAttemptAmount.toFixed(4) ?? "—";
  const partialCostLabel = report.costEstimate?.complete === false ? "estimación parcial · " : "";
  const incompleteNotice =
    report.status === "completed"
      ? ""
      : '<aside class="warning"><strong>Revisión parcial</strong><span>Uno o más criterios o fragmentos del cambio no pudieron verificarse completamente.</span></aside>';
  const planningSummary = report.planning
    ? `${report.planning.mode} · ${report.planning.acceptedSlices} slices${report.planning.fallbackReason === undefined ? "" : ` · ${report.planning.fallbackReason}`}`
    : "legacy";
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <meta name="referrer" content="no-referrer">
  <title>SDD Review · ${escapeHtml(report.repository)} · #${report.changeRequestNumber}</title>
  <style>
    :root { color-scheme: light; --ink:#17201d; --muted:#68716c; --paper:#f2efe6; --panel:#fbfaf5; --rule:#c9c5b9; --acid:#d8f04a; --red:#b42318; --orange:#b54708; --blue:#175cd3; --green:#067647; --shadow:0 18px 50px rgba(23,32,29,.10); }
    * { box-sizing:border-box; }
    html { background:#d9d5ca; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family:Georgia,"Times New Roman",serif; line-height:1.55; }
    body::before { content:""; display:block; height:9px; background:repeating-linear-gradient(90deg,var(--ink) 0 44px,var(--acid) 44px 88px); }
    main { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:54px 0 90px; }
    .masthead { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:40px; align-items:end; padding-bottom:30px; border-bottom:2px solid var(--ink); }
    .kicker,.eyebrow,.metric span,.meta dt,.stamp,.coverage,.criteria { font:700 11px/1.25 Consolas,"Courier New",monospace; letter-spacing:.1em; text-transform:uppercase; }
    .kicker { display:inline-block; background:var(--acid); padding:5px 8px; transform:rotate(-1deg); }
    h1 { max-width:880px; margin:16px 0 4px; font-size:clamp(38px,7vw,82px); line-height:.91; letter-spacing:-.055em; font-weight:700; overflow-wrap:anywhere; }
    .subtitle { margin:12px 0 0; color:var(--muted); font-size:18px; }
    .stamp { min-width:190px; padding:17px 19px; border:2px solid currentColor; color:var(--orange); text-align:center; transform:rotate(1.5deg); }
    .stamp--blocking { color:var(--red); } .stamp--clear { color:var(--green); }
    .metrics { display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--rule); border-width:0 0 1px 1px; background:var(--panel); box-shadow:var(--shadow); margin:36px 0 54px; }
    .metric { min-height:116px; padding:20px; border:1px solid var(--rule); border-width:1px 1px 0 0; }
    .metric strong { display:block; margin-top:15px; font:700 clamp(25px,4vw,38px)/1 Consolas,"Courier New",monospace; overflow-wrap:anywhere; }
    .metric small { display:block; margin-top:6px; color:var(--muted); }
    section { margin-top:58px; }
    .section-head { display:flex; gap:18px; align-items:baseline; padding-bottom:13px; border-bottom:1px solid var(--ink); }
    .section-head b { font:700 13px Consolas,"Courier New",monospace; color:var(--muted); }
    h2 { margin:0; font-size:clamp(28px,4vw,45px); line-height:1; letter-spacing:-.035em; }
    .meta { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; margin:0; background:var(--rule); border:1px solid var(--rule); }
    .meta div { min-width:0; padding:18px; background:var(--panel); }
    .meta dt { color:var(--muted); } .meta dd { margin:8px 0 0; overflow-wrap:anywhere; }
    table { width:100%; border-collapse:collapse; background:var(--panel); font-size:14px; }
    th,td { padding:15px 13px; text-align:left; vertical-align:top; border-bottom:1px solid var(--rule); }
    td small { display:block; margin-top:4px; color:var(--muted); }
    th { font:700 11px Consolas,"Courier New",monospace; letter-spacing:.08em; text-transform:uppercase; background:#e7e3d8; }
    .coverage { display:inline-block; padding:5px 7px; border:1px solid currentColor; }
    .coverage--covered { color:var(--green); } .coverage--partial { color:var(--orange); } .coverage--missing { color:var(--red); } .coverage--not_verifiable { color:var(--muted); }
    .finding { margin-top:24px; padding:0 28px 28px; border:1px solid var(--rule); border-top:7px solid var(--blue); background:var(--panel); box-shadow:var(--shadow); }
    .finding--critical { border-top-color:var(--red); } .finding--high { border-top-color:#d92d20; } .finding--medium { border-top-color:var(--orange); } .finding--low { border-top-color:var(--blue); }
    .finding > header { display:grid; grid-template-columns:72px 1fr; gap:20px; align-items:start; padding:24px 0 20px; }
    .finding__index { font:700 45px/.9 Consolas,"Courier New",monospace; color:var(--rule); }
    .finding h3 { margin:7px 0 0; font-size:24px; line-height:1.2; }
    .severity { color:var(--red); }
    .evidence { margin:14px 0; border:1px solid #252e2a; background:#17201d; color:#e8eee8; }
    .evidence figcaption { display:flex; flex-wrap:wrap; gap:12px; justify-content:space-between; padding:10px 13px; border-bottom:1px solid #46504b; font:12px Consolas,"Courier New",monospace; color:#b9c3bd; }
    pre { margin:0; padding:18px; overflow:auto; white-space:pre-wrap; word-break:break-word; font:13px/1.55 Consolas,"Courier New",monospace; }
    .action { display:grid; grid-template-columns:150px 1fr; gap:14px; margin:20px 0 0; padding-top:16px; border-top:1px solid var(--rule); }
    .action strong { font:700 11px Consolas,"Courier New",monospace; letter-spacing:.08em; text-transform:uppercase; }
    .criteria { color:var(--muted); }
    .two-col { display:grid; grid-template-columns:1fr 1fr; gap:22px; }
    .note { padding:24px; border-left:7px solid var(--ink); background:var(--panel); }
    .warning { display:grid; grid-template-columns:auto 1fr; gap:18px; margin:24px 0; padding:18px 22px; border:2px solid var(--orange); background:#fff4e5; }
    .warning strong { font:700 12px Consolas,"Courier New",monospace; letter-spacing:.08em; text-transform:uppercase; color:var(--orange); }
    .note h3 { margin:0 0 12px; font-size:22px; }
    ul { margin:0; padding-left:20px; } li+li { margin-top:9px; }
    .empty { margin:0; color:var(--muted); font-style:italic; }
    details { margin-top:30px; border:1px solid var(--rule); background:var(--panel); }
    summary { cursor:pointer; padding:15px 18px; font:700 12px Consolas,"Courier New",monospace; letter-spacing:.06em; text-transform:uppercase; }
    footer { margin-top:70px; padding-top:20px; border-top:2px solid var(--ink); display:flex; justify-content:space-between; gap:30px; color:var(--muted); font-size:13px; }
    @media (max-width:800px) { main{width:min(100% - 24px,1180px);padding-top:34px}.masthead{grid-template-columns:1fr}.stamp{width:max-content}.metrics{grid-template-columns:1fr 1fr}.meta{grid-template-columns:1fr 1fr}.two-col{grid-template-columns:1fr}.finding>header{grid-template-columns:45px 1fr}.action{grid-template-columns:1fr} }
    @media (max-width:480px) { .metrics,.meta{grid-template-columns:1fr}.finding{padding-left:17px;padding-right:17px} }
    @media print { html,body{background:white}body::before{display:none}main{width:100%;padding:0}.metrics,.finding{box-shadow:none}.finding{break-inside:avoid}.evidence{background:white;color:black}.evidence figcaption{color:#333}details{display:none} }
  </style>
</head>
<body>
<main>
  <header class="masthead">
    <div><span class="kicker">Informe privado · solo lectura</span><h1>${escapeHtml(report.repository)} <small>#${report.changeRequestNumber}</small></h1><p class="subtitle">${escapeHtml(report.changeRequestTitle)}</p></div>
    <div class="stamp stamp--${verdictClass(report.verdict)}">${escapeHtml(report.verdict.replaceAll("_", " "))}</div>
  </header>
  <div class="metrics" aria-label="Resumen de revisión">
    <div class="metric"><span>Estado</span><strong>${escapeHtml(report.status)}</strong><small>${escapeHtml(scopeLabel)} · ${escapeHtml(report.provider)} · ${escapeHtml(report.host)}</small></div>
    <div class="metric"><span>Hallazgos</span><strong>${report.findings.length}</strong><small>${critical} críticos · ${high} altos</small></div>
    <div class="metric"><span>Cobertura</span><strong>${report.coverage.length}</strong><small>implementación · ${report.testCoverage.length} en pruebas</small></div>
    <div class="metric"><span>Artefactos</span><strong>${artifactsLoaded}/${report.artifacts.length}</strong><small>cargados / inventariados</small></div>
    <div class="metric"><span>Uso</span><strong>${report.usage.inputTokens + report.usage.outputTokens}</strong><small>${report.usage.calls} llamadas · ${failedAttempts} fallidos · ${thinkingTokens} thinking</small></div>
    <div class="metric"><span>Costo estimado</span><strong>${costAmount === "—" ? "—" : `USD ${costAmount}`}</strong><small>${failedCostAmount === "—" ? "sin tarifa disponible" : `${partialCostLabel}USD ${failedCostAmount} en intentos fallidos`}</small></div>
  </div>
  ${incompleteNotice}

  <section><div class="section-head"><b>00</b><h2>Trazabilidad</h2></div>
    <dl class="meta">
      <div><dt>Feature</dt><dd>${escapeHtml(feature)}</dd></div><div><dt>Modelos explorador / orquestador</dt><dd>${escapeHtml(modelSummary)}</dd></div>
      <div><dt>Alcance</dt><dd>${escapeHtml(scopeLabel)}</dd></div>
      <div><dt>Planificación</dt><dd>${escapeHtml(planningSummary)}</dd></div>
      <div><dt>Cache leído</dt><dd>${cacheReadTokens} tokens</dd></div><div><dt>Thinking</dt><dd>${thinkingTokens} tokens</dd></div>
      <div><dt>HEAD SHA</dt><dd><code>${escapeHtml(report.headSha)}</code></dd></div><div><dt>Base SHA</dt><dd><code>${escapeHtml(report.baseSha)}</code></dd></div>
      <div><dt>Review ID</dt><dd><code>${escapeHtml(report.reviewId)}</code></dd></div><div><dt>Generado</dt><dd>${escapeHtml(report.createdAt)}</dd></div>
      <div><dt>Vence</dt><dd>${escapeHtml(report.expiresAt)}</dd></div><div><dt>Reviewer / schema</dt><dd>${escapeHtml(report.reviewerVersion ?? "legacy")} / ${escapeHtml(report.schemaVersion)}</dd></div>
    </dl>
  </section>

  <section><div class="section-head"><b>01</b><h2>${reviewScope === "test_only" ? "Implementación fuera de alcance" : "Cobertura de implementación"}</h2></div>
    <table><thead><tr><th>Criterio</th><th>Descripción</th><th>Estado</th><th>Evidencia / nota</th></tr></thead><tbody>${report.coverage.map(renderCoverageRow).join("")}</tbody></table>
  </section>

  <section><div class="section-head"><b>02</b><h2>${reviewScope === "test_only" ? "Revisión de tests" : "Cobertura de pruebas · evidencia secundaria"}</h2></div>
    <table><thead><tr><th>Criterio</th><th>Descripción</th><th>Estado</th><th>Evidencia / nota</th></tr></thead><tbody>${report.testCoverage.map(renderCoverageRow).join("")}</tbody></table>
  </section>

  <section><div class="section-head"><b>03</b><h2>Hallazgos verificados</h2></div>
    ${report.findings.length === 0 ? '<p class="empty">No se registraron hallazgos con evidencia verificable.</p>' : report.findings.map(renderFinding).join("")}
  </section>

  <section><div class="section-head"><b>04</b><h2>Juicio técnico</h2></div>
    <div class="two-col"><div class="note"><h3>Riesgos</h3>${renderList(report.risks, "Sin riesgos adicionales registrados.")}</div><div class="note"><h3>Decisiones del TL</h3>${renderList(report.pendingDecisions, "Sin decisiones pendientes registradas.")}</div></div>
  </section>

  <section><div class="section-head"><b>05</b><h2>Límites e inventario</h2></div>
    <div class="two-col"><div class="note"><h3>Limitaciones</h3>${renderList([...report.limitations, ...report.stagesIncomplete.map((stage) => `Etapa incompleta: ${stage}`)], "Ejecución completa dentro de los límites.")}</div><div class="note"><h3>Artefactos</h3>${renderList(
      report.artifacts.map((artifact) => `${artifact.status.toUpperCase()} · ${artifact.path}`),
      "No se inventariaron artefactos.",
    )}</div></div>
    <details><summary>Registro estructurado del informe</summary><pre><code>${escapeHtml(JSON.stringify(report, null, 2))}</code></pre></details>
  </section>

  <section><div class="section-head"><b>06</b><h2>Ejecución por slice</h2></div>
    <table><thead><tr><th>Slice</th><th>Tipo</th><th>Ejecución</th><th>Evaluación</th><th>Criterios</th><th>Fallo</th><th>Intentos</th><th>Tokens in/out</th><th>Request IDs</th></tr></thead><tbody>${renderSliceRows(report)}</tbody></table>
    <h3>Intentos de agentes</h3>
    <table><thead><tr><th>Rol</th><th>Modelo</th><th>Slice</th><th>Intento</th><th>Estado</th><th>Causa</th><th>Tokens in/out</th><th>Request ID</th></tr></thead><tbody>${renderAttemptRows(report)}</tbody></table>
  </section>

  <footer><span>La decisión final corresponde al Tech Lead. El reviewer no comentó, aprobó, rechazó ni modificó el PR/MR.</span><span>Vence ${escapeHtml(report.expiresAt)} · SHA ${escapeHtml(report.headSha.slice(0, 12))}</span></footer>
</main>
</body>
</html>`;
}
