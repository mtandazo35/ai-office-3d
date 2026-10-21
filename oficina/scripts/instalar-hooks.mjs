#!/usr/bin/env node
// Instala (o quita con --desinstalar) los hooks http de Claude Code que alimentan la Oficina IA.
//
// - Crea ~/.claude/ai-office/token (permisos 600) si no existe.
// - Guarda una copia de ~/.claude/settings.json antes de tocarlo.
// - Es idempotente: quita las entradas que instaló antes y vuelve a ponerlas.
// - No toca ningún otro hook ni ajuste.
//
// Uso en Docker:  docker compose run --rm instalar [--desinstalar]
// Uso sin Docker: node oficina/scripts/instalar-hooks.mjs [--desinstalar]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const args = new Set(process.argv.slice(2));
const DESINSTALAR = args.has('--desinstalar') || args.has('--uninstall');
const DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PUERTO = Number(process.env.PUERTO || 7777);
const URL_HOOK = process.env.AI_OFFICE_URL || `http://127.0.0.1:${PUERTO}/api/hook`;
const GUARDIA_MAX_MIN = Number(process.env.GUARDIA_MAX_MIN || 14);
const CABECERA = 'X-AI-Office-Token';

// Eventos que escucha la oficina. timeout en segundos.
// Stop queda abierto en modo guardia: su timeout cubre el plazo de guardia más un margen.
const EVENTOS = [
  { evento: 'SessionStart', timeout: 5 },
  { evento: 'UserPromptSubmit', timeout: 5 },
  { evento: 'PreToolUse', matcher: '*', timeout: 5 },
  { evento: 'PostToolUse', matcher: '*', timeout: 5 },
  { evento: 'PostToolUseFailure', matcher: '*', timeout: 5 },
  { evento: 'PermissionRequest', matcher: '*', timeout: 5 },
  { evento: 'Notification', timeout: 5 },
  { evento: 'SubagentStart', timeout: 5 },
  { evento: 'SubagentStop', timeout: 5 },
  { evento: 'Stop', timeout: GUARDIA_MAX_MIN * 60 + 60 },
  { evento: 'StopFailure', timeout: 5 },
  { evento: 'SessionEnd', timeout: 1 }
];

function salir(msg, codigo = 1) { console.error(msg); process.exit(codigo); }

if (!fs.existsSync(DIR)) salir(`No encuentro la carpeta de Claude Code en ${DIR}. ¿Has usado Claude Code en este equipo? (en Docker: revisa CLAUDE_DIR en .env)`);

const ARCHIVO = path.join(DIR, 'settings.json');
const DIR_OFICINA = path.join(DIR, 'ai-office');
const ARCHIVO_TOKEN = path.join(DIR_OFICINA, 'token');

let ajustes = {};
if (fs.existsSync(ARCHIVO)) {
  const texto = fs.readFileSync(ARCHIVO, 'utf8');
  if (texto.trim()) {
    try { ajustes = JSON.parse(texto); } catch (e) { salir(`${ARCHIVO} no es JSON válido; no lo toco. Corrígelo y vuelve a ejecutar.\n${e.message}`); }
  }
  if (typeof ajustes !== 'object' || Array.isArray(ajustes) || ajustes === null) salir(`${ARCHIVO} no contiene un objeto JSON; no lo toco.`);
}

// Una entrada es nuestra si es un hook http con nuestra cabecera.
const esNuestro = (h) => h && h.type === 'http' && h.headers && Object.prototype.hasOwnProperty.call(h.headers, CABECERA);

function limpiar(hooks) {
  let quitados = 0;
  for (const evento of Object.keys(hooks)) {
    if (!Array.isArray(hooks[evento])) continue;
    hooks[evento] = hooks[evento]
      .map((grupo) => {
        if (!grupo || !Array.isArray(grupo.hooks)) return grupo;
        const antes = grupo.hooks.length;
        const resto = grupo.hooks.filter((h) => !esNuestro(h));
        quitados += antes - resto.length;
        return resto.length ? { ...grupo, hooks: resto } : null;
      })
      .filter(Boolean);
    if (!hooks[evento].length) delete hooks[evento];
  }
  return quitados;
}

const hooks = ajustes.hooks && typeof ajustes.hooks === 'object' ? ajustes.hooks : {};
const quitados = limpiar(hooks);

let token = null;
if (!DESINSTALAR) {
  fs.mkdirSync(DIR_OFICINA, { recursive: true, mode: 0o700 });
  if (fs.existsSync(ARCHIVO_TOKEN)) token = fs.readFileSync(ARCHIVO_TOKEN, 'utf8').trim();
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(ARCHIVO_TOKEN, token + '\n', { mode: 0o600 });
  }
  for (const e of EVENTOS) {
    const grupo = { hooks: [{ type: 'http', url: URL_HOOK, timeout: e.timeout, headers: { [CABECERA]: token } }] };
    if (e.matcher) grupo.matcher = e.matcher;
    (hooks[e.evento] = Array.isArray(hooks[e.evento]) ? hooks[e.evento] : []).push(grupo);
  }
}

if (Object.keys(hooks).length) ajustes.hooks = hooks; else delete ajustes.hooks;

// Copia de seguridad y escritura atómica.
if (fs.existsSync(ARCHIVO)) {
  const copia = `${ARCHIVO}.bak-ai-office-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(ARCHIVO, copia);
  console.log(`Copia de seguridad: ${copia}`);
}
const tmp = `${ARCHIVO}.tmp-ai-office`;
let modo = 0o600;
try { modo = fs.statSync(ARCHIVO).mode & 0o777; } catch {}
try {
  fs.writeFileSync(tmp, JSON.stringify(ajustes, null, 2) + '\n', { mode: modo });
  fs.renameSync(tmp, ARCHIVO);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch {}
  salir(`No pude escribir ${ARCHIVO}: ${e.message}\nEn Linux, ejecuta el contenedor con tu usuario: UID_GID=$(id -u):$(id -g) en .env`);
}

if (DESINSTALAR) {
  console.log(`Hooks de la Oficina IA quitados (${quitados} entradas). El resto de tu configuración no se ha tocado.`);
  console.log(`El token sigue en ${ARCHIVO_TOKEN}; bórralo si no vas a volver a usar la oficina.`);
} else {
  console.log(`Hooks instalados en ${ARCHIVO}: ${EVENTOS.map((e) => e.evento).join(', ')}.`);
  console.log(`Destino: ${URL_HOOK}`);
  if (Array.isArray(ajustes.allowedHttpHookUrls)) {
    console.log(`Atención: tienes "allowedHttpHookUrls" definido. Añade ${URL_HOOK} a esa lista o Claude Code no enviará los eventos.`);
  }
  console.log('Reinicia tus sesiones de Claude Code (o revisa /hooks) para que empiecen a enviar eventos.');
}
