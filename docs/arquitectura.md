# Oficina Virtual 3D para Monitoreo de Agentes de IA

Arquitectura diseñada para visualizar en tiempo real la actividad, estado y tareas de instancias de IA (como Claude) trabajando dentro de Visual Studio Code mediante un entorno tridimensional interactivo.

## 1. La Experiencia Visual (Oficina de IA)

*   **El Entorno:** Una oficina 3D estilo *cyberpunk* o corporativa minimalista (tema oscuro). Las entidades principales son **"Estaciones de Trabajo"** o avatares cibernéticos que representan a cada agente.
*   **Estado Visual:** 
    *   🟢 **Escribiendo/Ejecutando:** El avatar teclea o la pantalla del escritorio brilla con código en movimiento.
    *   🔵 **Pensando/Analizando:** Un halo azul o estado estático mientras el modelo procesa el prompt.
    *   🟡 **Esperando aprobación:** Luz ámbar intermitente; la sesión está parada hasta que una persona responda.
    *   🔴 **Error/Bloqueado:** Luces rojas (ej. fallo en un script, límite de tokens).
    *   ⚪ **Inactivo (Idle):** Estación apagada o en reposo.
*   **Panel Interactivo (HUD):** Al hacer clic en el escritorio de un agente en el entorno 3D, se abre un panel lateral superpuesto que muestra:
    *   **Nombre/ID del Agente:** (ej. *Claude-Dev-1*, *Claude-Reviewer*).
    *   **Labor actual:** Tarea asignada (ej. "Refactorizando componente de React").
    *   **Actividad en VS Code:** Archivo actual abierto (`/src/app.ts`), línea de código modificada.
    *   **Streaming de Logs:** La salida de la terminal o el "pensamiento" del agente en tiempo real.
    *   **Métricas de IA:** Tokens consumidos, tiempo de ejecución de la tarea.

---

## 2. Arquitectura de Integración (El Reto de VS Code)

Para saber qué hace Claude dentro de VS Code, se extrae la información del entorno local y se envía al Dashboard 3D mediante tres componentes principales:

1.  **El "Agent Watcher" (Recolector Local):**
    *   Un script en Node.js que corre en la máquina donde trabaja Claude Code.
    *   **Tiempo real por hooks de Claude Code.** Cada hook es un comando que recibe por stdin un JSON con campos comunes (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, y `agent_id`/`agent_type` cuando el evento ocurre dentro de un subagente) más los propios del evento (`tool_name`, `tool_input`, `tool_use_id` en `PreToolUse`…). El hook solo reenvía ese JSON al watcher y termina con código 0: nunca debe bloquear ni decidir permisos.
    *   **Historial y métricas por transcripts.** El JSONL de `transcript_path` (en `~/.claude/projects/<proyecto>/<sesion>.jsonl`) se lee en modo *tail* para tokens, resultados con error y contexto que el hook no trae.
    *   No se leen logs de otras extensiones (Cline, Roo Code): su formato no es estable ni está documentado.
2.  **El Hub de Eventos (Backend central):**
    *   Un servidor Node.js (Express + Socket.io) que recibe los datos de todos los "Agent Watchers", los unifica y mantiene en memoria el estado actual de cada sesión.
3.  **El Dashboard 3D (Frontend):**
    *   React Three Fiber renderiza la oficina y se suscribe vía WebSockets al Hub para animar los avatares y actualizar los paneles laterales en vivo.

### 2.1 De hook a estado del avatar

| Evento de Claude Code | Estado del avatar | Dato para el HUD |
| :- | :- | :- |
| `SessionStart` | Inactivo (aparece la estación) | proyecto (`cwd`), modelo |
| `UserPromptSubmit` | Pensando | prompt (resumido) |
| `PreToolUse` | Ejecutando | herramienta y archivo/comando (`tool_input`) |
| `PostToolUse` | Pensando | resultado de la herramienta |
| `PostToolUseFailure` | Error (temporal) | herramienta que falló |
| `Notification` (matcher `permission_prompt`) / `PermissionRequest` | Esperando aprobación | qué pide permiso |
| `SubagentStart` / `SubagentStop` | Aparece / se retira un avatar hijo junto al padre | `agent_type` |
| `Stop` | Inactivo | último mensaje |
| `StopFailure` | Error | motivo |
| `SessionEnd` | Estación apagada | — |

Configuración de ejemplo en `~/.claude/settings.json` (un único script para todos los eventos):

```json
{
  "hooks": {
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.ai-office/emit.sh", "timeout": 5 }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.ai-office/emit.sh", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/.ai-office/emit.sh", "timeout": 5 }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "~/.ai-office/emit.sh", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "~/.ai-office/emit.sh", "timeout": 5 }] }]
  }
}
```

`emit.sh` envía el JSON al watcher local y no espera respuesta, para no añadir latencia a la sesión:

```bash
#!/usr/bin/env bash
curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:7777/evento >/dev/null 2>&1 || true
exit 0
```

### 2.2 Seguridad

Los eventos y transcripts contienen código, rutas, comandos y, potencialmente, secretos. Por eso:

*   El watcher escucha solo en `127.0.0.1`. El Hub, si está en otra máquina, exige un token por watcher y va detrás de TLS (por ejemplo, Nginx Proxy Manager).
*   El watcher recorta y enmascara antes de enviar: `tool_input` y salidas truncados (p. ej. 2 KB) y patrones de secretos (`AKIA…`, `ghp_…`, `sk-…`, `password=`, cabeceras `Authorization`) sustituidos por `***`.
*   El Dashboard es de solo lectura: no puede aprobar permisos ni enviar prompts a las sesiones.
*   El Hub no persiste los eventos por defecto; el historial se reconstruye desde los transcripts locales.

---

## 3. Estructura de Carpetas del Monorepo

Estructura prevista (hoy el repositorio solo contiene `docs/` y `prototipos/`):

```text
ai-office-3d/
├── docker-compose.yml          # Levanta el Backend y el Frontend del Dashboard
├── README.md                   
├── agent-watcher/              # (Se ejecuta localmente donde trabaja Claude)
│   ├── hooks/emit.sh           # Script que Claude Code ejecuta en cada hook
│   ├── src/
│   │   ├── hookServer.ts       # Recibe los eventos de los hooks en 127.0.0.1
│   │   ├── transcriptTail.ts   # Sigue los JSONL de sesión (tokens, errores)
│   │   ├── redact.ts           # Recorta y enmascara secretos antes de enviar
│   │   └── socketClient.ts     # Envía la actividad al Backend
│   └── package.json
├── backend/                    # (El cerebro del Dashboard)
│   ├── src/
│   │   ├── server.ts
│   │   ├── sockets/            # Recibe de los watchers, emite al frontend
│   │   └── state/              # Mantiene en memoria el estado actual de cada agente
│   └── package.json
└── frontend/                   # (La Oficina 3D)
    ├── src/
    │   ├── assets/models/      # Modelos 3D (Escritorios, Avatares, Oficina)
    │   ├── components/
    │   │   ├── 3d/             # OfficeScene.tsx, AgentDesk.tsx
    │   │   └── ui/             # Overlay.tsx, AgentTerminal.tsx (Tailwind)
    │   ├── store/              # Zustand (gestión del estado de los agentes)
    │   └── App.tsx
    └── package.json
```

---

## 4. Plan de Implementación por Etapas

### Etapa 1: Mock y Arquitectura Base
*   Configurar el Frontend (React Three Fiber) y Backend (Node.js + WebSockets).
*   Crear un generador de *datos falsos* en el backend que simule 3 agentes trabajando, cambiando sus estados (escribiendo, pensando, error) periódicamente.
*   Conectar el Frontend por WebSockets para verificar el flujo de datos sin latencia.

### Etapa 2: Desarrollo del Entorno 3D y UI
*   Construir la escena 3D y colocar escritorios básicos (cubos/planos provisionales).
*   Implementar *Raycasting* (eventos de clic en 3D) para la selección de agentes.
*   Diseñar la UI superpuesta en HTML/CSS (Tailwind, tema oscuro) para mostrar la terminal falsa y el estado de la tarea.
*   Vincular los cambios de estado visuales (luces, colores) a los WebSockets.

### Etapa 3: El "Agent Watcher" (Integración Real)
*   Registrar los hooks de la sección 2.1 y el script `emit.sh`.
*   Desarrollar el watcher local: recibe los JSON de los hooks, aplica el enmascarado de la sección 2.2 y los traduce a eventos del Hub: `{ sesion: "<session_id>", agente: "<agent_id|principal>", estado: "ejecutando", herramienta: "Edit", archivo: "src/index.ts", ts: 1729480000 }`.
*   Seguir el transcript de cada sesión (`transcript_path`) para tokens y errores.
*   Probar con dos sesiones simultáneas y con un subagente para validar que cada uno tiene su avatar.

### Etapa 4: Pulido y Optimización Visual
*   Reemplazar figuras geométricas por modelos 3D reales (GLTF/GLB).
*   Añadir animaciones complejas (pantallas parpadeando, movimiento de avatares).
*   Implementar reconexión automática de WebSockets.