'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Acceso } = require('../src/acceso');

const req = (cookie, ip = '198.51.100.7', extra = {}) => ({ headers: { cookie: cookie || '', ...extra }, socket: { remoteAddress: ip, encrypted: true } });

test('sin contraseña el acceso está abierto (modo local)', () => {
  const a = new Acceso({});
  assert.equal(a.activo, false);
  assert.equal(a.autorizada(req()), true);
});

test('contraseña correcta crea una sesión con cookie segura', () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  assert.equal(a.autorizada(req()), false);
  const r = a.entrar(req(), 'una-clave-larga-123');
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

test('cinco fallos bloquean la IP aunque luego acierte', () => {
  const a = new Acceso({ password: 'una-clave-larga-123' });
  for (let i = 0; i < 5; i++) assert.equal(a.entrar(req(), 'mala').ok, false);
  const r = a.entrar(req(), 'una-clave-larga-123');
  assert.equal(r.ok, false);
  assert.ok(r.esperaSeg > 0);
  // Otra IP no queda afectada.
  assert.ok(a.entrar(req('', '203.0.113.9'), 'una-clave-larga-123').ok);
});

test('la sesión caduca', () => {
  let t = 1000;
  const a = new Acceso({ password: 'una-clave-larga-123', ahora: () => t });
  const r = a.entrar(req(), 'una-clave-larga-123');
  t += 13 * 3600 * 1000;
  assert.equal(a.autorizada(req('oficina_sesion=' + r.token)), false);
});

test('X-Forwarded-For solo se usa si se confía en el proxy', () => {
  const sin = new Acceso({ password: 'x'.repeat(12) });
  const con = new Acceso({ password: 'x'.repeat(12), confiarProxy: true });
  const r = req('', '172.17.0.1', { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' });
  assert.equal(sin.ip(r), '172.17.0.1');
  assert.equal(con.ip(r), '203.0.113.50');
});
