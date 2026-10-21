# ai-office-3d

Oficina virtual en 3D, en tu propio equipo, para **ver trabajar a tus sesiones de Claude Code** (terminal o VS Code) y **darles órdenes** desde el navegador.

- **Estilo videojuego:** la oficina es un diorama con suelo de madera, ventanas cuyo cielo sigue la hora real, reloj de pared, estantería, cafetera, plantas y sombras. Cada sesión es un personaje chibi con su propio aspecto: entra por la puerta, se sienta, teclea, levanta la mano cuando pide permiso, se rasca la cabeza al pensar y se va al cerrar la sesión.
- **Efectos:** código flotando del monitor mientras trabaja, confeti al completar un turno, bocadillos («…», «?», «!», «Zz»), «¡Orden recibida!» y subidas de nivel. Cada agente sube de nivel según las acciones que hace, con su barra de XP. Los subagentes son robots ayudantes que vuelan alrededor de su escritorio.
- El monitor de cada escritorio muestra la herramienta y el archivo o comando en curso, y el anillo del suelo indica el estado: trabajando, pensando, espera tu aprobación, en guardia, error o inactivo.
- Al pulsar un escritorio ves el detalle: permiso pendiente, contexto y tokens, último prompt y respuesta, y registro de actividad.
- **Órdenes:** las escribes en el panel y Claude las recibe en su siguiente paso. Con el **modo guardia**, el agente se queda esperando órdenes de la oficina al terminar su turno.

Funciona con hooks `http` de Claude Code. No necesita scripts en el equipo ni salir a internet: three.js va dentro de la imagen.

## Puesta en marcha en el VPS

Requisitos: Docker con Compose y una versión reciente de Claude Code (con hooks de tipo `http`) **trabajando en el mismo VPS**.

```bash
git clone https://github.com/mtandazo35/ai-office-3d && cd ai-office-3d
cp .env.example .env
# Usuario que usa Claude Code en el VPS, acceso desde la IP, contraseña aleatoria e IP pública para el certificado:
sed -i "s|^UID_GID=.*|UID_GID=$(id -u):$(id -g)|; s|^PUBLICAR_IP=.*|PUBLICAR_IP=0.0.0.0|; s|^OFICINA_PASSWORD=.*|OFICINA_PASSWORD=$(openssl rand -base64 24)|; s|^TLS_HOSTS=.*|TLS_HOSTS=$(curl -s https://ifconfig.me)|" .env

docker compose up -d --build
docker compose run --rm instalar                     # añade los hooks a ~/.claude/settings.json (una vez)
docker compose logs oficina | grep SHA-256           # huella del certificado
```

Abre `https://IP_DEL_VPS:7777`. El navegador avisará de que el certificado no es de confianza porque es autofirmado: comprueba que la huella SHA-256 coincide con la del log y acéptalo. Entra con la contraseña (`grep OFICINA_PASSWORD .env`). Por último, reinicia tus sesiones de Claude Code en el VPS (con `/hooks` compruebas que están cargados).

- **Cortafuegos:** abre solo el puerto 7777, mejor limitado a tus IPs (p. ej. `ufw allow from TU_IP to any port 7777 proto tcp`). El 7778 de los hooks queda en 127.0.0.1 y no hay que abrirlo.
- **Con dominio y Nginx Proxy Manager:** pon `TLS=0`, `CONFIAR_PROXY=1` y `PUBLICAR_IP=127.0.0.1`, y apunta el proxy (con Let's Encrypt y soporte de WebSockets) a `127.0.0.1:7777`.
- **Claude Code en tu PC y la oficina en el VPS:** abre un túnel `ssh -N -L 7778:127.0.0.1:7778 usuario@VPS` y, en el PC, instala los hooks con el token del VPS: `AI_OFFICE_TOKEN=$(ssh usuario@VPS cat ~/.claude/ai-office/token) node oficina/scripts/instalar-hooks.mjs`. Así no expones el puerto de hooks.
- **Solo en local** (sin VPS): deja `PUBLICAR_IP=127.0.0.1`. Se abre en `http://127.0.0.1:7777` sin contraseña.
- **Probar sin Claude Code:** `AI_OFFICE_DEMO=1 docker compose up --build` muestra tres agentes simulados que también obedecen órdenes.
- **Desinstalar los hooks:** `docker compose run --rm instalar --desinstalar`. Solo se quitan las entradas de la oficina; antes de cada cambio queda una copia `settings.json.bak-ai-office-…`.

## Cómo llegan las órdenes a Claude

| Cuándo | Hook | Qué recibe Claude |
| :- | :- | :- |
| Mientras trabaja | `PostToolUse` | la orden junto al resultado de la herramienta |
| Al enviar un prompt | `UserPromptSubmit` | la orden junto al prompt |
| Al terminar su turno | `Stop` | la orden como motivo para seguir trabajando |
| En guardia | `Stop` (espera abierta) | la orden en cuanto la envías, hasta `GUARDIA_MAX_MIN` minutos |

Las órdenes **no saltan los permisos** de Claude Code: si una acción requiere aprobación, la sigue pidiendo en la terminal o en VS Code.

## Seguridad

La oficina puede dar instrucciones a Claude, que actúa con tus permisos en el VPS. Por eso:
- en modo VPS exige contraseña (se niega a arrancar sin ella), usa HTTPS y bloquea una IP 15 min tras 5 fallos;
- la sesión es una cookie `HttpOnly` + `SameSite=Strict` de 12 h;
- en modo local solo escucha en `127.0.0.1` y rechaza cabeceras `Host` ajenas (DNS rebinding);
- el puerto de hooks (7778) nunca se publica fuera de `127.0.0.1`;
- exige un token en los hooks;
- solo acepta el WebSocket desde su propia página;
- enmascara secretos antes de mostrarlos;
- corre en un contenedor endurecido con `~/.claude` en solo lectura.

Detalle en [`docs/arquitectura.md`](docs/arquitectura.md#23-seguridad).

## Contenido

- `oficina/`: el servicio (servidor Node, oficina 3D, instalador de hooks y tests: `npm test`).
- `docs/arquitectura.md`: diseño, tabla evento → estado, mecanismo de órdenes y seguridad.
- `prototipos/modelo-multiagente-3d.html`: prototipo autocontenido del modelo multiagente (niveles N1–N4, Coordinador y especialistas). Se abre directamente en el navegador.
