# ai-office-3d

Oficina virtual en 3D, en tu propio equipo, para **ver trabajar a tus sesiones de Claude Code** (terminal o VS Code) y **darles órdenes** desde el navegador.

- **Estilo videojuego:** la oficina es un diorama con suelo de madera, ventanas cuyo cielo sigue la hora real, reloj de pared, estantería, cafetera, plantas y sombras. Cada sesión es un personaje chibi con su propio aspecto (peinado, ropa y accesorio según su rol): entra por la puerta, se sienta, teclea, se levanta y te mira cuando pide permiso, pone cara según su estado, se va a por un café si lleva rato sin trabajar y sale al cerrar la sesión.
- **Efectos:** código flotando del monitor mientras trabaja, confeti al completar un turno, bocadillos («…», «?», «!», «Zz»), «¡Orden recibida!» y subidas de nivel. Cada agente sube de nivel según las acciones que hace, con su barra de XP. Cada subagente es un personaje con nombre propio, mesa pequeña y portátil delante de su agente (se dibujan hasta 6; el detalle los lista todos), y su agente figura como «Coordinando ayudantes» mientras acabó su turno y ellos siguen.
- **Gestión de agentes:** cada agente recibe un nombre propio y fijo para su sesión (Nico, Vera, Teo…). En «Gestionar agentes» (`/agentes.html`) puedes cambiar su nombre, darle un rol y elegir su género, que cambia el peinado de su personaje. Lo que edites se conserva al reiniciar la oficina y sigue ahí si reanudas la sesión, pero una sesión nueva empieza con un perfil nuevo. El rol no cambia lo que hace Claude: solo es una etiqueta y le pone un accesorio al personaje.
- El monitor de cada escritorio muestra la herramienta y el archivo o comando en curso, y el anillo del suelo indica el estado: trabajando, pensando, espera tu aprobación, en guardia, error, sin señal o inactivo.
- Al pulsar un escritorio ves el detalle: permiso pendiente, contexto y tokens, último prompt y respuesta, y registro de actividad.
- **Órdenes:** las escribes en el panel, cada agente con su propio borrador, y Claude las recibe en su siguiente paso. Con el **modo guardia**, el agente se queda esperando órdenes de la oficina al terminar su turno.

Funciona con hooks `http` de Claude Code. No necesita scripts en el equipo ni salir a internet: three.js va dentro de la imagen.

## ⚡ Quick install (one-liner)

En el servidor donde trabaja Claude Code, como root o con `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/mtandazo35/ai-office-3d/main/install.sh | sudo bash
```

Instala Docker si falta, clona el repo en `/root/ai-office-3d`, levanta la oficina, añade los hooks e instala Claude Code. El contenedor corre con un usuario normal: el que usa `sudo` o, si entras como root, uno nuevo llamado `oficina`, que acepta tus mismas claves SSH. Si el servidor tiene menos de 3 GB de RAM y no tiene swap, crea 2 GB. Se puede repetir para actualizar, y respeta el `.env` que ya exista.

La oficina queda en modo local: solo escucha en `127.0.0.1` y no abre ningún puerto a internet. Al terminar, el script muestra el túnel SSH y el enlace de un solo uso para entrar.

Para conectar un agente, pulsa **Conectar Claude Code** en el panel. La primera vez te da un enlace para autorizar con tu cuenta y una caja donde pegar el código; después basta con el botón. Cada pulsación abre un agente, hasta 6, y le hablas desde su caja de órdenes; «Terminar» cierra su sesión, y **Cerrar sesión de Claude** termina todos y cierra tu cuenta en ese servidor. **Quien tenga la contraseña del panel puede abrir agentes y darles órdenes con tu cuenta y con los permisos de ese usuario**, así que trátala como una clave SSH. Por `http`, la contraseña y el código viajan sin cifrar por tu red. Con `OFICINA_SIN_CLAUDE=1` no se instala Claude Code ni el conector.

Probado en Debian 13. Solo admite sistemas con `apt`, y en otras versiones de Debian o Ubuntu aún no se ha comprobado. Antes de ejecutarlo puedes leer [`install.sh`](install.sh).

Si prefieres hacerlo paso a paso, o publicar el panel en la IP del servidor, sigue con la sección siguiente.

## Puesta en marcha en el VPS

Requisitos: Docker con Compose y una versión reciente de Claude Code (con hooks de tipo `http`) **trabajando en el mismo VPS**.

```bash
git clone https://github.com/mtandazo35/ai-office-3d && cd ai-office-3d
cp .env.example .env && chmod 600 .env                 # lleva la contraseña
# Usuario que usa Claude Code en el VPS, acceso desde la IP, contraseña aleatoria e IP pública para el certificado:
sed -i "s|^UID_GID=.*|UID_GID=$(id -u):$(id -g)|; s|^PUBLICAR_IP=.*|PUBLICAR_IP=0.0.0.0|; s|^OFICINA_PASSWORD=.*|OFICINA_PASSWORD=$(openssl rand -base64 24)|; s|^TLS_HOSTS=.*|TLS_HOSTS=$(curl -s https://ifconfig.me)|" .env

# Antes del primer arranque: si no existen, Docker las crea como root y el instalador falla después.
# Con CLAUDE_DIR propio, créalas en esa carpeta.
mkdir -p ~/.claude/ai-office ~/.claude/projects && chmod 700 ~/.claude/ai-office

docker compose up -d --build
docker compose run --rm instalar                     # añade los hooks a ~/.claude/settings.json (una vez)
docker compose logs oficina | grep SHA-256           # huella del certificado
```

Abre `https://IP_DEL_VPS:7777`. El navegador avisará de que el certificado no es de confianza porque es autofirmado: comprueba que la huella SHA-256 coincide con la del log y acéptalo. Entra con la contraseña (`grep OFICINA_PASSWORD .env`). Por último, reinicia tus sesiones de Claude Code en el VPS (con `/hooks` compruebas que están cargados).

- **Cortafuegos:** limita el 7777 a tus IPs con el cortafuegos de tu proveedor o con la cadena `DOCKER-USER` de iptables. **`ufw allow` no sirve aquí:** Docker publica el puerto con sus propias reglas, que se saltan UFW, y el panel seguiría abierto a internet. El 7778 de los hooks queda en 127.0.0.1 y no hay que abrirlo.
- **Con dominio y Nginx Proxy Manager:** sigue la [receta de abajo](#con-dominio-y-nginx-proxy-manager).
- **Claude Code en tu PC y la oficina en el VPS:** abre un túnel `ssh -N -L 7778:127.0.0.1:7778 usuario@VPS` y, en el PC, instala los hooks con el token del VPS: `AI_OFFICE_TOKEN=$(ssh usuario@VPS cat ~/.claude/ai-office/token) node oficina/scripts/instalar-hooks.mjs`. Así no expones el puerto de hooks.
- **Solo en local** (sin VPS): deja `PUBLICAR_IP=127.0.0.1`. Al arrancar, el log muestra un enlace de un solo uso que caduca en 15 min (`docker compose logs oficina | grep entrar`). Si caduca, la contraseña de la pantalla de acceso es el contenido de `panel-secreto`, en la carpeta de datos (`docker compose exec oficina cat /datos/panel-secreto`; sin Docker, `oficina/datos/panel-secreto`).
- **Sin Docker:** `cd oficina && npm ci && npm start`. Escucha solo en `127.0.0.1`. Para abrir el panel, define `PUBLICAR_IP` y `OFICINA_PASSWORD`: el panel escucha en esa IP y los hooks siguen en `127.0.0.1`.
- **Probar sin Claude Code:** `AI_OFFICE_DEMO=1 docker compose up --build` muestra tres agentes simulados que también obedecen órdenes. Sin Docker, `npm run demo` dentro de `oficina/`, también en Windows.
- **Desinstalar los hooks:** `docker compose run --rm instalar --desinstalar`. Solo se quitan las entradas de la oficina; antes de cada cambio queda una copia `settings.json.bak-ai-office-…`, y se conservan las 5 más recientes.

### Con dominio y Nginx Proxy Manager

NPM suele correr en su propio contenedor: para él, `127.0.0.1` es él mismo y no llega a la oficina. Hay que poner los dos en una red Docker compartida y apuntar el proxy al nombre del contenedor.

1. En `.env`, con `OFICINA_PASSWORD` generada con `openssl rand -base64 24`:

   ```bash
   PUBLICAR_IP=127.0.0.1
   ACCESO_REMOTO=1
   TLS=0
   CONFIAR_PROXY=1
   OFICINA_PASSWORD=...
   ```

   **La contraseña es obligatoria en este modo.** Con `ACCESO_REMOTO=1` el servidor no arranca sin una de al menos 12 caracteres. Sin ese ajuste, una contraseña vacía o corta no impediría arrancar, y el panel respondería 421 a tu dominio.
2. Busca la red de NPM: `docker inspect -f '{{json .NetworkSettings.Networks}}' CONTENEDOR_DE_NPM`.
3. Crea `docker-compose.override.yml` junto al compose (git lo ignora y Compose lo carga solo):

   ```yaml
   services:
     oficina:
       networks: [default, proxy]
   networks:
     proxy:
       external: true
       name: RED_DE_NPM
   ```

4. Ejecuta `docker compose up -d`. En NPM crea un Proxy Host con esquema `http`, host `ai-office` y puerto `7777`, que es el interno aunque cambies `PUERTO`. Activa Let's Encrypt, «Force SSL» y «Websockets Support».

Si NPM corre directamente en el host, sin contenedor, no hace falta el override: apúntalo a `127.0.0.1:7777`. Deja siempre el panel publicado en `127.0.0.1`: `CONFIAR_PROXY=1` hace que se crea lo que dice `X-Forwarded-For`.

### Contraseña en un archivo

`OFICINA_PASSWORD` en `.env` se ve con `docker inspect`. Para evitarlo:

```bash
(umask 077; openssl rand -base64 24 > oficina_password.txt)   # del mismo usuario que UID_GID; git lo ignora
```

En `.env`, deja `OFICINA_PASSWORD=` vacía, porque tiene prioridad, y pon `OFICINA_PASSWORD_FILE=/run/secrets/oficina_password`. Añade a `docker-compose.override.yml`:

```yaml
services:
  oficina:
    secrets: [oficina_password]
secrets:
  oficina_password:
    file: ./oficina_password.txt
```

## Cómo llegan las órdenes a Claude

| Cuándo | Hook | Qué recibe Claude |
| :- | :- | :- |
| Mientras trabaja | `PostToolUse` | la orden junto al resultado de la herramienta |
| Al enviar un prompt | `UserPromptSubmit` | la orden junto al prompt |
| Al terminar su turno | `Stop` | la orden como motivo para seguir trabajando |
| En guardia | `Stop` (espera abierta) | la orden en cuanto la envías, hasta `GUARDIA_MAX_MIN` minutos |

**Las órdenes siguen el modo de permisos de cada sesión.** Si Claude Code pide aprobación para una acción, la sigue pidiendo en la terminal o en VS Code. Pero en modo bypass o auto, y en lo que cubran tus listas de permitidos, **una orden se ejecuta sin que nadie apruebe nada**. En esos casos, entrar en el panel equivale a tener una shell con ese usuario. El detalle del agente muestra un aviso cuando la sesión está en `bypassPermissions`, `dontAsk` o `auto`.

## Seguridad

La oficina puede dar instrucciones a Claude, que actúa con tus permisos en el VPS. Por eso:
- en modo VPS o con `ACCESO_REMOTO=1` exige contraseña (se niega a arrancar sin ella) y bloquea una IP 15 min tras 5 fallos; en modo VPS usa además HTTPS;
- la sesión es una cookie `HttpOnly` + `SameSite=Strict` de 12 h;
- en modo local solo se publica en `127.0.0.1`, rechaza cabeceras `Host` ajenas (DNS rebinding) y también exige credencial: un secreto generado en un archivo solo para tu usuario. Esto frena a otros usuarios del equipo, pero **no a programas que corran con tu mismo usuario**, que pueden leer ese archivo. En Windows, la protección depende de los permisos de la carpeta;
- sin Docker, el servidor escucha en `127.0.0.1` por defecto; la imagen fija `ESCUCHA=0.0.0.0` porque dentro del contenedor quien limita es el `ports` del compose;
- el puerto de hooks (7778) nunca se publica fuera de `127.0.0.1`, y `/api/hook` solo existe en ese puerto, no en el del panel;
- exige un token en los hooks;
- solo acepta el WebSocket desde su propia página;
- enmascara secretos antes de mostrarlos, por patrones: no es infalible;
- corre en un contenedor endurecido que solo monta `~/.claude/projects` y `~/.claude/ai-office`, en solo lectura: las credenciales de Claude y `settings.json` quedan fuera.

Lo que queda en claro en tu equipo: la contraseña en `.env` (`chmod 600`, o usa el [archivo](#contraseña-en-un-archivo)), los transcripts, y el token de los hooks en `settings.json` y sus copias `.bak`. No subas esos archivos a un repo de dotfiles.

Detalle en [`docs/arquitectura.md`](docs/arquitectura.md#23-seguridad).

## Contenido

- `oficina/`: el servicio (servidor Node, oficina 3D, instalador de hooks y tests: `npm test`).
- `docs/arquitectura.md`: diseño, tabla evento → estado, mecanismo de órdenes y seguridad.
- `prototipos/modelo-multiagente-3d.html`: prototipo autocontenido del modelo multiagente (niveles N1–N4, Coordinador y especialistas). Se abre directamente en el navegador.
