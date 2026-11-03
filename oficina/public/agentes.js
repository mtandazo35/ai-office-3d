// Gestión de agentes: nombre, rol y género de cada sesión, activa o guardada.
// Todo el texto se pinta con textContent o value, nunca con innerHTML.
import { COLORES, NOMBRES, GENEROS } from '/estados.js';

const $ = (id) => document.getElementById(id);
const filas = new Map(); // id -> { li, nombre, rol, genero, guardar, ... , sucio, datos }
const esperando = new Map(); // ref -> id de la fila que espera respuesta
let perfiles = [];
let ws = null;
let secuencia = 0;

function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...hijos);
  return n;
}

function avisar(texto) {
  $('aviso-texto').textContent = texto;
  if (!$('aviso').open) $('aviso').showModal();
}
$('aviso-cerrar').addEventListener('click', () => $('aviso').close());

function enviar(msg) {
  if (!ws || ws.readyState !== 1) { avisar('Sin conexión con la oficina. Vuelve a intentarlo en unos segundos.'); return false; }
  ws.send(JSON.stringify(msg));
  return true;
}

function campo(etiqueta, control) {
  return el('label', { class: 'campo' }, etiqueta, control);
}

function selectorGenero() {
  const s = el('select', {}, el('option', { value: '' }, 'Sin especificar'));
  for (const [valor, texto] of Object.entries(GENEROS)) s.append(el('option', { value: valor }, texto));
  return s;
}

function crearFila(id) {
  const f = { id, sucio: false };
  const marcar = () => { f.sucio = true; f.guardar.disabled = false; f.nota.textContent = ''; };
  f.nombre = el('input', { type: 'text', maxlength: '24', autocomplete: 'off', required: '', oninput: marcar });
  f.rol = el('input', { type: 'text', maxlength: '30', list: 'roles', placeholder: 'Sin rol', autocomplete: 'off', oninput: marcar });
  f.genero = selectorGenero();
  f.genero.addEventListener('change', marcar);
  f.guardar = el('button', { class: 'btn', type: 'submit', disabled: '' }, 'Guardar');
  f.nota = el('span', { class: 'agente-guardado', role: 'status' });
  f.olvidar = el('button', { class: 'btn sec', type: 'button', onclick: () => pedirOlvidar(f) }, 'Olvidar');
  f.punto = el('i');
  f.estado = el('span');
  f.proyecto = el('span');
  f.idTexto = el('span', { class: 'agente-id', title: id }, id.slice(0, 8));
  f.li = el('li', {}, el('form', { class: 'agente', onsubmit: (ev) => { ev.preventDefault(); guardar(f); } },
    el('div', { class: 'agente-info' }, el('span', { class: 'agente-estado' }, f.punto, f.estado), f.proyecto, f.idTexto),
    campo('Nombre', f.nombre), campo('Rol', f.rol), campo('Género', f.genero),
    el('div', { class: 'agente-acciones' }, f.nota, f.olvidar, f.guardar)));
  return f;
}

function guardar(f) {
  const ref = 'r' + (++secuencia);
  const msg = { t: 'perfil', id: f.id, ref, nombre: f.nombre.value, rol: f.rol.value, genero: f.genero.value };
  if (!enviar(msg)) return;
  esperando.set(ref, f.id);
  f.guardar.disabled = true;
}

let aOlvidar = null;
function pedirOlvidar(f) {
  aOlvidar = f;
  $('confirmar-texto').textContent = '¿Olvidar a ' + f.datos.nombre + '? Se borra su nombre, rol y género guardados.';
  $('confirmar').showModal();
}
$('confirmar-no').addEventListener('click', () => $('confirmar').close());
$('confirmar-si').addEventListener('click', () => {
  $('confirmar').close();
  if (aOlvidar) enviar({ t: 'olvidar', id: aOlvidar.id, ref: 'o' + (++secuencia) });
  aOlvidar = null;
});

// Una fila con cambios sin guardar no se pisa aunque lleguen datos nuevos.
function actualizarFila(f, p) {
  f.datos = p;
  if (!f.sucio) {
    f.nombre.value = p.nombre;
    f.rol.value = p.rol;
    f.genero.value = p.genero;
  }
  f.punto.style.setProperty('--c', p.activo ? COLORES[p.estado] || COLORES.inactivo : 'var(--tenue)');
  f.estado.textContent = p.activo ? NOMBRES[p.estado] || p.estado : 'Sin sesión activa';
  f.proyecto.textContent = p.proyecto || 'sin proyecto';
  f.olvidar.hidden = p.activo;
}

function pintar() {
  const buscado = $('filtro').value.trim().toLocaleLowerCase('es');
  const ul = $('agentes');
  const vivos = new Set(perfiles.map((p) => p.id));
  for (const [id, f] of filas) if (!vivos.has(id)) { f.li.remove(); filas.delete(id); }
  let anterior = null, visibles = 0;
  for (const p of perfiles) {
    let f = filas.get(p.id);
    if (!f) { f = crearFila(p.id); filas.set(p.id, f); }
    actualizarFila(f, p);
    const coincide = !buscado || [p.nombre, p.rol, p.proyecto].join(' ').toLocaleLowerCase('es').includes(buscado);
    f.li.hidden = !coincide;
    if (coincide) visibles += 1;
    const esperado = anterior ? anterior.nextSibling : ul.firstChild;
    if (esperado !== f.li) ul.insertBefore(f.li, esperado);
    anterior = f.li;
  }
  const activos = perfiles.filter((p) => p.activo).length;
  const conRol = perfiles.filter((p) => p.rol).length;
  const guardados = perfiles.length - activos;
  $('resumen').textContent = activos + (activos === 1 ? ' activo · ' : ' activos · ') + guardados + (guardados === 1 ? ' guardado sin sesión · ' : ' guardados sin sesión · ') + conRol + ' con rol';
  $('vacio').hidden = visibles > 0;
  $('vacio').textContent = perfiles.length ? 'Ningún agente coincide con la búsqueda.' : 'Todavía no hay agentes. Aparecerán aquí cuando una sesión de Claude Code empiece a trabajar.';
}
$('filtro').addEventListener('input', pintar);

function alResponder(m) {
  const id = esperando.get(m.ref);
  esperando.delete(m.ref);
  if (m.error) {
    const f = id && filas.get(id);
    if (f) f.guardar.disabled = false;
    avisar(m.error);
    return;
  }
  const f = id && filas.get(id);
  if (!f) return;
  f.sucio = false;
  f.nota.textContent = 'Guardado';
  setTimeout(() => { if (!f.sucio) f.nota.textContent = ''; }, 2500);
}

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
    if (m.t === 'snapshot' || m.t === 'perfiles') { perfiles = m.perfiles || []; pintar(); }
    else if (m.t === 'respuesta') alResponder(m);
  });
  ws.addEventListener('close', async (ev) => {
    estado.dataset.estado = 'caido'; estado.lastElementChild.textContent = 'Reconectando…';
    if (ev.code === 4401) { location.replace('/login.html'); return; }
    try { const r = await fetch('/api/estado', { credentials: 'same-origin' }); if (r.status === 401) { location.replace('/login.html'); return; } } catch {}
    setTimeout(conectar, espera); espera = Math.min(espera * 2, 8000);
  });
}
conectar();
