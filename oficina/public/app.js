// Panel de la oficina: conexión WebSocket, lista de agentes, detalle y órdenes.
// Todo el texto que viene de las sesiones se pinta con textContent (nunca innerHTML).
import { crearEscena, COLORES, NOMBRES } from '/escena.js';

const $ = (id) => document.getElementById(id);
const sesiones = new Map();
let seleccion = null;
let config = {};
let ws = null;
let escena = null;

// ---------- Escena 3D ----------
try {
  escena = crearEscena($('c'), { alSeleccionar: (id) => seleccionar(id) });
} catch (e) {
  console.error(e);
  $('c').hidden = true;
  $('sin-webgl').hidden = false;
}

// Leyenda
for (const k of ['ejecutando', 'pensando', 'esperando', 'guardia', 'error', 'inactivo']) {
  const li = document.createElement('li');
  const i = document.createElement('i'); i.style.setProperty('background', COLORES[k]);
  li.append(i, NOMBRES[k]);
  $('leyenda').append(li);
}

// ---------- Utilidades ----------
function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'c') n.style.setProperty('--c', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const h of hijos) if (h !== null && h !== undefined) n.append(h);
  return n;
}
const hora = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function hace(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min';
}
const miles = (n) => (n ? n.toLocaleString('es') : '—');
const orden = () => [...sesiones.values()].sort((a, b) => (a.inicio || 0) - (b.inicio || 0));
function queHace(s) {
  if (s.estado === 'esperando') return s.permiso ? 'Pide permiso: ' + s.permiso : 'Espera tu aprobación en la terminal';
  if (s.estado === 'guardia') return 'Esperando órdenes de la oficina';
  if (s.herramienta) return (s.estado === 'ejecutando' ? '' : 'último: ') + s.herramienta + ' · ' + s.detalle;
  if (s.estado === 'pensando') return s.ultimoPrompt ? '«' + s.ultimoPrompt + '»' : 'Pensando…';
  return s.ultimoPrompt ? 'Último: «' + s.ultimoPrompt + '»' : 'Sin actividad';
}

// ---------- Pintado ----------
function pintarTodo() {
  pintarResumen();
  pintarLista();
  pintarDetalle();
  if (escena) escena.actualizar(orden());
  const hay = sesiones.size > 0;
  $('vacio').hidden = hay;
  let motivo = '';
  if (config.demo) motivo = '';
  else if (config.token === false) motivo = 'Los hooks aún no están instalados (no hay token).';
  $('vacio-motivo').textContent = motivo;
}

function pintarResumen() {
  const cuenta = {};
  sesiones.forEach((s) => { cuenta[s.estado] = (cuenta[s.estado] || 0) + 1; });
  const r = $('resumen'); r.replaceChildren();
  if (config.demo) r.append(el('span', {}, 'MODO DEMO'));
  for (const k of ['ejecutando', 'pensando', 'esperando', 'guardia', 'error', 'inactivo']) {
    if (!cuenta[k]) continue;
    const i = el('i'); i.style.setProperty('background', COLORES[k]);
    r.append(el('span', { title: NOMBRES[k] }, i, cuenta[k] + ' ' + NOMBRES[k].toLowerCase()));
  }
  const esperando = cuenta.esperando || 0;
  document.title = (esperando ? '(' + esperando + ') ' : '') + 'Oficina IA';
}

function pintarLista() {
  const ul = $('lista'); ul.replaceChildren();
  if (!sesiones.size) { ul.append(el('li', { class: 'l-vacia' }, 'Sin sesiones activas.')); return; }
  for (const s of orden()) {
    const pend = s.ordenes.filter((o) => o.estado === 'pendiente').length;
    ul.append(el('li', {},
      el('button', { type: 'button', c: COLORES[s.estado], 'aria-current': String(s.id === seleccion), onclick: () => seleccionar(s.id) },
        el('span', { class: 'l-cab' }, el('span', { class: 'l-proy' }, s.proyecto + (pend ? '  ✉' + pend : '')), el('span', { class: 'l-est' }, NOMBRES[s.estado] || s.estado)),
        el('span', { class: 'l-que' }, queHace(s)))));
  }
}

let firmaFormulario = '';
function pintarDetalle() {
  const s = seleccion && sesiones.get(seleccion);
  $('detalle').hidden = !s;
  $('lista-sec').hidden = !!s && matchMedia('(max-width: 900px)').matches;
  if (!s) return;
  const color = COLORES[s.estado] || COLORES.inactivo;
  $('d-proyecto').textContent = s.proyecto;
  $('d-cwd').textContent = s.cwd;

  const chips = $('d-chips'); chips.replaceChildren(el('span', { class: 'chip estado', c: color }, NOMBRES[s.estado] || s.estado));
  if (s.modelo) chips.append(el('span', { class: 'chip' }, s.modelo));
  if (s.origen === 'transcript') chips.append(el('span', { class: 'chip', title: 'Detectada leyendo su transcript; aún no ha mandado eventos de hooks' }, 'sin hooks'));
  chips.append(el('span', { class: 'chip', title: s.id }, s.id.slice(0, 8)));

  const ahora = $('d-ahora'); ahora.style.setProperty('--c', color); ahora.replaceChildren();
  if (s.estado === 'esperando') {
    ahora.append(el('span', { class: 't-tit' }, 'Espera tu aprobación'), el('span', { class: 't-det' }, s.permiso || ''),
      el('span', { class: 't-nota' }, 'Apruébalo o recházalo en la terminal o en VS Code.'));
  } else if (s.estado === 'guardia') {
    ahora.append(el('span', { class: 't-tit' }, 'En guardia'), el('span', { class: 't-nota' }, 'Terminó su turno y espera una orden. Escríbela abajo y la ejecutará al momento.'));
  } else if (s.herramienta) {
    ahora.append(el('span', { class: 't-tit' }, s.herramienta), el('span', { class: 't-det' }, s.detalle),
      s.estado === 'ejecutando' ? null : el('span', { class: 't-nota' }, 'Última herramienta usada; ahora está ' + (NOMBRES[s.estado] || s.estado).toLowerCase() + '.'));
  } else {
    ahora.append(el('span', { class: 't-tit' }, NOMBRES[s.estado] || s.estado), el('span', { class: 't-nota' }, 'Última actividad hace ' + hace(s.ultimaActividad)));
  }

  $('d-ctx').textContent = miles(s.tokens.contexto);
  $('d-sal').textContent = miles(s.tokens.salida);
  $('d-ini').textContent = hace(s.inicio);

  $('d-subagentes-sec').hidden = !s.subagentes.length;
  $('d-subagentes').replaceChildren(...s.subagentes.map((a) => el('li', { c: COLORES[a.estado] || COLORES.pensando },
    el('i'), el('b', {}, a.tipo), el('span', {}, a.herramienta ? a.herramienta + ' · ' + a.detalle : NOMBRES[a.estado] || ''))));

  // Órdenes
  const terminada = s.estado === 'terminada';
  $('orden').disabled = terminada; $('btn-orden').disabled = terminada;
  const firma = s.id + '|' + s.guardia;
  if (firma !== firmaFormulario) { $('guardia').checked = s.guardia; firmaFormulario = firma; }
  $('guardia').disabled = terminada;
  $('guardia-plazo').textContent = config.guardiaMaxMin ? 'Espera hasta ' + config.guardiaMaxMin + ' min por turno; mientras tanto la terminal queda ocupada.' : '';
  $('d-ordenes').replaceChildren(...s.ordenes.slice().reverse().map((o) => {
    const est = o.estado === 'pendiente' ? 'Pendiente · ' + hora(o.creada)
      : o.estado === 'entregada' ? 'Entregada ' + hora(o.entregada) + ' vía ' + o.via : 'Cancelada';
    return el('li', { dataset: { estado: o.estado } }, el('span', { class: 'o-texto' }, o.texto), el('span', { class: 'o-est' }, est),
      o.estado === 'pendiente' ? el('button', { type: 'button', class: 'btn sec mini', onclick: () => enviar({ t: 'cancelar', id: s.id, ordenId: o.id }) }, 'Cancelar') : null);
  }));

  $('d-prompt').textContent = s.ultimoPrompt || '';
  $('d-mensaje').textContent = s.ultimoMensaje || '';
  $('d-log').replaceChildren(...s.log.slice().reverse().map((ev) =>
    el('li', { dataset: { tipo: ev.tipo } }, el('time', {}, hora(ev.ts)), el('span', {}, ev.texto))));
}

function seleccionar(id) {
  seleccion = id && sesiones.has(id) ? id : null;
  firmaFormulario = '';
  if (escena) escena.seleccionar(seleccion);
  pintarLista();
  pintarDetalle();
  if (seleccion && matchMedia('(max-width: 900px)').matches) $('panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Acciones ----------
$('volver').addEventListener('click', () => seleccionar(null));
$('f-orden').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const texto = $('orden').value.trim();
  if (!texto || !seleccion) return;
  if (enviar({ t: 'orden', id: seleccion, texto })) $('orden').value = '';
});
$('orden').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); $('f-orden').requestSubmit(); }
});
$('guardia').addEventListener('change', (ev) => {
  if (seleccion) enviar({ t: 'guardia', id: seleccion, activa: ev.target.checked });
});
$('btn-ayuda').addEventListener('click', () => $('ayuda').showModal());
document.querySelector('[data-abre-ayuda]').addEventListener('click', () => $('ayuda').showModal());

function enviar(msg) {
  if (!ws || ws.readyState !== 1) { avisar('Sin conexión con la oficina; reintentando…'); return false; }
  ws.send(JSON.stringify(msg));
  return true;
}
function avisar(texto) { $('orden-ayuda').textContent = texto; setTimeout(() => { $('orden-ayuda').textContent = 'Se entrega en su próximo paso (tras una herramienta o al terminar el turno). Ctrl+Enter para enviar.'; }, 4000); }

// ---------- WebSocket con reconexión ----------
let espera = 500;
function conectar() {
  const estado = $('conexion');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.addEventListener('open', () => {
    espera = 500;
    estado.dataset.estado = 'ok'; estado.lastElementChild.textContent = 'En vivo';
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'snapshot') {
      sesiones.clear(); m.sesiones.forEach((s) => sesiones.set(s.id, s)); config = m.config || {};
      if (seleccion && !sesiones.has(seleccion)) seleccion = null;
      pintarTodo();
    } else if (m.t === 'sesion') {
      sesiones.set(m.s.id, m.s); pintarTodo();
    } else if (m.t === 'quitar') {
      sesiones.delete(m.id); if (seleccion === m.id) seleccionar(null); pintarTodo();
    } else if (m.t === 'respuesta' && m.error) {
      avisar(m.error);
    }
  });
  ws.addEventListener('close', () => {
    estado.dataset.estado = 'caido'; estado.lastElementChild.textContent = 'Reconectando…';
    setTimeout(conectar, espera); espera = Math.min(espera * 2, 8000);
  });
}
conectar();
// Refresca los "hace X" del detalle.
setInterval(() => { if (seleccion) pintarDetalle(); }, 5000);
