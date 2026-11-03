#!/usr/bin/env python3
"""Conector de la Oficina IA: abre sesiones de Claude Code en tmux, en el servidor.

El panel corre en un contenedor sin acceso al host, así que este servicio hace ese trabajo con el
usuario que trabaja con Claude. Solo escucha en un socket local dentro de ~/.claude/ai-office, una
carpeta 700 de ese usuario; el panel llega a él por el montaje de esa carpeta, tras su login.

Solo responde por su cuenta a las pantallas que conoce. Ante cualquier otra se detiene y devuelve lo
que ve, para que decida una persona.
"""
import json
import os
import re
import socketserver
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler

CASA = os.path.expanduser("~")
SOCKET = os.environ.get("CONECTOR_SOCKET", os.path.join(CASA, ".claude", "ai-office", "conector.sock"))
SESIONES = os.path.join(CASA, ".claude", "sessions")
CREDENCIALES = os.path.join(CASA, ".claude", ".credentials.json")
MAX_AGENTES = int(os.environ.get("CONECTOR_MAX_AGENTES", "6"))
MAX_TEXTO = 16000
RE_CODIGO = re.compile(r"^[A-Za-z0-9_#.~-]{8,1024}$")
RE_LISTO = re.compile(r"shift\+tab|for shortcuts")
ORIGENES_LOGIN = ("https://claude.com/", "https://claude.ai/", "https://console.anthropic.com/", "https://platform.claude.com/")

cerrojo = threading.Lock()


# ---------- Lectura de la pantalla (sin efectos, se prueba sola) ----------
def extraer_url(pantalla):
    """El enlace de autorización ocupa varias líneas: va de https:// hasta la petición del código."""
    inicio = pantalla.find("https://")
    fin = pantalla.find("Paste code", inicio)
    if inicio < 0 or fin < 0:
        return None
    url = re.sub(r"\s+", "", pantalla[inicio:fin])
    return url if url.startswith(ORIGENES_LOGIN) else None


def esta_listo(pantalla):
    return bool(RE_LISTO.search(pantalla)) and "esc to interrupt" not in pantalla


def limpiar_texto(texto):
    """Una sola línea, sin controles. Un primer carácter especial se neutraliza: `!` ejecutaría una
    orden de shell sin pasar por Claude, y `/` un comando de la sesión."""
    limpio = re.sub(r"[\x00-\x1f\x7f]+", " ", str(texto)).strip()[:MAX_TEXTO]
    if limpio[:1] in ("!", "/", "#", "&", "@"):
        limpio = "Orden: " + limpio
    return limpio


# Pantallas de la primera vez que se responden solas, y con qué teclas.
PANTALLAS = (
    ("Choose the text style", ["Enter"]),
    ("Select login method", ["Enter"]),
    ("Login successful", ["Enter"]),
    ("Security notes", ["Enter"]),
    ("trust this folder", ["Down", "Enter"]),
)


def teclas_para(pantalla):
    for texto, teclas in PANTALLAS:
        if texto in pantalla:
            return teclas
    return None


# ---------- tmux ----------
def tmux(*args):
    r = subprocess.run(["tmux", *args], capture_output=True, text=True, errors="replace", timeout=15, check=False)
    return r.returncode, r.stdout


def ver(nombre):
    return tmux("capture-pane", "-p", "-J", "-t", "=" + nombre + ":")[1]


def teclas(nombre, *lista):
    for tecla in lista:
        tmux("send-keys", "-t", "=" + nombre + ":", tecla)
        time.sleep(0.5)


def escribir(nombre, texto):
    tmux("send-keys", "-t", "=" + nombre + ":", "-l", "--", texto)
    time.sleep(0.5)
    teclas(nombre, "Enter")


def agentes():
    """Sesiones de tmux que corren Claude Code, con su id de sesión."""
    codigo, salida = tmux("list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}")
    if codigo != 0:
        return []
    lista = []
    for linea in salida.splitlines():
        nombre, _, pid = linea.partition("\t")
        try:
            with open(os.path.join(SESIONES, pid + ".json"), encoding="utf-8") as f:
                datos = json.load(f)
        except (OSError, ValueError):
            lista.append({"agente": nombre, "sessionId": "", "cwd": ""})
            continue
        lista.append({"agente": nombre, "sessionId": datos.get("sessionId", ""), "cwd": datos.get("cwd", "")})
    return lista


def buscar(session_id):
    for a in agentes():
        if a["sessionId"] and a["sessionId"] == session_id:
            return a
    return None


def resumen(pantalla):
    return "\n".join([l.rstrip() for l in pantalla.splitlines() if l.strip()][-15:])


def avanzar(nombre, limite):
    """Avanza por las pantallas conocidas hasta pedir el código, estar lista o agotar el plazo."""
    fin = time.time() + limite
    pantalla = ""
    while time.time() < fin:
        pantalla = ver(nombre)
        if "Paste code" in pantalla:
            url = extraer_url(pantalla)
            if url:
                return {"estado": "login", "agente": nombre, "url": url}
            return {"estado": "desconocido", "agente": nombre, "pantalla": resumen(pantalla)}
        pulsar = teclas_para(pantalla)
        if pulsar:
            teclas(nombre, *pulsar)
            time.sleep(2)
            continue
        if esta_listo(pantalla):
            return listo(nombre)
        time.sleep(1)
    return {"estado": "desconocido", "agente": nombre, "pantalla": resumen(pantalla)}


def listo(nombre):
    for _ in range(10):
        for a in agentes():
            if a["agente"] == nombre and a["sessionId"]:
                return {"estado": "listo", **a}
        time.sleep(0.5)
    return {"estado": "desconocido", "agente": nombre, "pantalla": "Claude está listo, pero no encuentro su sesión."}


# ---------- Acciones ----------
def nuevo_agente():
    with cerrojo:
        actuales = agentes()
        # Si uno ya espera el código, se reutiliza: pulsar dos veces no abre dos inicios de sesión.
        for a in actuales:
            if "Paste code" in ver(a["agente"]):
                return avanzar(a["agente"], 5)
        if len(actuales) >= MAX_AGENTES:
            return {"error": "Ya hay " + str(MAX_AGENTES) + " agentes abiertos. Termina alguno antes de abrir otro."}
        ocupados = {a["agente"] for a in actuales}
        n = 1
        while "agente-" + str(n) in ocupados:
            n += 1
        nombre = "agente-" + str(n)
        codigo, _ = tmux("new-session", "-d", "-s", nombre, "-x", "220", "-y", "50", "-c", CASA, "claude")
        if codigo != 0:
            return {"error": "No pude abrir la sesión de tmux."}
        time.sleep(3)
        return avanzar(nombre, 40)


def enviar_codigo(nombre, codigo):
    if not isinstance(codigo, str) or not RE_CODIGO.match(codigo.strip()):
        return {"error": "Ese código no tiene el formato esperado. Cópialo entero."}
    if not any(a["agente"] == nombre for a in agentes()):
        return {"error": "Esa sesión ya no existe. Pulsa «Conectar» otra vez."}
    with cerrojo:
        if "Paste code" not in ver(nombre):
            return {"error": "Esa sesión ya no está esperando un código."}
        escribir(nombre, codigo.strip())
        fin = time.time() + 20
        while time.time() < fin and "Paste code" in ver(nombre):
            time.sleep(1)
        if "Paste code" in ver(nombre):
            return {"error": "Claude no aceptó el código. Puede haber caducado: cierra y vuelve a pulsar «Conectar».", "estado": "login", "agente": nombre}
        return avanzar(nombre, 45)


def enviar_texto(session_id, texto):
    a = buscar(session_id)
    if not a:
        return 404, {"error": "Ese agente ya no está abierto."}
    limpio = limpiar_texto(texto)
    if not limpio:
        return 400, {"error": "La orden está vacía."}
    with cerrojo:
        if not esta_listo(ver(a["agente"])):
            return 409, {"error": "El agente está ocupado."}
        escribir(a["agente"], limpio)
    return 200, {"ok": True}


def terminar(session_id):
    a = buscar(session_id)
    if not a:
        return 404, {"error": "Ese agente ya no está abierto."}
    with cerrojo:
        if esta_listo(ver(a["agente"])):
            # /exit le da a Claude la ocasión de cerrar bien y avisar a la oficina.
            escribir(a["agente"], "/exit")
            for _ in range(8):
                time.sleep(1)
                if not any(x["agente"] == a["agente"] for x in agentes()):
                    return 200, {"ok": True}
        tmux("kill-session", "-t", "=" + a["agente"])
    return 200, {"ok": True}


# ---------- Servidor local ----------
class Manejador(BaseHTTPRequestHandler):
    def address_string(self):
        return "local"

    def log_message(self, *args):
        pass  # los códigos y órdenes no deben acabar en ningún log

    def responder(self, codigo, datos):
        cuerpo = json.dumps(datos).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        if self.path == "/estado":
            return self.responder(200, {"autenticado": os.path.exists(CREDENCIALES), "agentes": [a for a in agentes() if a["sessionId"]]})
        return self.responder(404, {"error": "No encontrado"})

    def do_POST(self):
        largo = int(self.headers.get("Content-Length") or 0)
        if largo > 64 * 1024:
            return self.responder(413, {"error": "Demasiado grande"})
        try:
            d = json.loads(self.rfile.read(largo) or b"{}")
        except ValueError:
            return self.responder(400, {"error": "JSON inválido"})
        if self.path == "/agentes":
            r = nuevo_agente()
            return self.responder(200, r)
        if self.path == "/codigo":
            return self.responder(200, enviar_codigo(str(d.get("agente", "")), d.get("codigo")))
        if self.path == "/enviar":
            return self.responder(*enviar_texto(str(d.get("sessionId", "")), d.get("texto", "")))
        if self.path == "/terminar":
            return self.responder(*terminar(str(d.get("sessionId", ""))))
        return self.responder(404, {"error": "No encontrado"})


class Servidor(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    os.makedirs(os.path.dirname(SOCKET), mode=0o700, exist_ok=True)
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    os.umask(0o177)
    with Servidor(SOCKET, Manejador) as servidor:
        servidor.serve_forever()


if __name__ == "__main__":
    main()
