'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Oficina, detalleHerramienta, NOMBRES_AGENTES, ESTADOS } = require('../src/oficina');
const { redactar } = require('../src/redactar');
const { Transcripts } = require('../src/transcripts');

const base = { session_id: 's1', cwd: '/home/m/proy/api', transcript_path: '/home/m/.claude/projects/-home-m-proy-api/s1.jsonl' };
const ev = (o, nombre, extra) => o.procesar({ ...base, hook_event_name: nombre, ...extra });

test('los hooks mueven el estado de la sesión', async () => {
  const o = new Oficina();
  await ev(o, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
  const s = o.sesiones.get('s1');
  assert.equal(s.proyecto, 'api');
  assert.equal(s.estado, 'inactivo');
  await ev(o, 'UserPromptSubmit', { prompt: 'arregla el login' });
  assert.equal(s.estado, 'pensando');
  await ev(o, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/home/m/proy/api/src/auth.ts' } });
  assert.equal(s.estado, 'ejecutando');
  assert.equal(s.detalle, 'src/auth.ts');
  await ev(o, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  assert.equal(s.estado, 'esperando');
  await ev(o, 'PostToolUse', { tool_name: 'Bash' });
  assert.equal(s.estado, 'pensando');
  await ev(o, 'PostToolUseFailure', { tool_name: 'Bash', error: 'exit 1' });
  assert.equal(s.estado, 'error');
  const r = await ev(o, 'Stop', { last_assistant_message: 'hecho' });
  assert.equal(r, null);
  assert.equal(s.estado, 'inactivo');
  await ev(o, 'SessionEnd', { reason: 'exit' });
  assert.equal(s.estado, 'terminada');
});

test('los subagentes tienen su propio estado y no cierran la sesión', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await ev(o, 'SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  await ev(o, 'PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Read', tool_input: { file_path: '/home/m/proy/api/README.md' } });
  const s = o.sesiones.get('s1');
  assert.equal(s.subagentes.a1.estado, 'ejecutando');
  assert.equal(s.subagentes.a1.detalle, 'README.md');
  await ev(o, 'Stop', { agent_id: 'a1' });
  assert.notEqual(s.estado, 'inactivo');
  await ev(o, 'SubagentStop', { agent_id: 'a1' });
  assert.equal(Object.keys(s.subagentes).length, 0);
});

test('una orden se entrega como additionalContext en PostToolUse, una sola vez', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  assert.ok(o.nuevaOrden('s1', 'usa pnpm, no npm').orden);
  const r = await ev(o, 'PostToolUse', { tool_name: 'Read' });
  assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(r.hookSpecificOutput.additionalContext, /usa pnpm, no npm/);
  assert.equal(o.sesiones.get('s1').ordenes[0].estado, 'entregada');
  assert.equal(await ev(o, 'PostToolUse', { tool_name: 'Read' }), null);
});

test('una orden pendiente al terminar bloquea el Stop para que Claude siga', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  o.nuevaOrden('s1', 'ahora escribe los tests');
  const r = await ev(o, 'Stop', {});
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /ahora escribe los tests/);
});

test('las órdenes de un subagente no se entregan al agente principal por su PostToolUse', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  o.nuevaOrden('s1', 'para');
  assert.equal(await ev(o, 'PostToolUse', { agent_id: 'a1', tool_name: 'Read' }), null);
  assert.equal(o.sesiones.get('s1').ordenes[0].estado, 'pendiente');
});

test('modo guardia: el Stop espera y se responde al llegar una orden', async () => {
  const o = new Oficina({ guardiaMaxMs: 5000 });
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  o.ponerGuardia('s1', true);
  const p = ev(o, 'Stop', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(o.sesiones.get('s1').estado, 'guardia');
  assert.ok(o.esperas.has('s1'));
  o.nuevaOrden('s1', 'despliega en staging');
  const r = await p;
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /despliega en staging/);
  assert.equal(o.esperas.has('s1'), false);
});

test('modo guardia: desactivarla libera la sesión sin orden', async () => {
  const o = new Oficina({ guardiaMaxMs: 5000 });
  o.ponerGuardia(o.sesion('s1', base.cwd).id, true);
  const p = ev(o, 'Stop', {});
  await new Promise((r) => setImmediate(r));
  o.ponerGuardia('s1', false);
  assert.equal(await p, null);
  assert.equal(o.sesiones.get('s1').estado, 'inactivo');
});

test('modo guardia: vence el plazo', async () => {
  const o = new Oficina({ guardiaMaxMs: 30 });
  o.ponerGuardia(o.sesion('s1', base.cwd).id, true);
  assert.equal(await ev(o, 'Stop', {}), null);
  assert.equal(o.sesiones.get('s1').estado, 'inactivo');
});

test('órdenes inválidas o canceladas no se entregan', async () => {
  const o = new Oficina();
  assert.ok(o.nuevaOrden('no-existe', 'x').error);
  o.sesion('s1', base.cwd);
  assert.ok(o.nuevaOrden('s1', '   ').error);
  assert.ok(o.nuevaOrden('s1', 'x'.repeat(4001)).error);
  const { orden } = o.nuevaOrden('s1', 'algo');
  assert.ok(o.cancelarOrden('s1', orden.id));
  assert.equal(await ev(o, 'PostToolUse', { tool_name: 'Read' }), null);
});

test('detalle legible de cada herramienta', () => {
  assert.equal(detalleHerramienta('Bash', { command: 'npm test\nmás' }, '/x'), '$ npm test');
  assert.equal(detalleHerramienta('Write', { file_path: 'C:\\p\\a\\b.ts' }, 'C:\\p'), 'a/b.ts');
  assert.equal(detalleHerramienta('mcp__github__create_issue', {}, ''), 'github › create_issue');
});

test('enmascara secretos y recorta', () => {
  const t = redactar('export GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + ' password=hunter22 curl -H "Authorization: Bearer abcdefghijklmnop" https://u:p4ss@host/x sk-ant-api03-' + 'b'.repeat(30));
  assert.ok(!t.includes('hunter22'));
  assert.ok(!t.includes('aaaaaaaa'));
  assert.ok(!t.includes('abcdefghijklmnop'));
  assert.ok(!t.includes('p4ss'));
  assert.ok(!t.includes('bbbbbbbb'));
  assert.equal(redactar('x'.repeat(50), 10).length, 12);
});

test('enmascara secretos pasados como argumento o entrecomillados', () => {
  const casos = [
    ["sshpass -p 'Clave 1' ssh root@host", 'Clave'],
    ['sshpass -pClave2 ssh root@host', 'Clave2'],
    ['mysql -uroot -pClave3 base', 'Clave3'],
    ['tool --password Clave4', 'Clave4'],
    ['tool --token "Clave 5"', 'Clave'],
    ['curl -u admin:Clave6 https://x.example', 'Clave6'],
    ['curl --user "admin:Clave7" https://x.example', 'Clave7'],
    ['password="a b"', 'a b'],
    ["export PASSWORD='Clave 8'", 'Clave'],
    ['{"token": "Clave 9"}', 'Clave']
  ];
  for (const [entrada, secreto] of casos) assert.ok(!redactar(entrada).includes(secreto), entrada + ' => ' + redactar(entrada));
  // Lo que no es secreto se sigue leyendo.
  assert.equal(redactar('mysql -u root -p base'), 'mysql -u root -p base');
  assert.equal(redactar('curl -u admin https://x.example'), 'curl -u admin https://x.example');
  assert.equal(redactar('npm test -- --watch'), 'npm test -- --watch');
});

test('las rutas de transcripts no salen del montaje', () => {
  const t = new Transcripts(new Oficina(), { raiz: '/claude' });
  assert.equal(t.rutaLocal('/home/m/.claude/projects/p/s.jsonl'), '/claude/projects/p/s.jsonl');
  assert.equal(t.rutaLocal('C:\\Users\\m\\.claude\\projects\\p\\s.jsonl'), '/claude/projects/p/s.jsonl');
  assert.equal(t.rutaLocal('/home/m/.claude/projects/../settings.json'), null);
  assert.equal(t.rutaLocal('/etc/passwd'), null);
  assert.equal(t.rutaLocal('/home/m/.claude/projects/../secreto.jsonl'), null);
  assert.equal(t.rutaLocal('C:\\Users\\m\\.claude\\projects\\..\\secreto.jsonl'), null);
  assert.equal(t.rutaLocal('/claude/projects/p/../../secreto.jsonl'), null);
  assert.equal(t.rutaLocal('/claude/projects-otro/s.jsonl'), null);
  assert.equal(t.rutaLocal('/claude/projects/p/s.jsonl'), '/claude/projects/p/s.jsonl');
});

test('las rutas de transcripts funcionan y no salen del montaje con una raíz de Windows', () => {
  const t = new Transcripts(new Oficina(), { raiz: 'C:\\Users\\m\\.claude\\' });
  assert.equal(t.rutaLocal('C:\\Users\\m\\.claude\\projects\\p\\s.jsonl'), 'C:/Users/m/.claude/projects/p/s.jsonl');
  assert.equal(t.rutaLocal('/home/m/.claude/projects/p/s.jsonl'), 'C:/Users/m/.claude/projects/p/s.jsonl');
  assert.equal(t.rutaLocal('C:\\Users\\m\\.claude\\projects\\..\\secreto.jsonl'), null);
  assert.equal(t.rutaLocal('C:\\Users\\m\\.claude\\projects\\p\\..\\..\\..\\..\\secreto.jsonl'), null);
  assert.equal(t.rutaLocal('C:\\Users\\m\\.claude\\settings.json'), null);
});

test('cada agente tiene nombre automático, estable y sin repetir', () => {
  const a = new Oficina(), b = new Oficina();
  assert.equal(a.sesion('sesion-1').nombre, b.sesion('sesion-1').nombre);
  assert.ok(NOMBRES_AGENTES.includes(a.sesion('sesion-1').nombre));
  const o = new Oficina();
  const nombres = [];
  for (let i = 0; i < NOMBRES_AGENTES.length + 3; i++) nombres.push(o.sesion('s' + i).nombre);
  assert.equal(new Set(nombres).size, nombres.length);
});

test('renombrar valida el nombre y no admite duplicados', () => {
  const o = new Oficina();
  o.sesion('a'); o.sesion('b');
  assert.ok(o.renombrar('no-existe', 'X').error);
  assert.ok(o.renombrar('a', '   ').error);
  assert.ok(o.renombrar('a', 'x'.repeat(25)).error);
  assert.ok(o.renombrar('a', 123).error);
  assert.ok(o.renombrar('a', 'Jefa de pruebas').ok);
  assert.equal(o.vista(o.sesiones.get('a')).nombre, 'Jefa de pruebas');
  assert.ok(o.renombrar('b', 'jefa de PRUEBAS').error);
  assert.ok(o.renombrar('a', 'Jefa de pruebas').ok);
  assert.ok(o.renombrar('b', ' a\u0007b ').ok);
  assert.equal(o.sesiones.get('b').nombre, 'ab');
});

test('el nombre elegido sobrevive a un reinicio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-'));
  try {
    const archivoPerfiles = path.join(dir, 'sub', 'perfiles.json');
    const o = new Oficina({ archivoPerfiles });
    o.sesion('a');
    assert.ok(o.renombrar('a', 'Capitana').ok);
    assert.equal(new Oficina({ archivoPerfiles }).sesion('a').nombre, 'Capitana');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('el rol y el género se validan, se guardan y vuelven al reabrir la sesión', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-'));
  try {
    const archivoPerfiles = path.join(dir, 'perfiles.json');
    const o = new Oficina({ archivoPerfiles });
    o.sesion('a', '/x/api');
    assert.ok(o.actualizarPerfil('a', { rol: 'x'.repeat(31) }).error);
    assert.ok(o.actualizarPerfil('a', { genero: 'otro' }).error);
    assert.ok(o.actualizarPerfil('a', { nombre: 'Vera', rol: ' Revisora ', genero: 'femenino' }).ok);
    const s = new Oficina({ archivoPerfiles }).sesion('a');
    assert.deepEqual([s.nombre, s.rol, s.genero], ['Vera', 'Revisora', 'femenino']);
    assert.ok(o.actualizarPerfil('a', { rol: '', genero: '' }).ok);
    assert.deepEqual([o.sesiones.get('a').nombre, o.sesiones.get('a').rol, o.sesiones.get('a').genero], ['Vera', '', '']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la lista incluye agentes guardados sin sesión, editables y olvidables', () => {
  const o = new Oficina();
  o.sesion('a', '/x/api');
  o.actualizarPerfil('a', { nombre: 'Vera', rol: 'QA' });
  assert.ok(o.olvidarPerfil('a').error, 'no se olvida un agente activo');
  o.sesiones.delete('a');
  assert.deepEqual(o.listaPerfiles().map((p) => [p.id, p.activo, p.proyecto, p.rol]), [['a', false, 'api', 'QA']]);
  assert.ok(o.actualizarPerfil('a', { rol: 'DevOps' }).ok);
  assert.equal(o.listaPerfiles()[0].rol, 'DevOps');
  o.sesion('b');
  assert.ok(o.renombrar('b', 'vera').error, 'el nombre de un agente guardado sigue reservado');
  assert.ok(o.olvidarPerfil('a').ok);
  assert.ok(o.olvidarPerfil('a').error);
  assert.ok(o.actualizarPerfil('a', { rol: 'x' }).error);
});

// ---------- Hallazgo 4: sesiones cerradas ----------
function oficinaConReloj() {
  const reloj = { t: 1000000 };
  return { o: new Oficina({ ahora: () => reloj.t }), reloj };
}

test('una sesión cerrada no vuelve por su transcript', async () => {
  const { o, reloj } = oficinaConReloj();
  await ev(o, 'SessionEnd', { reason: 'exit' });
  reloj.t += 61000;
  o.limpiar();
  assert.equal(o.sesiones.has('s1'), false);
  o.descubierta('s1', { cwd: '/x', mtime: reloj.t });
  assert.equal(o.sesiones.has('s1'), false);
});

test('el barrido de transcripts no resucita una sesión cerrada', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-'));
  try {
    const carpeta = path.join(dir, 'projects', 'p');
    fs.mkdirSync(carpeta, { recursive: true });
    fs.writeFileSync(path.join(carpeta, 's1.jsonl'), JSON.stringify({ cwd: '/x', type: 'system' }) + '\n');
    fs.writeFileSync(path.join(carpeta, 'otra.jsonl'), JSON.stringify({ cwd: '/x', type: 'system' }) + '\n');
    const reloj = { t: Date.now() };
    const o = new Oficina({ ahora: () => reloj.t });
    await ev(o, 'SessionEnd', { reason: 'exit' });
    reloj.t += 61000;
    o.limpiar();
    await new Transcripts(o, { raiz: dir }).explorar();
    assert.deepEqual([...o.sesiones.keys()], ['otra'], 'la que no se cerró sí se descubre');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('una sesión cerrada que se reanuda vuelve por sus hooks y luego se ve con normalidad', async () => {
  const { o, reloj } = oficinaConReloj();
  await ev(o, 'SessionEnd', { reason: 'exit' });
  reloj.t += 61000;
  o.limpiar();
  await ev(o, 'UserPromptSubmit', { prompt: 'sigo' });
  assert.equal(o.sesiones.get('s1').estado, 'pensando');
  o.descubierta('s1', { cwd: '/x', modelo: 'm1', mtime: reloj.t });
  assert.equal(o.sesiones.get('s1').modelo, 'm1');
});

test('la lista de sesiones cerradas olvida pasada la ventana del transcript', async () => {
  const { o, reloj } = oficinaConReloj();
  await ev(o, 'SessionEnd', { reason: 'exit' });
  reloj.t += 61000;
  o.limpiar();
  assert.equal(o.cerradas.size, 1);
  reloj.t += 26 * 60 * 1000;
  o.limpiar();
  assert.equal(o.cerradas.size, 0);
});

// ---------- Hallazgo 9: permisos y texto de las órdenes ----------
test('el texto de una orden no dice que el panel sea local', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  o.nuevaOrden('s1', 'algo');
  const r = await ev(o, 'PostToolUse', { tool_name: 'Read' });
  assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /local/i);
});

test('modoPermisos sale de permission_mode y llega a la vista', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  const s = o.sesiones.get('s1');
  assert.equal(o.vista(s).modoPermisos, '');
  await ev(o, 'PreToolUse', { tool_name: 'Read', permission_mode: 'bypassPermissions' });
  assert.equal(o.vista(s).modoPermisos, 'bypassPermissions');
  await ev(o, 'PostToolUse', { tool_name: 'Read' });
  assert.equal(o.vista(s).modoPermisos, 'bypassPermissions', 'un evento sin el campo no borra el último modo conocido');
  await ev(o, 'PreToolUse', { tool_name: 'Read', permission_mode: 123 });
  assert.equal(o.vista(s).modoPermisos, 'bypassPermissions');
  await ev(o, 'PreToolUse', { tool_name: 'Read', agent_id: 'a1', permission_mode: 'plan' });
  assert.equal(o.vista(s).modoPermisos, 'bypassPermissions', 'el modo de un subagente no es el de la sesión');
  await ev(o, 'PreToolUse', { tool_name: 'Read', permission_mode: 'default' });
  assert.equal(o.vista(s).modoPermisos, 'default');
});

// ---------- Hallazgo 11: límites de entrega ----------
const LIMITE_CONTEXTO = 10000;

test('cada entrega cabe en additionalContext y el resto sale en la siguiente', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  for (let i = 0; i < 5; i++) o.nuevaOrden('s1', String(i).repeat(4000));
  const entregas = [];
  for (let r; (r = await ev(o, 'PostToolUse', { tool_name: 'Read' }));) entregas.push(r.hookSpecificOutput.additionalContext);
  assert.equal(entregas.length, 3);
  for (const texto of entregas) assert.ok(texto.length <= LIMITE_CONTEXTO, 'entrega de ' + texto.length);
  for (let i = 0; i < 5; i++) assert.ok(entregas.join('').includes(String(i).repeat(4000)));
  assert.equal(o.pendientes(o.sesiones.get('s1')).length, 0);
});

test('el peor caso de lote, con numeración y encabezado, no pasa del límite', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  for (let i = 0; i < 30; i++) o.nuevaOrden('s1', 'y'.repeat(300));
  const r = await ev(o, 'PostToolUse', { tool_name: 'Read' });
  const texto = r.hookSpecificOutput.additionalContext;
  assert.equal(texto.length > 9000, true, 'el lote llega al máximo: ' + texto.length);
  assert.ok(texto.length <= LIMITE_CONTEXTO, 'entrega de ' + texto.length);
  assert.equal(o.pendientes(o.sesiones.get('s1')).length, 0);
});

test('el Stop también entrega por lotes', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  for (let i = 0; i < 3; i++) o.nuevaOrden('s1', 'z'.repeat(4000));
  const r = await ev(o, 'Stop', {});
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.length <= LIMITE_CONTEXTO);
  assert.equal(o.pendientes(o.sesiones.get('s1')).length, 1);
});

async function agotarContinuaciones(o) {
  for (let i = 0; i < 8; i++) {
    o.nuevaOrden('s1', 'orden ' + i);
    assert.equal((await ev(o, 'Stop', {})).decision, 'block', 'continuación ' + i);
  }
}

test('tras 8 continuaciones seguidas de Stop la orden sigue pendiente', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await agotarContinuaciones(o);
  const { orden } = o.nuevaOrden('s1', 'la novena');
  assert.equal(await ev(o, 'Stop', {}), null);
  assert.equal(orden.estado, 'pendiente');
  assert.equal(o.sesiones.get('s1').estado, 'inactivo');
});

test('PreToolUse reinicia el tope de continuaciones', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await agotarContinuaciones(o);
  const { orden } = o.nuevaOrden('s1', 'la novena');
  await ev(o, 'PreToolUse', { tool_name: 'Read' });
  assert.equal((await ev(o, 'Stop', {})).decision, 'block');
  assert.equal(orden.estado, 'entregada');
});

test('el PreToolUse de un subagente no reinicia el tope de continuaciones', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await agotarContinuaciones(o);
  o.nuevaOrden('s1', 'la novena');
  await ev(o, 'PreToolUse', { tool_name: 'Read', agent_id: 'a1' });
  assert.equal(await ev(o, 'Stop', {}), null);
});

test('UserPromptSubmit reinicia el tope y entrega lo que quedó pendiente', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await agotarContinuaciones(o);
  const { orden } = o.nuevaOrden('s1', 'la novena');
  assert.equal(await ev(o, 'Stop', {}), null);
  const r = await ev(o, 'UserPromptSubmit', { prompt: 'sigue' });
  assert.match(r.hookSpecificOutput.additionalContext, /la novena/);
  assert.equal(orden.estado, 'entregada');
  o.nuevaOrden('s1', 'otra');
  assert.equal((await ev(o, 'Stop', {})).decision, 'block');
});

test('guardia en el tope: la orden queda pendiente y Claude no se queda retenido', async () => {
  const o = new Oficina({ guardiaMaxMs: 500 });
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await agotarContinuaciones(o);
  o.ponerGuardia('s1', true);
  const p = ev(o, 'Stop', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(o.sesiones.get('s1').estado, 'guardia');
  const { orden } = o.nuevaOrden('s1', 'la novena');
  assert.equal(await p, null);
  assert.equal(orden.estado, 'pendiente');
  assert.equal(o.esperas.has('s1'), false);
  // Con órdenes en cola y el tope agotado, el siguiente Stop no abre otra espera.
  const segundo = ev(o, 'Stop', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(o.esperas.has('s1'), false);
  assert.equal(await segundo, null);
  assert.equal(orden.estado, 'pendiente');
});

// ---------- Hallazgo 14: sin señal ----------
const MIN = 60 * 1000;

test('sin_senal es un estado válido', () => {
  assert.ok(ESTADOS.includes('sin_senal'));
});

for (const inicial of ['ejecutando', 'pensando']) {
  test(inicial + ' pasa a sin_senal solo tras más de 10 min sin eventos', async () => {
    const { o, reloj } = oficinaConReloj();
    await ev(o, inicial === 'pensando' ? 'UserPromptSubmit' : 'PreToolUse', { prompt: 'x', tool_name: 'Bash', tool_input: { command: 'sleep 1' } });
    const s = o.sesiones.get('s1');
    assert.equal(s.estado, inicial);
    const avisos = [];
    o.on('sesion', (v) => avisos.push(v.estado));
    reloj.t += 10 * MIN;
    o.limpiar();
    assert.equal(s.estado, inicial);
    reloj.t += 1;
    o.limpiar();
    assert.equal(s.estado, 'sin_senal');
    assert.equal(o.vista(s).estado, 'sin_senal');
    assert.deepEqual(avisos, ['sin_senal'], 'el panel se entera del cambio');
    assert.equal(o.sesiones.has('s1'), true);
  });
}

for (const [nombre, preparar] of [
  ['esperando', (o) => ev(o, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })],
  ['inactivo', (o) => ev(o, 'Stop', {})],
  ['error', (o) => ev(o, 'PostToolUseFailure', { tool_name: 'Bash', error: 'x' })]
]) {
  test(nombre + ' no cambia a sin_senal', async () => {
    const { o, reloj } = oficinaConReloj();
    await preparar(o);
    const s = o.sesiones.get('s1');
    assert.equal(s.estado, nombre);
    reloj.t += 30 * MIN;
    o.limpiar();
    assert.equal(s.estado, nombre);
  });
}

test('guardia no cambia a sin_senal', async () => {
  const reloj = { t: 1000000 };
  const o = new Oficina({ ahora: () => reloj.t, guardiaMaxMs: 60000 });
  o.ponerGuardia(o.sesion('s1', base.cwd).id, true);
  const p = ev(o, 'Stop', {});
  await new Promise((r) => setImmediate(r));
  reloj.t += 30 * MIN;
  o.limpiar();
  assert.equal(o.sesiones.get('s1').estado, 'guardia');
  o.ponerGuardia('s1', false);
  await p;
});

async function enSinSenal(inicial = 'ejecutando') {
  const { o, reloj } = oficinaConReloj();
  await ev(o, inicial === 'pensando' ? 'UserPromptSubmit' : 'PreToolUse', { prompt: 'x', tool_name: 'Bash', tool_input: { command: 'sleep 1' } });
  reloj.t += 11 * MIN;
  o.limpiar();
  const s = o.sesiones.get('s1');
  assert.equal(s.estado, 'sin_senal');
  return { o, s };
}

for (const inicial of ['ejecutando', 'pensando']) {
  test('PostToolUse saca de sin_senal a pensando (venía de ' + inicial + ')', async () => {
    const { o, s } = await enSinSenal(inicial);
    await ev(o, 'PostToolUse', { tool_name: 'Bash' });
    assert.equal(s.estado, 'pensando');
  });
}

test('cualquier evento saca de sin_senal con su efecto normal', async () => {
  const casos = [
    ['PreToolUse', { tool_name: 'Read' }, 'ejecutando'],
    ['UserPromptSubmit', { prompt: 'y' }, 'pensando'],
    ['PermissionRequest', { tool_name: 'Bash' }, 'esperando'],
    ['PostToolUseFailure', { tool_name: 'Bash', error: 'x' }, 'error'],
    ['Notification', { notification_type: 'idle_prompt' }, 'inactivo'],
    ['Stop', {}, 'inactivo'],
    ['StopFailure', { error: 'x' }, 'error'],
    ['SessionEnd', { reason: 'exit' }, 'terminada'],
    // Estos no fijan un estado propio: vuelve a lo que hacía antes de perder la señal.
    ['SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 'ejecutando'],
    ['PreToolUse', { agent_id: 'a1', tool_name: 'Read' }, 'ejecutando'],
    ['Notification', { notification_type: 'otro', message: 'hola' }, 'ejecutando']
  ];
  for (const [nombre, extra, esperado] of casos) {
    const { o, s } = await enSinSenal();
    await ev(o, nombre, extra);
    assert.equal(s.estado, esperado, nombre + ' ' + JSON.stringify(extra));
  }
});

// ---------- Hallazgo 15: lecturas de transcripts ----------
function transcriptGrande(archivo, lineas) {
  const relleno = 'r'.repeat(300);
  let contenido = '';
  for (let i = 0; i < lineas; i++) {
    contenido += JSON.stringify({ type: 'assistant', cwd: '/x', relleno, message: { id: 'm' + i, model: 'modelo', usage: { output_tokens: 1, input_tokens: i } } }) + '\n';
  }
  fs.writeFileSync(archivo, contenido);
}

test('lecturas simultáneas del mismo transcript no se mezclan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-'));
  try {
    const archivo = path.join(dir, 's.jsonl');
    const LINEAS = 2000; // varias veces el trozo de 64 KB de un flujo
    transcriptGrande(archivo, LINEAS);
    const t = new Transcripts(new Oficina());
    let procesadas = 0;
    const linea = t.linea.bind(t);
    t.linea = (l, texto) => { procesadas += 1; linea(l, texto); };
    const [a, b, c] = await Promise.all([t.leer('s', archivo), t.leer('s', archivo), t.leer('s', archivo.replace(/\\/g, '/'))]);
    assert.equal(procesadas, LINEAS);
    assert.equal(t.lectores.size, 1, 'la misma ruta con otro separador es el mismo archivo');
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a.mensajes.size, LINEAS);
    assert.equal(a.offset, fs.statSync(archivo).size);
    assert.equal(a.resto, '');
    assert.equal(t.colas.size, 0, 'la cola no se queda con rutas ya leídas');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('una lectura que falla no atasca las siguientes de esa ruta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-'));
  try {
    const archivo = path.join(dir, 's.jsonl');
    transcriptGrande(archivo, 3);
    const t = new Transcripts(new Oficina());
    const original = t.leerAhora.bind(t);
    t.leerAhora = () => { t.leerAhora = original; throw new Error('fallo de prueba'); };
    await assert.rejects(t.leer('s', archivo));
    assert.equal((await t.leer('s', archivo)).mensajes.size, 3);
    assert.equal(t.colas.size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('los lectores no crecen sin límite y sale el que lleva más tiempo sin usarse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-'));
  try {
    const rutas = ['a', 'b', 'c'].map((n) => path.join(dir, n + '.jsonl'));
    rutas.forEach((r) => transcriptGrande(r, 1));
    const t = new Transcripts(new Oficina(), { maxLectores: 2 });
    await t.leer('a', rutas[0]);
    await t.leer('b', rutas[1]);
    await t.leer('a', rutas[0]); // «a» se usa de nuevo: la siguiente en salir es «b»
    await t.leer('c', rutas[2]);
    assert.deepEqual([...t.lectores.keys()].sort(), [path.resolve(rutas[0]), path.resolve(rutas[2])].sort());
    // Un lector retirado se reconstruye leyendo desde el principio.
    assert.equal((await t.leer('b', rutas[1])).mensajes.size, 1);
    assert.equal(t.lectores.size, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('programar lee de verdad con la ruta que manda el hook', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-'));
  try {
    const carpeta = path.join(dir, 'projects', 'p');
    fs.mkdirSync(carpeta, { recursive: true });
    transcriptGrande(path.join(carpeta, 's1.jsonl'), 2);
    const o = new Oficina();
    const s = o.sesion('s1', '/x');
    s.transcript = '/otra/maquina/.claude/projects/p/s1.jsonl';
    new Transcripts(o, { raiz: dir }).programar(s, 1);
    for (let i = 0; i < 200 && s.tokens.salida !== 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.tokens.salida, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Hallazgo 17: nada de nombres reales en la demo ----------
test('la demo no lleva nombres reales ni IPs privadas', () => {
  const demo = fs.readFileSync(path.join(__dirname, '..', 'src', 'demo.js'), 'utf8');
  for (const prohibido of [/manuel/i, /suricata/i, /backend-isp/i, /frontend-isp/i, /mikrotik/i, /10\.0\.0\.1/]) assert.doesNotMatch(demo, prohibido);
  assert.match(demo, /192\.0\.2\.1/);
  assert.match(demo, /\/home\/usuario\/proyectos\/api/);
});

test('una orden cuya respuesta no salió vuelve a la cola y se entrega de nuevo', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  o.nuevaOrden('s1', 'usa pnpm');
  assert.ok(await ev(o, 'PostToolUse', { tool_name: 'Read' }));
  const orden = o.sesiones.get('s1').ordenes[0];
  assert.equal(orden.estado, 'entregada');
  assert.equal(o.devolverLote('s1'), true);
  assert.equal(orden.estado, 'pendiente');
  assert.equal(orden.via, undefined);
  assert.equal(o.devolverLote('s1'), false);
  const r = await ev(o, 'PostToolUse', { tool_name: 'Read' });
  assert.match(r.hookSpecificOutput.additionalContext, /usa pnpm/);
  assert.equal(o.devolverLote('no-existe'), false);
});

test('devolver un lote de Stop no gasta una continuación', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  o.nuevaOrden('s1', 'sigue');
  assert.equal((await ev(o, 'Stop', {})).decision, 'block');
  assert.equal(o.sesiones.get('s1').continuaciones, 1);
  o.devolverLote('s1');
  assert.equal(o.sesiones.get('s1').continuaciones, 0);
});

test('las órdenes pendientes nunca se descartan: al llegar a 30 se rechaza la nueva', () => {
  const o = new Oficina();
  o.sesion('s1', base.cwd);
  for (let i = 0; i < 30; i++) assert.ok(o.nuevaOrden('s1', 'p' + i).orden);
  assert.match(o.nuevaOrden('s1', 'de más').error, /30/);
  assert.equal(o.sesiones.get('s1').ordenes[0].texto, 'p0');
  assert.ok(o.cancelarOrden('s1', o.sesiones.get('s1').ordenes[0].id));
  assert.ok(o.nuevaOrden('s1', 'nueva').orden);
  const s = o.sesiones.get('s1');
  assert.equal(s.ordenes.length, 30);
  assert.equal(s.ordenes[0].texto, 'p1', 'se olvida la cancelada');
  assert.equal(s.ordenes[29].texto, 'nueva');
});

test('esperando pasa a sin_senal solo tras más de 2 h, y vuelve con un evento', async () => {
  let t = 1000000;
  const o = new Oficina({ ahora: () => t });
  await ev(o, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  const s = o.sesiones.get('s1');
  t += 2 * 3600 * 1000 - 1000;
  o.limpiar();
  assert.equal(s.estado, 'esperando');
  t += 2000;
  o.limpiar();
  assert.equal(s.estado, 'sin_senal');
  await ev(o, 'PostToolUse', { tool_name: 'Bash' });
  assert.equal(s.estado, 'pensando');
});

test('el texto de la orden dice que viene de una sesión iniciada', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  o.nuevaOrden('s1', 'algo');
  const r = await ev(o, 'PostToolUse', { tool_name: 'Read' });
  assert.match(r.hookSpecificOutput.additionalContext, /con sesión iniciada/);
});

test('cada subagente tiene nombre propio, sin repetir el de nadie', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  for (let i = 0; i < 5; i++) await ev(o, 'SubagentStart', { agent_id: 'a' + i, agent_type: 'Explore' });
  const s = o.sesiones.get('s1');
  const nombres = [s.nombre, ...Object.values(s.subagentes).map((a) => a.nombre)];
  assert.equal(new Set(nombres).size, 6);
  const nombre = s.subagentes.a0.nombre;
  await ev(o, 'PreToolUse', { agent_id: 'a0', agent_type: 'Explore', tool_name: 'Read', tool_input: {} });
  assert.equal(s.subagentes.a0.nombre, nombre, 'no cambia con cada evento');
  assert.equal(o.vista(s).subagentes[0].nombre, nombre);
  assert.ok(o.renombrar('s1', nombre).error, 'tampoco se puede coger el nombre de un subagente');
});

test('el agente figura como coordinando si acabó su turno y sus subagentes siguen', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await ev(o, 'SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  await ev(o, 'Stop', {});
  const s = o.sesiones.get('s1');
  assert.equal(s.estado, 'inactivo');
  assert.equal(o.vista(s).estado, 'coordinando');
  assert.equal(o.listaPerfiles()[0].estado, 'coordinando');
  await ev(o, 'SubagentStop', { agent_id: 'a1', agent_type: 'Explore' });
  assert.equal(o.vista(s).estado, 'inactivo');
});

test('un evento tardío no resucita a un subagente ni cuenta como del principal', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await ev(o, 'SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  await ev(o, 'SubagentStop', { agent_id: 'a1', agent_type: 'Explore' });
  const s = o.sesiones.get('s1');
  const estado = s.estado;
  await ev(o, 'PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Read', tool_input: {} });
  assert.equal(Object.keys(s.subagentes).length, 0);
  assert.equal(s.estado, estado);
  await ev(o, 'SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  assert.equal(Object.keys(s.subagentes).length, 1, 'si vuelve a arrancar, sí cuenta');
});

test('un subagente sin eventos durante 15 min se retira, y SessionEnd los quita a todos', async () => {
  let t = 1000000;
  const o = new Oficina({ ahora: () => t });
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  await ev(o, 'SubagentStart', { agent_id: 'viejo', agent_type: 'Explore' });
  const s = o.sesiones.get('s1');
  t += 14 * 60 * 1000;
  await ev(o, 'SubagentStart', { agent_id: 'nuevo', agent_type: 'Explore' });
  o.limpiar();
  assert.deepEqual(Object.keys(s.subagentes).sort(), ['nuevo', 'viejo']);
  t += 2 * 60 * 1000;
  o.limpiar();
  assert.deepEqual(Object.keys(s.subagentes), ['nuevo']);
  await ev(o, 'SessionEnd', { reason: 'exit' });
  assert.equal(Object.keys(s.subagentes).length, 0);
});

test('al cerrar la sesión se cancelan sus órdenes en cola y no acepta más', async () => {
  const o = new Oficina();
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  const { orden } = o.nuevaOrden('s1', 'pendiente al cerrar');
  await ev(o, 'SessionEnd', { reason: 'exit' });
  assert.equal(orden.estado, 'cancelada');
  assert.match(o.nuevaOrden('s1', 'otra').error, /terminado/);
  assert.equal(o.sesiones.get('s1').ordenes.length, 1);
});

test('una sesión vista solo por su transcript no acepta órdenes hasta su primer hook', async () => {
  const o = new Oficina();
  o.descubierta('s1', { cwd: base.cwd, mtime: Date.now() });
  assert.match(o.nuevaOrden('s1', 'hola').error, /no está conectada/);
  assert.equal(o.sesiones.get('s1').ordenes.length, 0);
  await ev(o, 'UserPromptSubmit', { prompt: 'x' });
  assert.ok(o.nuevaOrden('s1', 'hola').orden);
});
