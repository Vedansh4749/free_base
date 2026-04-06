/*  FREE CANVAS NOTEPAD – Phase 4
    Features: Infinite pan (Shift+drag / Middle-click), Ctrl+scroll zoom,
    Free-direction node wiring (Ctrl+drag from note), Waypoint pins (Ctrl+click wire),
    Calculator with keyboard/history/preview/copy, Budget note, PDF export.
*/

document.addEventListener('DOMContentLoaded', () => {

// ─── DOM ─────────────────────────────────────────────────────────────────────
const viewport      = document.getElementById('viewport');
const canvas        = document.getElementById('canvas');
const connLayer     = document.getElementById('connection-layer');
const noteTemplate  = document.getElementById('note-template');
const calcWidget    = document.getElementById('calculator-widget');
const calcHeader    = document.getElementById('calc-header');
const calcCloseBtn  = document.getElementById('calc-closeBtn');
const calcHistBtn   = document.getElementById('calc-historyBtn');
const calcBudgetBtn = document.getElementById('calc-budgetBtn');
const calcHistPanel = document.getElementById('calc-historyPanel');
const calcBudPanel  = document.getElementById('calc-budgetPanel');
const calcHistList  = document.getElementById('calc-history-list');
const calcClearBtn  = document.getElementById('calc-clearHistoryBtn');
const calcBudArea   = document.getElementById('calc-budgetArea');
const calcExpr      = document.getElementById('calc-expression');
const calcDisp      = document.getElementById('calc-display');
const calcPrev      = document.getElementById('calc-preview');
const copyResultBtn = document.getElementById('copy-result-btn');
const copyBudBtn    = document.getElementById('copy-budget-btn');
const calcToggleBtn = document.getElementById('calc-toggleBtn');
const exportBtn     = document.getElementById('exportBtn');
const zoomIndicator = document.getElementById('zoom-indicator');
const calcBtns      = document.querySelectorAll('.calc-btn');

// ─── CANVAS CONSTANTS ─────────────────────────────────────────────────────────
const CANVAS_W = 10000;
const CANVAS_H = 10000;

// ─── STATE ────────────────────────────────────────────────────────────────────
let panX = window.innerWidth  / 2 - CANVAS_W / 2;
let panY = window.innerHeight / 2 - CANVAS_H / 2;
let zoom = 1;
let highestZ = 10;

let connections = []; // {id, from, fromAnchor:{side,x,y}, to, toAnchor:{side,x,y}, waypoints:[{x,y}]}
let isPanning = false, panSX = 0, panSY = 0, panOX = 0, panOY = 0;
let ctrlHeld = false;

// Wire drawing
let isDrawingWire = false, wireFromId = null, wireFromAnchor = null, tempWire = null;

// Calculator
let calcCurrent = '0', calcFull = '', calcHistory = [], calcReset = false;
let stateSaveTimer = null;

// Supabase & Realtime Setup
const supabaseClient = window.supabase.createClient(
    'https://feswqkmphbqvcsuixqje.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlc3dxa21waGJxdmNzdWl4cWplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0Nzg1MjksImV4cCI6MjA5MTA1NDUyOX0.hW9XImiMv5d-8i4k1X6lw_LXL-hZWhQor22lDcjXIOo'
);
let currentRoom = null;
let realtimeChannel = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────
canvas.style.width  = CANVAS_W + 'px';
canvas.style.height = CANVAS_H + 'px';

// Room UI
const roomManager = document.getElementById('room-manager');
const appContent = document.getElementById('app-content');
const createRoomBtn = document.getElementById('create-room-btn');
const joinCodeInp = document.getElementById('join-code');
const joinRoomBtn = document.getElementById('join-room-btn');
const roomCodeDisplay = document.getElementById('room-code-display');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const joinError = document.getElementById('join-error');

createRoomBtn.addEventListener('click', async () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await enterRoom(code);
});
joinRoomBtn.addEventListener('click', async () => {
    const code = joinCodeInp.value.trim().toUpperCase();
    if(code.length > 0) await enterRoom(code);
});
leaveRoomBtn.addEventListener('click', () => location.reload());

async function enterRoom(code) {
    currentRoom = code;
    roomCodeDisplay.innerText = code;
    roomManager.style.display = 'none';
    appContent.classList.remove('hidden');

    const { data: items } = await supabaseClient
        .from('canvas_items')
        .select('*')
        .eq('room_id', code);
    
    if (items) {
        items.forEach(item => {
            if (item.type === 'note') createNoteEl(item.data, true);
            if (item.type === 'connection') connections.push(item.data);
            if (item.type === 'state') {
                panX = item.data.panX ?? panX;
                panY = item.data.panY ?? panY;
                zoom = item.data.zoom ?? 1;
                highestZ = item.data.highestZ ?? 10;
                calcHistory = item.data.calcHistory ?? [];
                if (item.data.budgetNote && calcBudArea) calcBudArea.value = item.data.budgetNote;
            }
        });
    }
    
    drawConnections();
    renderHistory();
    applyTransform();
    updateZoomLabel();
    setupPan();
    setupZoom();
    setupGlobal();
    setupCalc();
    setupExport();

    window.__deleteConnection = id => {
        connections = connections.filter(c => c.id !== id);
        drawConnections(); deleteSync('connection', id);
    };
    window.__deleteWaypoint = (connId, wpIdx) => {
        const conn = connections.find(c => c.id === connId);
        if (conn) {
            conn.waypoints.splice(wpIdx, 1);
            drawConnections(); syncConnection(conn);
        }
    };
    window.__addWaypoint = (connId, x, y) => {
        const conn = connections.find(c => c.id === connId);
        if (conn) {
            conn.waypoints = conn.waypoints || [];
            conn.waypoints.push({ x, y });
            drawConnections(); syncConnection(conn);
        }
    };

    realtimeChannel = supabaseClient.channel(`room:${code}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'canvas_items', filter: `room_id=eq.${code}` }, handleRealtimeEvent)
        .subscribe();
}

function handleRealtimeEvent(payload) {
    const { eventType, new: newItem, old: oldItem } = payload;
    if (eventType === 'DELETE') {
        if (oldItem.type === 'note') {
            const el = canvas.querySelector(`.note[data-id="${oldItem.id}"]`);
            if (el) el.remove();
        } else if (oldItem.type === 'connection') {
            connections = connections.filter(c => c.id !== oldItem.id);
            drawConnections();
        }
        return;
    }
    
    if (newItem.type === 'note') {
        const existing = canvas.querySelector(`.note[data-id="${newItem.id}"]`);
        if (existing) {
            existing.style.left = newItem.data.x + 'px';
            existing.style.top = newItem.data.y + 'px';
            if (newItem.data.width) existing.style.width = newItem.data.width;
            if (newItem.data.height) existing.style.height = newItem.data.height;
            existing.style.zIndex = newItem.data.zIndex;
            existing.dataset.color = newItem.data.color;
            existing.style.background = `var(--note-${newItem.data.color})`;
            const contentEl = existing.querySelector('.note-content');
            if (document.activeElement !== contentEl) contentEl.innerHTML = newItem.data.content || '';
        } else {
            createNoteEl(newItem.data, true);
        }
    } else if (newItem.type === 'connection') {
        const idx = connections.findIndex(c => c.id === newItem.id);
        if (idx !== -1) connections[idx] = newItem.data;
        else connections.push(newItem.data);
        drawConnections();
    } else if (newItem.type === 'state') {
        calcHistory = newItem.data.calcHistory ?? calcHistory;
        if (newItem.data.budgetNote !== undefined && calcBudArea && document.activeElement !== calcBudArea) {
            calcBudArea.value = newItem.data.budgetNote;
        }
        renderHistory();
    }
}


// ─── TRANSFORM ────────────────────────────────────────────────────────────────
function applyTransform() {
    canvas.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
    canvas.style.transformOrigin = '0 0';
}
function screenToCanvas(sx, sy) {
    // canvas origin is always at (panX, panY) in screen space
    return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
}
function updateZoomLabel() {
    zoomIndicator.innerText = Math.round(zoom * 100) + '%';
}

// ─── FRAME ALL (press F) ────────────────────────────────────────────────────────────
function frameAll() {
    const notes = canvas.querySelectorAll('.note');
    if (!notes.length) return;
    // Find bounding box of all notes in canvas coords
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    notes.forEach(n => {
        const x = parseFloat(n.style.left) || 0;
        const y = parseFloat(n.style.top)  || 0;
        const w = n.offsetWidth, h = n.offsetHeight;
        if (x     < minX) minX = x;
        if (y     < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
    });
    const PAD  = 80;
    const bw   = maxX - minX + PAD * 2;
    const bh   = maxY - minY + PAD * 2;
    const newZ = Math.min(window.innerWidth / bw, window.innerHeight / bh, 2);
    // Animate to new pan/zoom
    const targetPanX = window.innerWidth  / 2 - (minX - PAD + bw / 2) * newZ;
    const targetPanY = window.innerHeight / 2 - (minY - PAD + bh / 2) * newZ;
    // Smooth transition via CSS
    canvas.style.transition = 'transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
    panX = targetPanX; panY = targetPanY; zoom = newZ;
    applyTransform();
    updateZoomLabel();
    setTimeout(() => { canvas.style.transition = ''; drawConnections(); }, 580);
    triggerSave();
}

// ─── SYNC ─────────────────────────────────────────────────────────────────────
function syncState() {
    if(!currentRoom) return;
    clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(() => {
        supabaseClient.from('canvas_items').upsert({
            id: 'state_' + currentRoom, room_id: currentRoom, type: 'state',
            data: { panX, panY, zoom, highestZ, calcHistory, budgetNote: calcBudArea?.value || '' }
        }).then();
    }, 500);
}
function syncNote(noteEl) {
    if(!currentRoom) return;
    const id = noteEl.dataset.id;
    const data = {
        id, x: parseFloat(noteEl.style.left) || 0, y: parseFloat(noteEl.style.top) || 0,
        width: noteEl.style.width, height: noteEl.style.height,
        content: noteEl.querySelector('.note-content').innerHTML,
        color: noteEl.dataset.color || 'default', zIndex: parseInt(noteEl.style.zIndex) || 10,
        isImage: noteEl.classList.contains('image-note')
    };
    supabaseClient.from('canvas_items').upsert({ id, room_id: currentRoom, type: 'note', data }).then();
}
function syncConnection(conn) {
    if(!currentRoom) return;
    supabaseClient.from('canvas_items').upsert({ id: conn.id, room_id: currentRoom, type: 'connection', data: conn }).then();
}
function deleteSync(type, id) {
    if(!currentRoom) return;
    supabaseClient.from('canvas_items').delete().eq('id', id).then();
}
window.triggerSave = syncState; // Legacy alias fallback
// ─── EDGE ANCHOR MATH ─────────────────────────────────────────────────────────
// Returns the point on the note's border closest to (cmx,cmy) in canvas-space
function getEdgeAnchor(noteEl, cmx, cmy) {
    const nx = parseFloat(noteEl.style.left) || 0;
    const ny = parseFloat(noteEl.style.top)  || 0;
    const nw = noteEl.offsetWidth, nh = noteEl.offsetHeight;
    const cx = nx + nw / 2, cy = ny + nh / 2;
    const dx = cmx - cx, dy = cmy - cy;
    if (dx === 0 && dy === 0) return { side:'bottom', x:cx, y:ny+nh };
    const diag = Math.atan2(nh / 2, nw / 2);
    const ang  = Math.atan2(Math.abs(dy), Math.abs(dx));
    let side, ax, ay;
    if (ang <= diag) {
        side = dx >= 0 ? 'right' : 'left';
        ax   = dx >= 0 ? nx + nw : nx;
        ay   = Math.max(ny+8, Math.min(ny+nh-8, cy + dy*(nw/2)/Math.abs(dx)));
    } else {
        side = dy >= 0 ? 'bottom' : 'top';
        ay   = dy >= 0 ? ny + nh : ny;
        ax   = Math.max(nx+8, Math.min(nx+nw-8, cx + dx*(nh/2)/Math.abs(dy)));
    }
    return { side, x:ax, y:ay };
}

// ─── BEZIER PATH ─────────────────────────────────────────────────────────────
const DIR = { right:[1,0], left:[-1,0], bottom:[0,1], top:[0,-1] };
function buildPath(a1, a2, waypoints) {
    const [d1x,d1y] = DIR[a1.side] || [0,1];
    const [d2x,d2y] = DIR[a2.side] || [0,-1];
    const dist = Math.hypot(a2.x-a1.x, a2.y-a1.y);
    const ctrl = Math.max(80, dist * 0.38);
    if (!waypoints || !waypoints.length) {
        return `M${a1.x} ${a1.y} C${a1.x+d1x*ctrl} ${a1.y+d1y*ctrl},${a2.x+d2x*ctrl} ${a2.y+d2y*ctrl},${a2.x} ${a2.y}`;
    }
    // Route through waypoints
    const pts = [{...a1}, ...waypoints, {...a2}];
    let d = `M${a1.x} ${a1.y}`;
    const c1x=a1.x+d1x*ctrl, c1y=a1.y+d1y*ctrl;
    const c2x=a2.x+d2x*ctrl, c2y=a2.y+d2y*ctrl;
    d += ` C${c1x} ${c1y},${waypoints[0].x} ${waypoints[0].y},${waypoints[0].x} ${waypoints[0].y}`;
    for (let i=0;i<waypoints.length-1;i++) {
        const mid = {x:(waypoints[i].x+waypoints[i+1].x)/2, y:(waypoints[i].y+waypoints[i+1].y)/2};
        d += ` S${waypoints[i+1].x} ${waypoints[i+1].y},${mid.x} ${mid.y}`;
    }
    if (waypoints.length>1) {
        const last=waypoints[waypoints.length-1];
        d += ` S${c2x} ${c2y},${a2.x} ${a2.y}`;
    } else {
        d += ` S${c2x} ${c2y},${a2.x} ${a2.y}`;
    }
    return d;
}

// ─── DRAW CONNECTIONS ─────────────────────────────────────────────────────────
function drawConnections() {
    // Keep defs, remove all paths/circles
    const defs = connLayer.querySelector('defs');
    connLayer.innerHTML = '';
    if (defs) connLayer.appendChild(defs);

    connections.forEach(conn => {
        const fromEl = canvas.querySelector(`.note[data-id="${conn.from}"]`);
        const toEl   = canvas.querySelector(`.note[data-id="${conn.to}"]`);
        if (!fromEl || !toEl) return;

        // Recompute anchors from stored side + current rect (handles resize/move)
        const fa = getEdgeAnchor(fromEl, conn.fromAnchor.x, conn.fromAnchor.y);
        const ta = getEdgeAnchor(toEl,   conn.toAnchor.x,   conn.toAnchor.y);

        const path = document.createElementNS('http://www.w3.org/2000/svg','path');
        path.classList.add('connection-path');
        path.setAttribute('d', buildPath(fa, ta, conn.waypoints));
        path.setAttribute('marker-end','url(#arrowhead)');
        path.style.pointerEvents = 'painted';
        path.style.cursor = 'pointer';

        // Ctrl+click wire → add waypoint pin
        path.addEventListener('click', e => {
            if (!ctrlHeld) return;
            e.stopPropagation();
            const cp = screenToCanvas(e.clientX, e.clientY);
            conn.waypoints = conn.waypoints || [];
            conn.waypoints.push({x:cp.x, y:cp.y});
            drawConnections();
            triggerSave();
        });
        // Dbl-click wire → delete connection
        path.addEventListener('dblclick', e => {
            if (ctrlHeld) return;
            e.stopPropagation();
            connections = connections.filter(c => c.id !== conn.id);
            drawConnections();
            deleteSync('connection', conn.id);
        });
        // Right-click wire → context menu
        path.addEventListener('contextmenu', e => {
            e.preventDefault(); e.stopPropagation();
            const cp = screenToCanvas(e.clientX, e.clientY);
            window.__showWireCtx?.(e.clientX, e.clientY, conn.id, cp.x, cp.y);
        });
        connLayer.appendChild(path);

        // Draw waypoint dots
        (conn.waypoints || []).forEach((wp, idx) => {
            const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
            circle.classList.add('waypoint-dot');
            circle.setAttribute('cx', wp.x);
            circle.setAttribute('cy', wp.y);
            circle.setAttribute('r', 6);
            circle.style.pointerEvents = 'painted';

            // Drag waypoint
            let wpDragging=false, wpStartX, wpStartY, wpOrigX, wpOrigY;
            circle.addEventListener('mousedown', ev => {
                ev.stopPropagation(); ev.preventDefault();
                wpDragging=true; wpStartX=ev.clientX; wpStartY=ev.clientY;
                wpOrigX=wp.x; wpOrigY=wp.y;
                const onMove = mv => {
                    if (!wpDragging) return;
                    const cp=screenToCanvas(mv.clientX,mv.clientY);
                    conn.waypoints[idx]={x:cp.x,y:cp.y};
                    drawConnections();
                };
                const onUp = () => {
                    wpDragging=false;
                    document.removeEventListener('mousemove',onMove);
                    document.removeEventListener('mouseup',onUp);
                    syncConnection(conn);
                };
                document.addEventListener('mousemove',onMove);
                document.addEventListener('mouseup',onUp);
            });
            // Dbl-click to delete waypoint
            circle.addEventListener('dblclick', ev => {
                ev.stopPropagation();
                conn.waypoints.splice(idx,1);
                drawConnections();
                syncConnection(conn);
            });
            // Right-click pin → context menu
            circle.addEventListener('contextmenu', ev => {
                ev.preventDefault(); ev.stopPropagation();
                window.__showPinCtx?.(ev.clientX, ev.clientY, conn.id, idx);
            });
            connLayer.appendChild(circle);
        });
    });
}

// ─── PAN ─────────────────────────────────────────────────────────────────────
function setupPan() {
    // Middle mouse OR Shift+leftclick
    viewport.addEventListener('mousedown', e => {
        const mid   = e.button === 1;
        const shift = e.button === 0 && e.shiftKey;
        if (!mid && !shift) return;
        if (mid) e.preventDefault();
        isPanning=true; panSX=e.clientX; panSY=e.clientY; panOX=panX; panOY=panY;
        document.body.classList.add('panning');
    });
    document.addEventListener('mousemove', e => {
        if (!isPanning) return;
        panX = panOX + e.clientX - panSX;
        panY = panOY + e.clientY - panSY;
        requestAnimationFrame(() => { applyTransform(); drawConnections(); });
    });
    document.addEventListener('mouseup', e => {
        if (!isPanning) return;
        isPanning=false;
        document.body.classList.remove('panning');
        triggerSave();
    });
    // Two-finger touch panm
    let tdist=0, tx=0, ty=0;
    viewport.addEventListener('touchstart', e => {
        if (e.touches.length===2) {
            tdist=Math.hypot(e.touches[1].clientX-e.touches[0].clientX, e.touches[1].clientY-e.touches[0].clientY);
            tx=(e.touches[0].clientX+e.touches[1].clientX)/2;
            ty=(e.touches[0].clientY+e.touches[1].clientY)/2;
        }
    },{passive:true});
    viewport.addEventListener('touchmove', e => {
        if (e.touches.length!==2) return;
        e.preventDefault();
        const nd=Math.hypot(e.touches[1].clientX-e.touches[0].clientX,e.touches[1].clientY-e.touches[0].clientY);
        const mx=(e.touches[0].clientX+e.touches[1].clientX)/2;
        const my=(e.touches[0].clientY+e.touches[1].clientY)/2;
        const scale=nd/tdist;
        zoom=Math.max(0.15,Math.min(4,zoom*scale));
        panX+=(mx-tx); panY+=(my-ty);
        tdist=nd; tx=mx; ty=my;
        requestAnimationFrame(()=>{applyTransform();updateZoomLabel();drawConnections();});
    },{passive:false});
    // Shift key cursor
    document.addEventListener('keydown',e=>{if(e.key==='Shift') document.body.classList.add('shift-held');});
    document.addEventListener('keyup',e=>{if(e.key==='Shift') document.body.classList.remove('shift-held');});
}

// ─── ZOOM ─────────────────────────────────────────────────────────────────────
function setupZoom() {
    viewport.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZ = Math.max(0.1, Math.min(5, zoom * factor));
        panX = e.clientX - (e.clientX - panX) * (newZ / zoom);
        panY = e.clientY - (e.clientY - panY) * (newZ / zoom);
        zoom = newZ;
        requestAnimationFrame(()=>{ applyTransform(); updateZoomLabel(); drawConnections(); });
        triggerSave();
    },{passive:false});
}

// ─── GLOBAL EVENTS ────────────────────────────────────────────────────────────
function setupGlobal() {
    // Dbl-click on empty canvas → new note
    canvas.addEventListener('dblclick', e => {
        if (e.target !== canvas && e.target.id !== 'connection-layer') return;
        const p = screenToCanvas(e.clientX, e.clientY);
        createNewNote('', p.x-150, p.y-125);
    });
    // Paste
    document.addEventListener('paste', e => {
        const active = document.activeElement;
        if (active?.classList.contains('note-content') || active?.id==='calc-budgetArea') return;
        e.preventDefault();
        const items = [...(e.clipboardData?.items||[])];
        let handled=false;
        for (const item of items) {
            if (item.kind==='file' && item.type.startsWith('image/')) {
                const blob=item.getAsFile(); const reader=new FileReader();
                reader.onload=ev=>{
                    const p=screenToCanvas(window.innerWidth/2,window.innerHeight/2);
                    const id=createNewNote(`<img src="${ev.target.result}"/>`,p.x-150,p.y-125);
                    const el=canvas.querySelector(`.note[data-id="${id}"]`);
                    if(el) el.classList.add('image-note');
                };
                reader.readAsDataURL(blob); handled=true; break;
            }
        }
        if (!handled) {
            for (const item of items) {
                if (item.kind==='string' && item.type==='text/plain') {
                    item.getAsString(text=>{
                        const p=screenToCanvas(window.innerWidth/2,window.innerHeight/2);
                        createNewNote(text.replace(/\n/g,'<br>'),p.x-150,p.y-125);
                    }); break;
                }
            }
        }
    });
    // Ctrl + F key tracking
    document.addEventListener('keydown', e => {
        if (e.key === 'Control') { ctrlHeld = true; document.body.classList.add('ctrl-mode'); }
        // F = Frame All (only when not typing)
        if (e.key === 'f' || e.key === 'F') {
            const active = document.activeElement;
            if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA' && !active.isContentEditable)) {
                e.preventDefault();
                frameAll();
            }
        }
    });
    document.addEventListener('keyup', e => {
        if (e.key === 'Control') { ctrlHeld = false; if (!isDrawingWire) document.body.classList.remove('ctrl-mode'); }
    });
    // Wire move/up
    document.addEventListener('mousemove', onWireMove);
    document.addEventListener('mouseup', onWireUp);
    // Click outside color picker
    document.addEventListener('click', e=>{
        if(!e.target.closest('.color-picker')&&!e.target.closest('.color-btn'))
            document.querySelectorAll('.color-picker').forEach(p=>p.classList.add('hidden'));
    });
}

// ─── WIRE DRAWING ─────────────────────────────────────────────────────────────
function onWireMove(e) {
    if (!isDrawingWire || !tempWire) return;
    const cp=screenToCanvas(e.clientX, e.clientY);
    tempWire.setAttribute('d', buildPath(wireFromAnchor,{side:'top',x:cp.x,y:cp.y},[]));
    // Highlight potential target
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.note');
    canvas.querySelectorAll('.note.wire-target').forEach(n=>n.classList.remove('wire-target'));
    if (el && el.dataset.id!==wireFromId) el.classList.add('wire-target');
}
function onWireUp(e) {
    if (!isDrawingWire) return;
    isDrawingWire=false;
    if(!ctrlHeld) document.body.classList.remove('ctrl-mode');
    tempWire?.remove(); tempWire=null;
    canvas.querySelectorAll('.note.wire-target').forEach(n=>n.classList.remove('wire-target'));
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.note');
    if (target && target.dataset.id!==wireFromId) {
        const cp=screenToCanvas(e.clientX,e.clientY);
        const toAnchor=getEdgeAnchor(target,cp.x,cp.y);
        const dup=connections.find(c=>c.from===wireFromId&&c.to===target.dataset.id);
        if (!dup) {
            connections.push({id:'c'+Date.now(),from:wireFromId,fromAnchor:wireFromAnchor,to:target.dataset.id,toAnchor,waypoints:[]});
            drawConnections(); syncConnection(conn);
        }
    }
}

// ─── NOTE CREATION ────────────────────────────────────────────────────────────
function createNewNote(content='', x=300, y=300) {
    const id='n'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
    createNoteEl({id,x,y,width:'',height:'',content,color:'default',zIndex:++highestZ,isImage:false});
    return id;
}
function createNoteEl(data, skipSync=false) {
    const clone=noteTemplate.content.cloneNode(true);
    const el=clone.querySelector('.note');
    el.dataset.id=data.id;
    el.style.cssText=`left:${data.x}px;top:${data.y}px;z-index:${data.zIndex};`;
    if(data.width) el.style.width=data.width;
    if(data.height) el.style.height=data.height;
    if(data.color){el.dataset.color=data.color; el.style.background=`var(--note-${data.color})`; }
    if(data.isImage) el.classList.add('image-note');
    el.querySelector('.note-content').innerHTML=data.content||'';
    setupNoteEvents(el);
    setupDragResize(el);
    canvas.appendChild(el);
    if(!skipSync) syncNote(el);
}

// ─── NOTE EVENTS ─────────────────────────────────────────────────────────────
function setupNoteEvents(el) {
    const content  = el.querySelector('.note-content');
    const delBtn   = el.querySelector('.delete-btn');
    const colorBtn = el.querySelector('.color-btn');
    const picker   = el.querySelector('.color-picker');

    content.addEventListener('input', () => syncNote(el));
    content.addEventListener('blur', () => syncNote(el));

    delBtn.addEventListener('click', ()=>{
        el.style.cssText+=';transition:all 0.2s;transform:scale(0.8);opacity:0';
        setTimeout(()=>{
            const id=el.dataset.id;
            connections=connections.filter(c=>c.from!==id&&c.to!==id);
            drawConnections(); el.remove(); deleteSync('note', id);
        },210);
    });

    colorBtn.addEventListener('click', e=>{
        e.stopPropagation(); picker.classList.toggle('hidden'); el.style.zIndex=++highestZ;
    });
    el.querySelectorAll('.color-swatch').forEach(sw=>sw.addEventListener('click',e=>{
        e.stopPropagation();
        const c=sw.dataset.color; el.dataset.color=c;
        el.style.background=`var(--note-${c})`; picker.classList.add('hidden'); syncNote(el);
    }));

    el.addEventListener('mousedown', e=>{
        el.style.zIndex=++highestZ;
        // Ctrl + mousedown (not on content or action buttons) → start wire
        if (ctrlHeld && !e.target.closest('.note-actions') && e.target!==content && !content.contains(e.target)) {
            e.preventDefault(); e.stopPropagation();
            const cp=screenToCanvas(e.clientX,e.clientY);
            wireFromId=el.dataset.id;
            wireFromAnchor=getEdgeAnchor(el,cp.x,cp.y);
            isDrawingWire=true;
            tempWire=document.createElementNS('http://www.w3.org/2000/svg','path');
            tempWire.classList.add('connection-path','wire-temp');
            connLayer.appendChild(tempWire);
        }
    });
}

// ─── DRAG & RESIZE ────────────────────────────────────────────────────────────
function setupDragResize(el) {
    const header=el.querySelector('.note-header');
    const resizer=el.querySelector('.note-resize-handle');
    let dragging=false, resizing=false;
    let sx,sy,il,it,iw,ih;

    function startDrag(e) {
        if(e.target.closest('.note-actions')) return;
        if(isPanning||isDrawingWire||ctrlHeld) return;
        dragging=true; el.classList.add('dragging'); el.style.zIndex=++highestZ;
        sx=e.touches?.[0]?.clientX??e.clientX; sy=e.touches?.[0]?.clientY??e.clientY;
        il=parseFloat(el.style.left)||0; it=parseFloat(el.style.top)||0;
        document.addEventListener('mousemove',doDrag); document.addEventListener('mouseup',endDrag);
        document.addEventListener('touchmove',doDrag,{passive:false}); document.addEventListener('touchend',endDrag);
    }
    function doDrag(e) {
        if(!dragging) return; e.preventDefault();
        const cx=e.touches?.[0]?.clientX??e.clientX, cy=e.touches?.[0]?.clientY??e.clientY;
        requestAnimationFrame(()=>{
            el.style.left=(il+(cx-sx)/zoom)+'px'; el.style.top=(it+(cy-sy)/zoom)+'px';
            drawConnections();
        });
    }
    function endDrag() {
        dragging=false; el.classList.remove('dragging');
        document.removeEventListener('mousemove',doDrag); document.removeEventListener('mouseup',endDrag);
        document.removeEventListener('touchmove',doDrag); document.removeEventListener('touchend',endDrag);
        syncNote(el);
    }
    header.addEventListener('mousedown',startDrag);
    header.addEventListener('touchstart',startDrag,{passive:false});

    function startResize(e) {
        e.stopPropagation(); resizing=true; el.style.zIndex=++highestZ;
        sx=e.touches?.[0]?.clientX??e.clientX; sy=e.touches?.[0]?.clientY??e.clientY;
        iw=el.offsetWidth; ih=el.offsetHeight;
        document.addEventListener('mousemove',doResize); document.addEventListener('mouseup',endResize);
        document.addEventListener('touchmove',doResize,{passive:false}); document.addEventListener('touchend',endResize);
    }
    function doResize(e) {
        if(!resizing) return; e.preventDefault();
        const cx=e.touches?.[0]?.clientX??e.clientX, cy=e.touches?.[0]?.clientY??e.clientY;
        requestAnimationFrame(()=>{
            el.style.width=Math.max(200,iw+(cx-sx)/zoom)+'px';
            el.style.height=Math.max(150,ih+(cy-sy)/zoom)+'px';
            drawConnections();
        });
    }
    function endResize() {
        resizing=false;
        document.removeEventListener('mousemove',doResize); document.removeEventListener('mouseup',endResize);
        document.removeEventListener('touchmove',doResize); document.removeEventListener('touchend',endResize);
        syncNote(el);
    }
    resizer.addEventListener('mousedown',startResize);
    resizer.addEventListener('touchstart',startResize,{passive:false});
}

// ─── CALCULATOR ───────────────────────────────────────────────────────────────
function setupCalc() {
    // Apple-style spring open/close
    function openCalc() {
        calcWidget.classList.remove('hidden');
        calcWidget.style.zIndex = ++highestZ;
        // Animate from button position (bottom-right)
        calcWidget.style.transformOrigin = 'bottom right';
        calcWidget.classList.add('calc-opening');
        setTimeout(() => calcWidget.classList.remove('calc-opening'), 400);
    }
    function closeCalc() {
        calcWidget.classList.add('calc-closing');
        setTimeout(() => {
            calcWidget.classList.add('hidden');
            calcWidget.classList.remove('calc-closing');
        }, 280);
    }
    calcToggleBtn.addEventListener('click', () => {
        calcWidget.classList.contains('hidden') ? openCalc() : closeCalc();
    });
    calcCloseBtn.addEventListener('click', closeCalc);

    // Budget panel toggle
    calcBudgetBtn.addEventListener('click',()=>{
        calcBudPanel.classList.toggle('hidden');
        if(!calcBudPanel.classList.contains('hidden')) calcHistPanel.classList.add('hidden');
    });
    // History panel toggle
    calcHistBtn.addEventListener('click',()=>{
        calcHistPanel.classList.toggle('hidden');
        if(!calcHistPanel.classList.contains('hidden')) calcBudPanel.classList.add('hidden');
    });
    calcClearBtn.addEventListener('click',()=>{ calcHistory=[]; renderHistory(); triggerSave(); });

    // Budget auto-save
    calcBudArea?.addEventListener('input',()=>{ syncState(); });

    // Copy buttons
    copyResultBtn?.addEventListener('click',()=>{
        navigator.clipboard.writeText(calcCurrent).then(()=>{ flashBtn(copyResultBtn,'Copied!'); });
    });
    copyBudBtn?.addEventListener('click',()=>{
        navigator.clipboard.writeText(calcBudArea?.value||'').then(()=>{ flashBtn(copyBudBtn,'Copied!'); });
    });

    // Drag calculator
    let cd=false, csx,csy,cox,coy;
    calcHeader.addEventListener('mousedown',e=>{
        if(e.target.closest('.calc-header-actions')) return;
        cd=true; csx=e.clientX; csy=e.clientY;
        const rect=calcWidget.getBoundingClientRect();
        cox=rect.left; coy=rect.top;
        calcWidget.style.right='auto'; calcWidget.style.left=cox+'px'; calcWidget.style.top=coy+'px';
        document.addEventListener('mousemove',cDrag); document.addEventListener('mouseup',cEnd);
    });
    function cDrag(e) {
        if(!cd) return;
        calcWidget.style.left=(cox+e.clientX-csx)+'px';
        calcWidget.style.top=(coy+e.clientY-csy)+'px';
    }
    function cEnd(){ cd=false; document.removeEventListener('mousemove',cDrag); document.removeEventListener('mouseup',cEnd); }
    calcWidget.addEventListener('mousedown',()=>calcWidget.style.zIndex=++highestZ);

    // Math engine
    function updateDisplay() {
        calcExpr.innerText = calcFull;
        let dv=calcCurrent; if(dv.length>12) dv=Number(dv).toPrecision(10);
        calcDisp.innerText = dv;
        // Live preview
        if (calcFull && !calcReset && !calcFull.includes('=')) {
            const r=safeEval(calcFull+(calcCurrent==='Error'?'':calcCurrent));
            calcPrev.innerText = (r!=='Error'&&r.toString()!==calcCurrent) ? '= '+r : '';
        } else { calcPrev.innerText=''; }
    }
    function safeEval(expr) {
        try {
            const s=expr.replace(/×/g,'*').replace(/÷/g,'/').replace(/−/g,'-');
            if(/[^0-9\+\-\*\/\.\(\) ]/.test(s)) return 'Error';
            const r=Function('"use strict";return('+s+')')();
            return Number.isFinite(r)?Math.round(r*1e6)/1e6:'Error';
        } catch(e){ return 'Error'; }
    }
    function calcInput(val, type) {
        if (type==='num') {
            if(calcReset){
                calcCurrent=(val==='.'?'0.':val);
                if(calcFull.includes('=')) calcFull='';
                calcReset=false;
            } else {
                if(calcCurrent==='0'||calcCurrent==='Error') calcCurrent=(val==='.'?'0.':val);
                else { if(val==='.'&&calcCurrent.includes('.')) return; calcCurrent+=val; }
            }
        } else if(type==='op') {
            const v = val==='−'?'-':val;
            if(calcFull.includes('=')){calcFull=calcCurrent+` ${v} `;}
            else if(!calcReset){calcFull+=calcCurrent+` ${v} `;}
            else if(calcFull.length>0){calcFull=calcFull.slice(0,-3)+` ${v} `;}
            calcReset=true;
        } else if(type==='clear'){ calcCurrent='0'; calcFull=''; calcReset=false; }
        else if(type==='del'){ if(!calcReset&&calcCurrent!=='Error') calcCurrent=calcCurrent.length>1?calcCurrent.slice(0,-1):'0'; }
        else if(type==='eq') {
            if(calcFull.includes('=')) return;
            const eq=calcFull+calcCurrent;
            const res=safeEval(eq);
            if(res!=='Error'){ calcHistory.push({eq,res}); if(calcHistory.length>25) calcHistory.shift(); renderHistory(); }
            calcFull=eq+' ='; calcCurrent=String(res); calcReset=true;
            triggerSave();
        }
        updateDisplay();
    }

    calcBtns.forEach(btn=>btn.addEventListener('click',()=>{
        let type='num';
        if(btn.classList.contains('act-clear')) type='clear';
        else if(btn.classList.contains('act-del')) type='del';
        else if(btn.classList.contains('act-op')) type='op';
        else if(btn.classList.contains('act-equal')) type='eq';
        let val=btn.dataset.val||btn.innerText;
        const a=btn.dataset.action;
        if(a==='multiply') val='×'; if(a==='divide') val='÷';
        if(a==='subtract') val='−'; if(a==='add') val='+';
        calcInput(val, type);
    }));

    document.addEventListener('keydown',e=>{
        if(calcWidget.classList.contains('hidden')) return;
        if(document.activeElement?.classList.contains('note-content')) return;
        if(document.activeElement?.id==='calc-budgetArea') return;
        const k=e.key;
        if(/^[0-9\.]$/.test(k)) calcInput(k,'num');
        else if(k==='+') calcInput('+','op');
        else if(k==='-') calcInput('−','op');
        else if(k==='*') calcInput('×','op');
        else if(k==='/'){e.preventDefault();calcInput('÷','op');}
        else if(k==='Enter'||k==='='){e.preventDefault();calcInput('=','eq');}
        else if(k==='Backspace') calcInput('','del');
        else if(k==='Escape') calcInput('','clear');
    });

    renderHistory();
}

function renderHistory() {
    calcHistList.innerHTML='';
    [...calcHistory].reverse().forEach(item=>{
        const d=document.createElement('div'); d.className='calc-history-item';
        d.innerHTML=`<span style="color:var(--text-dim)">${item.eq}</span> <strong>= ${item.res}</strong>`;
        d.addEventListener('click',()=>{
            calcFull=item.eq+' ='; calcCurrent=String(item.res); calcReset=true;
            calcExpr.innerText=calcFull; calcDisp.innerText=calcCurrent; calcPrev.innerText='';
        });
        calcHistList.appendChild(d);
    });
}

function flashBtn(btn, msg) {
    const orig=btn.innerHTML;
    btn.innerHTML=`<i class="ph ph-check"></i> ${msg}`;
    setTimeout(()=>btn.innerHTML=orig, 1500);
}

// ─── EXPORT PDF ───────────────────────────────────────────────────────────────
function setupExport() {
    exportBtn?.addEventListener('click', async ()=>{
        exportBtn.innerHTML='<i class="ph ph-circle-notch" style="animation:spin 1s linear infinite"></i>';
        exportBtn.disabled=true;
        try {
            const uiOverlay=document.getElementById('ui-overlay');
            const cw=calcWidget; const cwHid=cw.classList.contains('hidden');
            uiOverlay.style.display='none'; cw.style.display='none';
            const shot=await html2canvas(canvas,{backgroundColor:'#0b0c10',scale:1.5,useCORS:true,logging:false});
            uiOverlay.style.display=''; cw.style.display='';
            if(!cwHid) cw.classList.remove('hidden');
            const {jsPDF}=window.jspdf;
            const img=shot.toDataURL('image/png');
            const iw=shot.width, ih=shot.height;
            const pw=297, ph=Math.round((ih/iw)*pw);
            const pdf=new jsPDF({orientation:ph>pw?'p':'l',unit:'mm',format:[pw,ph]});
            pdf.addImage(img,'PNG',0,0,pw,ph);
            pdf.save(`canvas-${new Date().toISOString().slice(0,10)}.pdf`);
        } catch(err){ console.error(err); alert('Export failed. Please try again.'); }
        finally {
            exportBtn.innerHTML='<i class="ph ph-download-simple"></i>';
            exportBtn.disabled=false;
        }
    });
}

}); // end DOMContentLoaded

// ─── CONTEXT MENU ─────────────────────────────────────────────────────────────
(function setupContextMenu() {
    const menu     = document.getElementById('ctx-menu');
    const ctxTitle = document.getElementById('ctx-title');
    const ctxEdit  = document.getElementById('ctx-edit');
    const ctxColor = document.getElementById('ctx-color');
    const ctxPin   = document.getElementById('ctx-add-pin');
    const ctxDel   = document.getElementById('ctx-delete');

    let ctxTarget = null; // { type: 'note'|'wire'|'pin', ref, connId?, wpIdx?, clickX?, clickY? }

    function showMenu(x, y, type, ref) {
        ctxTarget = ref;
        // Reset all items first
        ctxEdit.style.display  = 'flex';
        ctxColor.style.display = 'flex';
        ctxPin.style.display   = 'flex';
        ctxDel.style.display   = 'flex';

        if (type === 'note') {
            ctxTitle.textContent = 'Note Options';
            ctxPin.style.display = 'none';
            ctxDel.querySelector('i').className = 'ph ph-trash';
            ctxDel.childNodes[1].textContent = ' Delete Note';
        } else if (type === 'wire') {
            ctxTitle.textContent = 'Wire Options';
            ctxEdit.style.display  = 'none';
            ctxColor.style.display = 'none';
            ctxPin.textContent = '';
            ctxPin.innerHTML = '<i class="ph ph-push-pin"></i> Add Pin Here';
            ctxDel.innerHTML = '<i class="ph ph-trash"></i> Delete Wire';
        } else if (type === 'pin') {
            ctxTitle.textContent = 'Pin Options';
            ctxEdit.style.display  = 'none';
            ctxColor.style.display = 'none';
            ctxPin.style.display = 'none';
            ctxDel.innerHTML = '<i class="ph ph-trash"></i> Delete Pin';
        }

        // Keep menu on screen
        menu.classList.remove('hidden');
        // Force reflow to get correct dimensions
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        const safeX = Math.min(x, window.innerWidth  - mw - 8);
        const safeY = Math.min(y, window.innerHeight - mh - 8);
        menu.style.left = safeX + 'px';
        menu.style.top  = safeY + 'px';
        // Re-trigger animation
        menu.style.animation = 'none';
        requestAnimationFrame(() => { menu.style.animation = ''; });
    }

    function hideMenu() {
        menu.classList.add('hidden');
        ctxTarget = null;
    }

    // Hide on outside click / scroll / Escape
    document.addEventListener('click',  e => { if (!menu.contains(e.target)) hideMenu(); });
    document.addEventListener('wheel',  ()  => hideMenu(), { passive: true });
    document.addEventListener('keydown', e  => { if (e.key === 'Escape') hideMenu(); });

    // ── Note right-click ────────────────────────────────────────────────────
    // We use event delegation on the canvas for note right-clicks
    document.getElementById('canvas').addEventListener('contextmenu', e => {
        const noteEl = e.target.closest('.note');
        if (!noteEl) return;
        e.preventDefault();
        showMenu(e.clientX, e.clientY, 'note', { type:'note', el: noteEl });
    });

    // ── Wire / pin clicks are attached inside drawConnections() ─────────────
    // We expose a global so drawConnections can call it
    window.__showWireCtx = (x, y, connId, clickX, clickY) => {
        showMenu(x, y, 'wire', { type:'wire', connId, clickX, clickY });
    };
    window.__showPinCtx = (x, y, connId, wpIdx) => {
        showMenu(x, y, 'pin', { type:'pin', connId, wpIdx });
    };

    // ── Actions ─────────────────────────────────────────────────────────────
    ctxEdit.addEventListener('click', () => {
        if (!ctxTarget || ctxTarget.type !== 'note') return;
        hideMenu();
        const contentEl = ctxTarget.el.querySelector('.note-content');
        contentEl.focus();
        // Move cursor to end
        const range = document.createRange();
        range.selectNodeContents(contentEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
    });

    ctxColor.addEventListener('click', () => {
        if (!ctxTarget || ctxTarget.type !== 'note') return;
        hideMenu();
        const picker = ctxTarget.el.querySelector('.color-picker');
        picker.classList.toggle('hidden');
    });

    ctxPin.addEventListener('click', () => {
        if (!ctxTarget || ctxTarget.type !== 'wire') return;
        const { connId, clickX, clickY } = ctxTarget;
        hideMenu();
        window.__addWaypoint?.(connId, clickX, clickY);
    });

    ctxDel.addEventListener('click', () => {
        if (!ctxTarget) return;
        const t = ctxTarget;
        hideMenu();
        if (t.type === 'note') {
            const btn = t.el.querySelector('.delete-btn');
            btn?.click();
        } else if (t.type === 'wire') {
            window.__deleteConnection?.(t.connId);
        } else if (t.type === 'pin') {
            window.__deleteWaypoint?.(t.connId, t.wpIdx);
        }
    });
}());
