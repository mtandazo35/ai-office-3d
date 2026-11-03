'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Acceso, MAX_IPS, direccionesEscucha } = require('../src/acceso');

const req = (cookie, ip = '198.51.100.7', extra = {}) => ({ headers: { cookie: cookie || '', ...extra }, socket: { remoteAddress: ip, encrypted: true } });

test('sin contraseña el acceso está abierto (modo local)', () => {
  const a = new Acceso({});
  assert.equal(a.activo, false);
  assert.equal(a.autorizada(req()), true);
});

test('contraseña correcta crea una sesión con cookie segura', async () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  assert.equal(a.autorizada(req()), false);
  const r = await a.entrar(req(), 'una-clave-larga-123');
  assert.ok(r.ok);
  const cookie = a.cookieSesion(req(), r.token);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(a.autorizada(req('oficina_sesion=' + r.token)), true);
  assert.equal(a.autorizada(req('oficina_sesion=otro')), false);
  a.salir(req('oficina_sesion=' + r.token));
  assert.equal(a.autorizada(req('oficina_sesion=' + r.token)), false);
});

test('cinco fallos bloquean la IP aunque luego acierte', async () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  for (let i = 0; i < 5; i++) assert.equal((await a.entrar(req(), 'mala')).ok, false);
  const r = await a.entrar(req(), 'una-clave-larga-123');
  assert.equal(r.ok, false);
  assert.ok(r.esperaSeg > 0);
  // Otra IP no queda afectada.
  assert.ok((await a.entrar(req('', '203.0.113.9'), 'una-clave-larga-123')).ok);
});

test('la sesión caduca', async () => {
  let t = 1000;
  const a = new Acceso({ password: 'una-clave-larga-123', ahora: () => t });
  const r = await a.entrar(req(), 'una-clave-larga-123');
  t += 13 * 3600 * 1000;
  assert.equal(a.autorizada(req('oficina_sesion=' + r.token)), false);
});

test('X-Forwarded-For solo se usa si se confía en el proxy', () => {
  const sin = new Acceso({ password: 'x'.repeat(12) });
  const con = new Acceso({ password: 'x'.repeat(12), confiarProxy: true });
  const r = req('', '192.0.2.1', { 'x-forwarded-for': '198.51.100.99, 203.0.113.50' });
  assert.equal(sin.ip(r), '192.0.2.1');
  // La última entrada es la que añadió el proxy; la primera la escribe el cliente.
  assert.equal(con.ip(r), '203.0.113.50');
  // Lo que no sea una IP no se usa como clave del bloqueo.
  assert.equal(con.ip(req('', '192.0.2.1', { 'x-forwarded-for': '198.51.100.99, no-es-una-ip' })), '192.0.2.1');
});

test('cambiar el principio de X-Forwarded-For no evita el bloqueo', async () => {
  const a = new Acceso({ password: 'una-clave-larga-123', confiarProxy: true });
  const falso = (i) => req('', '192.0.2.1', { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.50` });
  for (let i = 1; i <= 5; i++) await a.entrar(falso(i), 'mala');
  const r = await a.entrar(falso(6), 'una-clave-larga-123');
  assert.equal(r.ok, false);
  assert.ok(r.esperaSeg > 0);
});

test('los intentos en paralelo no se saltan el bloqueo', async () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  const espias = [];
  const original = a.comprobar.bind(a);
  a.comprobar = (p) => { espias.push(p); return original(p); };
  // La buena va la sexta: con el contador subido después de scrypt, también se comprobaría.
  const intentos = ['mala', 'mala', 'mala', 'mala', 'mala', 'una-clave-larga-123', 'mala', 'mala'];
  const res = await Promise.all(intentos.map((p) => a.entrar(req(), p)));
  assert.equal(espias.length, 5);
  assert.deepEqual(res.map((r) => r.ok), intentos.map(() => false));
  assert.ok(res.slice(5).every((r) => r.esperaSeg > 0));
});

test('la quinta contraseña, si es la buena, entra aunque esté contada de antemano', async () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  for (let i = 0; i < 4; i++) await a.entrar(req(), 'mala');
  assert.ok((await a.entrar(req(), 'una-clave-larga-123')).ok);
  assert.equal(a.bloqueada('198.51.100.7'), false);
  assert.equal(a.intentos.size, 0);
});

test('comprobar la contraseña no detiene el bucle de eventos', async () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  let vuelta = false;
  setImmediate(() => { vuelta = true; });
  await a.entrar(req(), 'una-clave-larga-123');
  assert.equal(vuelta, true);
});

// scrypt retenido hasta que la prueba lo suelte, para ver cuántos corren a la vez.
function scryptRetenido(t) {
  const pendientes = [];
  t.mock.method(crypto, 'scrypt', (_p, _s, _n, cb) => pendientes.push(cb));
  return pendientes;
}

test('los scrypt simultáneos están limitados y los que esperan acaban', { timeout: 5000 }, async (t) => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  const huella = a.huella;
  const pendientes = scryptRetenido(t);
  const res = Array.from({ length: 6 }, (_, i) => a.entrar(req('', `198.51.100.${i + 1}`), 'x'));
  let tandas = 0, atendidos = 0;
  while (atendidos < 6) {
    await new Promise((r) => setImmediate(r));
    assert.ok(pendientes.length <= 2, `simultáneos: ${pendientes.length}`);
    for (const cb of pendientes.splice(0)) { cb(null, huella); atendidos += 1; }
    assert.ok(++tandas < 20, 'la cola no avanza');
  }
  assert.ok((await Promise.all(res)).every((r) => r.ok));
  assert.equal(a.scryptEnCurso, 0);
});

test('con la cola llena se rechaza sin contar el intento como fallo', { timeout: 5000 }, async (t) => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  const huella = a.huella;
  const pendientes = scryptRetenido(t);
  const res = Array.from({ length: 18 }, (_, i) => a.entrar(req('', `198.51.100.${i + 1}`), 'x'));
  const otra = await a.entrar(req('', '203.0.113.9'), 'x');
  assert.equal(otra.ok, false);
  assert.ok(otra.esperaSeg > 0);
  assert.equal(a.intentos.has('203.0.113.9'), false);
  let tandas = 0, atendidos = 0;
  while (atendidos < 18) {
    await new Promise((r) => setImmediate(r));
    for (const cb of pendientes.splice(0)) { cb(null, huella); atendidos += 1; }
    assert.ok(++tandas < 40, 'la cola no avanza');
  }
  await Promise.all(res);
});

test('si scrypt falla no se pierde el hueco ni se concede el acceso', async (t) => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  t.mock.method(crypto, 'scrypt', (_p, _s, _n, cb) => cb(new Error('sin memoria')));
  await assert.rejects(a.entrar(req(), 'x'), /sin memoria/);
  assert.equal(a.scryptEnCurso, 0);
  assert.equal(a.intentos.get('198.51.100.7').fallos, 1);
});

test('el mapa de intentos no crece sin límite y conserva los bloqueos', async () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  // Un valor que no es texto cuenta como fallo sin pasar por scrypt.
  for (let i = 0; i < 5; i++) await a.entrar(req(), null);
  assert.equal(a.bloqueada('198.51.100.7'), true);
  for (let i = 0; i < MAX_IPS + 50; i++) await a.entrar(req('', `2001:db8::${i.toString(16)}`), null);
  assert.ok(a.intentos.size <= MAX_IPS, `tamaño: ${a.intentos.size}`);
  assert.equal(a.bloqueada('198.51.100.7'), true);
});

test('sin ESCUCHA, el panel no sale de localhost salvo que se publique', () => {
  const d = (publicarIp, remoto, escucha) => direccionesEscucha({ publicarIp, remoto, escucha });
  assert.deepEqual(d('127.0.0.1', false), { panel: '127.0.0.1', hooks: '127.0.0.1' });
  // ACCESO_REMOTO=1 detrás de un proxy local.
  assert.deepEqual(d('127.0.0.1', true), { panel: '127.0.0.1', hooks: '127.0.0.1' });
  // Fuera de Docker con contraseña: el panel se publica, pero los hooks siguen en el propio equipo.
  assert.deepEqual(d('0.0.0.0', true), { panel: '0.0.0.0', hooks: '127.0.0.1' });
  assert.deepEqual(d('203.0.113.5', true), { panel: '203.0.113.5', hooks: '127.0.0.1' });
  // Un PUBLICAR_IP en blanco no puede acabar en listen('', ...), que escucharía en todas.
  assert.deepEqual(d('', true), { panel: '127.0.0.1', hooks: '127.0.0.1' });
  // ESCUCHA explícita manda en los dos (Docker).
  assert.deepEqual(d('127.0.0.1', false, '0.0.0.0'), { panel: '0.0.0.0', hooks: '0.0.0.0' });
});

// Comprobaciones de texto: arrancar de verdad sin ESCUCHA abriría el puerto en la LAN si esto fallara,
// y Docker no está disponible en todos los equipos donde se corren las pruebas.
test('servidor.js usa esas direcciones y el Dockerfile fija ESCUCHA', () => {
  const leer = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const servidor = leer('src/servidor.js');
  assert.match(servidor, /panel: ESCUCHA, hooks: ESCUCHA_HOOKS \} = direccionesEscucha\(\{ escucha: env\.ESCUCHA,/);
  assert.match(servidor, /principal\.listen\(PUERTO, ESCUCHA,/);
  assert.match(servidor, /ganchos\.listen\(PUERTO_HOOKS, ESCUCHA_HOOKS,/);
  assert.match(leer('Dockerfile'), /^ENV ESCUCHA=0\.0\.0\.0$/m);
});
