'use strict';
// Acceso al panel cuando la oficina se publica fuera de localhost (p. ej. en la IP de un VPS):
// contraseña -> cookie de sesión HttpOnly + SameSite=Strict, con bloqueo por intentos fallidos.

const crypto = require('crypto');

const DURACION_MS = 12 * 3600 * 1000;      // la sesión dura 12 h
const VENTANA_FALLOS_MS = 10 * 60 * 1000;   // 5 fallos en 10 min...
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;          // ...bloquean esa IP 15 min
const COOKIE = 'oficina_sesion';

class Acceso {
  constructor({ password, confiarProxy = false, ahora = () => Date.now() } = {}) {
    this.activo = !!password;
    this.confiarProxy = confiarProxy;
    this.ahora = ahora;
    this.sesiones = new Map();   // token -> caduca
    this.intentos = new Map();   // ip -> { fallos, desde, hasta }
    if (this.activo) {
      // Solo se guarda un derivado de la contraseña, nunca el texto.
      this.sal = crypto.randomBytes(16);
      this.huella = crypto.scryptSync(String(password), this.sal, 32);
    }
  }

  ip(req) {
    if (this.confiarProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
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

  comprobar(password) {
    if (!this.activo || typeof password !== 'string' || password.length > 512) return false;
    const h = crypto.scryptSync(password, this.sal, 32);
    return crypto.timingSafeEqual(h, this.huella);
  }

  // Devuelve { ok, token?, error?, esperaSeg? }
  entrar(req, password) {
    const ip = this.ip(req);
    const t = this.ahora();
    if (this.bloqueada(ip)) return { ok: false, error: 'Demasiados intentos. Prueba más tarde.', esperaSeg: Math.ceil((this.intentos.get(ip).hasta - t) / 1000) };
    if (!this.comprobar(password)) {
      let r = this.intentos.get(ip);
      if (!r || t - r.desde > VENTANA_FALLOS_MS) r = { fallos: 0, desde: t, hasta: 0 };
      r.fallos += 1;
      if (r.fallos >= MAX_FALLOS) r.hasta = t + BLOQUEO_MS;
      this.intentos.set(ip, r);
      return { ok: false, error: 'Contraseña incorrecta.' };
    }
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

module.exports = { Acceso, COOKIE };
