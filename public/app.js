const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const canvasWrapper = document.getElementById('canvas-wrapper');
const currentCharDisplay = document.getElementById('current-char');
const clearBtn = document.getElementById('clear-btn');
const userCountDisplay = document.getElementById('user-count');
const bubblesLayer = document.getElementById('bubbles-layer');
const colorPicker = document.getElementById('color-picker');
const sizeBtn = document.getElementById('size-btn');

const myNameDisplay = document.getElementById('my-name');

// ASCII Grid Base Settings
const BASE_W = 10;
const BASE_H = 16;
const COLS = 80;
const ROWS = 40;
const INTERNAL_W = COLS * BASE_W;
const INTERNAL_H = ROWS * BASE_H;

// Fixed Canvas Size
canvas.width = INTERNAL_W;
canvas.height = INTERNAL_H;
canvasWrapper.style.aspectRatio = `${INTERNAL_W} / ${INTERNAL_H}`;

// State
let currentChar = '#';
let currentColor = '#ffffff';
let currentSize = 1;
let isDrawing = false;
let me = null; // { id, name, color }
let localGrid = new Map(); // key: "col,row" -> { char, color, size }
let userBubbles = new Map(); // key: userId -> DOM element
let activeUsers = [];

// WebSockets
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
let wsUrl = `${protocol}//${window.location.host}`;

// Restore saved user identity & tools if available
const savedSession = sessionStorage.getItem('myUser');
if (savedSession) {
    const saved = JSON.parse(savedSession);
    const params = new URLSearchParams({
        id: saved.id,
        name: saved.name,
        color: saved.color
    });
    wsUrl += `?${params.toString()}`;
    
    // Restore tools
    if (saved.toolChar) {
        currentChar = saved.toolChar;
        currentCharDisplay.value = currentChar;
    }
    if (saved.toolColor) {
        currentColor = saved.toolColor;
        colorPicker.value = currentColor;
        currentCharDisplay.style.color = currentColor;
    }
    if (saved.toolSize) {
        currentSize = saved.toolSize;
        sizeBtn.textContent = currentSize + 'x';
        
            // Provide a visual hint of scaling without breaking the UI layout
    currentCharDisplay.style.fontSize = `${14 + (currentSize * 2)}px`;
    }
}

const ws = new WebSocket(wsUrl);
ws.binaryType = "arraybuffer";

// Binary Batching
let drawQueue = [];
let drawQueueTimer = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function flushDrawQueue() {
    if (drawQueue.length === 0) return;
    
    // Calculate total size: Type(1) + (col(1) + row(1) + rgb(3) + size(1) + charLen(1) + charBytes(N))
    let totalBytes = 1; 
    const encodedDraws = drawQueue.map(draw => {
        const charBytes = textEncoder.encode(draw.char);
        return { ...draw, charBytes };
    });
    
    for (const d of encodedDraws) {
        totalBytes += 1 + 1 + 3 + 1 + 1 + d.charBytes.length; 
    }
    
    const buffer = new Uint8Array(totalBytes);
    buffer[0] = 1; // Type 1: BATCH_DRAW
    
    let offset = 1;
    for (const d of encodedDraws) {
        buffer[offset++] = d.col;
        buffer[offset++] = d.row;
        
        const r = parseInt(d.color.slice(1, 3), 16);
        const g = parseInt(d.color.slice(3, 5), 16);
        const b = parseInt(d.color.slice(5, 7), 16);
        
        buffer[offset++] = r;
        buffer[offset++] = g;
        buffer[offset++] = b;
        buffer[offset++] = d.size;
        
        buffer[offset++] = d.charBytes.length;
        buffer.set(d.charBytes, offset);
        offset += d.charBytes.length;
    }
    
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
    }
    
    drawQueue = [];
    drawQueueTimer = null;
}


// Helper to save current tool state
function saveToolState() {
    if (!me) return;
    sessionStorage.setItem('myUser', JSON.stringify({
        ...me,
        toolChar: currentChar,
        toolColor: currentColor,
        toolSize: currentSize
    }));
}

// Initial Paint Setup
ctx.fillStyle = '#000000';
ctx.fillRect(0, 0, canvas.width, canvas.height);
drawGridLines(ctx, false);

// Listeners
colorPicker.addEventListener('input', (e) => {
    currentColor = e.target.value;
    currentCharDisplay.style.color = currentColor;
    saveToolState();
});

sizeBtn.addEventListener('click', (e) => {
    currentSize = currentSize + 1;
    if (currentSize > 4) currentSize = 1;
    sizeBtn.textContent = currentSize + 'x';
    currentCharDisplay.style.fontSize = `${14 + (currentSize * 2)}px`;
    saveToolState();
    e.target.blur();
});

const drawingTimers = new Map();

function triggerDrawAnimation(userId) {
    const dot = document.querySelector(".stacked-dot[data-user-id='" + userId + "']");
    const row = document.querySelector(".dropdown-row[data-user-id='" + userId + "']");
    
    if (dot) {
        dot.classList.add('is-drawing');
    }
    
    if (row) {
        const statusSpan = row.querySelector('.activity-status');
        if (statusSpan && statusSpan.textContent === "") {
            statusSpan.textContent = " - drawing...";
        }
    }
    
    if (drawingTimers.has(userId)) clearTimeout(drawingTimers.get(userId));
    
    const timer = setTimeout(() => {
        if (dot) dot.classList.remove('is-drawing');
        if (row) {
            const statusSpan = row.querySelector('.activity-status');
            if (statusSpan) statusSpan.textContent = "";
        }
    }, 1500);
    drawingTimers.set(userId, timer);
}

function updateUserList(users) {
    activeUsers = users;
    if (userCountDisplay) userCountDisplay.textContent = users.length;
    
    const topUsers = document.getElementById('top-users');
    if (!topUsers) return;
    
    topUsers.innerHTML = '';
    
    const dotsWrapper = document.createElement('div');
    dotsWrapper.className = 'stacked-dots-wrapper';
    
    // Add toggle for touch/click events
    dotsWrapper.addEventListener('click', (e) => {
        e.stopPropagation();
        dotsWrapper.classList.toggle('active');
    });

    const maxDots = 3;
    const displayUsers = users.slice(0, maxDots);
    const remaining = users.length - maxDots;
    
    displayUsers.forEach((user, index) => {
        const dot = document.createElement('div');
        dot.className = 'stacked-dot';
        dot.style.backgroundColor = user.color;
        dot.style.setProperty('--user-color', user.color);
        dot.dataset.userId = user.id;
        dot.style.zIndex = maxDots - index;
        
        let displayName = user.name;
        if (me && user.id === me.id) displayName += ' (You)';
        dot.title = displayName;
        
        dotsWrapper.appendChild(dot);
    });
    
    if (remaining > 0) {
        const extraDot = document.createElement('div');
        extraDot.className = 'stacked-dot extra-dot';
        extraDot.textContent = "+" + remaining;
        extraDot.style.zIndex = 0;
        dotsWrapper.appendChild(extraDot);
    }
    
    const hoverDropdown = document.createElement('div');
    hoverDropdown.className = 'mobile-hover-dropdown';
    
    users.forEach(user => {
        const dRow = document.createElement('div');
        dRow.className = 'dropdown-row';
        dRow.dataset.userId = user.id;
        
        const dDot = document.createElement('div');
        dDot.className = 'user-color-dot';
        dDot.style.backgroundColor = user.color;
        
        const dName = document.createElement('span');
        let dDisplayName = user.name;
        if (me && user.id === me.id) {
            dDisplayName += ' (You)';
            dName.style.fontWeight = 'bold';
            dName.style.color = 'var(--text-white)';
        }
        dName.textContent = dDisplayName;
        
        const statusSpan = document.createElement('span');
        statusSpan.className = 'activity-status';
        
        dRow.appendChild(dDot);
        dRow.appendChild(dName);
        dRow.appendChild(statusSpan);
        hoverDropdown.appendChild(dRow);
    });
    
    dotsWrapper.appendChild(hoverDropdown);
    topUsers.appendChild(dotsWrapper);
}

// Manage Chat Bubbles
function getOrCreateBubble(userId) {
    if (userBubbles.has(userId)) return userBubbles.get(userId);
    
    const user = activeUsers.find(u => u.id === userId);
    const name = user ? user.name : `User_${userId}`;
    const color = user ? user.color : '#fff';
    
    const el = document.createElement('div');
    el.className = 'chat-bubble';
    el.innerHTML = `<span style="color: ${color}; padding-right:4px;">●</span>${name}`;
    bubblesLayer.appendChild(el);
    
    const obj = { el, timeoutId: null };
    userBubbles.set(userId, obj);
    return obj;
}

function showBubble(userId, col, row) {
    if (me && userId === me.id) return;
    
    const bubbleObj = getOrCreateBubble(userId);
    const { el } = bubbleObj;
    
    const pxX = (col * BASE_W) / canvas.width * 100;
    const pxY = (row * BASE_H) / canvas.height * 100;
    
    // Instead of naive left/top which causes clipping on right/top edges,
    // we use variables or clamping. Since it's absolutely positioned within bubbles-layer (which is the same size as canvas),
    // a bubble near the right edge will spill over.
    // If we remove overflow: hidden from bubbles-layer, it will show over the border, which is good!
    // But if we want it to stay *inside* the canvas area entirely, we can use CSS clamp.
    // Let's just let it spill over by removing the overflow hidden, but to prevent it from going off-screen entirely on tight screens:
    
    el.style.left = `calc(min(calc(${pxX}% + 15px), calc(100% - ${el.offsetWidth + 10}px)))`;
    el.style.top = `calc(max(calc(${pxY}% - 15px), 10px))`;
    
    el.classList.add('visible');
    
    clearTimeout(bubbleObj.timeoutId);
    bubbleObj.timeoutId = setTimeout(() => {
        el.classList.remove('visible');
    }, 1000);
}


function drawGridLines(targetCtx, lightMode) {
    targetCtx.strokeStyle = lightMode ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)';
    targetCtx.lineWidth = 1;
    targetCtx.beginPath();
    for (let i = 0; i <= COLS; i++) {
        targetCtx.moveTo(i * BASE_W, 0);
        targetCtx.lineTo(i * BASE_W, INTERNAL_H);
    }
    for (let i = 0; i <= ROWS; i++) {
        targetCtx.moveTo(0, i * BASE_H);
        targetCtx.lineTo(INTERNAL_W, i * BASE_H);
    }
    targetCtx.stroke();
}

// Render Cell
function drawCell(col, row, char, color, size) {
    if (!size) size = 1;
    
    const cellW = BASE_W * size;
    const cellH = BASE_H * size;
    const x = col * BASE_W;
    const y = row * BASE_H;
    
    const key = `${col},${row}`;
    localGrid.set(key, { col, row, char, color, size });
    
    // Clear cell background to wipe old characters
    ctx.fillStyle = isLightMode ? '#ffffff' : '#000000';
    ctx.fillRect(x, y, cellW, cellH);
    
    // Redraw the cell's boundary so it doesn't get erased
    ctx.strokeStyle = isLightMode ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, cellW, cellH);
    
    // Center the text inside the cell perfectly
    // Use exactly BASE_H * size so the character strictly fills the cell vertically
    const fontSize = BASE_H * size;
    ctx.font = `${fontSize}px "Geist Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(char, x + cellW / 2, y + cellH / 2);
}

function clearCanvas() {
    localGrid.clear();
    ctx.fillStyle = isLightMode ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGridLines(ctx, isLightMode);
}

// WebSocket Listeners
ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
        const buffer = new Uint8Array(event.data);
        if (buffer[0] === 1) { // BATCH_DRAW
            const userId = textDecoder.decode(buffer.subarray(1, 5)).trim();
            let offset = 5;
            
            let lastCol = -1, lastRow = -1;
            while (offset < buffer.length) {
                const col = buffer[offset++];
                const row = buffer[offset++];
                const r = buffer[offset++];
                const g = buffer[offset++];
                const b = buffer[offset++];
                const size = buffer[offset++];
                const charLen = buffer[offset++];
                const char = textDecoder.decode(buffer.subarray(offset, offset + charLen));
                offset += charLen;
                
                const color = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
                
                drawCell(col, row, char, color, size);
                lastCol = col; lastRow = row;
            }
            if (lastCol !== -1) {
                showBubble(userId, lastCol, lastRow);
                triggerDrawAnimation(userId);
            }
        }
        return;
    }

    const msg = JSON.parse(event.data);
    
    if (msg.type === 'init') {
        clearCanvas();
        me = msg.data.me;
        myNameDisplay.textContent = me.name;
        
        if (!savedSession) {
            currentColor = me.color;
            colorPicker.value = currentColor;
            currentCharDisplay.style.color = currentColor;
            saveToolState();
        }
        
        updateUserList(msg.data.users);
        // Important: clear the canvas with the right theme background before repainting init cells
        ctx.fillStyle = isLightMode ? '#ffffff' : '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawGridLines(ctx, isLightMode);
        msg.data.cells.forEach(cell => drawCell(cell.col, cell.row, cell.char, cell.color, cell.size));
    } else if (msg.type === 'clear') {
        clearCanvas();
    } else if (msg.type === 'users') {
        updateUserList(msg.data);
    }
};

// Input Handling (Mouse / Draw)
function handlePointerEvent(e) {
    if (!isDrawing) return;
    
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }
    
    if (clientX === undefined || clientY === undefined) return;
    
    const rect = canvas.getBoundingClientRect();
    
    // Map scaled CSS pixels to internal canvas pixels
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    
    let col = Math.floor(x / BASE_W);
    let row = Math.floor(y / BASE_H);
    
    // Snap to grid based on current size to maintain strict cellular structure
    col = Math.floor(col / currentSize) * currentSize;
    row = Math.floor(row / currentSize) * currentSize;
    
    if (col >= 0 && col < COLS && row >= 0 && row < ROWS) {
        const key = `${col},${row}`;
        const existing = localGrid.get(key);
        
        if (!existing || existing.char !== currentChar || existing.color !== currentColor || existing.size !== currentSize) {
            drawCell(col, row, currentChar, currentColor, currentSize);
            drawQueue.push({ col, row, char: currentChar, color: currentColor, size: currentSize });
            if (!drawQueueTimer) {
                drawQueueTimer = setTimeout(flushDrawQueue, 50); // Send updates every 50ms
            }
            if (me) triggerDrawAnimation(me.id);
        }
    }
}

// --- Pan & Zoom State ---
let zoomLevel = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let lastPanPoint = null;

const zoomSliderInput = document.getElementById('zoom-slider');
const zoomDisplayEl = document.getElementById('zoom-display');
const resetViewBtn = document.getElementById('reset-view-btn');

function updateTransform() {
    canvasWrapper.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoomLevel})`;
}

zoomSliderInput.addEventListener('input', (e) => {
    zoomLevel = parseFloat(e.target.value);
    applyZoom();
});


const zoomInBtn = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');

function applyZoom() {
    zoomSliderInput.value = zoomLevel;
    zoomDisplayEl.textContent = zoomLevel.toFixed(1) + 'x';
    updateTransform();
}

zoomInBtn.addEventListener('click', () => {
    zoomLevel = Math.min(3.0, zoomLevel + 0.1);
    applyZoom();
});

zoomOutBtn.addEventListener('click', () => {
    zoomLevel = Math.max(0.2, zoomLevel - 0.1);
    applyZoom();
});


resetViewBtn.addEventListener('click', () => {
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    zoomSliderInput.value = 1;
    zoomDisplayEl.textContent = '1.0x';
    updateTransform();
    resetViewBtn.blur();
});

// Prevent context menu to allow right click panning
canvasWrapper.addEventListener('contextmenu', e => e.preventDefault());

// Mouse Events
canvasWrapper.addEventListener('mousedown', (e) => {
    if (e.button === 2) { // Right click
        isPanning = true;
        canvasWrapper.classList.add('is-panning');
        lastPanPoint = { x: e.clientX, y: e.clientY };
        e.preventDefault();
    } else if (e.button === 0) { // Left click
        isDrawing = true;
        handlePointerEvent(e);
    }
});

window.addEventListener('mousemove', (e) => {
    if (isPanning && lastPanPoint) {
        const dx = e.clientX - lastPanPoint.x;
        const dy = e.clientY - lastPanPoint.y;
        panX += dx;
        panY += dy;
        lastPanPoint = { x: e.clientX, y: e.clientY };
        updateTransform();
    } else if (isDrawing) {
        handlePointerEvent(e);
    }
});

window.addEventListener('mouseup', (e) => {
    if (e.button === 2) {
        isPanning = false;
        canvasWrapper.classList.remove('is-panning');
        lastPanPoint = null;
    }
    if (e.button === 0) {
        isDrawing = false;
    }
});

// Touch Events
canvasWrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        isPanning = true;
        isDrawing = false;
        canvasWrapper.classList.add('is-panning');
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        lastPanPoint = {
            x: (touch1.clientX + touch2.clientX) / 2,
            y: (touch1.clientY + touch2.clientY) / 2
        };
        e.preventDefault();
    } else if (e.touches.length === 1 && !isPanning) {
        isDrawing = true;
        handlePointerEvent(e);
        e.preventDefault();
    }
}, { passive: false });

canvasWrapper.addEventListener('touchmove', (e) => {
    if (isPanning && e.touches.length === 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const currentMidX = (touch1.clientX + touch2.clientX) / 2;
        const currentMidY = (touch1.clientY + touch2.clientY) / 2;
        
        panX += (currentMidX - lastPanPoint.x);
        panY += (currentMidY - lastPanPoint.y);
        lastPanPoint = { x: currentMidX, y: currentMidY };
        updateTransform();
        e.preventDefault();
    } else if (isDrawing && e.touches.length === 1) {
        handlePointerEvent(e);
        e.preventDefault();
    }
}, { passive: false });

canvasWrapper.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        isPanning = false;
        canvasWrapper.classList.remove('is-panning');
        lastPanPoint = null;
    }
    if (e.touches.length === 0) {
        isDrawing = false;
    }
});

canvasWrapper.addEventListener('touchcancel', () => {
    isDrawing = false;
    isPanning = false;
    canvasWrapper.classList.remove('is-panning');
});

// Scroll Wheel Zoom
canvasWrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    // Determine zoom step (scroll up = zoom in, scroll down = zoom out)
    // We use a smaller step for smoother scrolling
    const zoomStep = 0.1;
    if (e.deltaY < 0) {
        zoomLevel = Math.min(3.0, zoomLevel + zoomStep);
    } else if (e.deltaY > 0) {
        zoomLevel = Math.max(0.2, zoomLevel - zoomStep);
    }
    
    // Update the visual slider and text display
    zoomSliderInput.value = zoomLevel;
    zoomDisplayEl.textContent = zoomLevel.toFixed(1) + 'x';
    
    updateTransform();
}, { passive: false });

// Input Handling (Keyboard / Tool Swap)
document.addEventListener('keydown', (e) => {
    const activeTag = e.target.tagName;
    if (e.metaKey || e.ctrlKey || e.altKey || activeTag === 'INPUT' || activeTag === 'BUTTON') return;
    
    if (e.key.length === 1) {
        currentChar = e.key;
        currentCharDisplay.value = currentChar;
            // Provide a visual hint of scaling without breaking the UI layout
    currentCharDisplay.style.fontSize = `${14 + (currentSize * 2)}px`;
        saveToolState();
    }
});

clearBtn.addEventListener('click', (e) => {
    clearCanvas();
    ws.send(JSON.stringify({ type: 'clear' }));
    e.target.blur();
});

// Mobile Character Input
currentCharDisplay.addEventListener('input', (e) => {
    const val = e.target.value;
    if (val.length > 0) {
        currentChar = val.charAt(val.length - 1);
        e.target.value = currentChar;
            // Provide a visual hint of scaling without breaking the UI layout
    currentCharDisplay.style.fontSize = `${14 + (currentSize * 2)}px`;
        saveToolState();
    }
});

currentCharDisplay.addEventListener('click', (e) => {
    e.target.value = '';
    e.target.focus();
});
currentCharDisplay.addEventListener('blur', (e) => {
    if (e.target.value === '') e.target.value = currentChar;
});



// --- Username Editing ---
const nameEditWrapper = document.getElementById("name-edit-wrapper");
const nameInput = document.getElementById('name-input');
const cancelNameBtn = document.getElementById('cancel-name-btn');
const saveNameBtn = document.getElementById('save-name-btn');

function closeNameModal() {
    nameEditWrapper.classList.remove('active');
    nameInput.blur();
}

function saveName() {
    if (!me) return;
    const newName = nameInput.value;
    if (newName && newName.trim() !== "" && newName.trim() !== me.name) {
        const safeName = newName.trim().substring(0, 16);
        me.name = safeName;
        myNameDisplay.textContent = safeName;
        saveToolState();
        
        ws.send(JSON.stringify({
            type: 'rename',
            data: { name: safeName }
        }));
    }
    closeNameModal();
}

myNameDisplay.addEventListener('click', () => {
    if (!me) return;
    nameInput.value = me.name;
    nameEditWrapper.classList.add('active');
    setTimeout(() => nameInput.focus(), 100);
});

cancelNameBtn.addEventListener('click', closeNameModal);
saveNameBtn.addEventListener('click', saveName);

nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveName();
    } else if (e.key === 'Escape') {
        closeNameModal();
    }
});

document.addEventListener('mousedown', (e) => {
    // Close name editor if clicking outside
    if (nameEditWrapper && nameEditWrapper.classList.contains('active')) {
        if (!nameEditWrapper.contains(e.target)) {
            closeNameModal();
        }
    }
    
    // Close users dropdown if clicking outside
    const dotsWrapper = document.querySelector('.stacked-dots-wrapper');
    if (dotsWrapper && dotsWrapper.classList.contains('active')) {
        if (!dotsWrapper.contains(e.target)) {
            dotsWrapper.classList.remove('active');
        }
    }
});

// --- Theme & Export Features ---
const themeBtn = document.getElementById('theme-btn');
const exportBtn = document.getElementById('export-btn');

let isLightMode = localStorage.getItem('lightMode') === 'true';

function applyTheme() {
    if (isLightMode) {
        document.body.classList.add('light-mode');
        
    } else {
        document.body.classList.remove('light-mode');
        
    }
    
    // Repaint canvas background
    const canvasBg = isLightMode ? '#ffffff' : '#000000';
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGridLines(ctx, isLightMode);
    
    // Redraw all local cells
    for (const [key, cell] of localGrid.entries()) {
        drawCell(cell.col, cell.row, cell.char, cell.color, cell.size);
    }
}

// Initial theme application
if (isLightMode) {
    applyTheme();
}

themeBtn.addEventListener('click', () => {
    isLightMode = !isLightMode;
    localStorage.setItem('lightMode', isLightMode);
    
    // Check if browser supports GPU-accelerated View Transitions
    if (document.startViewTransition) {
        document.startViewTransition(() => {
            applyTheme();
        });
    } else {
        applyTheme();
    }
});

exportBtn.addEventListener('click', () => {
    const canvasBg = isLightMode ? '#ffffff' : '#000000';
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" style="background-color: ${canvasBg}">`;
    svg += `<defs><style>@import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&amp;display=swap'); text { font-family: 'Geist Mono', monospace; }</style></defs>`;
    svg += `<rect width="100%" height="100%" fill="${canvasBg}"/>`;
    
    // Draw Faint Grid on SVG
    const gridStroke = isLightMode ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)';
    svg += `<g stroke="${gridStroke}" stroke-width="1">`;
    for (let i = 0; i <= COLS; i++) {
        svg += `<line x1="${i * BASE_W}" y1="0" x2="${i * BASE_W}" y2="${INTERNAL_H}" />`;
    }
    for (let i = 0; i <= ROWS; i++) {
        svg += `<line x1="0" y1="${i * BASE_H}" x2="${INTERNAL_W}" y2="${i * BASE_H}" />`;
    }
    svg += `</g>`;

    for (const [key, cell] of localGrid.entries()) {
        const cellW = BASE_W * cell.size;
        const cellH = BASE_H * cell.size;
        const x = cell.col * BASE_W;
        const y = cell.row * BASE_H;
        const fontSize = BASE_H * cell.size;
        const centerX = x + cellW / 2;
        // SVG dominant-baseline="central" is very slightly off-center compared to Canvas 'middle' in some fonts, 
        // adding +1 pixel nudge for Geist Mono perfection
        const centerY = y + cellH / 2 + 1; 
        
        // Escape special XML characters in char
        let safeChar = cell.char
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
            
        svg += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${canvasBg}" stroke="${gridStroke}" stroke-width="1"/>`;
        svg += `<text x="${centerX}" y="${centerY}" fill="${cell.color}" font-family="Geist Mono, monospace" font-size="${fontSize}px" text-anchor="middle" dominant-baseline="central" xml:space="preserve">${safeChar}</text>`;
    }
    
    svg += `</svg>`;
    
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canvas_export_${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    exportBtn.blur();
});
