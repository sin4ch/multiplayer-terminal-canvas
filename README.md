# Multiplayer Terminal Canvas

A collaborative, real-time ASCII terminal canvas web application. 
Draw with friends using strictly constrained cellular grids, supporting infinite panning, zooming, light/dark modes, and SVG exports.

## Features
- **Real-time Collaboration:** Powered by WebSockets and a custom binary protocol for high performance.
- **Terminal Grid:** Characters snap perfectly to a monospace cellular grid.
- **Modern UI:** Floating toolbars, interactive user status, and smooth View Transition API theme toggling.
- **Pan & Zoom:** Infinite panning (Right-click/Two-finger) and smooth zooming (Scroll-wheel/Slider/+/-).
- **Export:** Export the entire canvas as a perfectly mapped, portable SVG.

## Tech Stack
- **Backend:** Bun + TypeScript (Native WebSockets server)
- **Frontend:** Vanilla HTML, CSS, JavaScript (Zero frameworks, hardware-accelerated transforms)

## Setup

1. Install [Bun](https://bun.sh/).
2. Start the development server:
   \`\`\`bash
   bun run server.ts
   \`\`\`
3. Open \`http://localhost:3000\` in your browser to begin drawing. 
