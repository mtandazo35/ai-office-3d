'use strict';
// Pruebas contra el servidor real, en un proceso aparte: un fallo aquí es un proceso muerto.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function levantar(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-srv-'));
  const panel = await puertoLibre(), hooks = await puertoLibre();
  const hijo = spawn(process.execPath, ['src/servidor.js'], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ESCUCHA: '127.0.0.1', PUBLICAR_IP: '127.0.0.1', AI_OFFICE_DEMO: '0', OFICINA_PASSWORD: '', TLS: '0', PUERTO_INTERNO: String(panel), PUERTO_HOOKS_INTERNO: String(hooks), CLAUDE_DIR_CONTENEDOR: dir, DATOS_DIR: dir, ...extra }
  });
  const srv = { hijo, panel, hooks, dir, muerto: false, log: '' };
  hijo.stdout.on('data', (d) => { srv.log += d; });
  hijo.on('exit', () => { srv.muerto = true; });
  t.after(async () => {
    hijo.kill();
    await dormir(200);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${hooks}/salud`)).ok) return srv; } catch { /* aún arranca */ }
    await dormir(100);
  }
  throw new Error('el servidor no arrancó');
}

// Petición cruda: fetch normaliza la ruta y nunca enviaría // tal cual.
function crudo(puerto, texto) {
  return new Promise((resolve, reject) => {
    let datos = '';
    const s = net.connect(puerto, '127.0.0.1', () => s.write(texto));
    s.on('data', (d) => { datos += d; });
    s.on('close', () => resolve(datos));
    s.on('error', reject);
    s.setTimeout(3000, () => s.destroy());
  });
}
// Sesión real, con el secreto que el servidor generó en su carpeta de datos.
async function cookieDe(srv) {
  const password = fs.readFileSync(path.join(srv.dir, 'panel-secreto'), 'utf8').trim();
  const r = await fetch('http://127.0.0.1:' + srv.panel + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

const peticion = (ruta) => `GET ${ruta} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;

test('una URL inválida responde 400 y no tumba el proceso', async (t) => {
  const srv = await levantar(t);
  for (const puerto of [srv.panel, srv.hooks]) {
    for (const ruta of ['//', '//:', 'http://']) {
      const r = await crudo(puerto, peticion(ruta));
      assert.match(r, /^HTTP\/1\.1 400/, `ruta ${ruta} en ${puerto}: ${r.slice(0, 40)}`);
    }
  }
  await dormir(200);
  assert.equal(srv.muerto, false);
  assert.equal((await fetch(`http://127.0.0.1:${srv.panel}/salud`)).status, 200);
});

test('una mejora a WebSocket con URL inválida se rechaza sin tumbar el proceso', async (t) => {
  const srv = await levantar(t);
  const r = await crudo(srv.panel, 'GET // HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  assert.match(r, /^HTTP\/1\.1 403/);
  await dormir(200);
  assert.equal(srv.muerto, false);
});

test('un mensaje de más de 64 KB cierra ese WebSocket y el servidor sigue vivo', async (t) => {
  const srv = await levantar(t);
  const origen = `http://127.0.0.1:${srv.panel}`;
  const ws = new WebSocket(`ws://127.0.0.1:${srv.panel}/ws`, { origin: origen, headers: { Cookie: await cookieDe(srv) } });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('unexpected-response', () => reject(new Error('rechazado'))); });
  const cierre = new Promise((resolve) => ws.on('close', resolve));
  ws.send('x'.repeat(70000));
  assert.equal(await cierre, 1009);
  await dormir(200);
  assert.equal(srv.muerto, false);
  assert.equal((await fetch(`${origen}/salud`)).status, 200);
});

test('/api/hook solo responde en el puerto de hooks', async (t) => {
  const TOKEN = 'token-de-prueba';
  const srv = await levantar(t, { AI_OFFICE_TOKEN: TOKEN });
  const enviar = (puerto) => fetch(`http://127.0.0.1:${puerto}/api/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AI-Office-Token': TOKEN },
    body: JSON.stringify({ hook_event_name: 'Notification', session_id: 'prueba', message: 'hola' })
  });
  assert.equal((await enviar(srv.panel)).status, 405);
  assert.equal((await enviar(srv.hooks)).status, 200);
});

const CLAVE = 'una-clave-larga-123';
const entrar = (puerto, password, xff) => fetch(`http://127.0.0.1:${puerto}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) },
  body: JSON.stringify({ password })
});

test('el login por HTTP entra con la clave buena y rechaza la mala', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t, { OFICINA_PASSWORD: CLAVE });
  assert.equal((await entrar(srv.panel, 'mala')).status, 401);
  const r = await entrar(srv.panel, CLAVE);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^oficina_sesion=/);
});

test('un ataque en paralelo con X-Forwarded-For falso queda bloqueado y /salud sigue respondiendo', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t, { OFICINA_PASSWORD: CLAVE, CONFIAR_PROXY: '1' });
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => entrar(srv.panel, 'mala', `198.51.100.${i + 1}, 203.0.113.50`)));
  assert.ok(res.filter((r) => r.status === 429).length >= 7);
  assert.equal((await fetch(`http://127.0.0.1:${srv.hooks}/salud`)).status, 200);
  assert.equal((await entrar(srv.panel, CLAVE, '198.51.100.200, 203.0.113.50')).status, 429);
  // Otra IP real, la que escribió el proxy, no queda afectada.
  assert.equal((await entrar(srv.panel, CLAVE, '203.0.113.51')).status, 200);
});

// El atacante es un programa local: fija Origin y Host a voluntad.
function abrirWs(srv, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + srv.panel + '/ws', { origin: 'http://127.0.0.1:' + srv.panel, headers: cookie ? { Cookie: cookie } : {} });
    ws.on('open', () => { ws.terminate(); resolve('abierto'); });
    ws.on('unexpected-response', (_q, r) => { ws.terminate(); resolve(r.statusCode); });
    ws.on('error', () => {});
  });
}

test('en local, sin credencial no se ve el panel ni se abre el WebSocket aunque se falsifique Origin', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t);
  const base = 'http://127.0.0.1:' + srv.panel;
  assert.equal(await abrirWs(srv), 401);
  assert.equal((await fetch(base + '/api/estado')).status, 401);
  assert.equal((await fetch(base + '/app.js')).status, 401);
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login.html');
  assert.equal(await abrirWs(srv, 'oficina_sesion=inventada'), 401);
  assert.equal(await abrirWs(srv, await cookieDe(srv)), 'abierto');
});

test('el enlace de un solo uso da sesión una sola vez', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t);
  const token = srv.log.match(/entrar\?c=(\S+)/)[1];
  const base = 'http://127.0.0.1:' + srv.panel;
  const mala = await fetch(base + '/entrar?c=inventado', { redirect: 'manual' });
  assert.equal(mala.headers.get('location'), '/login.html');
  assert.equal(mala.headers.get('set-cookie'), null);
  assert.equal((await fetch(base + '/entrar', { method: 'HEAD', redirect: 'manual' })).headers.get('set-cookie'), null);
  const buena = await fetch(base + '/entrar?c=' + token, { redirect: 'manual' });
  assert.equal(buena.headers.get('location'), '/');
  const cookie = buena.headers.get('set-cookie').split(';')[0];
  assert.match(buena.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(base + '/api/estado', { headers: { Cookie: cookie } })).status, 200);
  const otra = await fetch(base + '/entrar?c=' + token, { redirect: 'manual' });
  assert.equal(otra.headers.get('location'), '/login.html');
  assert.equal(otra.headers.get('set-cookie'), null);
});

test('el log muestra el enlace y la ruta, nunca el secreto', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t);
  const secreto = fs.readFileSync(path.join(srv.dir, 'panel-secreto'), 'utf8').trim();
  assert.ok(secreto.length >= 32);
  assert.match(srv.log, /panel-secreto/);
  assert.ok(!srv.log.includes(secreto));
});

test('en local, un Host ajeno sigue recibiendo 421 aunque haya credencial (DNS rebinding)', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t);
  const r = await crudo(srv.panel, 'GET / HTTP/1.1\r\nHost: malicioso.example\r\nConnection: close\r\n\r\n');
  assert.match(r, /^HTTP\/1\.1 421/);
});

test('la configuración del panel da el usuario del comando de conexión, solo si es válido', { timeout: 20000 }, async (t) => {
  const usuarioDe = async (valor) => {
    const srv = await levantar(t, { OFICINA_USUARIO: valor });
    const r = await fetch('http://127.0.0.1:' + srv.panel + '/api/estado', { headers: { Cookie: await cookieDe(srv) } });
    return (await r.json()).config.usuario;
  };
  assert.equal(await usuarioDe('oficina'), 'oficina');
  assert.equal(await usuarioDe('a; rm -rf x'), '');
});

test('con contraseña propia no se genera secreto ni enlace', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t, { OFICINA_PASSWORD: CLAVE });
  assert.equal(fs.existsSync(path.join(srv.dir, 'panel-secreto')), false);
  assert.ok(!srv.log.includes('entrar?c='));
});

test('en modo remoto no arranca sin una contraseña de al menos 12 caracteres', { timeout: 20000 }, async () => {
  for (const clave of ['', 'corta']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-srv-'));
    const hijo = spawn(process.execPath, ['src/servidor.js'], {
      cwd: path.join(__dirname, '..'), stdio: 'ignore',
      env: { ...process.env, ESCUCHA: '127.0.0.1', ACCESO_REMOTO: '1', OFICINA_PASSWORD: clave, OFICINA_PASSWORD_FILE: '', AI_OFFICE_DEMO: '0', TLS: '0', PUERTO_INTERNO: String(await puertoLibre()), PUERTO_HOOKS_INTERNO: String(await puertoLibre()), CLAUDE_DIR_CONTENEDOR: dir, DATOS_DIR: dir }
    });
    const codigo = await new Promise((resolve) => hijo.on('exit', resolve));
    assert.equal(codigo, 1, 'clave ' + JSON.stringify(clave));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('OFICINA_PASSWORD_FILE sirve como contraseña', { timeout: 20000 }, async (t) => {
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-clave-')), 'clave');
  fs.writeFileSync(archivo, CLAVE + '\n');
  t.after(() => fs.rmSync(path.dirname(archivo), { recursive: true, force: true }));
  const srv = await levantar(t, { OFICINA_PASSWORD_FILE: archivo, ACCESO_REMOTO: '1' });
  assert.equal((await entrar(srv.panel, 'otra-clave-larga-456')).status, 401);
  assert.equal((await entrar(srv.panel, CLAVE)).status, 200);
});

// Conector falso en un socket (tubería con nombre en Windows).
let socketsFalsos = 0;
function conectorFalso(t, respuestas) {
  const http = require('node:http');
  const ruta = process.platform === 'win32' ? '\\\\.\\pipe\\oficina-conector-' + process.pid + '-' + (++socketsFalsos) : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-con-')), 'c.sock');
  const pedidos = [];
  const srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      pedidos.push({ metodo: req.method, ruta: req.url, cuerpo: cuerpo ? JSON.parse(cuerpo) : null });
      const r = respuestas[req.url] || { agentes: [] };
      res.statusCode = r.__codigo || 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });
  t.after(() => srv.close());
  return new Promise((resolve) => srv.listen(ruta, () => resolve({ ruta, pedidos })));
}

async function wsConSesion(srv) {
  const origen = 'http://127.0.0.1:' + srv.panel;
  const ws = new WebSocket('ws://127.0.0.1:' + srv.panel + '/ws', { origin: origen, headers: { Cookie: await cookieDe(srv) } });
  const mensajes = [];
  ws.on('message', (m) => mensajes.push(JSON.parse(m)));
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  const espera = async (fn) => { for (let i = 0; i < 40; i++) { const x = mensajes.find(fn); if (x) return x; await dormir(100); } throw new Error('sin respuesta'); };
  return { ws, mensajes, espera };
}

test('«Conectar» devuelve el enlace, envía el código al conector y registra el agente', { timeout: 20000 }, async (t) => {
  const falso = await conectorFalso(t, {
    '/agentes': { estado: 'login', agente: 'agente-1', url: 'https://claude.com/x' },
    '/codigo': { estado: 'listo', agente: 'agente-1', sessionId: 'sesion-nueva', cwd: '/x/proy' }
  });
  const srv = await levantar(t, { CONECTOR_SOCKET: falso.ruta });
  const { ws, espera } = await wsConSesion(srv);
  assert.equal((await espera((m) => m.t === 'snapshot')).config.conector, true);
  ws.send(JSON.stringify({ t: 'conectar', ref: 'r1' }));
  const uno = await espera((m) => m.t === 'conexion' && m.ref === 'r1');
  assert.equal(uno.estado, 'login');
  assert.equal(uno.url, 'https://claude.com/x');
  ws.send(JSON.stringify({ t: 'codigo', ref: 'r2', agente: 'agente-1', codigo: 'codigo-de-prueba' }));
  const dos = await espera((m) => m.t === 'conexion' && m.ref === 'r2');
  assert.equal(dos.estado, 'listo');
  assert.deepEqual(falso.pedidos.find((p) => p.ruta === '/codigo').cuerpo, { agente: 'agente-1', codigo: 'codigo-de-prueba' });
  await espera((m) => m.t === 'sesion' && m.s.id === 'sesion-nueva' && m.s.enTerminal === true);
  assert.ok(!srv.log.includes('codigo-de-prueba'), 'el código no va al log');
  ws.terminate();
});

test('una orden a un agente parado se escribe en su terminal; si falla, vuelve a la cola', { timeout: 20000 }, async (t) => {
  const falso = await conectorFalso(t, {
    '/estado': { autenticado: true, agentes: [{ agente: 'agente-1', sessionId: 'a1', cwd: '/x' }] },
    '/agentes': { estado: 'listo', agente: 'agente-1', sessionId: 'a1', cwd: '/x' },
    '/enviar': { __codigo: 409, error: 'El agente está ocupado.' }
  });
  const srv = await levantar(t, { CONECTOR_SOCKET: falso.ruta });
  const { ws, espera } = await wsConSesion(srv);
  ws.send(JSON.stringify({ t: 'conectar', ref: 'r1' }));
  await espera((m) => m.t === 'conexion' && m.ref === 'r1');
  ws.send(JSON.stringify({ t: 'orden', id: 'a1', ref: 'o1', texto: 'haz esto' }));
  await espera((m) => m.t === 'respuesta' && m.ref === 'o1');
  await espera((m) => m.t === 'sesion' && m.s.id === 'a1' && m.s.ordenes.length === 1 && m.s.ordenes[0].estado === 'pendiente' && m.s.estado === 'inactivo' && m.s.log.some((e) => /vuelve a la cola/.test(e.texto)));
  assert.equal(falso.pedidos.find((p) => p.ruta === '/enviar').cuerpo.texto, 'haz esto');
  ws.terminate();
});

test('sin sesión no se llega al conector', { timeout: 20000 }, async (t) => {
  const falso = await conectorFalso(t, {});
  const srv = await levantar(t, { CONECTOR_SOCKET: falso.ruta });
  const ws = new WebSocket('ws://127.0.0.1:' + srv.panel + '/ws', { origin: 'http://127.0.0.1:' + srv.panel });
  const codigo = await new Promise((r) => { ws.on('unexpected-response', (_q, x) => r(x.statusCode)); ws.on('error', () => {}); ws.on('open', () => r('abierto')); });
  assert.equal(codigo, 401);
  assert.equal(falso.pedidos.filter((p) => p.metodo === 'POST').length, 0);
});

test('sin conector, el panel lo sabe y «conectar» responde un error', { timeout: 20000 }, async (t) => {
  const srv = await levantar(t);
  const { ws, espera } = await wsConSesion(srv);
  assert.equal((await espera((m) => m.t === 'snapshot')).config.conector, false);
  ws.send(JSON.stringify({ t: 'conectar', ref: 'r1' }));
  assert.ok((await espera((m) => m.t === 'conexion' && m.ref === 'r1')).error);
  ws.terminate();
});

test('cerrar la sesión de Claude pasa por el conector, cierra los agentes y avisa al panel', { timeout: 30000 }, async (t) => {
  const respuestas = {
    '/estado': { autenticado: true, agentes: [{ agente: 'agente-1', sessionId: 'a1', cwd: '/x' }] },
    '/cerrar-cuenta': { ok: true, autenticado: false }
  };
  const falso = await conectorFalso(t, respuestas);
  const srv = await levantar(t, { CONECTOR_SOCKET: falso.ruta });
  await dormir(500);
  const { ws, espera } = await wsConSesion(srv);
  const inicio = await espera((m) => m.t === 'snapshot');
  assert.equal(inicio.config.claudeIniciado, true);
  assert.ok(inicio.sesiones.some((s) => s.id === 'a1' && s.enTerminal));
  respuestas['/estado'] = { autenticado: false, agentes: [] };
  ws.send(JSON.stringify({ t: 'cerrarCuenta', ref: 'x1' }));
  const r = await espera((m) => m.t === 'conexion' && m.ref === 'x1');
  assert.equal(r.ok, true);
  assert.equal(falso.pedidos.filter((p) => p.ruta === '/cerrar-cuenta').length, 1);
  await espera((m) => m.t === 'sesion' && m.s.id === 'a1' && m.s.estado === 'terminada');
  await espera((m) => m.t === 'config' && m.config.claudeIniciado === false);
  ws.terminate();
});
