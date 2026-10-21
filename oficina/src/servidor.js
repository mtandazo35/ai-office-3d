'use strict';
// Oficina IA: recibe los hooks http de Claude Code, mantiene el estado de cada sesión,
// lo transmite por WebSocket a la oficina 3D y entrega las órdenes del usuario a Claude.
//
// Dos puertos:
//   PUERTO (7777)        panel web + WebSocket (+ /api/hook). Local, o publicado en la IP del VPS con
//                        contraseña y HTTPS.
//   PUERTO_HOOKS (7778)  solo /api/hook en HTTP plano, para Claude Code en la misma máquina.
//                        El compose lo publica únicamente en 127.0.0.1.

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Oficina } = require('./oficina');
const { Transcripts } = require('./transcripts');
const { Acceso } = require('./acceso');
const tls = require('./tls');

const env = process.env;
const PUERTO = Number(env.PUERTO_INTERNO || 7777);
const PUERTO_HOOKS = Number(env.PUERTO_HOOKS_INTERNO || 7778);
const ESCUCHA = env.ESCUCHA || '0.0.0.0';
// En Docker ~/.claude está montado en /claude; sin Docker se usa el del propio usuario.
const RAIZ_CLAUDE = env.CLAUDE_DIR_CONTENEDOR || (fs.existsSync('/claude') ? '/claude' : path.join(os.homedir(), '.claude'));
const ARCHIVO_TOKEN = path.join(RAIZ_CLAUDE, 'ai-office', 'token');
const DATOS = env.DATOS_DIR || (fs.existsSync('/datos') ? '/datos' : path.join(__dirname, '..', 'datos'));
const DEMO = env.AI_OFFICE_DEMO === '1';
const GUARDIA_MAX_MIN = Number(env.GUARDIA_MAX_MIN || 14);
const HOSTS_EXTRA = (env.HOSTS_PERMITIDOS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

// Modo remoto: el panel se publica fuera de localhost (IP del VPS). Exige contraseña.
const PUBLICAR_IP = String(env.PUBLICAR_IP || '127.0.0.1').trim();
const REMOTO = env.ACCESO_REMOTO === '1' || !['127.0.0.1', 'localhost', '::1', ''].includes(PUBLICAR_IP);
const PASSWORD = env.OFICINA_PASSWORD || (env.OFICINA_PASSWORD_FILE ? safeLeer(env.OFICINA_PASSWORD_FILE) : '');
const MODO_TLS = String(env.TLS || (REMOTO ? 'auto' : '0')).toLowerCase();

const PUBLICO = path.join(__dirname, '..', 'public');
const THREE = path.join(__dirname, '..', 'node_modules', 'three', 'build');
const PUBLICOS_SIN_SESION = new Set(['/login.html', '/login.js', '/estilos.css', '/icono.svg']);

function safeLeer(f) { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } }
function log(...a) { console.log(new Date().toISOString(), ...a); }

if (REMOTO && PASSWORD.length < 12) {
  log('ERROR: el panel se publica fuera de localhost (PUBLICAR_IP=' + PUBLICAR_IP + ') y no hay OFICINA_PASSWORD de al menos 12 caracteres.');
  log('Desde la oficina se pueden dar órdenes a Claude: sin contraseña cualquiera que llegue a la IP podría hacerlo. Define OFICINA_PASSWORD en .env.');
  process.exit(1);
}

const oficina = new Oficina({ guardiaMaxMs: GUARDIA_MAX_MIN * 60 * 1000 });
const transcripts = new Transcripts(oficina, { raiz: RAIZ_CLAUDE });
const acceso = new Acceso({ password: PASSWORD, confiarProxy: env.CONFIAR_PROXY === '1' });

// ---------- Utilidades de seguridad ----------
let tokenCache = { valor: null, leido: 0 };
function tokenEsperado() {
  if (env.AI_OFFICE_TOKEN) return env.AI_OFFICE_TOKEN;
  if (Date.now() - tokenCache.leido > 5000) {
    tokenCache.valor = safeLeer(ARCHIVO_TOKEN) || null;
    tokenCache.leido = Date.now();
  }
  return tokenCache.valor;
}

function iguales(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sinPuerto = (host) => String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
function hostLocal(host) {
  const h = sinPuerto(host);
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || HOSTS_EXTRA.includes(h);
}
// Sin contraseña solo se atienden nombres locales (defensa contra DNS rebinding).
// Con contraseña cualquier Host vale: protege la sesión, y la cookie va ligada al host.
function hostPermitido(host) { return !!host && (acceso.activo || hostLocal(host)); }

// El WebSocket y las acciones del panel solo se aceptan desde la propia página.
function origenPropio(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try {
    const u = new URL(o);
    return u.host.toLowerCase() === String(req.headers.host).toLowerCase() && (acceso.activo || hostLocal(u.host));
  } catch { return false; }
}

const CABECERAS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function responder(res, codigo, cuerpo, tipo, extra) {
  res.writeHead(codigo, { ...CABECERAS, 'Content-Type': tipo || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) });
  res.end(cuerpo);
}
const json = (res, codigo, obj, extra) => responder(res, codigo, JSON.stringify(obj), 'application/json', extra);

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function servirArchivo(res, base, relativa) {
  const ruta = path.normalize(path.join(base, relativa));
  if (!ruta.startsWith(base + path.sep)) return responder(res, 404, 'No encontrado');
  fs.stat(ruta, (err, st) => {
    if (err || !st.isFile()) return responder(res, 404, 'No encontrado');
    res.writeHead(200, { ...CABECERAS, 'Content-Type': TIPOS[path.extname(ruta)] || 'application/octet-stream', 'Cache-Control': base === THREE ? 'public, max-age=86400' : 'no-cache' });
    fs.createReadStream(ruta).pipe(res);
  });
}

function leerCuerpo(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const trozos = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('demasiado grande')); req.destroy(); } else trozos.push(c); });
    req.on('end', () => resolve(Buffer.concat(trozos).toString('utf8')));
    req.on('error', reject);
  });
}
const esJson = (req) => String(req.headers['content-type'] || '').startsWith('application/json');

// ---------- Endpoint de hooks ----------
async function hook(req, res) {
  const esperado = tokenEsperado();
  if (!esperado && !DEMO) return responder(res, 401, 'Falta el token: ejecuta el instalador de hooks');
  if (esperado && !iguales(req.headers['x-ai-office-token'] || '', esperado)) return responder(res, 401, 'Token incorrecto');
  if (!esJson(req)) return responder(res, 415, 'Se espera JSON');
  let ev;
  try { ev = JSON.parse(await leerCuerpo(req, 2 * 1024 * 1024)); } catch { return responder(res, 400, 'JSON inválido'); }

  // Si Claude Code corta la petición (Esc, Ctrl+C o timeout del hook), se libera la guardia.
  res.on('close', () => { if (!res.writableEnded && ev && ev.session_id) oficina.conexionCerrada(ev.session_id); });

  let salida = null;
  try { salida = await oficina.procesar(ev); } catch (e) { log('error procesando hook', e); }
  const s = ev && ev.session_id && oficina.sesiones.get(ev.session_id);
  if (s && /^(Stop|PostToolUse|SubagentStop|SessionStart)$/.test(ev.hook_event_name)) transcripts.programar(s);
  if (res.writableEnded || res.destroyed) return;
  if (salida) json(res, 200, salida);
  else responder(res, 200, '');
}

// ---------- Inicio y cierre de sesión ----------
async function login(req, res) {
  if (!acceso.activo) return responder(res, 404, 'No encontrado');
  if (!esJson(req)) return responder(res, 415, 'Se espera JSON');
  let datos;
  try { datos = JSON.parse(await leerCuerpo(req, 4096)); } catch { return json(res, 400, { error: 'Petición inválida' }); }
  const r = acceso.entrar(req, datos && datos.password);
  if (!r.ok) {
    log(`Acceso fallido desde ${acceso.ip(req)}${r.esperaSeg ? ' (bloqueada)' : ''}`);
    // Pequeña espera para frenar ataques de fuerza bruta.
    return setTimeout(() => json(res, r.esperaSeg ? 429 : 401, { error: r.error, esperaSeg: r.esperaSeg }), 600);
  }
  log(`Acceso correcto desde ${acceso.ip(req)}`);
  json(res, 200, { ok: true }, { 'Set-Cookie': acceso.cookieSesion(req, r.token) });
}

function salir(req, res) {
  if (!origenPropio(req)) return responder(res, 403, 'Origen no permitido');
  const token = acceso.tokenDe(req);
  acceso.salir(req);
  for (const c of wss.clients) if (c.token && c.token === token) c.close(4401, 'sesión cerrada');
  json(res, 200, { ok: true }, { 'Set-Cookie': acceso.cookieBorrar(req) });
}

// ---------- Panel ----------
function panel(req, res) {
  if (!hostPermitido(req.headers.host)) return responder(res, 421, 'Host no permitido');
  const ruta = new URL(req.url, 'http://local').pathname;

  if (req.method === 'POST') {
    if (ruta === '/api/hook') return void hook(req, res).catch(() => responder(res, 500, 'Error'));
    if (ruta === '/api/login') return void login(req, res).catch(() => responder(res, 500, 'Error'));
    if (ruta === '/api/salir') return salir(req, res);
    return responder(res, 405, 'Método no permitido');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return responder(res, 405, 'Método no permitido');
  if (ruta === '/salud') return responder(res, 200, 'ok');
  if (PUBLICOS_SIN_SESION.has(ruta)) {
    if (ruta === '/login.html' && (!acceso.activo || acceso.autorizada(req))) return responder(res, 302, '', null, { Location: '/' });
    return servirArchivo(res, PUBLICO, ruta.slice(1));
  }
  if (!acceso.autorizada(req)) {
    if (ruta === '/' || ruta.endsWith('.html')) return responder(res, 302, '', null, { Location: '/login.html' });
    return responder(res, 401, 'Inicia sesión');
  }
  if (ruta === '/api/estado') return json(res, 200, { sesiones: oficina.instantanea(), config: configPublica() });
  if (ruta.startsWith('/vendor/three/')) return servirArchivo(res, THREE, ruta.slice('/vendor/three/'.length));
  if (ruta === '/') return servirArchivo(res, PUBLICO, 'index.html');
  return servirArchivo(res, PUBLICO, ruta.slice(1));
}

// Puerto solo para hooks (HTTP plano, publicado en 127.0.0.1).
function soloHooks(req, res) {
  if (!hostLocal(req.headers.host)) return responder(res, 421, 'Host no permitido');
  const ruta = new URL(req.url, 'http://local').pathname;
  if (req.method === 'POST' && ruta === '/api/hook') return void hook(req, res).catch(() => responder(res, 500, 'Error'));
  if (ruta === '/salud') return responder(res, 200, 'ok');
  return responder(res, 404, 'Este puerto solo recibe hooks');
}

function configPublica() {
  return { token: !!tokenEsperado(), demo: DEMO, guardiaMaxMin: GUARDIA_MAX_MIN, transcripts: fs.existsSync(path.join(RAIZ_CLAUDE, 'projects')), auth: acceso.activo, remoto: REMOTO };
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
function alActualizar(req, socket, cabeza) {
  const url = new URL(req.url, 'http://local');
  let codigo = 0;
  if (url.pathname !== '/ws' || !hostPermitido(req.headers.host) || !origenPropio(req)) codigo = 403;
  else if (!acceso.autorizada(req)) codigo = 401;
  if (codigo) { socket.write(`HTTP/1.1 ${codigo} ${codigo === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, cabeza, (ws) => { ws.token = acceso.tokenDe(req); wss.emit('connection', ws, req); });
}

function enviarTodos(msg) {
  const datos = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(datos);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'snapshot', sesiones: oficina.instantanea(), config: configPublica() }));
  let cuenta = 0, ventana = Date.now();
  ws.on('message', (raw) => {
    if (Date.now() - ventana > 10000) { ventana = Date.now(); cuenta = 0; }
    if (++cuenta > 40) return; // límite sencillo: 40 mensajes cada 10 s
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') return;
    let r;
    if (m.t === 'orden') r = oficina.nuevaOrden(m.id, m.texto);
    else if (m.t === 'cancelar') r = { ok: oficina.cancelarOrden(m.id, String(m.ordenId || '')) };
    else if (m.t === 'guardia') r = { ok: oficina.ponerGuardia(m.id, !!m.activa) };
    else return;
    ws.send(JSON.stringify({ t: 'respuesta', ref: m.ref, ...r }));
  });
});

oficina.on('sesion', (s) => enviarTodos({ t: 'sesion', s }));
oficina.on('quitar', (id) => enviarTodos({ t: 'quitar', id }));

// ---------- Arranque ----------
const servidores = [];
async function arrancar() {
  const cred = await tls.credenciales({ modo: MODO_TLS, hostsTexto: env.TLS_HOSTS || (REMOTO && !['0.0.0.0', '::'].includes(PUBLICAR_IP) ? PUBLICAR_IP : ''), dir: path.join(DATOS, 'tls'), certPath: env.TLS_CERT, keyPath: env.TLS_KEY, log });
  const principal = cred ? https.createServer({ cert: cred.cert, key: cred.key, minVersion: 'TLSv1.2' }, panel) : http.createServer(panel);
  principal.on('upgrade', alActualizar);
  principal.listen(PUERTO, ESCUCHA, () => {
    log(`Panel: ${cred ? 'https' : 'http'}://<host>:${PUERTO}` + (acceso.activo ? ' (con contraseña)' : ' (sin contraseña: solo uso local)') + (DEMO ? ' · modo demo' : ''));
  });
  const ganchos = http.createServer(soloHooks);
  ganchos.listen(PUERTO_HOOKS, ESCUCHA, () => log(`Hooks: http://127.0.0.1:${PUERTO_HOOKS}/api/hook`));
  servidores.push(principal, ganchos);
  if (!tokenEsperado() && !DEMO) log('Aviso: no hay token. Ejecuta el instalador de hooks (ver README).');
  if (REMOTO && !cred && env.CONFIAR_PROXY !== '1') log('Aviso: panel remoto SIN HTTPS. La contraseña viaja en claro; usa TLS=auto o un proxy con HTTPS.');
}

setInterval(() => oficina.limpiar(), 30000).unref();
setInterval(() => {
  acceso.limpiar();
  // Cierra los WebSocket cuya sesión caducó.
  if (acceso.activo) for (const c of wss.clients) if (!acceso.autorizada({ headers: { cookie: 'oficina_sesion=' + c.token } })) c.close(4401, 'sesión caducada');
}, 60000).unref();
const explorar = () => transcripts.explorar().catch((e) => log('transcripts', e.message));
setInterval(explorar, 20000).unref();
explorar();

if (DEMO) require('./demo').iniciar(oficina);

arrancar().catch((e) => { log('No se pudo arrancar:', e.message); process.exit(1); });

function apagar() { log('Apagando'); for (const id of oficina.esperas.keys()) oficina.liberarEspera(id); servidores.forEach((s) => s.close()); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);

module.exports = { oficina, acceso };
