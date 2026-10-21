'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Oficina, detalleHerramienta } = require('../src/oficina');
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

test('las rutas de transcripts no salen del montaje', () => {
  const t = new Transcripts(new Oficina(), { raiz: '/claude' });
  assert.equal(t.rutaLocal('/home/m/.claude/projects/p/s.jsonl'), '/claude/projects/p/s.jsonl');
  assert.equal(t.rutaLocal('C:\\Users\\m\\.claude\\projects\\p\\s.jsonl'), '/claude/projects/p/s.jsonl');
  assert.equal(t.rutaLocal('/home/m/.claude/projects/../settings.json'), null);
  assert.equal(t.rutaLocal('/etc/passwd'), null);
});
