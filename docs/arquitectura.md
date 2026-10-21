# Oficina Virtual 3D para agentes de IA

Oficina 3D local para ver en tiempo real qué hace cada sesión de Claude Code (terminal o VS Code) y darle órdenes desde el navegador.

## 1. Experiencia

* **Un escritorio por sesión.** Cada sesión tiene un avatar, un monitor con la acción en curso y un anillo de estado en el suelo:
    * 🟢 **Trabajando:** usa una herramienta; el avatar teclea y el monitor muestra la herramienta y el archivo o comando.
    * 🔵 **Pensando:** el modelo procesa; aparece un halo azul.
    * 🟡 **Espera tu aprobación:** el anillo ámbar parpadea; la sesión está parada hasta que alguien responda en la terminal o en VS Code.
    * 🟣 **En guardia:** terminó su turno y espera órdenes de la oficina.
    * 🔴 **Error:** falló una herramienta o la respuesta.
    * ⚪ **Inactivo:** sin actividad.
* **Subagentes:** se ven como drones que orbitan sobre el escritorio de la sesión que los lanzó.
* **Panel lateral:** muestra la lista de agentes y, al pulsar uno, su detalle: acción actual, permiso pendiente, contexto y tokens de salida, subagentes, último prompt y respuesta, registro de actividad y las órdenes.

## 2. Arquitectura

```text
Claude Code (terminal / VS Code)          Docker (solo 127.0.0.1)                    Navegador
┌───────────────────────────┐  POST     ┌──────────────────────────────┐   WS      ┌──────────────────┐
│ hooks type:"http"         │──────────▶│ servidor.js                  │◀────────▶│ Oficina 3D       │
│ (SessionStart, PreToolUse,│  JSON     │  · /api/hook  (token)        │  /ws      │  three.js local  │
│  PostToolUse, Stop…)      │◀──────────│  · oficina.js  estado+órdenes│           │  panel + órdenes │
└───────────────────────────┘ respuesta └──────────────┬───────────────┘           └──────────────────┘
          │ escribe                                     │ lee (solo lectura)
          ▼                                             ▼
   ~/.claude/projects/*.jsonl ─────────────────▶ transcripts.js  (tokens, sesiones recientes)
```

Todo cabe en **un único contenedor** (`oficina/`):

1. **Hooks http de Claude Code.** El instalador añade a `~/.claude/settings.json` hooks de tipo `http` que envían por POST el JSON de cada evento a `http://127.0.0.1:7777/api/hook`, con la cabecera `X-AI-Office-Token`. No hace falta ningún script en el equipo y funciona igual en Linux, macOS y Windows.
2. **Servidor (`src/servidor.js`).** Hecho con Node sin framework y con `ws` para el WebSocket. Valida el token, traduce los eventos a estados (`src/oficina.js`) y los retransmite al navegador.
3. **Transcripts (`src/transcripts.js`).** Monta `~/.claude` en solo lectura. Suma los tokens de cada sesión sin contar dos veces el mismo mensaje y detecta las sesiones activas en los últimos 20 minutos, aunque todavía no hayan enviado eventos de hooks.
4. **Oficina 3D (`public/`).** Usa three.js servido desde la propia imagen, sin CDN, así que funciona sin internet. Incluye una cámara orbital propia (ratón, táctil y teclado).

### 2.1 De hook a estado

| Evento de Claude Code | Estado | Dato para el panel |
| :- | :- | :- |
| `SessionStart` | Inactivo (aparece el escritorio) | proyecto (`cwd`), modelo |
| `UserPromptSubmit` | Pensando | prompt |
| `PreToolUse` | Trabajando | herramienta y archivo/comando (`tool_input`) |
| `PostToolUse` | Pensando | — |
| `PostToolUseFailure` | Error | herramienta y error |
| `PermissionRequest`, `Notification` (`permission_prompt`) | Espera tu aprobación | qué pide |
| `Notification` (`idle_prompt`) | Inactivo | — |
| `SubagentStart` / `SubagentStop` | dron que aparece / desaparece | `agent_type`; sus herramientas llegan con `agent_id` |
| `Stop` | Inactivo, o En guardia | última respuesta |
| `StopFailure` | Error | motivo |
| `SessionEnd` | se apaga y se retira a los 60 s | — |

### 2.2 Órdenes desde la oficina

Una orden se guarda en la cola de su sesión. Claude la recibe en la respuesta del siguiente hook que admite devolver contexto:

| Momento | Hook | Respuesta de la oficina | Efecto en Claude |
| :- | :- | :- | :- |
| Mientras trabaja | `PostToolUse` | `hookSpecificOutput.additionalContext` | la lee junto al resultado de la herramienta y la incorpora al trabajo en curso |
| Al recibir un prompt | `UserPromptSubmit` | `hookSpecificOutput.additionalContext` | la lee junto al prompt |
| Al terminar el turno | `Stop` | `{"decision":"block","reason":…}` | no se para: sigue trabajando con la orden |

**Modo guardia** (opcional, por sesión): si al terminar el turno no hay órdenes, la oficina mantiene abierta la petición `Stop` hasta que llegue una orden, se desactive la guardia o venza el plazo (`GUARDIA_MAX_MIN`, 14 min por defecto; el instalador da al hook `Stop` ese plazo más 1 min). Así un agente puede quedar «de servicio» y recibir trabajo desde la oficina. Mientras espera, la terminal queda ocupada. Si Claude Code corta la petición (Esc, Ctrl+C o el timeout del hook), la espera se libera.

Las sesiones **inactivas sin guardia** no ejecutan hooks, así que sus órdenes esperan en cola hasta el próximo prompt o la próxima herramienta.

### 2.3 Seguridad

La oficina puede darle instrucciones a Claude, y Claude actúa con los permisos del usuario. Por eso:

* **Solo local.** El compose publica el puerto en `127.0.0.1`. No hay que exponerlo a la red ni ponerlo detrás de un proxy público.
* **Defensa contra DNS rebinding.** Se rechaza cualquier petición cuya cabecera `Host` no sea `localhost`, `127.0.0.1` o `::1`.
* **Hooks autenticados.** `/api/hook` exige el token (comparación en tiempo constante) y `Content-Type: application/json`. Una web maliciosa no puede enviar ese tipo de contenido a otro origen sin preflight CORS, y la oficina nunca lo concede.
* **WebSocket solo desde la propia página.** Las órdenes viajan por `/ws`, que exige que `Origin` coincida con el host local. También tiene un límite de 40 mensajes cada 10 s y de 4000 caracteres por orden.
* **Lo que se muestra va enmascarado.** Antes de llegar al panel se recortan y ocultan claves privadas, tokens de GitHub/AWS/Slack/Anthropic/Google, JWT, `password=`, cabeceras `Authorization` y URLs con credenciales.
* **Las órdenes no amplían permisos.** Claude las ejecuta con el sistema de permisos normal de Claude Code: si una acción requiere aprobación, la sigue pidiendo en la terminal. La oficina no aprueba ni rechaza permisos.
* **Contenedor endurecido.** Usuario no root, sistema de archivos de solo lectura, `cap_drop: ALL`, `no-new-privileges`, límites de memoria y procesos, y `~/.claude` montado en solo lectura. Solo el paso `instalar` lo monta en escritura, y lo hace sin red.
* **Sin persistencia.** El estado vive en memoria. Al reiniciar la oficina se recuperan las sesiones recientes desde los transcripts locales.

## 3. Estructura

```text
ai-office-3d/
├── docker-compose.yml          # servicio oficina + paso «instalar» (perfil)
├── .env.example                # PUERTO, CLAUDE_DIR, UID_GID, GUARDIA_MAX_MIN, AI_OFFICE_DEMO
├── oficina/
│   ├── Dockerfile
│   ├── src/
│   │   ├── servidor.js         # HTTP, /api/hook, WebSocket, estáticos, seguridad
│   │   ├── oficina.js          # estados, subagentes, órdenes y modo guardia
│   │   ├── transcripts.js      # tokens y sesiones recientes desde ~/.claude/projects
│   │   ├── redactar.js         # recorte y enmascarado de secretos
│   │   └── demo.js             # agentes simulados (AI_OFFICE_DEMO=1)
│   ├── public/                 # index.html, app.js (panel), escena.js (3D), estilos.css
│   ├── scripts/instalar-hooks.mjs
│   └── test/oficina.test.js    # node --test
├── prototipos/modelo-multiagente-3d.html
└── docs/arquitectura.md
```

## 4. Etapas

1. ~~Mock y arquitectura base~~ → modo demo con tres agentes simulados.
2. ~~Escena 3D, raycasting y panel~~ → hecho.
3. ~~Integración real~~ → hooks http y transcripts.
4. ~~Órdenes desde la oficina~~ → cola por sesión, entrega por `PostToolUse`/`UserPromptSubmit`/`Stop` y modo guardia.
5. **Siguiente:**
    * Aprobar o rechazar permisos desde la oficina (hook `PermissionRequest` con decisión). Implica decidir quién puede aprobar.
    * Lanzar agentes nuevos desde la oficina (`claude -p` en un contenedor de trabajo con el repositorio montado).
    * Modelos GLTF y animaciones más ricas.
