import { serve } from "bun";

type Cell = { col: number; row: number; char: string; color: string; size: number };
type DrawMessage = { type: "draw"; data: Cell; userId?: string };
type ClearMessage = { type: "clear" };
type RenameMessage = { type: "rename"; data: { name: string } };
type Message = DrawMessage | ClearMessage | RenameMessage;

type User = { id: string; name: string; color: string };

// State
const grid = new Map<string, {char: string, color: string, size: number}>();
const users = new Map<string, User>();
const userConnections = new Map<string, number>(); // Track active sockets per user ID

function getRandomColor() {
    const letters = '89ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 8)];
    }
    return color;
}

const server = serve({
  port: 3000,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (server.upgrade(req, {
      data: {
        id: url.searchParams.get("id"),
        name: url.searchParams.get("name"),
        color: url.searchParams.get("color")
      }
    })) return;
    
    let path = url.pathname;
    if (path === "/") path = "/index.html";
    
    const file = Bun.file(`./public${path}`);
    if (file.size === 0) return new Response("Not Found", { status: 404 });
    
    if (path === "/index.html") {
      // Check for hard reload (Ctrl+Shift+R or Cmd+Shift+R)
      const isHardReload = req.headers.get("cache-control") === "no-cache" || req.headers.get("pragma") === "no-cache";
      let text = await file.text();
      
      if (isHardReload) {
          // Inject a script to clear the session so a new one is created
          text = text.replace("<head>", "<head><script>sessionStorage.removeItem('myUser');</script>");
      }
      return new Response(text, { headers: { "Content-Type": "text/html" } });
    }

    return new Response(file);
  },
  websocket: {
    open(ws) {
      let id = ws.data.id;
      let name = ws.data.name;
      let color = ws.data.color;

      if (!id) {
          id = Math.random().toString(36).substring(2, 6).toUpperCase();
          name = `anon_${id}`;
          color = getRandomColor();
      }
      
      const user: User = { id, name, color };
      ws.data = { id, name, color };
      
      users.set(id, user);
      userConnections.set(id, (userConnections.get(id) || 0) + 1);
      
      ws.subscribe("canvas");
      
      const cells = Array.from(grid.entries()).map(([key, val]) => {
          const [col, row] = key.split(',').map(Number);
          return { col, row, char: val.char, color: val.color, size: val.size };
      });
      
      ws.send(JSON.stringify({ 
          type: "init", 
          data: { cells, me: user, users: Array.from(users.values()) } 
      }));
      
      server.publish("canvas", JSON.stringify({ type: "users", data: Array.from(users.values()) }));
    },
    message(ws, message) {
      if (typeof message !== "string") {
          // Binary message handling
          const buffer = new Uint8Array(message);
          if (buffer[0] === 1) { // BATCH_DRAW
              const userId = ws.data.id;
              
              // We need to decode enough to save to grid, then rebroadcast with userId injected
              const decoder = new TextDecoder();
              let offset = 1; // skip type
              
              // We'll create a new buffer for broadcasting: [Type(1), UserId(4 bytes), ...cells]
              const broadcastBuffer = new Uint8Array(buffer.length + 4);
              broadcastBuffer[0] = 1;
              const encoder = new TextEncoder();
              broadcastBuffer.set(encoder.encode(userId.padEnd(4, ' ').substring(0, 4)), 1);
              broadcastBuffer.set(buffer.subarray(1), 5);
              
              while (offset < buffer.length) {
                  const col = buffer[offset++];
                  const row = buffer[offset++];
                  const r = buffer[offset++];
                  const g = buffer[offset++];
                  const b = buffer[offset++];
                  const size = buffer[offset++];
                  const charLen = buffer[offset++];
                  const char = decoder.decode(buffer.subarray(offset, offset + charLen));
                  offset += charLen;
                  
                  const color = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
                  
                  const key = `${col},${row}`;
                  grid.set(key, { char, color, size });
              }
              
              ws.publish("canvas", broadcastBuffer);
          }
          return;
      }

      try {
        const parsed = JSON.parse(message);
        const userId = ws.data.id;


        if (parsed.type === "clear") {
          grid.clear();
          ws.publish("canvas", JSON.stringify(parsed));
        } else if (parsed.type === "rename") {
          const user = users.get(userId);
          if (user) {
              user.name = parsed.data.name;
              ws.data.name = parsed.data.name;
              // Broadcast updated user list to everyone
              server.publish("canvas", JSON.stringify({ type: "users", data: Array.from(users.values()) }));
              // Ensure the sender gets their own list updated too
              ws.send(JSON.stringify({ type: "users", data: Array.from(users.values()) }));
          }
        }
      } catch (e) {
        console.error("Failed to parse message", e);
      }
    },
    close(ws) {
      const id = ws.data.id;
      const count = (userConnections.get(id) || 1) - 1;
      
      if (count <= 0) {
          userConnections.delete(id);
          users.delete(id);
      } else {
          userConnections.set(id, count);
      }
      
      ws.unsubscribe("canvas");
      server.publish("canvas", JSON.stringify({ type: "users", data: Array.from(users.values()) }));
    }
  }
});

console.log(`[SYS] Minimal Canvas Server running on http://localhost:${server.port}`);
