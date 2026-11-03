#!/usr/bin/env bash
# Instala la Oficina IA en modo local: el panel y los hooks solo escuchan en 127.0.0.1.
#
#   curl -fsSL https://raw.githubusercontent.com/mtandazo35/ai-office-3d/main/install.sh | sudo bash
#
# Se puede repetir: actualiza el repo, respeta el .env existente y reconstruye lo que haya cambiado.
#
# Opciones, como variables de entorno (con sudo: sudo env OFICINA_USUARIO=ana bash):
#   OFICINA_USUARIO  usuario que trabaja con Claude Code (por defecto, quien usa sudo; si es root, "oficina")
#   OFICINA_DIR      carpeta del repo (por defecto /root/ai-office-3d)
#   OFICINA_RAMA     rama a instalar (por defecto main)
#   OFICINA_SIN_CLAUDE=1  no instala Claude Code

set -euo pipefail

falla() { echo "ERROR: $*" >&2; exit 1; }
paso() { echo; echo "==> $*"; }

# Toda la lógica va en funciones y main se llama en la última línea: con curl | bash, una descarga
# cortada no deja el script a medias. Los comandos de docker leen de /dev/null porque, si no,
# se tragarían el resto de este script, que llega por la entrada estándar.

instalar_paquetes() {
  command -v apt-get >/dev/null || falla "este instalador solo admite Debian y Ubuntu (apt)."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq </dev/null
  local paquetes=(git ca-certificates curl)
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    paquetes+=(docker.io)
    # Debian 13 separa el cliente de docker; compose cambia de nombre según la distribución.
    apt-cache show docker-cli >/dev/null 2>&1 && paquetes+=(docker-cli)
    apt-cache show docker-buildx >/dev/null 2>&1 && paquetes+=(docker-buildx)
    if apt-cache show docker-compose-v2 >/dev/null 2>&1; then paquetes+=(docker-compose-v2); else paquetes+=(docker-compose); fi
  fi
  apt-get install -y -qq --no-install-recommends "${paquetes[@]}" </dev/null >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || falla "no hay 'docker compose' v2. Instala Docker Engine con su guía oficial y repite."
}

crear_swap_si_falta() {
  local ram_kb
  ram_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  if [ "$ram_kb" -ge 3000000 ] || [ -n "$(swapon --noheadings)" ] || [ -e /swapfile ]; then return 0; fi
  paso "Poca RAM y sin swap: creo 2 GB de swap"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

preparar_usuario() {
  local usuario=$1 casa
  if ! id "$usuario" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$usuario"
    # Si root entra con clave pública, el usuario nuevo acepta la misma clave. No se pone contraseña.
    if [ -s /root/.ssh/authorized_keys ]; then
      install -d -m 700 -o "$usuario" -g "$usuario" "$(getent passwd "$usuario" | cut -d: -f6)/.ssh"
      install -m 600 -o "$usuario" -g "$usuario" /root/.ssh/authorized_keys "$(getent passwd "$usuario" | cut -d: -f6)/.ssh/authorized_keys"
    fi
  fi
  casa=$(getent passwd "$usuario" | cut -d: -f6)
  # Antes del primer arranque: si no existen, Docker las crearía como root.
  install -d -m 700 -o "$usuario" -g "$usuario" "$casa/.claude" "$casa/.claude/ai-office" "$casa/.claude/projects"
}

preparar_repo() {
  local dir=$1 rama=$2
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch -q origin "$rama"
    git -C "$dir" checkout -q "$rama"
    git -C "$dir" merge -q --ff-only "origin/$rama"
  else
    git clone -q --branch "$rama" https://github.com/mtandazo35/ai-office-3d "$dir"
  fi
}

preparar_env() {
  local usuario=$1 casa
  casa=$(getent passwd "$usuario" | cut -d: -f6)
  if [ -f .env ]; then
    echo "Respeto el .env que ya existe."
    return 0
  fi
  cp .env.example .env
  chmod 600 .env
  sed -i "s|^UID_GID=.*|UID_GID=$(id -u "$usuario"):$(id -g "$usuario")|" .env
  echo "CLAUDE_DIR=$casa/.claude" >> .env
}

# Claude Code se instala con el usuario, y el enlace deja usar `ssh -t usuario@ip claude`,
# que no carga el perfil del usuario. Si falla, la oficina sigue siendo válida: solo se avisa.
instalar_claude() {
  local usuario=$1 casa
  casa=$(getent passwd "$usuario" | cut -d: -f6)
  [ "${OFICINA_SIN_CLAUDE:-0}" = 1 ] && return 0
  if [ ! -x "$casa/.local/bin/claude" ]; then
    su -l "$usuario" -c 'curl -fsSL https://claude.ai/install.sh | bash' </dev/null >/dev/null 2>&1 || true
  fi
  if [ -x "$casa/.local/bin/claude" ]; then
    ln -sf "$casa/.local/bin/claude" /usr/local/bin/claude
    su -l "$usuario" -c 'claude --version' </dev/null || true
  else
    echo "AVISO: no pude instalar Claude Code. Instálalo a mano con el usuario $usuario y repite."
  fi
}

valor_env() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }

# Dirección del panel según el .env: local por defecto, o publicado en una IP.
url_panel() {
  local ip puerto tls esquema=http
  ip=$(valor_env PUBLICAR_IP); puerto=$(valor_env PUERTO); tls=$(valor_env TLS)
  case "${ip:-127.0.0.1}" in
    127.0.0.1|localhost|::1) ip=127.0.0.1 ;;
    0.0.0.0|::) ip=$(hostname -I 2>/dev/null | awk '{print $1}'); [ "$tls" = 0 ] || esquema=https ;;
    *) [ "$tls" = 0 ] || esquema=https ;;
  esac
  echo "$esquema://$ip:${puerto:-7777}"
}

esperar_servicio() {
  local i estado=''
  for i in $(seq 1 24); do
    estado=$(docker inspect -f '{{.State.Health.Status}}' ai-office 2>/dev/null </dev/null || true)
    [ "$estado" = healthy ] && break
    sleep 5
  done
  if [ "$estado" != healthy ]; then
    docker compose logs --tail 20 oficina </dev/null || true
    falla "la oficina no llegó a estar sana (estado: ${estado:-desconocido})."
  fi
  local sin_credencial
  sin_credencial=$(curl -k -s -m 5 -o /dev/null -w '%{http_code}' "$(url_panel)/api/estado" </dev/null || true)
  [ "$sin_credencial" = 401 ] || echo "AVISO: el panel responde $sin_credencial sin credencial, y debería ser 401."
}

main() {
  [ "$(id -u)" = 0 ] || falla "ejecútalo como root o con sudo."

  local usuario="${OFICINA_USUARIO:-${SUDO_USER:-oficina}}"
  [ "$usuario" = root ] && usuario=oficina
  local dir="${OFICINA_DIR:-/root/ai-office-3d}"
  local rama="${OFICINA_RAMA:-main}"

  paso "Paquetes y Docker"
  instalar_paquetes
  docker --version
  docker compose version
  crear_swap_si_falta

  paso "Usuario: $usuario"
  preparar_usuario "$usuario"

  paso "Repositorio: $dir ($rama)"
  preparar_repo "$dir" "$rama"
  cd "$dir"
  git log -1 --format='%h %s'
  preparar_env "$usuario"
  grep -q '^OFICINA_USUARIO=' .env || echo "OFICINA_USUARIO=$usuario" >> .env

  paso "Construyo y arranco la oficina"
  docker compose up -d --build --quiet-pull </dev/null

  paso "Instalo los hooks de Claude Code"
  docker compose run --rm instalar </dev/null

  paso "Instalo Claude Code para $usuario"
  instalar_claude "$usuario"

  paso "Compruebo el servicio"
  esperar_servicio
  docker ps --filter name=ai-office --format '{{.Names}} | {{.Status}} | {{.Ports}}' </dev/null

  local enlace ip
  enlace=$(docker compose logs --no-log-prefix oficina </dev/null 2>/dev/null | grep -o 'http://[^ ]*entrar?c=[^ ]*' | tail -1 || true)
  ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

  local url
  url=$(url_panel)
  echo
  case "$url" in
    http://127.0.0.1:*)
      cat <<FIN
Oficina IA instalada. Solo escucha en 127.0.0.1: no hay ningún puerto abierto a internet.

1. Desde tu PC, abre un túnel SSH:
     ssh -N -L 7777:127.0.0.1:7777 $usuario@${ip:-IP_DEL_SERVIDOR}

2. Entra con este enlace de un solo uso, que caduca a los 15 min de arrancar la oficina:
     ${enlace:-docker compose logs oficina | grep entrar}
   Si caducó o ya lo usaste, la contraseña está en:
     docker compose -f $dir/docker-compose.yml exec oficina cat /datos/panel-secreto
FIN
      ;;
    *)
      cat <<FIN
Oficina IA instalada y publicada, con contraseña, en:
     $url

La contraseña está en $dir/.env (OFICINA_PASSWORD):
     grep ^OFICINA_PASSWORD= $dir/.env | cut -d= -f2-
FIN
      ;;
  esac
  cat <<FIN

Para conectar un agente, pulsa «Conectar Claude Code» en el panel, o pega esto en una terminal de tu PC:
     ssh -t $usuario@${ip:-IP_DEL_SERVIDOR} claude
La primera vez, Claude te pedirá iniciar sesión con tu cuenta.

Para quitar los hooks: cd $dir && docker compose run --rm instalar --desinstalar
FIN
}

main "$@"
