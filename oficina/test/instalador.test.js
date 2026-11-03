'use strict';
// Ejecuta el instalador de verdad, siempre con CLAUDE_DIR en una carpeta temporal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'instalar-hooks.mjs');
const CABECERA = 'X-AI-Office-Token';

function instalar(dir, ...args) {
  const env = { ...process.env, CLAUDE_DIR: dir };
  for (const v of ['AI_OFFICE_TOKEN', 'AI_OFFICE_URL', 'PUERTO_HOOKS', 'GUARDIA_MAX_MIN']) delete env[v];
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function conCarpeta(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-instalador-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const leerAjustes = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
const escribirAjustes = (dir, a) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(a));
const copiaDe = (minuto) => `settings.json.bak-ai-office-2026-01-01T00-${String(minuto).padStart(2, '0')}-00-000Z`;

test('no registra SessionStart como hook http, y sí los demás eventos', () => {
  conCarpeta((dir) => {
    instalar(dir);
    const { hooks } = leerAjustes(dir);
    assert.equal(hooks.SessionStart, undefined);
    for (const evento of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd']) {
      assert.equal(hooks[evento].length, 1, evento);
      assert.equal(hooks[evento][0].hooks[0].type, 'http', evento);
    }
  });
});

test('reinstalar limpia la entrada SessionStart vieja sin tocar los hooks ajenos', () => {
  conCarpeta((dir) => {
    const ajeno = { type: 'command', command: 'echo hola' };
    escribirAjustes(dir, {
      theme: 'dark',
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'http', url: 'http://127.0.0.1:7778/api/hook', timeout: 5, headers: { [CABECERA]: 'viejo' } }] },
          { hooks: [ajeno] }
        ]
      }
    });
    instalar(dir);
    const a = leerAjustes(dir);
    assert.equal(a.theme, 'dark');
    assert.deepEqual(a.hooks.SessionStart, [{ hooks: [ajeno] }]);
    instalar(dir);
    assert.equal(leerAjustes(dir).hooks.PreToolUse.length, 1, 'sigue siendo idempotente');
  });
});

test('si SessionStart solo tenía nuestra entrada, el evento desaparece', () => {
  conCarpeta((dir) => {
    escribirAjustes(dir, { hooks: { SessionStart: [{ hooks: [{ type: 'http', url: 'http://x/', headers: { [CABECERA]: 'viejo' } }] }] } });
    instalar(dir);
    assert.equal(leerAjustes(dir).hooks.SessionStart, undefined);
  });
});

test('conserva solo las 5 copias más recientes y no borra ningún otro archivo', () => {
  conCarpeta((dir) => {
    escribirAjustes(dir, {});
    const antiguas = [1, 2, 3, 4, 5, 6, 7].map(copiaDe);
    for (const n of antiguas) fs.writeFileSync(path.join(dir, n), '{}');
    const ajenos = ['settings.json.bak', 'settings.json.bak-ai-office-mi-copia', 'bak-ai-office-notas.txt', 'x' + copiaDe(1), copiaDe(1) + '.txt'];
    for (const n of ajenos) fs.writeFileSync(path.join(dir, n), 'mío');
    fs.mkdirSync(path.join(dir, copiaDe(0))); // una carpeta con ese nombre tampoco se toca

    instalar(dir);

    const hay = fs.readdirSync(dir);
    const copias = hay.filter((n) => /^settings\.json\.bak-ai-office-\d{4}-.*Z$/.test(n) && n !== copiaDe(0)).sort();
    assert.equal(copias.length, 5, copias.join());
    assert.deepEqual(copias.slice(0, 4), antiguas.slice(-4), 'quedan las 4 más nuevas de las que había');
    assert.ok(!antiguas.includes(copias[4]), 'y la que acaba de crear');
    for (const n of ajenos) assert.equal(fs.readFileSync(path.join(dir, n), 'utf8'), 'mío', n);
    assert.ok(fs.statSync(path.join(dir, copiaDe(0))).isDirectory());
    assert.ok(hay.includes('settings.json'));
  });
});

test('desinstalar también recorta las copias', () => {
  conCarpeta((dir) => {
    escribirAjustes(dir, {});
    for (const m of [1, 2, 3, 4, 5, 6, 7]) fs.writeFileSync(path.join(dir, copiaDe(m)), '{}');
    instalar(dir, '--desinstalar');
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-ai-office-')).length, 5);
  });
});

test('settings.json y sus copias quedan solo para el dueño, y avisa si tenían permisos laxos', { skip: process.platform === 'win32' ? 'los modos POSIX no aplican en Windows' : false }, () => {
  conCarpeta((dir) => {
    escribirAjustes(dir, { model: 'x' });
    fs.chmodSync(path.join(dir, 'settings.json'), 0o644);
    fs.writeFileSync(path.join(dir, copiaDe(1)), '{}', { mode: 0o644 });
    const r = instalar(dir);
    assert.match(r.stdout, /permisos 644/);
    assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-ai-office-'))) {
      assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
    }
  });
});

test('los hooks siguen instalados en settings.json y el contenido no se pierde al ajustar permisos', () => {
  conCarpeta((dir) => {
    escribirAjustes(dir, { model: 'x' });
    instalar(dir);
    const a = leerAjustes(dir);
    assert.equal(a.model, 'x');
    assert.ok(a.hooks.Stop);
  });
});
