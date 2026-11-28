/**
 * Hybrid Real-Time + Direct GAS API Client
 * - Auto-detects persistent Node.js WebSocket/Cache server (same-origin on Google AI Studio / Cloud Run / localhost,
 *   or cross-origin via REALTIME_SERVER_URL on GitHub Pages).
 * - Automatically fails over to direct Google Apps Script (API_URL) with 15s cooldown if Node server is unreachable/5xx/404.
 * - Attaches clientId (echo suppression) and adminKey (server-side role/PII auth) automatically.
 */

window.getRealtimeServerBaseUrl = function() {
    try {
        if (typeof REALTIME_SERVER_URL === 'string' && REALTIME_SERVER_URL.trim() !== '') {
            return REALTIME_SERVER_URL.trim().replace(/\/+$/, '');
        }
        if (typeof window !== 'undefined' && window.location) {
            const host = String(window.location.hostname || '').toLowerCase();
            const proto = String(window.location.protocol || '').toLowerCase();
            if (
                (proto === 'http:' || proto === 'https:') &&
                host &&
                !host.endsWith('.github.io') &&
                host !== 'github.io'
            ) {
                return window.location.origin.replace(/\/+$/, '');
            }
        }
    } catch (e) {}
    return '';
};

window.getRealtimeWsUrl = function() {
    const base = window.getRealtimeServerBaseUrl();
    if (!base) return '';
    if (base.startsWith('https://')) return 'wss://' + base.slice('https://'.length);
    if (base.startsWith('http://')) return 'ws://' + base.slice('http://'.length);
    return '';
};

let realtimeServerUnavailableUntil = 0;
const REALTIME_FAILOVER_COOLDOWN_MS = 15000;

function getDirectGasUrl() {
    if (typeof GAS_BACKEND_URL === 'string' && GAS_BACKEND_URL.startsWith('http')) {
        return GAS_BACKEND_URL;
    }
    if (typeof API_URL === 'string' && API_URL.startsWith('http')) {
        return API_URL;
    }
    return '';
}

function getStoredAdminKey() {
    try {
        return localStorage.getItem('adminKey') || '';
    } catch (e) {
        return '';
    }
}

async function postJsonText(endpointUrl, bodyStr) {
    const response = await fetch(endpointUrl, {
        method: 'POST',
        body: bodyStr,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        redirect: 'follow'
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        parsed = null;
    }
    return { ok: response.ok, status: response.status, parsed, text };
}

async function apiCall(action, data = {}, maxRetries = 2) {
    const bodyObj = {
        action: action,
        data: data,
        clientId: window.collabClientId || window.CLIENT_ID || null
    };
    const adminKey = getStoredAdminKey();
    if (adminKey) {
        bodyObj.adminKey = adminKey;
    }
    const bodyStr = JSON.stringify(bodyObj);

    const realtimeBase = window.getRealtimeServerBaseUrl();
    const gasUrl = getDirectGasUrl();

    // 1. Try persistent Node.js server first when available and not in failover cooldown
    if (realtimeBase && Date.now() >= realtimeServerUnavailableUntil) {
        try {
            const res = await postJsonText(`${realtimeBase}/api`, bodyStr);
            if (res.status === 401 && res.parsed && res.parsed.authError) {
                if (typeof window.handleAdminAuthRejection === 'function') {
                    window.handleAdminAuthRejection(res.parsed.message);
                }
                return res.parsed;
            }
            if (res.ok && res.parsed !== null) {
                if (res.parsed && typeof res.parsed.syncSeq === 'number' && window.LiveSync && typeof window.LiveSync.noteLocalSeq === 'function') {
                    window.LiveSync.noteLocalSeq(res.parsed.syncSeq);
                }
                return res.parsed;
            }
            // Failover to direct GAS on 404, 5xx, or non-JSON response
            if (res.status === 404 || res.status >= 500 || res.parsed === null) {
                console.warn(`[API] Realtime server returned ${res.status} for ${action}; failing over to direct GAS for 15s.`);
                realtimeServerUnavailableUntil = Date.now() + REALTIME_FAILOVER_COOLDOWN_MS;
            } else if (res.parsed !== null) {
                return res.parsed;
            }
        } catch (err) {
            console.warn(`[API] Realtime server unreachable for ${action} (${err.message}); failing over to direct GAS for 15s.`);
            realtimeServerUnavailableUntil = Date.now() + REALTIME_FAILOVER_COOLDOWN_MS;
        }
    }

    // 2. Direct GAS fallback (primary path on GitHub Pages without REALTIME_SERVER_URL)
    if (!gasUrl) {
        return { success: false, message: 'Backend API URL is not configured.' };
    }

    let delay = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await postJsonText(gasUrl, bodyStr);
            if (res.parsed !== null) {
                if (res.parsed && res.parsed.authError && typeof window.handleAdminAuthRejection === 'function') {
                    window.handleAdminAuthRejection(res.parsed.message);
                }
                return res.parsed;
            }
            if (attempt < maxRetries) {
                console.warn(`[API] GAS non-JSON response for ${action} (Attempt ${attempt + 1}). Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.round(delay * 1.5);
                continue;
            }
            console.error('[API] GAS Response is not JSON:', res.text.substring(0, 200));
            return { success: false, message: 'Server Error: Invalid Response. Please try again.' };
        } catch (error) {
            if (attempt < maxRetries) {
                console.warn(`[API] GAS Error for ${action} (Attempt ${attempt + 1}): ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.round(delay * 1.5);
                continue;
            }
            console.error('[API] GAS Error:', error);
            return { success: false, message: 'Connection Error. Please check internet.' };
        }
    }
    return { success: false, message: 'Connection Error. Please check internet.' };
}
