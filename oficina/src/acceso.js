'use strict';
// Acceso al panel cuando la oficina se publica fuera de localhost (p. ej. en la IP de un VPS):
// contraseña -> cookie de sesión HttpOnly + SameSite=Strict, con bloqueo por intentos fallidos.

const crypto = require('crypto');
const net = require('net');

const DURACION_MS = 12 * 3600 * 1000;      // la sesión dura 12 h
const VENTANA_FALLOS_MS = 10 * 60 * 1000;   // 5 fallos en 10 min...
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;          // ...bloquean esa IP 15 min
const COOKIE = 'oficina_sesion';
const MAX_IPS = 10000;                      // IPs recordadas como mucho en el mapa de intentos
const MAX_SCRYPT_SIMULTANEOS = 2;           // deja libres hilos de libuv para el resto del servidor
const MAX_SCRYPT_EN_COLA = 16;              // más allá de esto se rechaza sin comprobar

// Dónde escucha cada puerto. ESCUCHA explícita manda en los dos (Docker: 0.0.0.0, y quien limita
// es el "ports" del compose). Sin ella, el panel solo sale de localhost si se pidió publicarlo,
// y entonces exige contraseña; los hooks van siempre en HTTP plano y no salen del equipo.
function direccionesEscucha({ escucha, publicarIp, remoto }) {
  const fija = String(escucha || '').trim();
  if (fija) return { panel: fija, hooks: fija };
  return { panel: (remoto && publicarIp) || '127.0.0.1', hooks: '127.0.0.1' };
}

class Acceso {
  constructor({ password, confiarProxy = false, ahora = () => Date.now() } = {}) {
    this.activo = !!password;
    this.confiarProxy = confiarProxy;
    this.ahora = ahora;
    this.sesiones = new Map();   // token -> caduca
    this.intentos = new Map();   // ip -> { fallos, desde, hasta }
    this.scryptEnCurso = 0;
    this.scryptCola = [];        // quienes esperan turno para derivar
    if (this.activo) {
      // Solo se guarda un derivado de la contraseña, nunca el texto.
      this.sal = crypto.randomBytes(16);
      this.huella = crypto.scryptSync(String(password), this.sal, 32);
    }
  }

  ip(req) {
    if (this.confiarProxy) {
      // La última entrada es la que añadió nuestro proxy; las anteriores las manda el cliente.
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
      if (net.isIP(xff)) return xff;
    }
    return req.socket.remoteAddress || 'desconocida';
  }

  esHttps(req) {
    if (req.socket.encrypted) return true;
    return this.confiarProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  bloqueada(ip) {
    const r = this.intentos.get(ip);
    return !!(r && r.hasta && r.hasta > this.ahora());
  }

  async comprobar(password) {
    if (!this.activo || typeof password !== 'string' || password.length > 512) return false;
    return crypto.timingSafeEqual(await this.derivar(password), this.huella);
  }

  // Scrypt fuera del bucle de eventos y con turnos: al terminar, el hueco pasa al siguiente.
  async derivar(password) {
    if (this.scryptEnCurso < MAX_SCRYPT_SIMULTANEOS) this.scryptEnCurso += 1;
    else await new Promise((turno) => this.scryptCola.push(turno));
    try {
      return await new Promise((ok, mal) => crypto.scrypt(password, this.sal, 32, (e, h) => (e ? mal(e) : ok(h))));
    } finally {
      const siguiente = this.scryptCola.shift();
      if (siguiente) siguiente();
      else this.scryptEnCurso -= 1;
    }
  }

  contarFallo(ip, t) {
    let r = this.intentos.get(ip);
    if (!r || t - r.desde > VENTANA_FALLOS_MS) r = { fallos: 0, desde: t, hasta: 0 };
    r.fallos += 1;
    if (r.fallos >= MAX_FALLOS) r.hasta = t + BLOQUEO_MS;
    if (!this.intentos.has(ip) && this.intentos.size >= MAX_IPS) this.hacerSitio(t);
    this.intentos.set(ip, r);
  }

  // Mapa lleno: sale el registro más antiguo que no esté bloqueando, y si todos bloquean, el más antiguo.
  hacerSitio(t) {
    this.limpiar();
    if (this.intentos.size < MAX_IPS) return;
    for (const [k, v] of this.intentos) if (!(v.hasta > t)) { this.intentos.delete(k); return; }
    this.intentos.delete(this.intentos.keys().next().value);
  }

  // Devuelve { ok, token?, error?, esperaSeg? }
  async entrar(req, password) {
    const ip = this.ip(req);
    const t = this.ahora();
    if (this.bloqueada(ip)) return { ok: false, error: 'Demasiados intentos. Prueba más tarde.', esperaSeg: Math.ceil((this.intentos.get(ip).hasta - t) / 1000) };
    if (this.scryptEnCurso + this.scryptCola.length >= MAX_SCRYPT_SIMULTANEOS + MAX_SCRYPT_EN_COLA) {
      return { ok: false, error: 'Servidor ocupado. Prueba en unos segundos.', esperaSeg: 5 };
    }
    // Se cuenta como fallo ANTES de esperar a scrypt, y sin await de por medio: si no, los intentos
    // en paralelo verían todos el contador sin subir y se saltarían el bloqueo. Acertar lo borra.
    this.contarFallo(ip, t);
    if (!(await this.comprobar(password))) return { ok: false, error: 'Contraseña incorrecta.' };
    this.intentos.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sesiones.set(token, t + DURACION_MS);
    return { ok: true, token };
  }

  cookieSesion(req, token) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DURACION_MS / 1000}` + (this.esHttps(req) ? '; Secure' : '');
  }

  cookieBorrar(req) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` + (this.esHttps(req) ? '; Secure' : '');
  }

  tokenDe(req) {
    const c = String(req.headers.cookie || '');
    for (const parte of c.split(';')) {
      const i = parte.indexOf('=');
      if (i > 0 && parte.slice(0, i).trim() === COOKIE) return parte.slice(i + 1).trim();
    }
    return null;
  }

  // ¿La petición puede usar el panel?
  autorizada(req) {
    if (!this.activo) return true;
    const token = this.tokenDe(req);
    if (!token) return false;
    const caduca = this.sesiones.get(token);
    if (!caduca) return false;
    if (caduca < this.ahora()) { this.sesiones.delete(token); return false; }
    return true;
  }

  salir(req) {
    const token = this.tokenDe(req);
    if (token) this.sesiones.delete(token);
  }

  limpiar() {
    const t = this.ahora();
    for (const [k, v] of this.sesiones) if (v < t) this.sesiones.delete(k);
    for (const [k, v] of this.intentos) if ((!v.hasta || v.hasta < t) && t - v.desde > VENTANA_FALLOS_MS) this.intentos.delete(k);
  }
}

module.exports = { Acceso, COOKIE, MAX_IPS, direccionesEscucha };
