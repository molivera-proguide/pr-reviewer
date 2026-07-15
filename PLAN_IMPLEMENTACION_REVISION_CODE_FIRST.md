# Plan de implementación: revisión code-first orientada a TL

## 1. Objetivo

Reorientar el reviewer para que se comporte como un Tech Lead: revisar prioritariamente la
implementación y utilizar los tests modificados como evidencia secundaria del comportamiento, no
como una revisión paralela de igual peso.

El flujo normal debe eliminar el `test_explorer` dedicado, reducir variabilidad y costo, conservar
la separación entre cobertura funcional y cobertura de pruebas en el reporte, y mantener un flujo
especializado únicamente para PRs que modifican exclusivamente tests.

## 2. Problema observado

Las corridas reales sobre el mismo SHA mostraron que el análisis independiente de tests:

- agregó una llamada Haiku completa al camino normal;
- produjo asociaciones inestables entre coverage, findings y evidencia;
- requirió contratos y repairs específicos que aumentaron complejidad;
- llegó a ejecutar un retry de schema sin mejorar el resultado;
- convirtió USD 0,028085 en costo de intentos fallidos en la corrida 0.4.9;
- dejó toda la cobertura de tests `not_verifiable` aunque el slice había generado salida;
- dio a los gaps de tests un peso operativo desproporcionado frente a la revisión funcional.

La optimización de la 0.4.8 demostró que la síntesis final puede ser determinista y que el camino
normal con repair puede limitarse a cinco llamadas. El diseño code-first debe reducirlo a tres o
cuatro llamadas en PRs pequeños sin debilitar la revisión de implementación.

## 3. Decisión funcional

### 3.1 PR con cambios de implementación

- La implementación es la fuente primaria de findings, cobertura y veredicto.
- Los tests modificados relacionados se incluyen en el mismo contexto de dominio que el código.
- El explorer devuelve cobertura de implementación obligatoria y observaciones de tests opcionales.
- Los tests pueden confirmar un criterio o exponer un gap material, pero nunca degradar cobertura
  funcional por sí solos.
- Un gap de tests conserva severidad máxima `medium`, no bloquea y no dispara repair ni Sonnet.
- La ausencia de tests modificados se reporta como falta de visibilidad, no como defecto.

### 3.2 PR test-only

- Si no existen archivos de implementación modificados, se usa un flujo `test_only` explícito.
- El objetivo es revisar corrección, intención, falsos positivos, assertions y escenarios de los
  tests modificados.
- No se infiere cobertura de implementación a partir de tests.
- La implementación se marca fuera del alcance del cambio, sin volver incompleta la revisión por
  ese único motivo.
- Los findings siguen siendo `test_coverage` o `maintainability`, con severidad máxima `medium` o
  `low` respectivamente.

### 3.3 Modo estricto opcional

Una futura opción explícita puede solicitar revisión exhaustiva de tests por criterio. No forma
parte del flujo predeterminado y no debe activarse implícitamente.

## 4. Invariantes

- Mantener el reviewer estrictamente read-only respecto de repositorios y providers.
- No ejecutar shell, tests, builds, hooks ni código del repositorio revisado.
- Leer snapshots únicamente mediante SHAs inmutables.
- Validar todas las fronteras no confiables con Zod.
- No persistir ni registrar prompts, contenidos del repositorio, respuestas completas o secretos.
- Preservar cancelación, límites de bytes, tokens, llamadas y confinamiento de paths.
- Una revisión incompleta, stale, cancelada o fallida nunca puede resultar green.
- Sólo findings de implementación verificados y `critical/high` pueden bloquear por severidad.
- `stdout` continúa reservado exclusivamente para MCP durante `mcp`.
- No agregar endpoints de checkout, fetch, install, test, build, hook, commit, comment, approval,
  merge o escritura.

## 5. Flujo objetivo

### 5.1 Clasificación inicial

Después de excluir artefactos SDD del snapshot:

1. clasificar archivos como implementación o tests mediante `sliceKindOf`;
2. detectar `implementation_with_tests`, `implementation_only` o `test_only`;
3. conservar el inventario global acotado para explicar aislamiento esperado;
4. no crear un slice de tests independiente cuando existe implementación modificada.

### 5.2 Slices orientados a dominio

Para PRs con implementación:

- agrupar primero por dominio/directorio de implementación;
- adjuntar tests modificados relacionados por directorio, basename o dominio;
- si la relación no es inequívoca y el cambio es pequeño, adjuntar los tests al slice de
  implementación menos cargado;
- no duplicar el mismo archivo de test entre slices;
- respetar el límite de caracteres y marcar truncamiento de forma conservadora;
- mantener un máximo acotado de slices y la concurrencia existente.

El tipo de slice debe distinguir alcance primario y evidencia secundaria, por ejemplo:

```ts
type ReviewSliceScope = "implementation" | "test_only";

interface ReviewSlice {
  scope: ReviewSliceScope;
  implementationFiles: ChangedFile[];
  testFiles: ChangedFile[];
  criteria: SddCriterion[];
}
```

No se deben mezclar dominios sin relación sólo para ahorrar una llamada.

### 5.3 Exploración code-first

El prompt principal recibe implementación y tests relacionados, con reglas explícitas:

- evaluar primero el comportamiento de implementación contra cada criterio;
- usar tests sólo como evidencia adicional;
- devolver como máximo un finding contractual por criterio e impacto;
- mantener coverage funcional y observaciones de tests en campos separados;
- no convertir ausencia de tests en defecto funcional;
- no declarar `missing` de tests cuando sólo se ven archivos parciales o aislados;
- no exigir un finding de tests para completar coverage funcional.

### 5.4 Repair de implementación

Se conserva una única llamada `coverage-repair-1` únicamente para criterios requeridos sin:

- assessment `covered` con evidencia válida; o
- finding de implementación verificado.

Reglas:

- sólo archivos de implementación;
- sólo criterios omitidos;
- contrato compacto `covered | defect`;
- sin repair recursivo;
- un resultado aceptado reemplaza únicamente assessments ambiguos anteriores de esos criterios;
- findings verificados siguen siendo autoritativos;
- duplicados equivalentes se consolidan localmente;
- evidencia inválida, outcomes contradictorios u omisiones producen una razón segura y acotada.

### 5.5 Verificación semántica y proyección final

- Sonnet recibe sólo findings de implementación `critical/high` y claims contractuales ambiguos.
- Test gaps y mantenibilidad ordinaria nunca entran en esa llamada costosa.
- Riesgos finales se proyectan desde claims verificados.
- Decisiones pendientes provienen únicamente de conflictos SDD extraídos.
- No se restaura una llamada de síntesis final.

## 6. Contratos propuestos

### 6.1 Resultado code-first

El structured output debe favorecer una sola evaluación criterion-keyed para implementación y una
observación opcional de tests, evitando arrays independientes que puedan contradecirse.

Ejemplo conceptual:

```ts
interface CriterionReview {
  criterionId: string;
  implementation:
    | { status: "covered"; evidence: Evidence[]; notes: string }
    | { status: "defect"; finding: ImplementationFinding };
  tests?:
    | { status: "covered"; evidence: Evidence[]; notes: string }
    | { status: "partial" | "missing"; evidence: Evidence[]; notes: string }
    | { status: "not_verifiable"; notes: string };
}
```

Los metadatos no esenciales de un test gap (`claim`, `confidence`, `suggestedAction`) no deben
provocar un retry de schema. Se derivan localmente con defaults conservadores:

- `claim`: `notes` acotadas;
- `confidence`: valor fijo conservador;
- `suggestedAction`: acción genérica criterion-specific.

La evidencia, el criterion ID y el estado sí permanecen obligatorios cuando se afirma
`covered`, `partial` o `missing`.

### 6.2 Alcance del reporte

Agregar alcance explícito para distinguir implementación no verificable de implementación fuera del
scope de un PR test-only. Alternativas a evaluar:

- añadir `reviewScope: "implementation" | "test_only"`; y
- añadir `not_in_scope` al coverage schema, o excluir cobertura funcional del cálculo de completitud
  cuando `reviewScope === "test_only"`.

Si se agrega metadata persistida, incrementar el schema del reporte y mantener lectura de versiones
anteriores.

## 7. Cambios por componente

### `src/review/slicer.ts`

- Separar clasificación de archivos de la composición de slices.
- Crear slices de implementación con tests relacionados como evidencia secundaria.
- Crear slices `test_only` sólo cuando no haya implementación modificada.
- Mantener presupuestos, truncamiento, determinismo y no duplicación de archivos.

### `src/review/agents/schemas.ts`

- Reemplazar el contrato paralelo de tests por un contrato code-first criterion-keyed.
- Hacer opcionales los metadatos derivables de test gaps.
- Mantener evidencia y asociaciones contractuales estrictas.
- Modelar explícitamente el resultado test-only si difiere del flujo normal.

### `prompts/code-explorer.md`

- Incorporar tests relacionados como evidencia secundaria.
- Priorizar implementación y prohíbir contaminación entre dimensiones.
- Exigir una evaluación de implementación por criterio asignado.

### `prompts/test-explorer.md`

- Retirar del flujo normal.
- Conservar o reemplazar por `test-only-explorer.md` con alcance exclusivo para PRs test-only.
- Evitar campos obligatorios que no afecten aceptación ni seguridad.

### `src/review/pipeline.ts`

- Seleccionar flujo normal o test-only según archivos modificados.
- Ejecutar una sola exploración por dominio en el flujo normal.
- Convertir observaciones opcionales de tests a `testCoverage` y findings no bloqueantes.
- Mantener repair exclusivamente funcional.
- Excluir test coverage del cálculo de completitud funcional.
- Mantener proyección final determinista y Sonnet sólo para material de implementación.

### `src/domain/contracts.ts`

- Agregar metadata de scope sólo si es necesaria para representar correctamente PRs test-only.
- Mantener compatibilidad hacia atrás del reporte.

### Reporte HTML y MCP

- Mostrar claramente `Revisión de implementación` o `PR test-only`.
- Presentar tests como evidencia secundaria en el flujo normal.
- Mantener findings de tests visibles sin elevarlos a bloqueantes.
- No mostrar `not_verifiable` funcional como una falla cuando la implementación está fuera de scope.
- Mantener diagnósticos de intentos y costos sin contenido sensible.

### Skill

- Actualizar únicamente si cambia la interpretación que Claude debe comunicar.
- Explicar que los tests complementan la revisión funcional y no son una puerta de aprobación.

## 8. Política de costo

### Camino normal esperado

PR pequeño con implementación y tests relacionados:

1. `sdd_explorer`;
2. `code_explorer` code-first;
3. `coverage-repair-1` sólo si faltan criterios de implementación;
4. `semantic_verifier` sólo si hay findings materiales.

Objetivo: tres llamadas sin repair y máximo cuatro con repair para el fixture actual.

### PR test-only

1. `sdd_explorer`;
2. `test_only_explorer`.

Objetivo: dos llamadas, sin Sonnet salvo que una futura política explícita lo justifique.

### Límites

- Cero retries por metadata opcional de test gaps.
- Cero llamada final de síntesis.
- Cero repair de cobertura de tests.
- Preservar el máximo global de llamadas como última barrera.
- Mantener costo del fixture por debajo de la corrida 0.4.8: USD 0,04857.
- Objetivo de costo fallido: USD 0,00 en el camino normal.

## 9. Pruebas requeridas

### Slicer

- Adjunta tests relacionados al slice de implementación correcto.
- No duplica tests entre slices.
- No mezcla dominios no relacionados.
- Produce test-only cuando no hay implementación.
- Conserva byte budgets y truncamiento.

### Contratos

- Exige una evaluación funcional por criterio asignado.
- Acepta test gap sin metadata derivable y aplica defaults locales.
- Rechaza criterion IDs externos.
- Rechaza evidencia inválida para estados verificables.
- Consolida duplicados equivalentes y rechaza outcomes contradictorios.

### Cobertura y findings

- Un gap de tests no modifica implementation coverage.
- Tests relacionados pueden producir `partial` sin una llamada separada.
- Ausencia de tests modificados queda `not_verifiable`, no `missing`.
- Findings de tests nunca bloquean ni superan `medium`.
- Repair aceptado reemplaza sólo assessments ambiguos solicitados.
- Findings funcionales verificados prevalecen sobre coverage optimista.

### Test-only

- No infiere implementación cubierta desde tests.
- No vuelve incompleta la revisión sólo porque implementación esté fuera de scope.
- Detecta assertions débiles, tautológicas o que prueban el comportamiento equivocado.
- Nunca produce veredicto bloqueante por un gap de cobertura aislado.

### Regresión E2E

Para el fixture de descuentos:

- una sola llamada code-first contiene implementación y tests;
- AC-002 y AC-003 conservan findings funcionales criterion-specific;
- AC-001 queda cubierto;
- AC-003 de tests queda partial por probar 10% sin el cap;
- AC-002 de tests queda missing si Silver no aparece en assertions;
- AC-004 de tests queda partial por verificar totales pero omitir entradas inválidas;
- IDs permanecen estables en tres corridas del mismo SHA;
- máximo cuatro llamadas con repair;
- cero intentos fallidos;
- costo inferior a USD 0,04857;
- una revisión incompleta nunca queda green.

## 10. Secuencia de implementación

1. Añadir clasificación de scope y composición de slices code-first.
2. Diseñar el schema criterion-keyed con metadata de tests derivable.
3. Adaptar el prompt principal para usar tests como evidencia secundaria.
4. Integrar el flujo test-only.
5. Eliminar `test_explorer` del camino normal y cualquier retry causado por metadata opcional.
6. Mantener y verificar precedencia del repair funcional.
7. Actualizar reporte, contratos y documentación si se agrega scope persistido.
8. Añadir unit, contract, security y E2E tests.
9. Ejecutar `bun run typecheck`, `bun run lint`, tests relevantes y `bun run check`.
10. Compilar y verificar el artefacto.
11. Ejecutar tres corridas reales sobre el mismo SHA y comparar costo, calls, findings y coverage.
12. Incrementar versión e instalar sólo después de cumplir los criterios de aceptación.

## 11. Criterios de aceptación

- El flujo normal no ejecuta un `test_explorer` independiente.
- Código y tests relacionados se revisan en una sola llamada por dominio.
- Implementation coverage y test coverage permanecen separados en dominio y reporte.
- Test gaps nunca contaminan implementación ni veredicto bloqueante.
- Test-only está representado explícitamente y no genera incompletitud funcional artificial.
- Repair funcional conserva una sola llamada y precedencia acotada.
- Sonnet recibe sólo material de implementación o claims contractuales ambiguos.
- No existe síntesis final modelada.
- Cero retries por campos derivables.
- Máximo cuatro llamadas en el fixture con repair.
- Costo real menor a USD 0,04857 y costo fallido igual a USD 0,00.
- Tres corridas del mismo SHA mantienen IDs, asociaciones y cobertura estables.
- Typecheck, lint, tests, build y verificación del binario pasan.

## 12. Fuera de alcance

- Ejecutar tests, builds o comandos del repositorio revisado.
- Inspeccionar cobertura runtime o archivos generados por herramientas de coverage.
- Publicar comentarios, approvals, commits o merges.
- Hacer bloqueante un gap de tests aislado.
- Agregar llamadas para compensar structured output inestable.
- Implementar el modo estricto de tests en esta fase.
- Aumentar concurrencia, tokens o budgets para ocultar omisiones del modelo.
