/**
 * Hybrid Real-Time Sync Engine (WebSocket Push + BroadcastChannel + GAS Fallback)
 * - Persistent Node.js WebSocket Server (wss://): <50ms cross-device delta push & global "● N Live" badge.
 * - BroadcastChannel + storage event: 0ms same-browser cross-tab sync (works on GitHub Pages too).
 * - Automatic lightweight GAS fallback (getSyncState): pauses while WS is open; engages seamlessly when WS is offline/unset.
 */
(function () {
    if (window.LiveSync) return;

    const CHANNEL_NAME = 'myg_live_sync_v1';
    const STORAGE_EVENT_KEY = 'myg_live_sync_event';
    const COLLAB_TAB_ID_KEY = 'myg_collab_tab_id';
    const COLLAB_WIN_NAME_PREFIX = 'myg_tab:';

    const ACTIVE_FALLBACK_MS = 2500;
    const IDLE_FALLBACK_MS = 5000;
    const IDLE_THRESHOLD_MS = 90000;
    const MAX_BACKOFF_MS = 8000;

    // Persist per-tab clientId across refreshes (echo suppression + duplicate-tab eviction)
    let storedClientId = '';
    try {
        storedClientId = sessionStorage.getItem(COLLAB_TAB_ID_KEY) || '';
        if (!storedClientId && typeof window.name === 'string' && window.name.startsWith(COLLAB_WIN_NAME_PREFIX)) {
            storedClientId = window.name.slice(COLLAB_WIN_NAME_PREFIX.length);
        }
        if (!storedClientId) {
            storedClientId = 'c_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
        }
        sessionStorage.setItem(COLLAB_TAB_ID_KEY, storedClientId);
        if (!window.name || window.name.startsWith(COLLAB_WIN_NAME_PREFIX)) {
            window.name = COLLAB_WIN_NAME_PREFIX + storedClientId;
        }
    } catch (e) {
        storedClientId = 'c_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
    }

    window.collabClientId = storedClientId;
    window.CLIENT_ID = storedClientId;

    const collabState = {
        connected: false,
        mode: 'idle', // 'ws' | 'fallback' | 'idle'
        ws: null,
        reconnectDelay: 1000,
        reconnectTimer: null,
        pingInterval: null,
        view: 'index',
        sheetUrl: null,
        label: 'Home',
        activeItem: null,
        onlineCount: 1,
        totalOnline: 1,
        sheetOnline: 1,
        adminOnline: 0,
        sheetUsers: [],
        remoteFocusMap: new Map(),
        listeners: {},
        pendingWsQueue: [],
        hasConnectedOnce: false,
        intentionalClose: false,
        hasSentLeave: false
    };
    window.collabState = collabState;

    // Fallback GAS polling state (used ONLY when WS is unavailable or disconnected)
    let fallbackTimer = null;
    let fallbackInFlight = false;
    let lastSeq = 0;
    let hasBaseline = false;
    let consecutiveErrors = 0;
    let lastUserActivityAt = Date.now();
    let syncStateEndpointSupported = true;

    let channel = null;

    function detectInitialContext() {
        const path = (window.location.pathname || '').toLowerCase();
        const params = new URLSearchParams(window.location.search);
        const urlParam = params.get('url') || null;

        let view = 'index';
        let label = 'Home';
        if (path.includes('tracker')) { view = 'tracker'; label = 'Live Tracker'; }
        else if (path.includes('pairing')) { view = 'pairing'; label = 'Manual Pairing'; }
        else if (path.includes('grouping')) { view = 'grouping'; label = 'Manual Grouping'; }
        else if (path.includes('admin')) { view = 'admin'; label = 'Comm Dashboard'; }
        else if (path.includes('volunteer')) { view = 'volunteer'; label = 'Attendance Form'; }
        else if (path.includes('settings')) { view = 'settings'; label = 'Settings'; }

        collabState.view = view;
        if (urlParam && !collabState.sheetUrl) collabState.sheetUrl = urlParam;
        collabState.label = label;
    }

    function getAdminKeySafe() {
        try {
            return localStorage.getItem('adminKey') || '';
        } catch (e) {
            return '';
        }
    }

    function isOwnClient(id) {
        if (!id) return false;
        return id === storedClientId || id === window.collabClientId;
    }

    function markActivity() {
        const wasIdle = Date.now() - lastUserActivityAt > IDLE_THRESHOLD_MS;
        lastUserActivityAt = Date.now();
        if (wasIdle && !document.hidden && !collabState.connected) {
            scheduleFallbackPoll(400);
        }
    }

    // Track ONLY explicit user interaction — NEVER passive scroll events
    ['pointerdown', 'keydown', 'touchstart'].forEach(evt => {
        window.addEventListener(evt, markActivity, { passive: true, capture: true });
    });

    function emitLocal(type, payload) {
        const handlers = collabState.listeners[type];
        if (handlers && handlers.length > 0) {
            handlers.forEach(fn => {
                try { fn(payload); } catch (e) { console.error(`[LiveSync Handler Error: ${type}]`, e); }
            });
        }
    }

    function handleIncoming(msg) {
        if (!msg || typeof msg !== 'object' || !msg.type) return;
        if (msg.senderId && isOwnClient(msg.senderId) && !msg.forceApply) return;
        if (msg.clientId && isOwnClient(msg.clientId) && !msg.forceApply && msg.type !== 'presence:ack') return;

        if (typeof msg.syncSeq === 'number' && msg.syncSeq > lastSeq) {
            lastSeq = msg.syncSeq;
        }

        if (msg.type === 'pong') return;

        if (msg.type === 'presence:ack') {
            if (typeof msg.syncSeq === 'number' && msg.syncSeq > lastSeq) {
                lastSeq = msg.syncSeq;
                hasBaseline = true;
            }
            return;
        }

        if (msg.type === 'presence:state') {
            const total = Math.max(1, Number(msg.totalOnline) || 1);
            collabState.totalOnline = total;
            collabState.sheetOnline = Math.max(1, Number(msg.sheetOnline) || 1);
            collabState.onlineCount = total; // Count across ALL views per requirements
            collabState.adminOnline = Number(msg.adminOnline) || 0;
            collabState.sheetUsers = Array.isArray(msg.users) ? msg.users : [];
            updatePresencePill();
            emitLocal('presence:state', msg);
            return;
        }

        if (msg.type === 'auth:error') {
            if (typeof window.showToast === 'function') {
                window.showToast(msg.message || 'Admin authentication required.', 'error');
            }
            return;
        }

        emitLocal(msg.type, msg);
    }

    // Same-browser BroadcastChannel + storage fallback (0ms cross-tab sync)
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            channel = new BroadcastChannel(CHANNEL_NAME);
            channel.onmessage = (event) => handleIncoming(event.data);
        } catch (e) {
            channel = null;
        }
    }

    window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_EVENT_KEY || !event.newValue) return;
        try {
            handleIncoming(JSON.parse(event.newValue));
        } catch (e) {}
    });

    function broadcastSameBrowser(msg) {
        const payload = Object.assign({}, msg, {
            senderId: msg.senderId || storedClientId,
            clientId: msg.clientId || storedClientId,
            ts: msg.ts || Date.now()
        });
        if (channel) {
            try { channel.postMessage(payload); } catch (e) {}
        }
        try {
            localStorage.setItem(STORAGE_EVENT_KEY, JSON.stringify(payload));
        } catch (e) {}
    }

    // =========================================================
    // LIVE PRESENCE HEADER PILL ("● N Live") — Responsive Desktop & 390px Mobile
    // =========================================================
    function ensurePresencePill() {
        if (typeof document === 'undefined') return null;
        let badge = document.getElementById('collabPresenceBadge');
        if (badge) return badge;
        const refreshBtn = document.querySelector('button[onclick="refreshApp()"]');
        if (!refreshBtn || !refreshBtn.parentElement) return null;

        badge = document.createElement('div');
        badge.id = 'collabPresenceBadge';
        badge.setAttribute('aria-live', 'polite');
        badge.innerHTML = `<span id="collabPresenceDot" class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></span><span id="collabPresenceText">Live</span>`;
        refreshBtn.parentElement.insertBefore(badge, refreshBtn);
        return badge;
    }

    function updatePresencePill() {
        const badge = ensurePresencePill();
        if (!badge) return;
        const dot = document.getElementById('collabPresenceDot');
        const txt = document.getElementById('collabPresenceText');
        if (!dot || !txt) return;

        const baseClasses = 'inline-flex items-center gap-1 px-1.5 md:px-2 py-0.5 rounded-full text-[10px] font-black tracking-tight border select-none whitespace-nowrap shrink-0 transition-colors';
        const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

        if (isOffline) {
            badge.className = `${baseClasses} border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300`;
            dot.className = 'w-1.5 h-1.5 rounded-full bg-red-500 shrink-0';
            txt.textContent = 'Offline';
            badge.title = 'Offline — edits will sync when back online';
            return;
        }

        if (collabState.connected) {
            const count = Math.max(1, collabState.totalOnline || 1);
            badge.className = `${baseClasses} border-emerald-200 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300`;
            dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0';
            txt.textContent = `${count} Live`;

            if (collabState.sheetUsers && collabState.sheetUsers.length > 0) {
                const summary = collabState.sheetUsers
                    .map(u => `${u.label || u.view}${u.role === 'admin' ? ' [Admin]' : ''}`)
                    .join(', ');
                badge.title = `${count} active across all views: ${summary}`;
            } else {
                badge.title = `${count} active across all views (Real-time WebSocket)`;
            }
            return;
        }

        const wsUrl = typeof window.getRealtimeWsUrl === 'function' ? window.getRealtimeWsUrl() : '';
        if (!wsUrl) {
            // Direct GAS mode (e.g. GitHub Pages without Node WS URL)
            badge.className = `${baseClasses} border-blue-200 dark:border-blue-800/70 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300`;
            dot.className = 'w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0';
            txt.textContent = 'GAS Sync';
            badge.title = 'Connected directly to Google Apps Script (auto-sync active)';
            return;
        }

        badge.className = `${baseClasses} border-amber-200 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300`;
        dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping shrink-0';
        txt.textContent = 'Sync';
        badge.title = 'Reconnecting to real-time server (GAS fallback active)...';
    }

    // =========================================================
    // WEBSOCKET TRANSPORT
    // =========================================================
    function clearFallbackTimer() {
        if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }
    }

    function scheduleReconnect() {
        if (collabState.intentionalClose || document.hidden) return;
        const wsUrl = typeof window.getRealtimeWsUrl === 'function' ? window.getRealtimeWsUrl() : '';
        if (!wsUrl) return;
        if (collabState.reconnectTimer) clearTimeout(collabState.reconnectTimer);
        const delay = collabState.reconnectDelay;
        collabState.reconnectDelay = Math.min(Math.round(delay * 1.5), MAX_BACKOFF_MS);
        collabState.reconnectTimer = setTimeout(() => {
            collabState.reconnectTimer = null;
            connectWebSocket();
        }, delay);
    }

    function connectWebSocket() {
        if (collabState.intentionalClose) return false;
        detectInitialContext();

        const wsUrl = typeof window.getRealtimeWsUrl === 'function' ? window.getRealtimeWsUrl() : '';
        if (!wsUrl || typeof WebSocket === 'undefined') {
            collabState.mode = 'fallback';
            updatePresencePill();
            scheduleFallbackPoll(400);
            return false;
        }

        if (collabState.ws && (collabState.ws.readyState === WebSocket.OPEN || collabState.ws.readyState === WebSocket.CONNECTING)) {
            return true;
        }

        if (collabState.ws) {
            const oldWs = collabState.ws;
            oldWs.onopen = null;
            oldWs.onmessage = null;
            oldWs.onclose = null;
            oldWs.onerror = null;
            collabState.ws = null;
        }

        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            collabState.mode = 'fallback';
            updatePresencePill();
            scheduleFallbackPoll(600);
            scheduleReconnect();
            return false;
        }

        collabState.ws = ws;

        ws.onopen = () => {
            if (collabState.intentionalClose || collabState.ws !== ws) {
                try { ws.close(1000, 'stale'); } catch (e) {}
                return;
            }
            const wasReconnect = collabState.hasConnectedOnce;
            collabState.connected = true;
            collabState.mode = 'ws';
            collabState.hasConnectedOnce = true;
            collabState.hasSentLeave = false;
            collabState.reconnectDelay = 1000;

            // Pause GAS fallback polling while WebSocket is open!
            clearFallbackTimer();

            try {
                ws.send(JSON.stringify({
                    type: 'presence:join',
                    clientId: storedClientId,
                    adminKey: getAdminKeySafe(),
                    view: collabState.view,
                    sheetUrl: collabState.sheetUrl,
                    label: collabState.label,
                    activeItem: collabState.activeItem
                }));
            } catch (e) {}

            while (collabState.pendingWsQueue.length > 0) {
                const raw = collabState.pendingWsQueue.shift();
                try { ws.send(raw); } catch (e) {}
            }

            updatePresencePill();
            emitLocal('connection:state', { connected: true, mode: 'ws', reconnected: wasReconnect });

            if (wasReconnect) {
                emitLocal('connection:reconnected', { sheetUrl: collabState.sheetUrl });
                emitLocal('collab:reconnected', { sheetUrl: collabState.sheetUrl });
            }

            if (collabState.pingInterval) clearInterval(collabState.pingInterval);
            collabState.pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
                }
            }, 15000);
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                return;
            }
            handleIncoming(msg);
        };

        ws.onclose = () => {
            if (collabState.ws !== ws) return;
            collabState.ws = null;
            collabState.connected = false;
            if (collabState.pingInterval) {
                clearInterval(collabState.pingInterval);
                collabState.pingInterval = null;
            }
            updatePresencePill();
            if (collabState.intentionalClose) return;

            collabState.mode = 'fallback';
            emitLocal('connection:state', { connected: false, mode: 'fallback', reconnected: false });
            // Resume GAS fallback polling automatically while WS reconnects
            scheduleFallbackPoll(1200);
            scheduleReconnect();
        };

        ws.onerror = () => {
            try { ws.close(); } catch (e) {}
        };

        return true;
    }

    function disconnectWebSocket(reason = 'unload') {
        collabState.intentionalClose = true;
        clearFallbackTimer();

        if (collabState.reconnectTimer) {
            clearTimeout(collabState.reconnectTimer);
            collabState.reconnectTimer = null;
        }
        if (collabState.pingInterval) {
            clearInterval(collabState.pingInterval);
            collabState.pingInterval = null;
        }

        const ws = collabState.ws;
        collabState.ws = null;
        collabState.connected = false;

        if (ws) {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify({ type: 'presence:leave', clientId: storedClientId, reason }));
                } catch (e) {}
            }
            try {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close(1000, reason);
                }
            } catch (e) {}
        }

        const base = typeof window.getRealtimeServerBaseUrl === 'function' ? window.getRealtimeServerBaseUrl() : '';
        if (base && !collabState.hasSentLeave && storedClientId) {
            collabState.hasSentLeave = true;
            try {
                const body = JSON.stringify({ clientId: storedClientId, reason });
                if (navigator.sendBeacon) {
                    navigator.sendBeacon(`${base}/api/presence/leave`, new Blob([body], { type: 'text/plain;charset=utf-8' }));
                }
            } catch (e) {}
        }
        updatePresencePill();
    }

    // =========================================================
    // LIGHTWEIGHT 0-SHEET-READ GAS FALLBACK POLLER
    // Only runs when WS is disconnected or unset (e.g. GitHub Pages)
    // =========================================================
    function getFallbackDelayMs() {
        if (consecutiveErrors > 0) {
            return Math.min(2500 * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
        }
        const isIdle = Date.now() - lastUserActivityAt > IDLE_THRESHOLD_MS;
        return isIdle ? IDLE_FALLBACK_MS : ACTIVE_FALLBACK_MS;
    }

    function scheduleFallbackPoll(overrideMs) {
        clearFallbackTimer();
        if (collabState.connected || document.hidden || !syncStateEndpointSupported) return;
        const delay = typeof overrideMs === 'number' ? overrideMs : getFallbackDelayMs();
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            pollGasSyncState();
        }, delay);
    }

    async function pollGasSyncState() {
        if (collabState.connected || fallbackInFlight || document.hidden || !syncStateEndpointSupported) return;
        if (typeof apiCall !== 'function') return;

        fallbackInFlight = true;
        try {
            const res = await apiCall('getSyncState', { sinceSeq: lastSeq }, 0);
            if (res && res.success === false && String(res.message || '').includes('Unknown Action')) {
                syncStateEndpointSupported = false;
                return;
            }
            consecutiveErrors = 0;

            if (res && res.success) {
                const serverSeq = Number(res.seq) || 0;
                if (!hasBaseline) {
                    hasBaseline = true;
                    lastSeq = serverSeq;
                } else if (res.changed && serverSeq > lastSeq) {
                    lastSeq = serverSeq;
                    const rawEvents = Array.isArray(res.events) ? res.events : [];
                    const remoteEvents = rawEvents.filter(ev => ev && !isOwnClient(ev.clientId));
                    if (remoteEvents.length > 0 || rawEvents.length === 0) {
                        emitLocal('sync:remote', {
                            seq: serverSeq,
                            domains: res.domains || {},
                            events: remoteEvents,
                            sheetUrl: collabState.sheetUrl
                        });
                        emitLocal('collab:reconnected', { sheetUrl: collabState.sheetUrl, source: 'gas-fallback' });
                    }
                }
            }
        } catch (err) {
            consecutiveErrors = Math.min(consecutiveErrors + 1, 5);
        } finally {
            fallbackInFlight = false;
            if (!collabState.connected && syncStateEndpointSupported) {
                scheduleFallbackPoll();
            }
        }
    }

    // Lifecycle listeners
    window.addEventListener('pagehide', () => disconnectWebSocket('pagehide'));
    window.addEventListener('beforeunload', () => disconnectWebSocket('beforeunload'));

    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            collabState.intentionalClose = false;
            collabState.hasSentLeave = false;
            connectWebSocket();
        }
    });

    window.addEventListener('online', () => {
        consecutiveErrors = 0;
        collabState.intentionalClose = false;
        updatePresencePill();
        if (!connectWebSocket()) pollGasSyncState();
        emitLocal('connection:reconnected', { sheetUrl: collabState.sheetUrl });
        emitLocal('collab:reconnected', { sheetUrl: collabState.sheetUrl });
    });

    window.addEventListener('offline', () => {
        updatePresencePill();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearFallbackTimer();
        } else {
            lastUserActivityAt = Date.now();
            consecutiveErrors = 0;
            collabState.intentionalClose = false;
            if (!collabState.connected) {
                if (!connectWebSocket()) pollGasSyncState();
            } else {
                emitLocal('connection:reconnected', { sheetUrl: collabState.sheetUrl });
                emitLocal('collab:reconnected', { sheetUrl: collabState.sheetUrl });
            }
        }
    });

    // =========================================================
    // PUBLIC API (LiveSync + Backwards-Compatible collab* Aliases)
    // =========================================================
    const LiveSync = {
        clientId: storedClientId,
        get isWebSocketConnected() {
            return collabState.connected;
        },
        get mode() {
            return collabState.connected ? 'ws' : collabState.mode;
        },
        get presence() {
            return {
                totalOnline: collabState.totalOnline,
                sheetOnline: collabState.sheetOnline,
                adminOnline: collabState.adminOnline,
                users: collabState.sheetUsers
            };
        },
        on(type, handler) {
            if (!collabState.listeners[type]) collabState.listeners[type] = [];
            collabState.listeners[type].push(handler);
            return () => {
                collabState.listeners[type] = (collabState.listeners[type] || []).filter(fn => fn !== handler);
            };
        },
        noteLocalSeq(seq) {
            const n = Number(seq) || 0;
            if (n > lastSeq) lastSeq = n;
        },
        sendLive(typeOrPayload, maybePayload) {
            const payload = typeof typeOrPayload === 'string'
                ? Object.assign({}, maybePayload || {}, { type: typeOrPayload })
                : Object.assign({}, typeOrPayload || {});
            if (!payload.type) return false;

            const message = Object.assign({}, payload, {
                senderId: storedClientId,
                clientId: storedClientId
            });
            const raw = JSON.stringify(message);

            if (collabState.ws && collabState.ws.readyState === WebSocket.OPEN) {
                try { collabState.ws.send(raw); } catch (e) {}
            } else if (payload.type.startsWith('live:') && typeof window.getRealtimeWsUrl === 'function' && window.getRealtimeWsUrl()) {
                collabState.pendingWsQueue.push(raw);
                if (collabState.pendingWsQueue.length > 50) collabState.pendingWsQueue.shift();
            }

            // Emit 0ms same-browser delta to sibling tabs (works on GitHub Pages even without WS!)
            if (payload.type.startsWith('live:')) {
                const deltaType = 'delta:' + payload.type.slice(5);
                broadcastSameBrowser(Object.assign({}, message, { type: deltaType }));
            } else if (payload.type.startsWith('delta:') || payload.type.startsWith('global:') || payload.type === 'ephemeral:focus') {
                broadcastSameBrowser(message);
            }
            return true;
        },
        setView(view, sheetUrl, label) {
            if (view) collabState.view = view;
            if (sheetUrl !== undefined) collabState.sheetUrl = sheetUrl;
            if (label) collabState.label = label;

            if (collabState.ws && collabState.ws.readyState === WebSocket.OPEN) {
                try {
                    collabState.ws.send(JSON.stringify({
                        type: 'presence:update',
                        clientId: storedClientId,
                        adminKey: getAdminKeySafe(),
                        view: collabState.view,
                        sheetUrl: collabState.sheetUrl,
                        label: collabState.label,
                        activeItem: collabState.activeItem
                    }));
                } catch (e) {}
            }
            updatePresencePill();
        },
        refreshAuth() {
            this.setView(collabState.view, collabState.sheetUrl, collabState.label);
        },
        emitFocus(item) {
            collabState.activeItem = item || null;
            const frame = {
                type: 'ephemeral:focus',
                clientId: storedClientId,
                sheetUrl: collabState.sheetUrl,
                item: item || null
            };
            if (collabState.ws && collabState.ws.readyState === WebSocket.OPEN) {
                try { collabState.ws.send(JSON.stringify(frame)); } catch (e) {}
            }
            broadcastSameBrowser(frame);
        },
        disconnect(reason = 'unload') {
            disconnectWebSocket(reason);
        },
        refreshPresenceBadge: updatePresencePill
    };

    window.LiveSync = LiveSync;
    window.collabOn = (type, handler) => LiveSync.on(type, handler);
    window.collabSend = (payload) => LiveSync.sendLive(payload);
    window.collabSetContext = (view, sheetUrl, label) => LiveSync.setView(view, sheetUrl, label);
    window.collabEmitFocus = (item) => LiveSync.emitFocus(item);
    window.collabDisconnect = (reason) => LiveSync.disconnect(reason);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            updatePresencePill();
            connectWebSocket();
        });
    } else {
        updatePresencePill();
        connectWebSocket();
    }
})();
