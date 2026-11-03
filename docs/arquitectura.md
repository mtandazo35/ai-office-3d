# Oficina Virtual 3D para agentes de IA

Oficina 3D local para ver en tiempo real qué hace cada sesión de Claude Code (terminal o VS Code) y darle órdenes desde el navegador.

## 1. Experiencia

* **Un escritorio por sesión.** Cada sesión tiene un avatar, un monitor con la acción en curso y un anillo de estado en el suelo:
    * 🟢 **Trabajando:** usa una herramienta; el avatar teclea y el monitor muestra la herramienta y el archivo o comando.
    * 🔵 **Pensando:** el modelo procesa; aparece un halo azul.
    * 🟡 **Espera tu aprobación:** el anillo ámbar parpadea; la sesión está parada hasta que alguien responda en la terminal o en VS Code.
    * 🟣 **En guardia:** terminó su turno y espera órdenes de la oficina.
    * 🔴 **Error:** falló una herramienta o la respuesta.
    * 🟤 **Sin señal:** estaba trabajando o pensando y lleva 10 min sin mandar eventos. Puede seguir en un comando largo, o haberse interrumpido o cerrado; el siguiente evento la saca de ahí.
    * ⚪ **Inactivo:** sin actividad.
* **Perfiles:** cada sesión recibe un nombre automático derivado de su id, sin repetirlo. La página `/agentes.html` permite editar nombre (máximo 24 caracteres, sin duplicados), rol (máximo 30; no se envía a Claude, solo se muestra y elige el accesorio del personaje por palabras clave) y género (cambia el peinado). Los cambios viajan por el mismo WebSocket autenticado que las órdenes. Los perfiles van por id de sesión: una sesión nueva empieza con uno nuevo.
* **Comportamiento de los personajes:** se levantan y miran a la cámara al pedir permiso, en guardia y al celebrar; cambian cejas, boca y ojos según el estado; tras 45 s sin actividad pueden ir a la barra de café y volver. Con «reducir movimiento» no pasean.
* **Subagentes:** cada uno es un personaje con nombre automático, mesa y portátil delante del escritorio de la sesión que lo lanzó; el anillo y la pantalla muestran su estado. Se dibujan hasta 6 y el detalle los lista todos. Si la sesión ya acabó su turno, figura como «Coordinando ayudantes». Un subagente sin eventos durante 15 min se retira, y los eventos que llegan tras su `SubagentStop` se ignoran.
* **Panel lateral:** muestra la lista de agentes y, al pulsar uno, su detalle: acción actual, permiso pendiente, contexto y tokens de salida, subagentes, último prompt y respuesta, registro de actividad y las órdenes. El texto de cada orden es un borrador por agente: no se envía a otro al cambiar de escritorio, y no sale de la caja hasta que el servidor confirma.

## 2. Arquitectura

```text
Claude Code (terminal / VS Code)          Contenedor                                 Navegador
┌───────────────────────────┐  POST     ┌──────────────────────────────┐   WS      ┌──────────────────┐
│ hooks type:"http"         │──────────▶│ servidor.js                  │◀─────────▶│ Oficina 3D       │
│ (PreToolUse, PostToolUse, │  :7778    │  · :7778 /api/hook (token)   │ /ws :7777 │  three.js local  │
│  Stop…)                   │◀──────────│  · :7777 panel y /ws         │           │  panel + órdenes │
└───────────────────────────┘ respuesta │  · oficina.js  estado+órdenes│           └──────────────────┘
                                        └──────────────┬───────────────┘
          │ escribe                                    │ lee (solo lectura)
          ▼                                            ▼
   ~/.claude/projects/*.jsonl ─────────────────▶ transcripts.js  (tokens, sesiones recientes)
```

El puerto 7778 se publica siempre en `127.0.0.1`. El 7777 se publica en `127.0.0.1` por defecto (también detrás de un proxy, con contraseña) o en la IP del VPS con contraseña y HTTPS.

Todo cabe en **un único contenedor** (`oficina/`):

1. **Hooks http de Claude Code.** El instalador añade a `~/.claude/settings.json` hooks de tipo `http` que envían por POST el JSON de cada evento a `http://127.0.0.1:7778/api/hook`, con la cabecera `X-AI-Office-Token`. No hace falta ningún script en el equipo y funciona igual en Linux, macOS y Windows.
2. **Servidor (`src/servidor.js`).** Hecho con Node sin framework y con `ws` para el WebSocket. Valida el token, traduce los eventos a estados (`src/oficina.js`) y los retransmite al navegador.
3. **Transcripts (`src/transcripts.js`).** Lee `~/.claude/projects`, montada en solo lectura. Suma los tokens de cada sesión sin contar dos veces el mismo mensaje y detecta las sesiones activas en los últimos 20 minutos, aunque todavía no hayan enviado eventos de hooks.
4. **Oficina 3D (`public/`).** Usa three.js servido desde la propia imagen, sin CDN, así que funciona sin internet. Incluye una cámara orbital propia (ratón, táctil y teclado).

### 2.1 De hook a estado

| Evento de Claude Code | Estado | Dato para el panel |
| :- | :- | :- |
| `UserPromptSubmit` | Pensando | prompt |
| `PreToolUse` | Trabajando | herramienta y archivo/comando (`tool_input`) |
| `PostToolUse` | Pensando | — |
| `PostToolUseFailure` | Error | herramienta y error |
| `PermissionRequest`, `Notification` (`permission_prompt`) | Espera tu aprobación | qué pide |
| `Notification` (`idle_prompt`) | Inactivo | — |
| `SubagentStart` / `SubagentStop` | ayudante con mesa que aparece / desaparece | `agent_type`; sus herramientas llegan con `agent_id` |
| `Stop` | Inactivo, o En guardia | última respuesta |
| `StopFailure` | Error | motivo |
| `SessionEnd` | se apaga y se retira a los 60 s | — |
| (10 min sin eventos, trabajando o pensando) | Sin señal | — |

`SessionStart` no se instala porque no admite hooks `http`. El escritorio aparece con el primer prompt o la primera herramienta, o con el barrido de transcripts, cada 20 s.

### 2.2 Órdenes desde la oficina

Una orden se guarda en la cola de su sesión. Claude la recibe en la respuesta del siguiente hook que admite devolver contexto:

| Momento | Hook | Respuesta de la oficina | Efecto en Claude |
| :- | :- | :- | :- |
| Mientras trabaja | `PostToolUse` | `hookSpecificOutput.additionalContext` | la lee junto al resultado de la herramienta y la incorpora al trabajo en curso |
| Al recibir un prompt | `UserPromptSubmit` | `hookSpecificOutput.additionalContext` | la lee junto al prompt |
| Al terminar el turno | `Stop` | `{"decision":"block","reason":…}` | no se para: sigue trabajando con la orden |

**Modo guardia** (opcional, por sesión): si al terminar el turno no hay órdenes, la oficina mantiene abierta la petición `Stop` hasta que llegue una orden, se desactive la guardia o venza el plazo (`GUARDIA_MAX_MIN`, 14 min por defecto; el instalador da al hook `Stop` ese plazo más 1 min). Así un agente puede quedar «de servicio» y recibir trabajo desde la oficina. Mientras espera, la terminal queda ocupada. Si Claude Code corta la petición (Esc, Ctrl+C o el timeout del hook), la espera se libera.

Las sesiones **inactivas sin guardia** no ejecutan hooks, así que sus órdenes esperan en cola hasta el próximo prompt o la próxima herramienta.

**Topes de entrega.** Cada entrega lleva unos 9000 caracteres de órdenes, porque `additionalContext` admite 10.000; el resto sale en la siguiente. Claude Code ignora el `block` de `Stop` tras 8 continuaciones seguidas, así que al llegar a ese tope la orden sigue pendiente hasta la próxima herramienta o el próximo prompt.

### 2.3 Seguridad

La oficina puede darle instrucciones a Claude, y Claude actúa con los permisos del usuario. Por eso:

* **Dos puertos.** El panel (7777) se publica en `127.0.0.1` por defecto o en la IP del VPS (`PUBLICAR_IP`). Los hooks (7778, HTTP plano) se publican siempre en `127.0.0.1`, y `/api/hook` solo existe en ese puerto.
* **Escucha.** Sin `ESCUCHA`, el panel escucha en `127.0.0.1`, para que `npm start` no lo abra a la LAN, o en `PUBLICAR_IP` si es remoto; los hooks, siempre en `127.0.0.1`. El Dockerfile fija `ESCUCHA=0.0.0.0` para los dos puertos, porque dentro del contenedor quien limita es el `ports` del compose.
* **Modo VPS con contraseña.** Si el panel se publica fuera de localhost, o con `ACCESO_REMOTO=1` (detrás de un proxy), el servidor no arranca sin `OFICINA_PASSWORD` o `OFICINA_PASSWORD_FILE` de al menos 12 caracteres. El acceso usa una cookie de sesión aleatoria (`HttpOnly`, `SameSite=Strict`, `Secure` con HTTPS, 12 h). La contraseña solo se guarda en memoria como derivado scrypt. Tras 5 fallos en 10 min, la IP queda bloqueada 15 min, y cada fallo añade una espera.
* **HTTPS en el VPS.** Por defecto se genera un certificado autofirmado EC P-256 para la IP o el dominio de `TLS_HOSTS`, guardado en un volumen. También se puede usar un certificado propio (`TLS=archivos`) o un proxy con HTTPS (`TLS=0` + `CONFIAR_PROXY=1`).
* **Credencial también en modo local.** Origin y Host los falsifica cualquier programa del equipo, así que no bastan como barrera. Sin contraseña propia, el servidor genera un secreto en `panel-secreto`, dentro de la carpeta de datos (modo 0600), que hace de contraseña, y muestra en el log un enlace de un solo uso que caduca a los 15 min y da la cookie de sesión. Frena a otros usuarios del equipo, no a programas con el mismo usuario.
* **Defensa contra DNS rebinding en modo local.** Sin contraseña propia, se rechaza cualquier `Host` que no sea `localhost`, `127.0.0.1` o `::1`.
* **Hooks autenticados.** `/api/hook` exige el token (comparación en tiempo constante) y `Content-Type: application/json`. Una web maliciosa no puede enviar ese tipo de contenido a otro origen sin preflight CORS, y la oficina nunca lo concede.
* **WebSocket solo desde la propia página.** Las órdenes viajan por `/ws`, que exige sesión válida y que `Origin` coincida con el host. Al caducar la sesión, se cierra. También tiene un límite de 40 mensajes cada 10 s y de 4000 caracteres por orden. Lo que pasa del límite se descarta sin respuesta, así que el panel conserva el texto hasta que llega la confirmación.
* **Lo que se muestra va enmascarado, lo mejor posible.** Antes de llegar al panel se recortan y ocultan claves privadas, tokens de GitHub/AWS/Slack/Anthropic/Google, JWT, `password=`, cabeceras `Authorization`, URLs con credenciales y claves en argumentos como `sshpass -p`, `mysql -p`, `--password x` o `curl -u`. Funciona por patrones: un secreto con otro formato se vería, así que el panel debe tratarse como información sensible.
* **Las órdenes siguen el modo de permisos de la sesión.** La oficina no aprueba ni rechaza permisos. Si Claude Code pide aprobación para una acción, la sigue pidiendo en la terminal. Pero en modo bypass o auto, y en lo que cubran las listas de permitidos, una orden se ejecuta sin que nadie apruebe nada, y entrar en el panel equivale a tener una shell con ese usuario. El detalle del agente avisa si `permission_mode` es `bypassPermissions`, `dontAsk` o `auto`. Ese dato llega con los hooks: una sesión detectada solo por su transcript no muestra el aviso.
* **Contenedor endurecido.** Usuario no root (salvo que instales como root: la receta toma tu `id -u`, y entonces quedaría `0:0`; usa un usuario normal), sistema de archivos de solo lectura, `cap_drop: ALL`, `no-new-privileges`, límites de memoria y procesos. Solo monta `~/.claude/projects` y `~/.claude/ai-office`, en solo lectura, así que las credenciales de Claude y `settings.json` quedan fuera. Solo el paso `instalar` monta `~/.claude` entero, en escritura y sin red.
* **Casi sin persistencia.** El estado vive en memoria, así que tras reiniciar la oficina una sesión cerrada en los últimos 20 min puede reaparecer un tiempo por su transcript; solo los perfiles editados por el usuario (nombre, rol y género) se guardan, en `perfiles.json` dentro de la carpeta de datos. Se conservan como máximo 200. Al reiniciar la oficina se recuperan las sesiones recientes desde los transcripts locales.

## 3. Estructura

```text
ai-office-3d/
├── docker-compose.yml          # servicio oficina + paso «instalar» (perfil)
├── .env.example                # acceso (PUBLICAR_IP, contraseña, TLS, proxy), hooks, CLAUDE_DIR, UID_GID, guardia, demo
├── .github/workflows/ci.yml    # npm ci, npm test y sintaxis de public/ con Node 22 en Linux
├── oficina/
│   ├── Dockerfile
│   ├── src/
│   │   ├── servidor.js         # los dos puertos, /api/hook, WebSocket, estáticos, seguridad
│   │   ├── acceso.js           # contraseña, sesiones y bloqueo por IP
│   │   ├── tls.js              # HTTPS: autofirmado, certificado propio o ninguno
│   │   ├── oficina.js          # estados, subagentes, órdenes y modo guardia
│   │   ├── transcripts.js      # tokens y sesiones recientes desde ~/.claude/projects
│   │   ├── redactar.js         # recorte y enmascarado de secretos
│   │   └── demo.js             # agentes simulados (AI_OFFICE_DEMO=1)
│   ├── public/
│   │   ├── index.html, app.js  # panel: lista, detalle y órdenes
│   │   ├── escena.js           # oficina 3D
│   │   ├── estados.js          # colores y nombres de los estados
│   │   ├── agentes.html, agentes.js  # gestión de agentes
│   │   ├── login.html, login.js
│   │   └── estilos.css
│   ├── scripts/
│   │   ├── instalar-hooks.mjs
│   │   └── demo.js             # npm run demo
│   └── test/                   # node --test: acceso, instalador, oficina y servidor
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
