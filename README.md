# ai-office-3d

Oficina virtual en 3D para ver cómo trabajan los agentes de IA (sesiones de Claude Code en VS Code) en tiempo real.

## Contenido

- `docs/arquitectura.md`: diseño de la solución (experiencia visual, watcher local, hub de eventos, frontend con React Three Fiber y plan por etapas).
- `prototipos/modelo-multiagente-3d.html`: prototipo autocontenido con three.js (UMD r128 desde cdnjs). Visualiza el modelo multiagente de desarrollo (niveles N1–N4, Coordinador, nueve especialistas, estados y producción). Sirve para validar la escena, la cámara orbital y el HUD antes de conectar datos reales. Se abre directamente en el navegador; la cámara se maneja con ratón, táctil o teclado (flechas y +/−), y si no hay WebGL el panel sigue funcionando.

## Fuentes de datos previstas para el watcher

Claude Code ofrece dos fuentes locales, sin leer logs de otras extensiones:

1. **Hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`): reciben por stdin un JSON con id de sesión, herramienta, argumentos y cwd. Es la vía para el tiempo real. La correspondencia evento → estado del avatar y las reglas de seguridad están en `docs/arquitectura.md` (secciones 2.1 y 2.2).
2. **Transcripts JSONL** por sesión en `~/.claude/projects/<proyecto>/<sesion>.jsonl`: mensajes, llamadas a herramientas, resultados con marca de error, tokens y bandera de subagente. Es la vía para historial y métricas.

Estados del avatar: ejecutando, pensando, esperando aprobación, error, inactivo.

## Etapas

1. Mock y arquitectura base (backend con agentes simulados + frontend por WebSocket).
2. Escena 3D, raycasting y HUD.
3. Watcher real por hooks de Claude Code.
4. Modelos GLTF, animaciones y reconexión.
