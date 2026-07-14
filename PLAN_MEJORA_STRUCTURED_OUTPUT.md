# Plan de mejora: resiliencia del pipeline de revisión

## 1. Contexto

La revisión real del PR `molivera-proguide/test-pr-reviewer#1`, HEAD
`ecb4ccfd7d3815f1538856706ca55980d2f3f979`, resolvió correctamente el repositorio, el feature
`001`, los artefactos SDD y el snapshot inmutable, pero terminó con:

- estado `incomplete`;
- veredicto `REQUIERE_DECISION`;
- limitación `code_explorer failed after one structured-output repair attempt`;
- cero criterios preservados en el informe;
- cero hallazgos, aunque el cambio contiene dos incumplimientos obligatorios conocidos.

El comportamiento fail-closed fue correcto: una ejecución incompleta no recibió un veredicto
verde. Sin embargo, el resultado no fue útil para el Tech Lead y demuestra que la tolerancia a
fallos del pipeline todavía es insuficiente.

## 2. Objetivo

Conseguir que una salida inválida, truncada o rechazada por un agente:

1. sea clasificada con precisión sin registrar contenido sensible;
2. reciba una estrategia de recuperación adecuada a su causa;
3. no descarte resultados válidos de otros slices;
4. preserve los criterios SDD y muestre cobertura parcial;
5. nunca permita un veredicto verde si quedó una porción sin revisar.

La mejora se considera terminada cuando el PR de regresión `#1` produce una revisión completa y
detecta con evidencia verificable los incumplimientos de `AC-002` y `AC-003`.

## 3. Invariantes que no deben cambiar

- Mantener acceso estrictamente read-only al repositorio y al proveedor.
- No ejecutar checkout, fetch, builds, tests, hooks ni código del repositorio revisado.
- No persistir ni registrar API keys, prompts completos, respuestas completas del modelo o código
  fuente recibido.
- Mantener snapshots direccionados por SHA y volver a validar el HEAD antes del veredicto.
- Exigir evidencia determinística: revisión, ruta, líneas 1-based y excerpt exacto.
- Una revisión parcial, truncada, rechazada, cancelada o fallida nunca puede ser verde.
- Respetar los límites de tiempo, llamadas, tokens, bytes y concurrencia existentes.

## 4. Diagnóstico del diseño actual

### 4.1 Reintento sin contexto de reparación

El segundo intento de `AnthropicAgentClient.run` dice "Repair the previous invalid structured
response", pero abre una solicitud nueva que contiene solamente el payload original. No incluye la
respuesta inválida anterior ni un resumen de los errores de validación. En la práctica repite el
análisis en lugar de reparar una salida concreta.

### 4.2 Errores diferentes reciben el mismo tratamiento

Actualmente se reintenta de igual manera ante:

- `stop_reason: max_tokens`;
- `stop_reason: refusal`;
- violación del esquema Zod posterior a la transformación del SDK;
- error transitorio de red o API;
- error permanente de configuración;
- agotamiento de presupuesto.

Anthropic documenta que incluso con structured outputs puede haber una salida no conforme por
`refusal` o `max_tokens`. Estas causas requieren decisiones diferentes: ampliar/reducir el payload
para truncamiento, no repetir ciegamente un rechazo y aplicar backoff solamente a errores
transitorios.

### 4.3 Un slice fallido descarta todo el análisis

`Promise.all` hace que el fallo de un solo `code_explorer` aborte `runReviewPipeline`. El servicio
reemplaza entonces todo el resultado por un fallback vacío, perdiendo:

- el análisis SDD ya completado;
- criterios y decisiones extraídos;
- findings válidos de otros slices;
- cobertura parcial y uso real por etapa.

### 4.4 Diagnóstico insuficiente

Los logs conservan únicamente `error.name`. El informe no permite distinguir truncamiento,
rechazo, error del SDK, incompatibilidad del esquema o validación Zod. Tampoco identifica el slice
afectado ni el `request_id` seguro para soporte.

### 4.5 Presupuesto potencialmente subcontado

Si `messages.parse` recibe una respuesta facturable pero falla al parsearla, el catch libera la
reserva sin registrar los tokens de esa respuesta. Además, otros workers concurrentes pueden
continuar después de que `Promise.all` ya rechazó. El informe puede subestimar costo y actividad.

### 4.6 Esquema y payload con alta presión de salida

Cada slice recibe todos los criterios y puede devolver findings, cobertura y evidencia completa
para cada uno. Con varios dominios modificados se repite información, aumenta el tamaño de salida y
se consume el presupuesto disponible para JSON estructurado.

## 5. Diseño objetivo

### 5.1 Resultado tipado por intento

Introducir una clasificación interna que no contenga texto sensible:

```ts
type AgentFailureKind =
  | "max_tokens"
  | "refusal"
  | "schema_validation"
  | "transient_api"
  | "permanent_api"
  | "budget"
  | "cancelled";
```

Cada intento debe conservar solamente:

- rol y `sliceId` opcional;
- número de intento;
- clasificación;
- `stop_reason`;
- `request_id`;
- estado HTTP cuando exista;
- tokens de entrada/salida;
- paths de validación Zod, sin valores recibidos.

### 5.2 Recuperación específica por causa

- `max_tokens`: reducir el slice o aumentar `max_tokens` solamente si el presupuesto lo permite.
- `schema_validation`: realizar una reparación real en memoria, enviando la salida anterior como
  datos no confiables junto con los paths de validación. No registrar ni persistir esa salida.
- `transient_api`: respetar los retries/backoff del SDK y evitar duplicar reintentos de aplicación.
- `refusal`: no repetir el mismo prompt; marcar el slice como no revisado.
- `permanent_api`, `budget` o `cancelled`: detener nuevos intentos y propagar una causa explícita.

Antes de implementar la reparación, evaluar cambiar de `messages.parse` a `messages.create` con
`output_config.format`, parseo explícito y `schema.safeParse`. Esto permite observar
`stop_reason`, uso y request ID incluso cuando la respuesta no pasa la validación final.

### 5.3 Resultado parcial por slice

Cada slice debe producir uno de estos resultados:

```ts
type CodeSliceResult =
  | { status: "completed"; analysis: CodeAnalysis; diagnostics: AttemptSummary[] }
  | { status: "incomplete"; limitation: string; diagnostics: AttemptSummary[] };
```

El pipeline debe esperar la finalización controlada de todos los workers y combinar los resultados
exitosos. Si un slice falla:

- conservar findings y cobertura válidos de los demás;
- preservar todos los criterios extraídos por `sdd_explorer`;
- marcar como `not_verifiable` los criterios afectados;
- añadir `code_exploration:<slice-id>` a `stagesIncomplete`;
- fijar el estado global en `incomplete` y el veredicto en `REQUIERE_DECISION` o
  `RIESGO_BLOQUEANTE` si ya existe un bloqueante verificado;
- impedir siempre `SIN_HALLAZGOS_BLOQUEANTES`.

### 5.4 Salida más pequeña y predecible

- Indicar que un `code_explorer` solo debe devolver cobertura respaldada por su slice.
- Evitar que cada slice repita cobertura vacía para todos los criterios.
- Añadir descripciones breves a campos ambiguos del esquema, especialmente IDs, líneas y excerpts.
- Revisar las restricciones Zod transformadas por `zodOutputFormat`; mantener la validación local
  estricta, pero evitar constraints redundantes que no aporten seguridad.
- Evaluar separar candidatos de hallazgos y cobertura si la medición confirma que el esquema
  combinado causa truncamiento.
- No aumentar el límite global de 8 llamadas ni 40 000 tokens hasta medir el efecto de estas
  reducciones.

### 5.5 Reporte útil aun cuando sea incompleto

Extender el informe sin incluir contenido del modelo:

- criterios SDD preservados y estado `not_verifiable` cuando corresponda;
- slices completados y omitidos;
- categoría de fallo por etapa;
- cantidad de intentos y tokens contabilizados;
- mensaje visible: "0 hallazgos no equivale a 0 defectos: parte del cambio no fue revisada";
- request IDs seguros para diagnóstico.

Si se modifica el JSON del informe, incrementar `schemaVersion` a `1.1` y mantener lectura
compatible de informes `1.0` durante la transición.

## 6. Plan de implementación

### Fase 1 — Diagnóstico y contabilidad

- [ ] Añadir códigos de error específicos para truncamiento, rechazo, validación y API.
- [ ] Incorporar `AgentFailureKind`, `AttemptSummary` y un error de agente tipado.
- [ ] Capturar `stop_reason`, `request_id`, estado HTTP y uso sin guardar contenido.
- [ ] Contabilizar tokens facturables aunque falle el parseo local.
- [ ] Añadir `role`, `sliceId` e intento a logs seguros.
- [ ] Añadir tests unitarios para redacción de todos los metadatos de error.

Archivos principales:

- `src/anthropic/agent-client.ts`
- `src/domain/errors.ts`
- `src/security/budget.ts`
- `src/observability/logger.ts`

### Fase 2 — Estrategia de structured outputs

- [ ] Prototipar `messages.create` + `output_config.format` + `schema.safeParse`.
- [ ] Clasificar `max_tokens` y `refusal` antes de intentar parsear.
- [ ] Implementar una sola reparación contextual para `schema_validation`.
- [ ] Mantener la respuesta inválida únicamente en memoria y dentro del límite de bytes.
- [ ] Enviar en la reparación solo los paths de error, nunca detalles con valores sensibles.
- [ ] Aplicar reducción determinística del payload ante `max_tokens`.
- [ ] Evitar un retry adicional cuando el SDK ya agotó sus reintentos transitorios.

Archivos principales:

- `src/anthropic/agent-client.ts`
- `src/review/agents/schemas.ts`
- `prompts/shared/security.md`

### Fase 3 — Pipeline parcial y concurrencia controlada

- [ ] Asociar cada request de código con un `sliceId`.
- [ ] Reemplazar el comportamiento all-or-nothing por resultados tipados por slice.
- [ ] Esperar o cancelar explícitamente workers restantes antes de generar el informe.
- [ ] Conservar el resultado de `sdd_explorer` si falla una etapa posterior.
- [ ] Ejecutar verificación semántica sobre findings materiales disponibles.
- [ ] Sintetizar cobertura parcial o construirla determinísticamente si el sintetizador no puede
      ejecutarse.
- [ ] Marcar criterios no cubiertos como `not_verifiable`, no eliminarlos.
- [ ] Garantizar por test que cualquier slice incompleto impide un veredicto verde.

Archivos principales:

- `src/review/pipeline.ts`
- `src/review/slicer.ts`
- `src/review/verdict.ts`
- `src/application/reviewer-service.ts`

### Fase 4 — Simplificación de prompt y esquema

- [ ] Especificar en `code-explorer.md` que la cobertura devuelta debe pertenecer al slice.
- [ ] Añadir descripciones de schema para reducir ambigüedad semántica.
- [ ] Medir tamaño de payload y salida por slice usando solo conteos seguros.
- [ ] Evitar duplicación de criterios y contenido entre slices cuando sea determinísticamente
      posible.
- [ ] Agregar un límite por cantidad de findings/coverage si la API y el SDK lo soportan sin
      debilitar la validación local.

Archivos principales:

- `prompts/code-explorer.md`
- `src/review/agents/schemas.ts`
- `src/review/slicer.ts`

### Fase 5 — Informe y observabilidad

- [ ] Mostrar cobertura SDD aun con pipeline incompleto.
- [ ] Mostrar slices completados/fallidos y la categoría segura de error.
- [ ] Diferenciar visualmente "sin hallazgos" de "no revisado".
- [ ] Añadir métricas de intentos, fallos clasificados y uso contabilizado.
- [ ] Actualizar renderer, contrato del informe y documentación de seguridad.

Archivos principales:

- `src/domain/contracts.ts`
- `src/report/html-renderer.ts`
- `templates/report.html`
- `docs/security-model.md`
- `docs/architecture.md`

### Fase 6 — Regresión y aceptación

- [ ] Agregar fixtures de `success`, `max_tokens`, `refusal`, schema inválido y error transitorio.
- [ ] Probar un pipeline de tres slices donde uno falla y dos conservan resultados.
- [ ] Probar que workers tardíos no continúan después de cerrar el pipeline.
- [ ] Probar contabilidad de presupuesto en respuestas recibidas pero no parseables.
- [ ] Probar que logs e informes nunca contienen el output inválido ni datos del repositorio.
- [ ] Añadir un E2E determinístico basado en el diff y SDD de `test-pr-reviewer#1`.
- [ ] Ejecutar tres revisiones live consecutivas del PR `#1` como prueba manual de estabilidad.

Archivos principales:

- `tests/unit/agent-client.test.ts`
- `tests/unit/budget-verdict.test.ts`
- `tests/e2e/pipeline.test.ts`
- `tests/security/prompt-injection.test.ts`
- nuevo fixture sanitizado de `test-pr-reviewer#1`

## 7. Criterios de aceptación

### Funcionales

- El PR de prueba termina `completed` en tres ejecuciones live consecutivas.
- Se detecta `AC-002`: Silver recibe 10% en vez de 5%.
- Se detecta `AC-003`: Gold no aplica el máximo de 5000 centavos.
- Ambos findings citan `src/discount.ts`, HEAD correcto, línea 9 y excerpt exacto.
- El veredicto final es `RIESGO_BLOQUEANTE`.
- Si se fuerza el fallo de un slice, el informe conserva los cuatro criterios SDD, muestra cobertura
  parcial y nunca queda verde.

### Seguridad

- Ningún test, log o informe contiene API keys, prompts completos, outputs completos o bodies del
  proveedor.
- Toda evidencia continúa pasando por el verificador determinístico.
- No se agregan comandos ni endpoints mutantes.
- La reparación trata la respuesta previa como datos no confiables.

### Operación

- Máximo predeterminado de 8 llamadas y 40 000 tokens de salida.
- Timeout total máximo de 15 minutos.
- Concurrencia máxima de dos exploradores de código.
- La contabilidad reportada incluye todos los intentos facturables observables.
- `bun run check` y el smoke test del binario permanecen verdes.

## 8. Orden recomendado de entrega

1. Fase 1 para obtener evidencia precisa del siguiente fallo.
2. Fase 3 para evitar pérdida total de resultados desde el primer cambio.
3. Fase 2 para corregir la recuperación por causa.
4. Fase 4 para reducir la probabilidad de truncamiento/validación.
5. Fase 5 para hacer visibles los estados parciales.
6. Fase 6 para cerrar con regresión determinística y prueba live.

Cada fase debe ser un commit revisable y mantener el gate completo en verde. La versión objetivo
sugerida es `0.3.0`.

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| La reparación duplica costo | Un solo intento contextual y presupuesto reservado antes de llamar |
| El output previo contiene prompt injection | Encapsularlo como datos no confiables y no otorgarle instrucciones |
| Resultados parciales confunden al TL | Estado `incomplete`, cobertura `not_verifiable` y aviso visible |
| Más diagnósticos filtran contenido | Permitir solo enums, conteos, IDs de request y paths de validación |
| Workers continúan después de un fallo | Cancelación de etapa y espera explícita antes del informe |
| Simplificar el esquema pierde señal | Medir cobertura/hallazgos antes y después con el fixture de regresión |

## 10. Referencias

- [Anthropic: Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic: Messages API y stop reasons](https://platform.claude.com/docs/en/api/typescript/messages)
- Reporte de reproducción local: `pr-1-ecb4ccfd7d3815f1538856706ca55980d2f3f979.html`

## 11. Estado de implementación

Implementado en la versión `0.3.0`: clasificación y contabilidad segura por intento, parseo local
con `messages.create`, reparación contextual única, recuperación por `max_tokens`, agregación
parcial por slice, fallback determinístico de cobertura, reporte `1.1` compatible con `1.0`,
observabilidad segura y fixtures de regresión para AC-002/AC-003.

El gate automatizado completo pasa. Queda como validación operativa manual ejecutar tres revisiones
live consecutivas del PR `#1` con credenciales corporativas y confirmar estabilidad contra el
servicio real.
