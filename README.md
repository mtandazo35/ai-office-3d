# ai-office-3d

Oficina virtual en 3D, en tu propio equipo, para **ver trabajar a tus sesiones de Claude Code** (terminal o VS Code) y **darles órdenes** desde el navegador.

- Cada sesión es un escritorio con su avatar. El monitor muestra la herramienta y el archivo o comando en curso, y un anillo en el suelo indica el estado: trabajando, pensando, espera tu aprobación, en guardia, error o inactivo.
- Los subagentes aparecen como drones sobre el escritorio que los lanzó.
- Al pulsar un escritorio ves el detalle: permiso pendiente, contexto y tokens, último prompt y respuesta, y registro de actividad.
- **Órdenes:** las escribes en el panel y Claude las recibe en su siguiente paso. Con el **modo guardia**, el agente se queda esperando órdenes de la oficina al terminar su turno.

Funciona con hooks `http` de Claude Code. No necesita scripts en el equipo ni salir a internet: three.js va dentro de la imagen.

## Puesta en marcha

Requisitos: Docker con Compose y una versión reciente de Claude Code (con hooks de tipo `http`).

```bash
git clone https://github.com/mtandazo35/ai-office-3d && cd ai-office-3d
cp .env.example .env
echo "UID_GID=$(id -u):$(id -g)" >> .env      # Linux: para leer ~/.claude con tu usuario

docker compose up -d --build                   # oficina en http://127.0.0.1:7777
docker compose run --rm instalar               # añade los hooks a ~/.claude/settings.json (una vez)
```

Después reinicia tus sesiones de Claude Code (con `/hooks` compruebas que están cargados) y abre <http://127.0.0.1:7777>.

- **Probar sin Claude Code:** `AI_OFFICE_DEMO=1 docker compose up --build` muestra tres agentes simulados que también obedecen órdenes.
- **Windows (Docker Desktop):** define `CLAUDE_DIR=C:/Users/<tu-usuario>/.claude` en `.env`.
- **Desinstalar los hooks:** `docker compose run --rm instalar --desinstalar`. Solo se quitan las entradas de la oficina; antes de cada cambio queda una copia `settings.json.bak-ai-office-…`.
- **Sin Docker:** `cd oficina && npm ci && npm run instalar-hooks && npm start`.

## Cómo llegan las órdenes a Claude

| Cuándo | Hook | Qué recibe Claude |
| :- | :- | :- |
| Mientras trabaja | `PostToolUse` | la orden junto al resultado de la herramienta |
| Al enviar un prompt | `UserPromptSubmit` | la orden junto al prompt |
| Al terminar su turno | `Stop` | la orden como motivo para seguir trabajando |
| En guardia | `Stop` (espera abierta) | la orden en cuanto la envías, hasta `GUARDIA_MAX_MIN` minutos |

Las órdenes **no saltan los permisos** de Claude Code: si una acción requiere aprobación, la sigue pidiendo en la terminal o en VS Code.

## Seguridad

La oficina puede dar instrucciones a Claude, así que está pensada para uso estrictamente local:
- solo escucha en `127.0.0.1`;
- rechaza cabeceras `Host` ajenas (DNS rebinding);
- exige un token en los hooks;
- solo acepta el WebSocket desde su propia página;
- enmascara secretos antes de mostrarlos;
- corre en un contenedor endurecido con `~/.claude` en solo lectura.

Detalle en [`docs/arquitectura.md`](docs/arquitectura.md#23-seguridad).

## Contenido

- `oficina/`: el servicio (servidor Node, oficina 3D, instalador de hooks y tests: `npm test`).
- `docs/arquitectura.md`: diseño, tabla evento → estado, mecanismo de órdenes y seguridad.
- `prototipos/modelo-multiagente-3d.html`: prototipo autocontenido del modelo multiagente (niveles N1–N4, Coordinador y especialistas). Se abre directamente en el navegador.
