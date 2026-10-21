'use strict';
// Modo demo (AI_OFFICE_DEMO=1): tres sesiones simuladas que emiten los mismos eventos que
// mandaría Claude Code, para probar la oficina sin tocar la configuración de Claude.
// Las órdenes funcionan igual: se entregan por PostToolUse o Stop y la sesión "obedece".

const GUIONES = [
  { id: 'demo-backend', cwd: '/home/manuel/proyectos/backend-isp', modelo: 'claude-opus-5-5', prompt: 'Añade paginación al endpoint de facturas',
    pasos: [['Grep', { pattern: 'facturas', path: '/home/manuel/proyectos/backend-isp/src' }], ['Read', { file_path: '/home/manuel/proyectos/backend-isp/src/facturas/facturas.controller.ts' }],
      ['Edit', { file_path: '/home/manuel/proyectos/backend-isp/src/facturas/facturas.service.ts' }], ['permiso', { command: 'npm test -- facturas' }],
      ['Bash', { command: 'npm test -- facturas' }], ['Edit', { file_path: '/home/manuel/proyectos/backend-isp/src/facturas/dto/listar.dto.ts' }]] },
  { id: 'demo-frontend', cwd: '/home/manuel/proyectos/frontend-isp', modelo: 'claude-sonnet-5-5', prompt: 'Revisa la pantalla de pagos en móvil',
    pasos: [['Glob', { pattern: 'src/**/pagos*.tsx' }], ['Read', { file_path: '/home/manuel/proyectos/frontend-isp/src/pagos/PagosLista.tsx' }],
      ['sub', 'Explore'], ['Edit', { file_path: '/home/manuel/proyectos/frontend-isp/src/pagos/PagosLista.tsx' }], ['Bash', { command: 'npm run lint' }]] },
  { id: 'demo-infra', cwd: '/home/manuel/infra/suricata-ids-lab', modelo: 'claude-opus-5-5', prompt: 'Revisa por qué Suricata no envía alertas al MikroTik',
    pasos: [['Bash', { command: 'docker compose logs --tail 80 suricata' }], ['Read', { file_path: '/home/manuel/infra/suricata-ids-lab/suricata.yaml' }],
      ['WebSearch', { query: 'suricata eve.json alert mikrotik address-list' }], ['fallo', 'Bash'], ['Edit', { file_path: '/home/manuel/infra/suricata-ids-lab/sync/mikrotik.py' }]] }
];

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => a + Math.random() * (b - a);

async function correr(oficina, g, retraso) {
  await espera(retraso);
  const base = { session_id: g.id, cwd: g.cwd, transcript_path: '' };
  const ev = (nombre, extra) => oficina.procesar({ ...base, hook_event_name: nombre, ...extra });
  await ev('SessionStart', { source: 'startup', model: g.modelo });
  let prompt = g.prompt;
  for (;;) {
    await espera(azar(1500, 3000));
    let r = await ev('UserPromptSubmit', { prompt });
    for (const [tipo, datos] of g.pasos) {
      await espera(azar(1800, 4000));
      if (tipo === 'permiso') {
        await ev('PermissionRequest', { tool_name: 'Bash', tool_input: datos });
        await espera(azar(3000, 5000));
        await ev('PreToolUse', { tool_name: 'Bash', tool_input: datos });
      } else if (tipo === 'sub') {
        await ev('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Buscar estilos de la tabla', subagent_type: datos } });
        await ev('SubagentStart', { agent_id: 'a-' + g.id, agent_type: datos });
        for (const f of ['src/pagos/pagos.css', 'src/tema/tabla.ts']) {
          await espera(azar(1200, 2200));
          await ev('PreToolUse', { agent_id: 'a-' + g.id, agent_type: datos, tool_name: 'Read', tool_input: { file_path: g.cwd + '/' + f } });
          await ev('PostToolUse', { agent_id: 'a-' + g.id, agent_type: datos, tool_name: 'Read' });
        }
        await ev('SubagentStop', { agent_id: 'a-' + g.id, agent_type: datos });
      } else if (tipo === 'fallo') {
        await ev('PreToolUse', { tool_name: datos, tool_input: { command: 'ssh admin@10.0.0.1 /ip firewall address-list print' } });
        await espera(1500);
        await ev('PostToolUseFailure', { tool_name: datos, error: 'ssh: connect to host 10.0.0.1 port 22: Connection timed out' });
        continue;
      } else {
        await ev('PreToolUse', { tool_name: tipo, tool_input: datos });
      }
      await espera(azar(1000, 2500));
      r = await ev('PostToolUse', { tool_name: tipo });
      if (r) { prompt = '(orden recibida)'; } // la orden se entrega aquí; la simulación sigue
    }
    await espera(1200);
    r = await ev('Stop', { last_assistant_message: 'Listo. Cambios aplicados en ' + g.pasos.filter((p) => p[0] === 'Edit').length + ' archivos; pruebas en verde.' });
    if (r && r.decision === 'block') { prompt = 'Siguiendo la orden de la oficina'; continue; }
    await espera(azar(12000, 20000));
  }
}

function iniciar(oficina) {
  GUIONES.forEach((g, i) => correr(oficina, g, i * 1200).catch((e) => console.error('demo', e)));
}

module.exports = { iniciar };
