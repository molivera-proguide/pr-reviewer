# Plan de implementacion - SDD PR Reviewer

## 1. Estado y decisiones cerradas

Este documento define el plan de implementacion del MVP de **SDD PR Reviewer**. Es el roadmap tecnico de ejecucion del proyecto independiente ubicado en `pr-reviewer`; no modifica ni forma parte del repositorio `sdd-model-v1.1`.

Decisiones cerradas:

- Lenguaje: TypeScript en modo estricto.
- Runtime, gestor de paquetes, test runner y compilador: Bun.
- Integracion con Claude Code: servidor MCP local mediante transporte `stdio`.
- Interfaz humana: Claude Code conversa con el Tech Lead; el servidor MCP no presenta prompts interactivos.
- Proveedores: arquitectura agnostica con adaptadores iniciales para GitHub y GitLab.
- Acceso a proveedores: CLI oficiales `gh` y `glab`, ya instaladas y autenticadas por el TL.
- Modelo: un unico modelo Claude Sonnet 5, configurable mediante identificador de modelo para evitar acoplar el codigo a un alias que pueda cambiar.
- Autenticacion Anthropic: `ANTHROPIC_API_KEY` corporativa, recibida exclusivamente desde el entorno.
- Efectos externos: solo lectura. El MVP no comenta, no aprueba, no rechaza, no modifica y no hace merge.
- Unidad de trabajo: la tool acepta una coleccion, pero el MVP admite exactamente un PR/MR por invocacion. La estructura queda preparada para procesamiento secuencial posterior.
- Resultado: resumen estructurado para Claude Code y HTML autocontenido temporal fuera del repositorio.
- Persistencia: informe con vigencia de 24 horas y asociado al HEAD SHA revisado.

## 2. Objetivo verificable del MVP

Desde Claude Code, un TL debe poder pedir que se enumeren los PR/MR abiertos del proyecto actual, elegir uno y ordenar su revision. El servidor MCP debe obtener una instantanea inmutable del cambio, relacionarla con exactamente una feature `specs/NNN-*`, revisar implementacion y artefactos SDD mediante agentes internos aislados, y devolver un informe privado y trazable sin alterar el repositorio ni el PR/MR.

El MVP se considera exitoso cuando el siguiente flujo funciona tanto con GitHub como con GitLab:

1. Claude Code descubre las tools del servidor MCP.
2. `list_open_change_requests` devuelve cambios abiertos y su HEAD SHA.
3. El TL elige un cambio en la conversacion.
4. Claude Code invoca `review_change_requests` con la seleccion y confirmacion del TL.
5. El servidor valida que el HEAD SHA no haya cambiado.
6. El servidor resuelve una unica carpeta de feature y carga sus artefactos.
7. Los agentes revisan el cambio sin ejecutar codigo del PR/MR.
8. Los hallazgos contienen evidencia verificable.
9. El servidor genera un HTML fuera del repositorio y devuelve un resumen acotado.
10. El estado del repositorio y del PR/MR permanece sin cambios.

## 3. Limites del MVP

Queda explicitamente fuera de alcance:

- Comentarios generales o inline en GitHub/GitLab.
- Aprobacion, rechazo, cierre o merge.
- Commits, ramas, patches, checkout o write-back.
- Modificacion de specs, registry, graph, metrics o cualquier archivo del proyecto revisado.
- Ejecucion de tests, builds, hooks, scripts o dependencias del PR/MR.
- `git fetch`, instalacion de dependencias o cualquier operacion que modifique `.git` o el worktree.
- CI, Docker, webhooks, GitHub Apps y status checks.
- Procesamiento concurrente de varios PR/MR.
- Uso de la suscripcion de Claude Code como sustituto de la API key corporativa.
- Servidor MCP remoto. El MVP utiliza exclusivamente `stdio` local.
- Plataforma de plugins o herramientas arbitrarias para los agentes internos.

## 4. Arquitectura objetivo

```text
Tech Lead
   |
   v
Claude Code (host/cliente MCP)
   |
   | JSON-RPC sobre stdin/stdout
   v
pr-reviewer mcp (binario Bun compilado)
   |
   +-- MCP tools
   |     +-- reviewer_doctor
   |     +-- list_open_change_requests
   |     +-- review_change_requests
   |
   +-- Application services
   |     +-- resolver de repositorio
   |     +-- selector de proveedor
   |     +-- coordinador de revision
   |     +-- control de presupuesto/cancelacion
   |
   +-- Provider ports
   |     +-- GitHub adapter -> gh
   |     +-- GitLab adapter -> glab
   |
   +-- SDD context
   |     +-- resolver specs/NNN-*
   |     +-- lector de artefactos en HEAD SHA
   |     +-- ensamblador de slices
   |
   +-- Anthropic
   |     +-- explorador SDD
   |     +-- exploradores de codigo
   |     +-- verificador
   |     +-- sintetizador
   |
   +-- Outputs
         +-- structuredContent para Claude Code
         +-- HTML temporal autocontenido
```

### 4.1 Separacion de responsabilidades

**Claude Code**:

- Interpreta la intencion del TL.
- Invoca las tools MCP.
- Presenta la lista de PR/MR.
- Espera la seleccion explicita del TL.
- Resume el resultado devuelto por la tool.

**Servidor MCP**:

- No conversa ni solicita datos por terminal.
- Valida todos los inputs recibidos.
- Ejecuta el workflow completo de revision.
- Controla proveedor, instantanea, agentes, presupuesto e informe.
- Usa `stdout` exclusivamente para mensajes MCP.
- Envia diagnostico tecnico exclusivamente a `stderr`.

**Agentes internos**:

- Se autentican con `ANTHROPIC_API_KEY`.
- No reciben la conversacion de Claude Code.
- No reciben herramientas de shell, escritura o ejecucion.
- Trabajan con contextos separados y salidas validadas.

## 5. Stack tecnico

### 5.1 Dependencias de produccion

- Bun: runtime, package manager y compilacion a ejecutable.
- TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` y `useUnknownInCatchVariables`.
- `@modelcontextprotocol/sdk` v1.x: SDK MCP estable; no adoptar v2 mientras permanezca en pre-alpha.
- `@anthropic-ai/sdk`: cliente oficial de Anthropic.
- `zod`: schemas de inputs MCP, configuracion, respuestas de agentes e informe.
- `yaml`: lectura segura de registry, graph y artefactos YAML cuando existan.

Dependencias adicionales solo se incorporaran si eliminan una responsabilidad relevante. No se agregara un framework CLI, logger o templating mientras las APIs de Bun y modulos internos sean suficientes.

### 5.2 Herramientas de desarrollo

- `bun:test`: unitarias, integracion y contratos.
- `tsc --noEmit`: verificacion estatica independiente del transpiler de Bun.
- Biome: formato y lint con configuracion versionada.
- MCP Inspector o cliente MCP de prueba: smoke/conformance del transporte.

### 5.3 Comandos previstos

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run test:integration
bun run build
```

El ejecutable tendra tres comandos:

```text
pr-reviewer mcp
pr-reviewer doctor
pr-reviewer --version
```

`mcp` es la superficie principal. `doctor` y `--version` son auxiliares para instalacion y soporte. `version` se conserva como alias compatible.

## 6. Estructura prevista del repositorio

```text
pr-reviewer/
|-- AGENTS.md
|-- README.md
|-- LICENSE
|-- package.json
|-- bun.lock
|-- tsconfig.json
|-- biome.json
|-- PLAN_IMPLEMENTACION.md
|-- docs/
|   |-- architecture.md
|   |-- security-model.md
|   |-- distribution.md
|   `-- decisions/
|       `-- 001-typescript-bun-mcp-stdio.md
|-- specs/
|   `-- 001-sdd-pr-reviewer/
|       |-- input.md
|       |-- constitution.md
|       |-- spec.md
|       |-- plan.md
|       `-- tasks.md
|-- src/
|   |-- main.ts
|   |-- cli/
|   |-- config/
|   |-- domain/
|   |-- application/
|   |-- mcp/
|   |   |-- server.ts
|   |   |-- protocol.ts
|   |   `-- tools/
|   |-- providers/
|   |   |-- provider.ts
|   |   |-- github/
|   |   `-- gitlab/
|   |-- repository/
|   |-- sdd/
|   |-- review/
|   |   |-- coordinator.ts
|   |   |-- context-builder.ts
|   |   |-- slicer.ts
|   |   |-- evidence-verifier.ts
|   |   `-- agents/
|   |-- anthropic/
|   |-- report/
|   |-- security/
|   `-- observability/
|-- prompts/
|   |-- shared/
|   |-- sdd-explorer.md
|   |-- code-explorer.md
|   |-- verifier.md
|   `-- synthesizer.md
|-- templates/
|   `-- report.html
|-- tests/
|   |-- unit/
|   |-- integration/
|   |-- contract/
|   |-- security/
|   |-- e2e/
|   `-- fixtures/
`-- scripts/
    |-- build.ts
    `-- verify-artifact.ts
```

## 7. Contratos de dominio

Los contratos centrales se definen primero y no importan SDKs de MCP, Anthropic, `gh` o `glab`.

### 7.1 Entidades principales

- `RepositoryIdentity`: proveedor, host, owner/group, nombre y remote normalizado.
- `ChangeRequestSummary`: numero, titulo, autor, ramas, draft, fecha y HEAD SHA.
- `ChangeRequestSnapshot`: metadata completa, base SHA, HEAD SHA, diff y archivos cambiados.
- `ChangedFile`: path anterior/actual, estado, patch, contenido HEAD/base y truncamiento.
- `FeatureReference`: numero detectado, origen de la deteccion y carpeta resuelta.
- `Artifact`: path, tipo, SHA/identidad, contenido y estado de lectura.
- `ReviewSlice`: criterios SDD, archivos asignados, diff y presupuesto.
- `Finding`: severidad, categoria, afirmacion, evidencia, ubicacion, confianza y accion sugerida.
- `ReviewCoverage`: criterio, estado (`covered`, `partial`, `missing`, `not_verifiable`) y evidencia.
- `ReviewReport`: metadata, trazabilidad, cobertura, hallazgos, riesgos, estado y veredicto.
- `UsageBudget`: limites, consumo acumulado y causa de interrupcion.

### 7.2 Puerto de proveedor

```typescript
interface RepositoryProvider {
  readonly kind: "github" | "gitlab";
  checkAuthentication(signal: AbortSignal): Promise<AuthStatus>;
  identifyRepository(signal: AbortSignal): Promise<RepositoryIdentity>;
  listOpenChangeRequests(limit: number, signal: AbortSignal): Promise<ChangeRequestSummary[]>;
  getChangeRequest(number: number, signal: AbortSignal): Promise<ChangeRequestSnapshot>;
  getCurrentHeadSha(number: number, signal: AbortSignal): Promise<string>;
  listTree(revision: string, prefix: string, signal: AbortSignal): Promise<TreeEntry[]>;
  readTextFile(revision: string, path: string, signal: AbortSignal): Promise<SnapshotFile>;
}
```

El dominio no conoce comandos concretos. Cada adaptador construye invocaciones permitidas y transforma JSON externo en contratos validados.

## 8. Superficie MCP

### 8.1 Resolucion del proyecto

El root se resuelve en este orden:

1. `repository_path` opcional recibido por la tool.
2. `CLAUDE_PROJECT_DIR`, establecido por Claude Code para servidores `stdio`.
3. `roots/list` si el cliente anuncia esa capacidad y existe una unica raiz aplicable.
4. Error explicito; no usar silenciosamente un `cwd` ambiguo.

La ruta se canonicaliza, debe existir, contener `.git` y permanecer dentro de una raiz aprobada. El root resuelto se incluye en todos los resultados para hacer visible la decision.

### 8.2 `reviewer_doctor`

Input:

```json
{
  "repository_path": "opcional"
}
```

Verifica sin modificar estado:

- Version y plataforma del binario.
- Resolucion del proyecto.
- Remote y proveedor detectado.
- Disponibilidad de `git`, `gh` o `glab`.
- Autenticacion contra el host correspondiente.
- Presencia de `ANTHROPIC_API_KEY`, sin revelar su valor.
- Acceso de escritura al directorio local de informes, nunca al repositorio.
- Presencia de `specs/` como advertencia diagnóstica.

### 8.3 `list_open_change_requests`

Input:

```json
{
  "repository_path": "opcional",
  "limit": 50
}
```

Output estructurado:

```json
{
  "provider": "github",
  "repository": "company/project",
  "root": "C:/project",
  "change_requests": [
    {
      "number": 42,
      "title": "feat(014): vulnerability tools",
      "author": "developer",
      "source_branch": "feature/014-vuln-tools",
      "target_branch": "main",
      "draft": false,
      "head_sha": "abc123",
      "updated_at": "2026-07-13T00:00:00Z"
    }
  ]
}
```

### 8.4 `review_change_requests`

Input:

```json
{
  "repository_path": "opcional",
  "tl_confirmed": true,
  "selections": [
    {
      "number": 42,
      "expected_head_sha": "abc123"
    }
  ]
}
```

Reglas:

- `selections` se modela como array desde el inicio.
- En el MVP: `min(1)` y `max(1)`.
- `tl_confirmed` debe ser `true`; la descripcion de la tool instruye a Claude Code a no marcarlo sin seleccion explicita del TL.
- `expected_head_sha` es obligatorio y debe provenir del listado mostrado al TL.
- Antes y despues de revisar se compara el HEAD actual.
- La llamada es sincrona, cancelable y con duracion maxima configurable.
- Si el cliente ofrece progreso MCP, se emiten etapas y porcentajes sin incluir codigo ni secretos.

Output:

- `structuredContent` breve y validado.
- Bloque textual legible por Claude Code.
- Ubicacion del HTML.
- Estado `completed`, `incomplete`, `stale`, `cancelled` o `failed`.
- Consumo agregado de tokens, sin prompts ni contenido sensible.

La respuesta MCP debe permanecer por debajo de 8.000 tokens. El detalle completo vive en el HTML.

### 8.5 Disciplina de `stdio`

- Ningun `console.log` en produccion.
- `stdout` se reserva al transporte MCP.
- Logs y diagnostico van a `stderr` mediante una unica abstraccion.
- Los handlers respetan la cancelacion del cliente.
- El proceso finaliza limpiamente al cerrarse `stdin`.
- Tests automaticos fallan si aparece salida ajena al protocolo en `stdout`.

## 9. Adaptadores GitHub y GitLab

### 9.1 Deteccion

- Leer remotes mediante comandos Git de solo lectura.
- Preferir `origin`; si no existe, aceptar una unica alternativa inequívoca.
- Parsear URLs HTTPS y SSH, incluidos hosts GitLab Self-Managed.
- No inferir proveedor solo por el nombre del executable; usar host y metadata.
- Detener con diagnostico si el host no puede mapearse de forma segura.

### 9.2 Ejecucion segura de procesos

- Usar `Bun.spawn` con arrays de argumentos; nunca invocar un shell.
- Mantener allowlist de ejecutables: `git`, `gh`, `glab` y abridores de informe aprobados.
- Mantener allowlist de operaciones de solo lectura.
- Aplicar timeout, `AbortSignal`, limite de `stdout/stderr` y verificacion de exit code.
- Redactar tokens y headers antes de loguear errores.
- No aceptar fragmentos de comandos construidos por el modelo ni por archivos del repositorio.

### 9.3 Obtencion de instantanea

- Consultar metadata y diff mediante las CLI oficiales.
- Leer archivos completos mediante endpoints GET de la API a traves de `gh api`/`glab api`.
- Leer siempre por SHA, no por nombre mutable de rama.
- Obtener contenido HEAD de archivos agregados/modificados y contenido base de eliminados cuando sea necesario.
- Soportar renombres y archivos binarios sin intentar decodificarlos como texto.
- Para forks, usar el repositorio/proyecto fuente correcto asociado al HEAD SHA.
- No hacer checkout ni fetch para obtener el contenido.

### 9.4 Compatibilidad GitLab

El adaptador debe funcionar con GitLab.com y Self-Managed siempre que `glab` tenga configurado y autenticado el host. Las diferencias de version o endpoint se encapsulan en el adaptador y se cubren con fixtures de contrato.

## 10. Resolucion SDD y construccion de contexto

### 10.1 Numero de feature

- Extraer candidatos del titulo y rama fuente mediante una expresion con limites claros.
- Normalizar a tres digitos cuando corresponda (`14` -> `014`).
- Si titulo y rama contienen numeros de feature distintos, detener como conflicto.
- Resolver contra el arbol remoto del HEAD SHA, no contra el worktree local.
- Exigir exactamente una coincidencia `specs/NNN-*`.
- Si no existe o hay varias, devolver error de trazabilidad; no seleccionar por semejanza.

### 10.2 Artefactos

Leer, cuando existan:

- Todos los archivos de texto relevantes bajo `specs/<feature>/`.
- `input.md`, `constitution.md`, `spec.md`, `plan.md`, `tasks.md` y variantes de status.
- Documentos adicionales propios de la feature.
- `DECISIONS.md` aplicable.
- `existing-arch.md`.
- Ultimo handoff aplicable.
- `specs/_registry/features.yaml`.
- `graph/domain.yaml`.

Reglas:

- `graph/domain.yaml` se consulta antes de ampliar contexto fuera de archivos cambiados.
- No se escanea indiscriminadamente el codebase.
- El contexto base incluye diff y contenido completo de archivos cambiados.
- Contexto adicional de codigo solo se incorpora si el grafo lo indica o una evidencia concreta lo exige.
- Contradicciones no resueltas por `DECISIONS.md` se reportan como decision humana pendiente.
- Archivos binarios, secretos, llaves privadas, `.env` y objetos fuera de los limites se excluyen o redactan.

### 10.3 Lineas y evidencia

- Normalizar finales de linea antes de calcular ubicaciones.
- Conservar mapas de lineas del diff y del archivo completo.
- Toda evidencia debe referenciar revision, path y rango de lineas.
- Un verificador determinista comprueba que el rango existe y que el fragmento citado coincide.
- Las referencias invalidas se descartan o degradan a `not_verifiable`.

## 11. Orquestacion de agentes

### 11.1 Principio

Los subagentes son sesiones independientes de Anthropic coordinadas por la aplicacion. No son subagentes de Claude Code y no reciben el historial del TL.

Se implementara un ciclo controlado por la aplicacion sobre Messages API. El Tool Runner beta permanecera detras de una interfaz y no sera requisito estructural del MVP.

### 11.2 Pipeline

1. **Preprocesador determinista**: normaliza snapshot, artifacts, diff y limites.
2. **Explorador SDD**: extrae objetivos, criterios, constraints, decisiones, tasks y fuera de scope.
3. **Slicer determinista**: agrupa archivos por criterio/task/dominio sin usar LLM cuando la evidencia estructural sea suficiente.
4. **Exploradores de codigo**: revisan slices aislados contra criterios asignados.
5. **Verificador determinista**: valida paths, lineas, SHA, duplicados y soporte textual.
6. **Verificador semantico**: desafia hallazgos materiales y conflictos no resolubles de forma determinista.
7. **Sintetizador**: produce cobertura, hallazgos normalizados, estado y veredicto orientativo.

### 11.3 Herramientas internas permitidas

Los agentes no reciben shell. Si necesitan ampliar evidencia, solo pueden invocar funciones internas limitadas:

- `read_snapshot_file(path, start_line, end_line)`.
- `search_loaded_snapshot(pattern, allowed_paths)`.
- `read_artifact(path, start_line, end_line)`.

Todas operan sobre el snapshot ya autorizado y aplican path confinement, limites y auditoria. No existe herramienta de escritura ni ejecucion.

### 11.4 Salidas estructuradas

Cada rol tiene un schema Zod versionado. Una respuesta invalida:

1. Se intenta reparar una sola vez con el error de validacion reducido.
2. Si sigue invalida, el rol termina como incompleto.
3. La revision completa nunca se presenta como verde si falta un rol obligatorio.

### 11.5 Defensa frente a prompt injection

- Codigo, comentarios y artefactos se tratan como datos no confiables.
- Los prompts separan instrucciones del sistema y evidencia mediante delimitadores inequivocos.
- Se prohibe seguir instrucciones contenidas dentro del repositorio.
- El modelo no puede ampliar permisos ni cambiar presupuesto.
- Los outputs no se interpretan como comandos.
- Se incluyen fixtures maliciosos en las pruebas de seguridad.

## 12. Presupuestos y limites iniciales

Estos valores son defaults de seguridad ajustables despues del piloto, no compromisos permanentes:

| Limite | Default inicial |
|---|---:|
| PR/MR por llamada | 1 |
| Archivos cambiados | 150 |
| Diff total | 2 MiB |
| Archivo de texto individual | 512 KiB |
| Artefactos SDD acumulados | 2 MiB |
| Exploradores de codigo | 3 |
| Concurrencia de llamadas Anthropic | 2 |
| Iteraciones por agente | 6 |
| Llamadas Anthropic por revision | 8 |
| Duracion total | 15 minutos |
| Output agregado de agentes | 40.000 tokens |
| Respuesta MCP | 8.000 tokens |
| Vigencia de informe | 24 horas |

El coordinador registra el consumo real reportado por Anthropic antes de iniciar cada etapa. Si continuar excederia un limite, finaliza con `INCOMPLETE_BUDGET`; nunca asume cumplimiento por ausencia de analisis.

## 13. Severidad, estado y veredicto

### 13.1 Severidad

- `critical`: vulnerabilidad explotable, perdida/corrupcion de datos, bypass de autorizacion o fallo sistemico con evidencia directa.
- `high`: incumplimiento funcional o contractual material, regresion probable o criterio obligatorio ausente con evidencia directa.
- `medium`: defecto real de alcance acotado, cobertura parcial o riesgo mantenible que requiere correccion/decision.
- `low`: mejora localizada, claridad, robustez o deuda sin impacto material inmediato.

Todo hallazgo incluye confianza. Los hallazgos especulativos sin evidencia verificable no se elevan a `critical` o `high`.

### 13.2 Estado de ejecucion

- `completed`: todas las etapas obligatorias terminaron y el HEAD sigue vigente.
- `incomplete`: falto evidencia, presupuesto, capacidad o un rol obligatorio.
- `stale`: el HEAD cambio antes de finalizar.
- `cancelled`: Claude Code/TL cancelo la tool.
- `failed`: fallo tecnico sin informe confiable.

### 13.3 Veredicto orientativo

- `RIESGO_BLOQUEANTE`: existe al menos un hallazgo `critical` verificado o un `high` que incumple directamente un criterio obligatorio y fue confirmado por el verificador.
- `REQUIERE_DECISION`: existen conflictos de artefactos, evidencia parcial, hallazgos materiales no bloqueantes o decisiones humanas pendientes.
- `SIN_HALLAZGOS_BLOQUEANTES`: ejecucion completa sin hallazgos que alcancen el umbral bloqueante.

Una ejecucion `incomplete`, `stale`, `cancelled` o `failed` no puede producir `SIN_HALLAZGOS_BLOQUEANTES`.

La ausencia de `/sdd-review APROBADO` genera una advertencia visible y `REQUIERE_DECISION`, pero no bloquea silenciosamente la ejecucion del MVP.

## 14. Informe HTML y ciclo de vida

### 14.1 Directorios

- Windows: `%LOCALAPPDATA%/sdd-pr-reviewer/reports/`.
- macOS: `~/Library/Application Support/sdd-pr-reviewer/reports/`.
- Linux: `$XDG_STATE_HOME/sdd-pr-reviewer/reports/` o `~/.local/state/sdd-pr-reviewer/reports/`.

Formato:

```text
<reports>/<host-owner-repository>/pr-<number>-<head-sha>.html
```

### 14.2 Contenido

- Metadata de repositorio, proveedor, PR/MR, feature, modelo y timestamp.
- HEAD/base SHA y advertencia de vigencia.
- Inventario de artefactos encontrados, faltantes y truncados.
- Matriz de criterios y cobertura.
- Hallazgos ordenados por severidad y confianza.
- Evidencia con archivo, linea, revision y fragmento escapado.
- Conflictos y decisiones humanas pendientes.
- Limitaciones, presupuesto y etapas incompletas.
- Veredicto orientativo y recordatorio de que decide el TL.

### 14.3 Seguridad del HTML

- Escapar toda cadena proveniente del repositorio, proveedor o modelo.
- Documento estatico sin JavaScript.
- CSP restrictiva: sin red, frames ni recursos externos.
- CSS embebido y sin telemetria.
- Permisos locales restringidos al usuario cuando la plataforma lo permita.
- No incluir API keys, headers, prompts completos ni logs internos.

### 14.4 Apertura y eliminacion

- Abrir el informe como best effort con ejecutables allowlisted por plataforma.
- Un fallo al abrir no invalida el informe; se devuelve la ruta.
- Al iniciar el servidor y al terminar una revision, eliminar informes vencidos.
- Antes de borrar, resolver la ruta real y comprobar que permanezca dentro del directorio de reportes.
- Nunca realizar limpieza recursiva sobre una ruta calculada no validada.

## 15. Seguridad y privacidad

### 15.1 Invariantes

- Ninguna operacion de proveedor usa verbos/endpoints de escritura.
- Ningun agente puede ejecutar contenido del cambio.
- Ninguna ruta leida puede escapar del repositorio/snapshot autorizado.
- Ningun archivo se crea dentro del repositorio revisado.
- La API key no se persiste ni se imprime.
- El codigo se envia solo al endpoint Anthropic aprobado por la empresa.

### 15.2 Protecciones

- Redaccion de patrones de secretos antes de construir prompts y logs.
- Denegacion explicita de extensiones/paths sensibles (`.env`, llaves, certificados y binarios), salvo politica futura aprobada.
- Limites de bytes antes de decodificar o concatenar contenido.
- Dependencias fijadas en `bun.lock` y auditadas en CI.
- Sin instalacion dinamica de paquetes durante una revision.
- Manejo de errores sin incluir cuerpos completos de API.
- Logs persistentes desactivados por defecto; modo debug opt-in y redactado.
- Comparacion de `git status --porcelain` antes/despues en pruebas de aceptacion.

## 16. Observabilidad

Cada revision tiene un `review_id` local no sensible. Se registran en `stderr` eventos estructurados:

- Inicio/fin de tool.
- Proveedor y PR/MR, sin contenido de codigo.
- Etapa actual.
- Duracion por etapa.
- Cantidad de archivos/artefactos y bytes procesados.
- Consumo de tokens por rol.
- Reintentos, truncamientos y causa de finalizacion.

No se registran prompts completos, contenidos del repositorio, API keys ni respuestas completas del modelo.

## 17. Estrategia de pruebas

### 17.1 Unitarias

- Parser de remotes HTTPS/SSH y hosts Self-Managed.
- Resolucion de root y path confinement.
- Extraccion/normalizacion del numero de feature.
- Conflictos entre titulo y rama.
- Resolucion exacta de `specs/NNN-*`.
- Presupuesto, cancelacion y timeouts.
- Parsers de diff, renombres, eliminados y binarios.
- Schemas Zod y conversiones de dominio.
- Severidad, estado y reglas de veredicto.
- Escape HTML y limpieza segura por TTL.

### 17.2 Contratos de proveedor

- Fixtures versionados de respuestas reales anonimizadas de `gh` y `glab`.
- GitHub normal y fork.
- GitLab.com y Self-Managed.
- Paginacion, draft, PR/MR sin diff, renombres y archivos grandes.
- Auth ausente/expirada y permisos insuficientes.
- Confirmar que ninguna invocacion construida pertenece a la denylist de escritura.

### 17.3 Integracion MCP

- Inicializacion y negociacion de capacidades.
- Listado de las tres tools.
- Validacion de inputs y outputs.
- Cancelacion de `review_change_requests`.
- Cierre limpio al terminar `stdin`.
- Progreso cuando el cliente lo soporte.
- Garantia de que `stdout` contiene solo frames MCP.
- Respuesta resumida por debajo del limite acordado.

### 17.4 Integracion Anthropic

- Cliente fake para el pipeline normal.
- Respuestas invalidas, tool calls invalidas y reparacion unica.
- Rate limit, timeout, error 5xx y cancelacion.
- Consumo de presupuesto entre roles.
- Deteccion de salida duplicada/contradictoria.
- Smoke opt-in contra la API real con un fixture controlado.

### 17.5 Seguridad

- Prompt injection dentro de source, comentarios y specs.
- Path traversal y symlinks.
- Comandos/argumentos con caracteres de shell.
- Contenido HTML malicioso.
- Secretos simulados en archivos.
- Archivos comprimidos/bombas de tamaño y binarios.
- HEAD que cambia durante la revision.
- Prueba de que no cambia `git status` ni el estado remoto.

### 17.6 End-to-end

Escenarios minimos:

1. GitHub con feature valida y sin hallazgos bloqueantes.
2. GitHub con criterio obligatorio incumplido.
3. GitHub PR desde fork.
4. GitLab con feature valida.
5. GitLab Self-Managed fixture/entorno controlado.
6. Feature ausente.
7. Multiples carpetas coincidentes.
8. Titulo y rama con numeros en conflicto.
9. Presupuesto excedido.
10. HEAD obsoleto antes de finalizar.
11. API key ausente.
12. `gh`/`glab` sin autenticar.

La aceptacion final incluye una ejecucion real desde Claude Code usando el binario compilado, no solamente `bun run`.

## 18. Build y distribucion

### 18.1 Artefactos

Generar con `bun build --compile`:

- Windows x64.
- Linux x64 baseline.
- macOS arm64.
- Otras arquitecturas solo cuando exista demanda validada.

Cada release incluye:

- Ejecutable versionado.
- SHA-256 por artefacto.
- Changelog.
- Instrucciones `doctor` y configuracion MCP.
- SBOM o inventario de dependencias.

### 18.2 Configuracion Claude Code

Ejemplo conceptual de `.mcp.json`:

```json
{
  "mcpServers": {
    "sdd-pr-reviewer": {
      "type": "stdio",
      "command": "${SDD_PR_REVIEWER_BIN}",
      "args": ["mcp"]
    }
  }
}
```

La API key se define en el entorno corporativo del usuario, no como literal versionado. El instalador/documentacion debe contemplar que una politica de Claude Code puede limpiar credenciales de subprocesses; `reviewer_doctor` lo detecta y explica sin revelar valores.

La distribucion inicial sera mediante binario y configuracion MCP. Empaquetarlo como plugin administrado de Claude Code queda como evolucion posterior, cuando se resuelva la entrega de binarios por plataforma.

## 19. Fases de implementacion

No se asignan estimaciones de esfuerzo humano. Cada fase termina por evidencia y gates tecnicos.

### Fase 0 - Bootstrap y artefactos de decision

- [ ] Inicializar Git en `pr-reviewer` y definir rama principal.
- [ ] Crear `AGENTS.md` con reglas locales del producto.
- [ ] Convertir la propuesta consolidada en `specs/001-sdd-pr-reviewer/input.md`.
- [ ] Generar/revisar constitution, spec, plan y tasks de la feature inicial.
- [ ] Registrar ADR 001: TypeScript + Bun + MCP `stdio`.
- [ ] Documentar invariantes de solo lectura y threat model.
- [ ] Establecer criterios de aceptacion y fixtures iniciales.

**Gate:** requisitos y decisiones no se contradicen; el plan SDD de la feature referencia este roadmap.

### Fase 1 - Fundacion del proyecto

- [ ] Crear `package.json`, lockfile, TypeScript estricto y Biome.
- [ ] Definir scripts reproducibles de build, test, lint y typecheck.
- [ ] Crear entrypoint y comandos `mcp`, `doctor`, `--version`.
- [ ] Implementar configuracion validada y errores tipados.
- [ ] Implementar logger exclusivo a `stderr`.
- [ ] Configurar CI basica para Windows/Linux/macOS.

**Gate:** build limpio, typecheck/lint/test verdes y ejecutable minimo funcional en Windows y Linux.

### Fase 2 - Dominio y seguridad base

- [ ] Implementar contratos de dominio y schemas.
- [ ] Implementar `CommandRunner` allowlisted sin shell.
- [ ] Implementar path confinement y resolucion del proyecto.
- [ ] Implementar presupuestos, timeouts y cancelacion.
- [ ] Implementar redaccion de secretos y errores seguros.

**Gate:** tests de traversal, shell injection, cancelacion y limites verdes.

### Fase 3 - Servidor MCP

- [ ] Inicializar servidor MCP v1 sobre `stdio`.
- [ ] Registrar schemas de las tres tools.
- [ ] Implementar `reviewer_doctor` parcial.
- [ ] Implementar structured outputs y errores MCP.
- [ ] Implementar shutdown y cancelacion.
- [ ] Añadir test de contaminacion de `stdout`.

**Gate:** MCP Inspector/cliente de prueba descubre e invoca tools usando el binario compilado.

### Fase 4 - Repositorio y proveedores

- [ ] Detectar remote, host y proveedor.
- [ ] Implementar adaptador GitHub completo.
- [ ] Implementar adaptador GitLab completo.
- [ ] Implementar listado de cambios abiertos.
- [ ] Implementar snapshots por SHA, forks y renombres.
- [ ] Completar diagnostico de autenticacion.

**Gate:** contratos y smoke read-only pasan en GitHub y GitLab; ninguna operacion mutante aparece en trazas.

### Fase 5 - Resolucion SDD y contexto

- [ ] Resolver feature por titulo/rama.
- [ ] Resolver arbol remoto `specs/NNN-*` en HEAD.
- [ ] Cargar artifacts, registry, graph y contexto opcional.
- [ ] Construir mapas de lineas y evidencia.
- [ ] Aplicar filtros, redaccion y limites de contenido.
- [ ] Implementar deteccion de contradicciones no resueltas.

**Gate:** todos los escenarios de trazabilidad producen resultado determinista y explicable.

### Fase 6 - Cliente Anthropic y agentes

- [ ] Implementar adapter de Messages API.
- [ ] Definir prompts versionados y schemas de rol.
- [ ] Implementar explorador SDD.
- [ ] Implementar slicer y exploradores de codigo.
- [ ] Implementar verificador semantico.
- [ ] Implementar reparacion unica de output invalido.
- [ ] Registrar consumo de tokens por rol.

**Gate:** pipeline completo funciona con cliente fake y smoke real controlado; ninguna sesion comparte contexto no autorizado.

### Fase 7 - Coordinador y veredicto

- [ ] Orquestar etapas, concurrencia y presupuestos.
- [ ] Implementar verificador determinista de evidencia.
- [ ] Deduplicar y ordenar hallazgos.
- [ ] Calcular cobertura, estado y veredicto.
- [ ] Revalidar HEAD al finalizar.
- [ ] Implementar estados incompletos sin falso verde.

**Gate:** escenarios de cancelacion, budget, stale y error parcial terminan con estado correcto.

### Fase 8 - Reporte

- [ ] Implementar `ReviewReport` versionado.
- [ ] Crear HTML autocontenido, accesible y escapado.
- [ ] Implementar rutas multiplataforma y permisos.
- [ ] Implementar apertura best effort.
- [ ] Implementar TTL con borrado confinado.
- [ ] Reducir structured output MCP a lo esencial.

**Gate:** snapshots visuales/estructurales estables, CSP valida y ningun dato secreto presente.

### Fase 9 - End-to-end y hardening

- [ ] Ejecutar matriz E2E completa.
- [ ] Verificar invariancia de repositorio y estado remoto.
- [ ] Probar binarios compilados en plataformas objetivo.
- [ ] Probar desde Claude Code con lenguaje natural.
- [ ] Ajustar timeouts, limites y mensajes de diagnostico.
- [ ] Ejecutar auditoria de dependencias y threat-model review.

**Gate:** todos los criterios de aceptacion del MVP tienen evidencia reproducible.

### Fase 10 - Piloto controlado

- [ ] Seleccionar conjunto congelado de PR/MR con resultado humano conocido.
- [ ] Ejecutar reviewer sin publicar resultados en los PR/MR.
- [ ] Medir precision, falsos positivos, falsos negativos, costo y duracion.
- [ ] Revisar severidades y presupuestos con los TL.
- [ ] Corregir gaps y repetir el conjunto congelado.
- [ ] Aprobar o rechazar rollout interno.

**Gate:** calidad acordada por los TL y ausencia de efectos externos no autorizados.

## 20. Orden de dependencias

```text
Fase 0
  -> Fase 1
      -> Fase 2
          -> Fase 3
          -> Fase 4
              -> Fase 5
                  -> Fase 6
                      -> Fase 7
                          -> Fase 8
                              -> Fase 9
                                  -> Fase 10
```

MCP y proveedores pueden desarrollarse en paralelo despues de cerrar dominio y seguridad, pero se integran solo cuando ambos contratos esten verdes.

## 21. Matriz de trazabilidad de aceptacion

| Criterio | Implementacion | Evidencia esperada |
|---|---|---|
| Claude Code descubre el reviewer | Fase 3 | Test MCP + `/mcp` |
| Lista PR/MR abiertos | Fase 4 | Contratos GitHub/GitLab + E2E |
| TL selecciona uno | Schema MCP | Fixture de conversacion + input validado |
| Feature inequivoca | Fase 5 | Tests de resolucion y conflicto |
| Revision aislada | Fase 6 | Tests de contexto y prompts |
| Solo lectura | Fases 2, 4 y 9 | Trazas allowlist + git status antes/despues |
| Evidencia archivo/linea/SHA | Fases 5 y 7 | Verificador determinista |
| Informe privado temporal | Fase 8 | Test de path, CSP y TTL |
| Detecta HEAD obsoleto | Fase 7 | E2E stale |
| Error no produce falso verde | Fase 7 | Matriz de estados incompletos |
| Binario sin Bun instalado | Fase 9 | Smoke de artefacto compilado |

## 22. Riesgos y mitigaciones

| Riesgo | Mitigacion |
|---|---|
| Tool MCP demasiado larga | Timeout global, progreso, cancelacion y pipeline preparado para jobs futuros. |
| Output MCP llena el contexto de Claude Code | Limite de 8.000 tokens y detalle en HTML. |
| Bun compilado difiere de `bun run` | Todos los E2E finales usan ejecutable compilado por plataforma. |
| Cambio de SDK MCP | Fijar v1.x, adaptar detras de `src/mcp/protocol.ts` y no adoptar v2 mientras permanezca en pre-alpha. |
| Modelo/alias cambia | Modelo configurable, validacion en doctor y adapter aislado. |
| Prompt injection | Datos delimitados, tools cerradas, sin shell y tests adversariales. |
| PR enorme excede contexto/costo | Limites, slicing, presupuesto y estado incompleto explicito. |
| Evidencia inventada | Verificacion determinista de path, lineas, SHA y fragmento. |
| Fork inaccesible | Metadata del repositorio fuente y error claro si faltan permisos. |
| GitLab Self-Managed variable | Deteccion por host, fixtures por versiones y encapsulamiento en adapter. |
| Informe contiene codigo sensible | Almacenamiento local, CSP, permisos de usuario y TTL de 24 h. |
| Claude Code elimina la API key del entorno | `reviewer_doctor`, documentacion corporativa y configuracion administrada. |
| Limpieza borra una ruta incorrecta | Canonicalizacion y confinement previo a toda eliminacion. |

## 23. Definition of Done del MVP

El MVP esta terminado solo cuando:

- Los tres comandos y las tres tools funcionan desde el binario compilado.
- Claude Code puede listar y revisar mediante lenguaje natural.
- GitHub y GitLab cumplen el mismo contrato de dominio.
- La revision usa snapshot remoto por SHA y detecta obsolescencia.
- La feature SDD se resuelve exactamente o la ejecucion se detiene.
- Todos los agentes operan sin herramientas mutantes ni ejecucion de codigo.
- Cada hallazgo material tiene evidencia validada.
- Estados incompletos nunca generan un veredicto verde.
- El HTML es seguro, privado, autocontenido y expira.
- El repositorio y el PR/MR permanecen inalterados.
- Typecheck, lint, unitarias, integracion, seguridad y E2E estan verdes.
- Los artefactos Windows/Linux/macOS seleccionados pasan smoke tests.
- El piloto controlado alcanza los umbrales de calidad acordados por los TL.

## 24. Evolucion posterior al MVP

Orden recomendado:

1. Permitir varios PR/MR en `selections` y procesarlos secuencialmente con aislamiento completo.
2. Convertir la ejecucion larga a jobs o MCP Tasks cuando Claude Code y el SDK lo soporten de forma estable.
3. Empaquetar binario y MCP como plugin administrado de Claude Code.
4. Agregar proveedores/configuraciones corporativas adicionales sin alterar el dominio.
5. Evaluar integracion CI reutilizando el mismo coordinador.
6. Considerar publicacion controlada de comentarios solo mediante una nueva decision de gobernanza y permisos separados.

## 25. Referencias tecnicas oficiales

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Anthropic TypeScript SDK: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
- Anthropic Tool Runner: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner
- Bun standalone executables: https://bun.sh/docs/bundler/executables
- Bun child processes: https://bun.sh/docs/runtime/child-process
