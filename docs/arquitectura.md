# Oficina Virtual 3D para Monitoreo de Agentes de IA

Arquitectura diseñada para visualizar en tiempo real la actividad, estado y tareas de instancias de IA (como Claude) trabajando dentro de Visual Studio Code mediante un entorno tridimensional interactivo.

## 1. La Experiencia Visual (Oficina de IA)

*   **El Entorno:** Una oficina 3D estilo *cyberpunk* o corporativa minimalista (tema oscuro). Las entidades principales son **"Estaciones de Trabajo"** o avatares cibernéticos que representan a cada agente.
*   **Estado Visual:** 
    *   🟢 **Escribiendo/Ejecutando:** El avatar teclea o la pantalla del escritorio brilla con código en movimiento.
    *   🔵 **Pensando/Analizando:** Un halo azul o estado estático mientras el modelo procesa el prompt.
    *   🔴 **Error/Bloqueado:** Luces rojas (ej. fallo en un script, límite de tokens).
    *   ⚪ **Inactivo (Idle):** Estación apagada o en reposo.
*   **Panel Interactivo (HUD):** Al hacer clic en el escritorio de un agente en el entorno 3D, se abre un panel lateral superpuesto que muestra:
    *   **Nombre/ID del Agente:** (ej. *Claude-Dev-1*, *Claude-Reviewer*).
    *   **Labor actual:** Tarea asignada (ej. "Refactorizando componente de React").
    *   **Actividad en VS Code:** Archivo actual abierto (`/src/app.ts`), línea de código modificada.
    *   **Streaming de Logs:** La salida de la terminal o el "pensamiento" del agente en tiempo real.
    *   **Métricas de IA:** Tokens consumidos, tiempo de ejecución de la tarea.

---

## 2. Arquitectura de Integración (El Reto de VS Code)

Para saber qué hace Claude dentro de VS Code, se extrae la información del entorno local y se envía al Dashboard 3D mediante tres componentes principales:

1.  **El "Agent Watcher" (Recolector Local):**
    *   Un script en Node.js o Python que corre en la máquina local.
    *   Se conecta a la actividad de Claude. Lee los archivos de log locales que generan extensiones como *Cline*, *Roo Code* o la oficial de Claude, o utiliza una extensión personalizada de VS Code para emitir eventos cada vez que el agente modifica un archivo o ejecuta un comando.
2.  **El Hub de Eventos (Backend central):**
    *   Un servidor Node.js (Express + Socket.io) que recibe los datos de todos los "Agent Watchers" y los unifica.
3.  **El Dashboard 3D (Frontend):**
    *   React Three Fiber renderiza la oficina y se suscribe vía WebSockets al Hub para animar los avatares y actualizar los paneles laterales en vivo.

---

## 3. Estructura de Carpetas del Monorepo

```text
ai-office-3d/
├── docker-compose.yml          # Levanta el Backend y el Frontend del Dashboard
├── README.md                   
├── agent-watcher/              # (Se ejecuta localmente donde trabaja Claude)
│   ├── src/
│   │   ├── logParser.ts        # Lee los logs de Claude en tiempo real
│   │   ├── vsCodeListener.ts   # Detecta qué archivos se están modificando
│   │   └── socketClient.ts     # Envía la actividad al Backend
│   └── package.json
├── backend/                    # (El cerebro del Dashboard)
│   ├── src/
│   │   ├── server.ts
│   │   ├── sockets/            # Recibe de los watchers, emite al frontend
│   │   └── state/              # Mantiene en memoria el estado actual de cada agente
│   └── package.json
└── frontend/                   # (La Oficina 3D)
    ├── src/
    │   ├── assets/models/      # Modelos 3D (Escritorios, Avatares, Oficina)
    │   ├── components/
    │   │   ├── 3d/             # OfficeScene.tsx, AgentDesk.tsx
    │   │   └── ui/             # Overlay.tsx, AgentTerminal.tsx (Tailwind)
    │   ├── store/              # Zustand (gestión del estado de los agentes)
    │   └── App.tsx
    └── package.json
```

---

## 4. Plan de Implementación por Etapas

### Etapa 1: Mock y Arquitectura Base
*   Configurar el Frontend (React Three Fiber) y Backend (Node.js + WebSockets).
*   Crear un generador de *datos falsos* en el backend que simule 3 agentes trabajando, cambiando sus estados (escribiendo, pensando, error) periódicamente.
*   Conectar el Frontend por WebSockets para verificar el flujo de datos sin latencia.

### Etapa 2: Desarrollo del Entorno 3D y UI
*   Construir la escena 3D y colocar escritorios básicos (cubos/planos provisionales).
*   Implementar *Raycasting* (eventos de clic en 3D) para la selección de agentes.
*   Diseñar la UI superpuesta en HTML/CSS (Tailwind, tema oscuro) para mostrar la terminal falsa y el estado de la tarea.
*   Vincular los cambios de estado visuales (luces, colores) a los WebSockets.

### Etapa 3: El "Agent Watcher" (Integración Real)
*   Desarrollar el script local que vigilará a Claude.
*   Localizar dónde guarda los logs la herramienta de IA en VS Code.
*   Hacer que el script procese estos logs (Tail al archivo) y envíe eventos estructurados al Backend: `{ agent: "Claude-1", action: "coding", file: "index.js", snippet: "..." }`.

### Etapa 4: Pulido y Optimización Visual
*   Reemplazar figuras geométricas por modelos 3D reales (GLTF/GLB).
*   Añadir animaciones complejas (pantallas parpadeando, movimiento de avatares).
*   Implementar reconexión automática de WebSockets.