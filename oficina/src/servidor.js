'use strict';
// Oficina IA: recibe los hooks http de Claude Code, mantiene el estado de cada sesión,
// lo transmite por WebSocket a la oficina 3D y entrega las órdenes del usuario a Claude.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Oficina } = require('./oficina');
const { Transcripts } = require('./transcripts');

const PUERTO = Number(process.env.PUERTO || 7777);
const ESCUCHA = process.env.ESCUCHA || '0.0.0.0';   // dentro del contenedor; el compose publica solo en 127.0.0.1
// En Docker ~/.claude está montado en /claude; sin Docker se usa el del propio usuario.
const RAIZ_CLAUDE = process.env.CLAUDE_DIR_CONTENEDOR || (fs.existsSync('/claude') ? '/claude' : path.join(require('os').homedir(), '.claude'));
const ARCHIVO_TOKEN = path.join(RAIZ_CLAUDE, 'ai-office', 'token');
const DEMO = process.env.AI_OFFICE_DEMO === '1';
const GUARDIA_MAX_MIN = Number(process.env.GUARDIA_MAX_MIN || 14);
const HOSTS_EXTRA = (process.env.HOSTS_PERMITIDOS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const PUBLICO = path.join(__dirname, '..', 'public');
const THREE = path.join(__dirname, '..', 'node_modules', 'three', 'build');

const oficina = new Oficina({ guardiaMaxMs: GUARDIA_MAX_MIN * 60 * 1000 });
const transcripts = new Transcripts(oficina, { raiz: RAIZ_CLAUDE });

// ---------- Utilidades de seguridad ----------
function log(...a) { console.log(new Date().toISOString(), ...a); }

let tokenCache = { valor: null, leido: 0 };
function tokenEsperado() {
  if (process.env.AI_OFFICE_TOKEN) return process.env.AI_OFFICE_TOKEN;
  if (Date.now() - tokenCache.leido > 5000) {
    try { tokenCache.valor = fs.readFileSync(ARCHIVO_TOKEN, 'utf8').trim() || null; } catch { tokenCache.valor = null; }
    tokenCache.leido = Date.now();
  }
  return tokenCache.valor;
}

function iguales(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Solo se atiende a nombres locales: evita ataques de DNS rebinding desde una web maliciosa.
function hostLocal(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || HOSTS_EXTRA.includes(h);
}

// El WebSocket permite dar órdenes: solo se acepta desde la propia página de la oficina.
function origenPropio(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try { const u = new URL(o); return hostLocal(u.host) && u.host.toLowerCase() === String(req.headers.host).toLowerCase(); }
  catch { return false; }
}

const CABECERAS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

function responder(res, codigo, cuerpo, tipo) {
  res.writeHead(codigo, { ...CABECERAS, 'Content-Type': tipo || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(cuerpo);
}

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

// ---------- Endpoint de hooks ----------
async function hook(req, res) {
  const esperado = tokenEsperado();
  if (!esperado && !DEMO) return responder(res, 401, 'Falta el token: ejecuta el instalador de hooks');
  if (esperado && !iguales(req.headers['x-ai-office-token'] || '', esperado)) return responder(res, 401, 'Token incorrecto');
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return responder(res, 415, 'Se espera JSON');
  let ev;
  try { ev = JSON.parse(await leerCuerpo(req, 2 * 1024 * 1024)); } catch { return responder(res, 400, 'JSON inválido'); }

  // Si Claude Code corta la petición (Esc, Ctrl+C o timeout del hook), se libera la guardia.
  res.on('close', () => { if (!res.writableEnded && ev && ev.session_id) oficina.conexionCerrada(ev.session_id); });

  let salida = null;
  try { salida = await oficina.procesar(ev); } catch (e) { log('error procesando hook', e); }
  const s = ev && ev.session_id && oficina.sesiones.get(ev.session_id);
  if (s && /^(Stop|PostToolUse|SubagentStop|SessionStart)$/.test(ev.hook_event_name)) transcripts.programar(s);
  if (res.writableEnded || res.destroyed) return;
  if (salida) responder(res, 200, JSON.stringify(salida), 'application/json');
  else responder(res, 200, '');
}

// ---------- Servidor HTTP ----------
const servidor = http.createServer((req, res) => {
  if (!hostLocal(req.headers.host)) return responder(res, 421, 'Host no permitido');
  const url = new URL(req.url, 'http://local');
  const ruta = url.pathname;

  if (req.method === 'POST' && ruta === '/api/hook') return void hook(req, res).catch(() => responder(res, 500, 'Error'));
  if (req.method !== 'GET' && req.method !== 'HEAD') return responder(res, 405, 'Método no permitido');
  if (ruta === '/salud') return responder(res, 200, 'ok');
  if (ruta === '/api/estado') return responder(res, 200, JSON.stringify({ sesiones: oficina.instantanea(), config: configPublica() }), 'application/json');
  if (ruta.startsWith('/vendor/three/')) return servirArchivo(res, THREE, ruta.slice('/vendor/three/'.length));
  if (ruta === '/' ) return servirArchivo(res, PUBLICO, 'index.html');
  return servirArchivo(res, PUBLICO, ruta.slice(1));
});

function configPublica() {
  return { token: !!tokenEsperado(), demo: DEMO, guardiaMaxMin: GUARDIA_MAX_MIN, transcripts: fs.existsSync(path.join(RAIZ_CLAUDE, 'projects')) };
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
servidor.on('upgrade', (req, socket, cabeza) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/ws' || !hostLocal(req.headers.host) || !origenPropio(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, cabeza, (ws) => wss.emit('connection', ws, req));
});

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

// ---------- Tareas periódicas ----------
setInterval(() => oficina.limpiar(), 30000).unref();
const explorar = () => transcripts.explorar().catch((e) => log('transcripts', e.message));
setInterval(explorar, 20000).unref();
explorar();

if (DEMO) require('./demo').iniciar(oficina);

servidor.listen(PUERTO, ESCUCHA, () => {
  log(`Oficina IA en http://127.0.0.1:${PUERTO}` + (DEMO ? ' (modo demo)' : ''));
  if (!tokenEsperado() && !DEMO) log('Aviso: no hay token. Ejecuta el instalador de hooks (ver README).');
});

function apagar() { log('Apagando'); for (const id of oficina.esperas.keys()) oficina.liberarEspera(id); servidor.close(); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);

module.exports = { servidor, oficina };
