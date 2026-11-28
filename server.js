/**
 * MINDS MYG Outings Organiser — Persistent Node.js Real-Time WebSocket & GAS Cache Server
 * Architecture: realtime-ws-gas-sync
 * - Zero-config Google AI Studio / Cloud Run / localhost deployment (process.env.PORT, 0.0.0.0)
 * - Authoritative role-scoped in-memory StateCache (60s TTL, zero-clone) + read collapsing
 * - 0ms optimistic HTTP writes + FIFO AsyncQueue(1) background GAS write drain + SIGTERM drain
 * - Authenticated, role-filtered WebSocket broadcasts + global live presence counter
 * - Strict static file allowlist (404 on server.js, package.json, backend/Code.js, etc.)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const NodeCache = require('node-cache');
const config = require('./backend/config.js');

const _fetch = typeof global.fetch === 'function' ? global.fetch.bind(global) : require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = Number(process.env.PORT) || 3000;

// =========================================================
// SECURITY ALLOWLIST & CORS
// Keep ALLOWED_ROOT_FILES in exact sync with .github/workflows/deploy-pages.yml
// =========================================================
const ALLOWED_ROOT_FILES = new Set([
    'index.html',
    'volunteer.html',
    'tracker.html',
    'admin.html',
    'pairing.html',
    'grouping.html',
    'settings.html',
    'manifest.json',
    'sw.js'
]);

const ADMIN_ONLY_ACTIONS = new Set([
    'createOuting',
    'updateOuting',
    'saveAppSettings',
    'changeAdminPassword',
    'runAutoPairing',
    'runAutoGrouping',
    'fetchManualPairingData',
    'syncManualPairingUpdates',
    'syncManualGroupingUpdates',
    'getOutingDetails',
    'uploadExportTable',
    'getTemplateHeaders'
]);

const READ_ACTIONS = new Set([
    'getAppSettings',
    'getTemplateHeaders',
    'getRecentOutingSheets',
    'getNamesList',
    'getPersonData',
    'fetchManualPairingData',
    'fetchCommAttendance',
    'getOutingDetails',
    'getSyncState'
]);

// CORS for cross-origin GitHub Pages -> Cloud Run / AI Studio server
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// =========================================================
// AUTHORITATIVE IN-MEMORY STATE CACHE & QUEUES
// =========================================================
const stateCache = new NodeCache({ stdTTL: 60, checkperiod: 15, useClones: false });
const authCache = new NodeCache({ stdTTL: 120, checkperiod: 30, useClones: false });
const inFlightReads = new Map();

// Map<sheetUrl, Array<{ id, type, payload, timestamp }>>
const pendingServerMutations = new Map();
const lastLiveWsMutationAt = new Map();
let mutationCounter = 1;
let serverSyncSeq = 0;

function bumpSyncSeq() {
    serverSyncSeq += 1;
    return serverSyncSeq;
}

function touchLiveWsMutation(sheetUrl) {
    if (sheetUrl) lastLiveWsMutationAt.set(sheetUrl, Date.now());
}

function addPendingServerMutation(sheetUrl, type, payload) {
    if (!sheetUrl) return null;
    const id = mutationCounter++;
    if (!pendingServerMutations.has(sheetUrl)) {
        pendingServerMutations.set(sheetUrl, []);
    }
    pendingServerMutations.get(sheetUrl).push({
        id,
        type,
        payload,
        timestamp: Date.now()
    });
    return id;
}

function removePendingServerMutation(sheetUrl, id) {
    if (!sheetUrl || !id || !pendingServerMutations.has(sheetUrl)) return;
    const list = pendingServerMutations.get(sheetUrl).filter(m => m.id !== id);
    if (list.length === 0) {
        pendingServerMutations.delete(sheetUrl);
    } else {
        pendingServerMutations.set(sheetUrl, list);
    }
}

class AsyncQueue {
    constructor(concurrency = 1) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
        this._drainWaiters = [];
    }

    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    resolve(await task());
                } catch (e) {
                    reject(e);
                }
            });
            this.process();
        });
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) {
            if (this.running === 0 && this.queue.length === 0 && this._drainWaiters.length > 0) {
                const waiters = this._drainWaiters.splice(0);
                waiters.forEach(fn => fn());
            }
            return;
        }
        this.running++;
        const task = this.queue.shift();
        try {
            await task();
        } finally {
            this.running--;
            this.process();
        }
    }

    get isBusy() {
        return this.running > 0 || this.queue.length > 0;
    }

    get depth() {
        return this.running + this.queue.length;
    }

    drain() {
        if (!this.isBusy) return Promise.resolve();
        return new Promise(resolve => this._drainWaiters.push(resolve));
    }
}

const writeQueue = new AsyncQueue(1);

function getReadCacheKey(scope, action, data) {
    const cleanScope = scope === 'admin' ? 'admin' : 'public';
    return `${cleanScope}::${action}::${JSON.stringify(data || {})}`;
}

function getScopedCachedBoth(action, data) {
    return [
        stateCache.get(getReadCacheKey('admin', action, data)),
        stateCache.get(getReadCacheKey('public', action, data))
    ].filter(Boolean);
}

function delScopedCachedBoth(action, data) {
    stateCache.del(getReadCacheKey('admin', action, data));
    stateCache.del(getReadCacheKey('public', action, data));
}

function setScopedCachedBoth(action, data, value) {
    stateCache.set(getReadCacheKey('admin', action, data), value);
    stateCache.set(getReadCacheKey('public', action, data), value);
}

function hashAdminKey(adminKey) {
    return crypto.createHash('sha256').update(String(adminKey || '')).digest('hex');
}

// =========================================================
// GAS FETCH & AUTH HELPERS
// =========================================================
async function fetchFromGAS(action, data, options = {}) {
    const { maxAttempts = 3, adminKey = '', clientId = null } = options;
    const bodyObj = { action, data };
    if (adminKey) bodyObj.adminKey = adminKey;
    if (clientId) bodyObj.clientId = clientId;
    const payload = JSON.stringify(bodyObj);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const gasResponse = await _fetch(config.GAS_BACKEND_URL, {
                method: 'POST',
                body: payload,
                headers: {
                    'Content-Type': 'text/plain;charset=utf-8',
                    'User-Agent': 'Mozilla/5.0 (compatible; MYG-Realtime-Server/2.0)'
                },
                redirect: 'follow'
            });

            const text = await gasResponse.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                const errorMsg = 'Invalid JSON from GAS: ' + text.substring(0, 120);
                console.warn(`[WARN] ${action} attempt ${attempt} failed: ${errorMsg}`);
                lastError = new Error(errorMsg);
                if (attempt < maxAttempts) await new Promise(res => setTimeout(res, attempt * 800));
            }
        } catch (err) {
            console.warn(`[WARN] ${action} attempt ${attempt} network error: ${err.message}`);
            lastError = err;
            if (attempt < maxAttempts) await new Promise(res => setTimeout(res, attempt * 800));
        }
    }
    throw lastError;
}

async function verifyAdminKey(adminKey) {
    if (!adminKey || typeof adminKey !== 'string') return false;
    const keyHash = hashAdminKey(adminKey);
    const cached = authCache.get(keyHash);
    if (cached !== undefined) return Boolean(cached);

    try {
        // Prefer lightweight 0-Sheet-read getSyncState endpoint (falls back to verifyAdminPassword if GAS not yet updated)
        const syncRes = await fetchFromGAS('getSyncState', { sinceSeq: 0 }, { maxAttempts: 2, adminKey });
        if (syncRes && syncRes.success && syncRes.authInfo && typeof syncRes.authInfo.isAdmin === 'boolean') {
            const isValid = syncRes.authInfo.isAdmin;
            authCache.set(keyHash, isValid, isValid ? 120 : 15);
            return isValid;
        }
    } catch (e) {}

    try {
        const res = await fetchFromGAS('verifyAdminPassword', adminKey, { maxAttempts: 2 });
        const isValid = res === true || (res && res.success === true && res.valid === true);
        authCache.set(keyHash, isValid, isValid ? 120 : 15);
        return isValid;
    } catch (e) {
        return false;
    }
}

// =========================================================
// IN-MEMORY AUTHORITATIVE STATE PATCHING
// =========================================================
function normalizeHeader(str) {
    if (!str) return '';
    return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function patchCommAttendanceState(commData, multipleUpdates) {
    if (!commData || !commData.success) return false;
    if (!commData.attendance) commData.attendance = { '__GONE_HOME__': {} };
    if (!commData.busAttendance) commData.busAttendance = {};
    let changed = false;

    for (const [juncName, updates] of Object.entries(multipleUpdates || {})) {
        if (!Array.isArray(updates)) continue;
        const isBus = juncName.startsWith('__BUS__');
        const bName = isBus ? juncName.substring(7) : null;

        if (isBus) {
            if (!commData.busAttendance[bName]) commData.busAttendance[bName] = {};
        } else {
            if (!commData.attendance[juncName]) commData.attendance[juncName] = {};
            if (juncName !== '__GONE_HOME__' && Array.isArray(commData.junctures) && !commData.junctures.includes(juncName)) {
                commData.junctures.push(juncName);
            }
        }

        updates.forEach(u => {
            if (!u || !u.name) return;
            if (isBus) {
                const nextBus = u.status != null ? String(u.status).trim() : '';
                if (commData.busAttendance[bName][u.name] !== nextBus) {
                    commData.busAttendance[bName][u.name] = nextBus;
                    changed = true;
                }
            } else {
                const boolStatus = u.status === true || String(u.status).toLowerCase() === 'true';
                if (commData.attendance[juncName][u.name] !== boolStatus) {
                    commData.attendance[juncName][u.name] = boolStatus;
                    changed = true;
                }
            }
        });
    }
    return changed;
}

function patchPairingDataFromCommSync(pairData, multipleUpdates) {
    if (!pairData || !pairData.success || !pairData.data || !Array.isArray(pairData.data.trainees)) return false;
    const goneHomeUpdates = multipleUpdates && multipleUpdates['__GONE_HOME__'];
    if (!Array.isArray(goneHomeUpdates)) return false;

    let changed = false;
    goneHomeUpdates.forEach(u => {
        if (!u || !u.name) return;
        const normName = String(u.name).toLowerCase().trim();
        const trainee = pairData.data.trainees.find(t => t.name && t.name.toLowerCase().trim() === normName);
        if (trainee) {
            const boolStatus = u.status === true || String(u.status).toLowerCase() === 'true';
            if (trainee.isGoneHome !== boolStatus) {
                trainee.isGoneHome = boolStatus;
                changed = true;
            }
        }
    });
    return changed;
}

function mergePairingOp(currentStr, op, volName) {
    const vols = currentStr ? String(currentStr).split(/[,|\n]+/).map(v => v.trim()).filter(Boolean) : [];
    const target = String(volName || '').trim();
    if (!target) return vols.join(', ');
    const normTarget = target.toLowerCase();
    const normOp = String(op || '').toLowerCase();
    if (normOp === 'add') {
        if (!vols.some(v => v.toLowerCase() === normTarget)) vols.push(target);
        return vols.join(', ');
    }
    if (normOp === 'remove') {
        return vols.filter(v => v.toLowerCase() !== normTarget).join(', ');
    }
    return vols.join(', ');
}

function patchStatesOnPairingUpdate(sheetUrl, updates) {
    if (!sheetUrl || !Array.isArray(updates)) return;
    const pairCaches = getScopedCachedBoth('fetchManualPairingData', { sheetUrl });
    const commCaches = getScopedCachedBoth('fetchCommAttendance', { sheetUrl });

    updates.forEach(u => {
        if (!u || !u.traineeName) return;
        const normName = String(u.traineeName).toLowerCase().trim();
        const samplePair = pairCaches[0];
        const sampleComm = commCaches[0];

        const tSample = (samplePair && samplePair.success && samplePair.data && Array.isArray(samplePair.data.trainees))
            ? samplePair.data.trainees.find(x => x.name && x.name.toLowerCase().trim() === normName)
            : null;
        const pSample = (sampleComm && sampleComm.success && Array.isArray(sampleComm.participants))
            ? sampleComm.participants.find(x => x.name && x.name.toLowerCase().trim() === normName)
            : null;

        let newVolPaired;
        if (u.op && u.volName) {
            const baseVolPaired = tSample ? tSample.volPaired : (pSample ? pSample.volPaired : (u.volPaired || ''));
            newVolPaired = mergePairingOp(baseVolPaired, u.op, u.volName);
            u.volPaired = newVolPaired;
        } else {
            newVolPaired = u.volPaired != null ? String(u.volPaired).trim() : '';
        }

        pairCaches.forEach(pairData => {
            if (!pairData || !pairData.success || !pairData.data || !Array.isArray(pairData.data.trainees)) return;
            const t = pairData.data.trainees.find(x => x.name && x.name.toLowerCase().trim() === normName);
            if (t) {
                t.volPaired = newVolPaired;
                if (t.extra) t.extra.t_paired_vol = newVolPaired;
            }
        });
        commCaches.forEach(commData => {
            if (!commData || !commData.success || !Array.isArray(commData.participants)) return;
            const p = commData.participants.find(x => x.name && x.name.toLowerCase().trim() === normName);
            if (p) {
                p.volPaired = newVolPaired;
                if (p.extra) p.extra.t_paired_vol = newVolPaired;
            }
        });
    });
}

function patchStatesOnGroupingUpdate(sheetUrl, updates) {
    if (!sheetUrl || !Array.isArray(updates)) return;
    const pairCaches = getScopedCachedBoth('fetchManualPairingData', { sheetUrl });
    const commCaches = getScopedCachedBoth('fetchCommAttendance', { sheetUrl });

    updates.forEach(u => {
        if (!u) return;
        const rawName = u.name || u.traineeName;
        if (!rawName) return;
        const normName = String(rawName).toLowerCase().trim();

        if (u.role === 'TRAINEE' || u.traineeName) {
            const newGroup = u.group != null ? String(u.group).trim() : '';
            pairCaches.forEach(pairData => {
                if (!pairData || !pairData.success || !pairData.data || !Array.isArray(pairData.data.trainees)) return;
                const t = pairData.data.trainees.find(x => x.name && x.name.toLowerCase().trim() === normName);
                if (t) {
                    t.group = newGroup;
                    if (t.extra) t.extra.t_group = newGroup;
                }
            });
            commCaches.forEach(commData => {
                if (!commData || !commData.success || !Array.isArray(commData.participants)) return;
                const p = commData.participants.find(x => x.name && x.name.toLowerCase().trim() === normName);
                if (p) {
                    p.group = newGroup;
                    if (p.extra) p.extra.t_group = newGroup;
                }
            });
        } else if (u.role === 'VOLUNTEER') {
            pairCaches.forEach(pairData => {
                if (!pairData || !pairData.success || !pairData.data || !Array.isArray(pairData.data.volunteers)) return;
                const v = pairData.data.volunteers.find(x => x.name && x.name.toLowerCase().trim() === normName);
                if (v) {
                    if (u.groupIC !== undefined) v.groupIC = Boolean(u.groupIC);
                    if (u.meetIC !== undefined) v.meetIC = Boolean(u.meetIC);
                    if (u.dismissIC !== undefined) v.dismissIC = Boolean(u.dismissIC);
                }
            });
        }
    });
}

function patchPersonAttendanceInMemory(type, targetName, data, pairData, commData, namesData) {
    if (!type || !data) return;
    const role = String(type).toUpperCase();
    const rawName = targetName || data['Name'] || data[Object.keys(data)[0]];
    if (!rawName) return;
    const name = String(rawName).trim();
    const normName = name.toLowerCase();

    let attVal;
    let meetLoc;
    let dismissLoc;
    let groupVal;
    let pairedVol;
    let caregiversVal;
    let remarkVal;
    let projectVal;

    for (const [k, v] of Object.entries(data)) {
        const normKey = normalizeHeader(k);
        if (normKey.includes('attending')) attVal = String(v).toLowerCase().trim();
        else if (normKey.includes('meetinglocation')) meetLoc = String(v).trim();
        else if (normKey.includes('dismissallocation')) dismissLoc = String(v).trim();
        else if (normKey.includes('group')) groupVal = String(v).trim();
        else if (normKey.includes('volpaired')) pairedVol = String(v).trim();
        else if (normKey.includes('caregiver')) caregiversVal = parseInt(v, 10) || 0;
        else if (normKey.includes('remark')) remarkVal = String(v).trim();
        else if (normKey.includes('project')) projectVal = String(v).trim();
    }

    if (pairData && pairData.success && pairData.data) {
        if (role === 'TRAINEE') {
            let person = pairData.data.trainees.find(p => p.name.toLowerCase().trim() === normName);
            if (!person) {
                person = {
                    name,
                    role: 'TRAINEE',
                    caregivers: caregiversVal || 0,
                    attending: attVal !== undefined ? attVal : 'y',
                    volPaired: pairedVol || '',
                    project: projectVal || '',
                    group: groupVal || '',
                    isAttendingN: attVal === 'n',
                    isAttendingUnknown: attVal === '',
                    isGoneHome: false,
                    extra: { role: 'TRAINEE' }
                };
                pairData.data.trainees.push(person);
            }
            if (attVal !== undefined) {
                person.attending = attVal;
                person.isAttendingN = attVal === 'n';
                person.isAttendingUnknown = attVal === '';
                if (attVal === 'n') person.volPaired = '';
            }
            if (groupVal !== undefined) {
                person.group = groupVal;
                if (person.extra) person.extra.t_group = groupVal;
            }
            if (pairedVol !== undefined && attVal !== 'n') {
                person.volPaired = pairedVol;
                if (person.extra) person.extra.t_paired_vol = pairedVol;
            }
            if (caregiversVal !== undefined) person.caregivers = caregiversVal;
            if (meetLoc !== undefined && person.extra) person.extra.t_meet = meetLoc;
            if (dismissLoc !== undefined && person.extra) person.extra.t_dismiss = dismissLoc;
            if (remarkVal !== undefined && person.extra) person.extra.remark = remarkVal;
        } else if (role === 'VOLUNTEER') {
            let person = pairData.data.volunteers.find(p => p.name.toLowerCase().trim() === normName);
            if (attVal === 'n' || attVal === '') {
                pairData.data.volunteers = pairData.data.volunteers.filter(p => p.name.toLowerCase().trim() !== normName);
                if (attVal === 'n') {
                    pairData.data.trainees.forEach(t => {
                        if (t.volPaired && t.volPaired.toLowerCase().includes(normName)) {
                            const vols = t.volPaired.split(/[,|\n]+/).map(v => v.trim()).filter(Boolean);
                            t.volPaired = vols.filter(v => v.toLowerCase() !== normName).join(', ');
                        }
                    });
                }
            } else {
                if (!person) {
                    person = {
                        name,
                        role: 'VOLUNTEER',
                        project: projectVal || '',
                        groupIC: false,
                        meetIC: false,
                        dismissIC: false,
                        extra: { role: 'VOLUNTEER' }
                    };
                    pairData.data.volunteers.push(person);
                }
                if (projectVal !== undefined && projectVal !== '') person.project = projectVal;
                if (meetLoc !== undefined && person.extra) person.extra.v_meet = meetLoc;
                if (dismissLoc !== undefined && person.extra) person.extra.v_dismiss = dismissLoc;
                if (groupVal !== undefined && person.extra) person.extra.v_group = groupVal;
                if (remarkVal !== undefined && person.extra) person.extra.remark = remarkVal;
            }
        }
    }

    if (commData && commData.success && Array.isArray(commData.participants)) {
        if (role === 'TRAINEE') {
            let person = commData.participants.find(p => p.name.toLowerCase().trim() === normName);
            if (attVal === 'n' || attVal === '') {
                commData.participants = commData.participants.filter(p => p.name.toLowerCase().trim() !== normName);
            } else {
                if (!person && (attVal === 'y' || attVal === undefined)) {
                    person = {
                        name,
                        group: groupVal || '',
                        caregivers: caregiversVal || 0,
                        volPaired: pairedVol || '',
                        meetingLoc: meetLoc || '',
                        dismissalLoc: dismissLoc || '',
                        extra: { role: 'TRAINEE' }
                    };
                    commData.participants.push(person);
                    if (commData.attendance && commData.attendance['__GONE_HOME__']) {
                        commData.attendance['__GONE_HOME__'][name] = false;
                    }
                }
                if (person) {
                    if (groupVal !== undefined) {
                        person.group = groupVal;
                        if (person.extra) person.extra.t_group = groupVal;
                    }
                    if (pairedVol !== undefined) {
                        person.volPaired = pairedVol;
                        if (person.extra) person.extra.t_paired_vol = pairedVol;
                    }
                    if (meetLoc !== undefined) {
                        person.meetingLoc = meetLoc;
                        if (person.extra) person.extra.t_meet = meetLoc;
                    }
                    if (dismissLoc !== undefined) {
                        person.dismissalLoc = dismissLoc;
                        if (person.extra) person.extra.t_dismiss = dismissLoc;
                    }
                    if (caregiversVal !== undefined) person.caregivers = caregiversVal;
                    if (remarkVal !== undefined && person.extra) person.extra.remark = remarkVal;
                }
            }
        } else if (role === 'VOLUNTEER' && attVal === 'n') {
            commData.participants.forEach(t => {
                if (t.volPaired && t.volPaired.toLowerCase().includes(normName)) {
                    const vols = t.volPaired.split(/[,|\n]+/).map(v => v.trim()).filter(Boolean);
                    t.volPaired = vols.filter(v => v.toLowerCase() !== normName).join(', ');
                }
            });
        }
    }

    if (namesData && namesData.success && Array.isArray(namesData.names)) {
        if (!namesData.names.some(n => n.toLowerCase().trim() === normName)) {
            namesData.names.push(name);
            namesData.names.sort();
        }
    }
}

function patchStatesOnPersonAttendanceUpdate(sheetUrl, type, targetName, data) {
    if (!sheetUrl || !type || !data) return;
    const rawName = targetName || data['Name'] || data[Object.keys(data)[0]];
    const name = rawName ? String(rawName).trim() : '';

    const pairCaches = getScopedCachedBoth('fetchManualPairingData', { sheetUrl });
    const commCaches = getScopedCachedBoth('fetchCommAttendance', { sheetUrl });
    const namesCaches = getScopedCachedBoth('getNamesList', { url: sheetUrl, type: type.toLowerCase() });

    pairCaches.forEach(p => patchPersonAttendanceInMemory(type, targetName, data, p, null, null));
    commCaches.forEach(c => patchPersonAttendanceInMemory(type, targetName, data, null, c, null));
    namesCaches.forEach(n => patchPersonAttendanceInMemory(type, targetName, data, null, null, n));

    if (name) {
        delScopedCachedBoth('getPersonData', { url: sheetUrl, type: type.toLowerCase(), name });
    }
    delScopedCachedBoth('getOutingDetails', sheetUrl);
}

function applyPendingMutationsToState(action, reqData, responseData) {
    if (!responseData || !responseData.success) return responseData;
    const sheetUrl = (reqData && typeof reqData === 'object') ? (reqData.sheetUrl || reqData.url) : (typeof reqData === 'string' ? reqData : null);
    if (!sheetUrl || !pendingServerMutations.has(sheetUrl)) return responseData;

    const mutations = pendingServerMutations.get(sheetUrl);
    for (const m of mutations) {
        if (action === 'fetchCommAttendance') {
            if (m.type === 'syncCommAttendance') {
                patchCommAttendanceState(responseData, m.payload.multipleUpdates);
            } else if (m.type === 'syncManualPairingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    const normName = String(u.traineeName || '').toLowerCase().trim();
                    const p = (responseData.participants || []).find(x => x.name.toLowerCase().trim() === normName);
                    if (p) {
                        p.volPaired = (u.op && u.volName)
                            ? mergePairingOp(p.volPaired, u.op, u.volName)
                            : (u.volPaired != null ? String(u.volPaired).trim() : '');
                        if (p.extra) p.extra.t_paired_vol = p.volPaired;
                    }
                });
            } else if (m.type === 'syncManualGroupingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    if (u.role === 'TRAINEE' || u.traineeName) {
                        const normName = String(u.name || u.traineeName || '').toLowerCase().trim();
                        const p = (responseData.participants || []).find(x => x.name.toLowerCase().trim() === normName);
                        if (p) p.group = u.group;
                    }
                });
            } else if (m.type === 'submitAttendanceData' && m.payload) {
                patchPersonAttendanceInMemory(m.payload.type, m.payload.targetName, m.payload.data, null, responseData, null);
            }
        } else if (action === 'fetchManualPairingData' && responseData.data) {
            if (m.type === 'syncCommAttendance') {
                patchPairingDataFromCommSync(responseData, m.payload.multipleUpdates);
            } else if (m.type === 'syncManualPairingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    const normName = String(u.traineeName || '').toLowerCase().trim();
                    const t = (responseData.data.trainees || []).find(x => x.name.toLowerCase().trim() === normName);
                    if (t) {
                        t.volPaired = (u.op && u.volName)
                            ? mergePairingOp(t.volPaired, u.op, u.volName)
                            : (u.volPaired != null ? String(u.volPaired).trim() : '');
                        if (t.extra) t.extra.t_paired_vol = t.volPaired;
                    }
                });
            } else if (m.type === 'syncManualGroupingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    const normName = String(u.name || u.traineeName || '').toLowerCase().trim();
                    if (u.role === 'TRAINEE' || u.traineeName) {
                        const t = (responseData.data.trainees || []).find(x => x.name.toLowerCase().trim() === normName);
                        if (t) t.group = u.group;
                    } else if (u.role === 'VOLUNTEER') {
                        const v = (responseData.data.volunteers || []).find(x => x.name.toLowerCase().trim() === normName);
                        if (v) {
                            if (u.groupIC !== undefined) v.groupIC = Boolean(u.groupIC);
                            if (u.meetIC !== undefined) v.meetIC = Boolean(u.meetIC);
                            if (u.dismissIC !== undefined) v.dismissIC = Boolean(u.dismissIC);
                        }
                    }
                });
            } else if (m.type === 'submitAttendanceData' && m.payload) {
                patchPersonAttendanceInMemory(m.payload.type, m.payload.targetName, m.payload.data, responseData, null, null);
            }
        } else if (action === 'getNamesList') {
            if (m.type === 'submitAttendanceData' && m.payload && reqData && String(m.payload.type || '').toLowerCase() === String(reqData.type || '').toLowerCase()) {
                patchPersonAttendanceInMemory(m.payload.type, m.payload.targetName, m.payload.data, null, null, responseData);
            }
        }
    }
    return responseData;
}

// =========================================================
// WEBSOCKET REAL-TIME MULTIPLAYER HUB (AUTHENTICATED & SCOPED)
// =========================================================

// Map<WebSocket, { clientId, sheetUrl, view, label, color, activeItem, isAdmin, role, joined, joinedAt, lastSeen }>
const clients = new Map();
const roomBusOptions = new Map();

function attachRoomBusOptions(sheetUrl, commData) {
    if (sheetUrl && commData && commData.success && roomBusOptions.has(sheetUrl)) {
        commData.busOptions = roomBusOptions.get(sheetUrl);
    }
    return commData;
}

const COLLAB_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4'
];

function broadcastScopedDelta(sheetUrl, messageObj, options = {}) {
    const { excludeWs = null, adminOnly = false, globalBroadcast = false } = options;
    const isGroupingDelta = messageObj && messageObj.type === 'delta:grouping';

    for (const [ws, meta] of clients.entries()) {
        if (ws === excludeWs || ws.readyState !== 1 || !meta.joined) continue;
        if (adminOnly && !meta.isAdmin) continue;

        if (!globalBroadcast && sheetUrl) {
            const onSameSheet = meta.sheetUrl === sheetUrl;
            const onGlobalAdminView = meta.isAdmin && (meta.view === 'admin' || meta.view === 'index');
            if (!onSameSheet && !onGlobalAdminView) continue;
        }

        let payloadToSend = messageObj;
        // Strip admin-only VOLUNTEER IC updates from grouping deltas sent to non-admins
        if (isGroupingDelta && !meta.isAdmin) {
            const traineeOnlyUpdates = Array.isArray(messageObj.updates)
                ? messageObj.updates.filter(u => u && (u.role === 'TRAINEE' || u.traineeName))
                : [];
            if (traineeOnlyUpdates.length === 0 && !messageObj.deletedGroup) continue;
            payloadToSend = Object.assign({}, messageObj, { updates: traineeOnlyUpdates });
        }

        try {
            ws.send(JSON.stringify(payloadToSend));
        } catch (e) {}
    }
}

function removeClientSocket(ws, shouldBroadcast = true) {
    const meta = clients.get(ws);
    if (!meta) return false;
    const prevSheet = meta.sheetUrl || null;
    if (meta.activeItem) {
        broadcastScopedDelta(prevSheet, {
            type: 'ephemeral:focus',
            clientId: meta.clientId,
            sheetUrl: prevSheet,
            item: null
        }, { excludeWs: ws });
    }
    clients.delete(ws);
    if (shouldBroadcast) {
        broadcastPresence();
    }
    return true;
}

function evictDuplicateClientId(clientId, keepWs = null) {
    if (!clientId) return false;
    let evicted = false;
    for (const [otherWs, otherMeta] of Array.from(clients.entries())) {
        if (otherWs !== keepWs && otherMeta.clientId === clientId) {
            removeClientSocket(otherWs, false);
            evicted = true;
            try {
                if (otherWs.readyState === 0 || otherWs.readyState === 1) {
                    otherWs.terminate();
                }
            } catch (e) {}
        }
    }
    return evicted;
}

function broadcastPresence() {
    for (const [ws] of Array.from(clients.entries())) {
        if (ws.readyState !== 1) {
            removeClientSocket(ws, false);
        }
    }

    const uniqueUsersById = new Map();
    for (const [ws, meta] of clients.entries()) {
        if (ws.readyState === 1 && meta.joined) {
            uniqueUsersById.set(meta.clientId, {
                clientId: meta.clientId,
                sheetUrl: meta.sheetUrl,
                view: meta.view,
                label: meta.label,
                color: meta.color,
                role: meta.isAdmin ? 'admin' : 'public',
                activeItem: meta.activeItem || null
            });
        }
    }

    const allUsers = Array.from(uniqueUsersById.values());
    const totalOnline = allUsers.length;
    const adminOnline = allUsers.filter(u => u.role === 'admin').length;

    for (const [ws, meta] of clients.entries()) {
        if (ws.readyState !== 1 || !meta.joined) continue;

        const sameSheetCount = meta.sheetUrl
            ? allUsers.filter(u => u.sheetUrl === meta.sheetUrl).length
            : totalOnline;

        // Global count across all views is shown to everyone ("● N Live"),
        // while detailed collaborator lists are strictly Admin-only.
        const payload = {
            type: 'presence:state',
            totalOnline,
            sheetOnline: sameSheetCount,
            adminOnline: meta.isAdmin ? adminOnline : 0,
            users: meta.isAdmin ? allUsers : []
        };

        try {
            ws.send(JSON.stringify(payload));
        } catch (e) {}
    }
}

// 15s ping/pong heartbeat + 45s stale socket sweeper
const wsHeartbeatInterval = setInterval(() => {
    const now = Date.now();
    let pruned = false;

    for (const [ws, meta] of Array.from(clients.entries())) {
        const isStale = (now - (meta.lastSeen || meta.joinedAt)) > 45000;
        const isUnannounced = !meta.joined && (now - meta.joinedAt) > 15000;

        if (ws.readyState !== 1 || isStale || isUnannounced) {
            removeClientSocket(ws, false);
            pruned = true;
            try { ws.terminate(); } catch (e) {}
            continue;
        }

        try {
            ws.ping();
        } catch (e) {
            removeClientSocket(ws, false);
            pruned = true;
            try { ws.terminate(); } catch (err) {}
        }
    }

    if (pruned) {
        broadcastPresence();
    }
}, 15000);

wss.on('close', () => {
    clearInterval(wsHeartbeatInterval);
});

wss.on('connection', (ws) => {
    const color = COLLAB_COLORS[clients.size % COLLAB_COLORS.length];
    const now = Date.now();
    const defaultMeta = {
        clientId: 'u_' + Math.random().toString(36).substring(2, 9),
        sheetUrl: null,
        view: 'index',
        label: 'Collaborator',
        color,
        activeItem: null,
        isAdmin: false,
        role: 'public',
        joined: false,
        joinedAt: now,
        lastSeen: now
    };
    clients.set(ws, defaultMeta);

    ws.on('pong', () => {
        const meta = clients.get(ws);
        if (meta) meta.lastSeen = Date.now();
    });

    ws.on('message', async (rawMsg) => {
        let msg;
        try {
            msg = JSON.parse(rawMsg.toString());
        } catch (e) {
            return;
        }

        const meta = clients.get(ws);
        if (!meta) return;
        meta.lastSeen = Date.now();

        switch (msg.type) {
            case 'presence:join':
            case 'presence:update': {
                if (msg.clientId) meta.clientId = String(msg.clientId);
                if (msg.sheetUrl !== undefined) meta.sheetUrl = msg.sheetUrl || null;
                if (msg.view) meta.view = String(msg.view);
                if (msg.label) meta.label = String(msg.label);
                if (msg.activeItem !== undefined) meta.activeItem = msg.activeItem;

                if (msg.adminKey !== undefined) {
                    const valid = msg.adminKey ? await verifyAdminKey(String(msg.adminKey)) : false;
                    meta.isAdmin = valid;
                    meta.role = valid ? 'admin' : 'public';
                }

                // Socket may have closed while awaiting verifyAdminKey
                if (!clients.has(ws) || ws.readyState !== 1) return;

                meta.joined = true;
                evictDuplicateClientId(meta.clientId, ws);

                try {
                    ws.send(JSON.stringify({
                        type: 'presence:ack',
                        clientId: meta.clientId,
                        isAdmin: meta.isAdmin,
                        role: meta.role,
                        syncSeq: serverSyncSeq
                    }));
                } catch (e) {}

                broadcastPresence();

                if (meta.sheetUrl && roomBusOptions.has(meta.sheetUrl)) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'delta:busOptionsAll',
                            sheetUrl: meta.sheetUrl,
                            busOptions: roomBusOptions.get(meta.sheetUrl),
                            busOptionsByJuncture: roomBusOptions.get(meta.sheetUrl)
                        }));
                    } catch (e) {}
                }
                break;
            }

            case 'presence:leave': {
                removeClientSocket(ws, true);
                try { ws.close(1000, 'leave'); } catch (e) {}
                break;
            }

            case 'ephemeral:focus': {
                meta.activeItem = msg.item || null;
                broadcastScopedDelta(meta.sheetUrl || msg.sheetUrl, {
                    type: 'ephemeral:focus',
                    clientId: meta.clientId,
                    color: meta.color,
                    label: meta.label,
                    view: meta.view,
                    sheetUrl: meta.sheetUrl || msg.sheetUrl,
                    item: msg.item || null
                }, { excludeWs: ws });
                break;
            }

            case 'live:commAttendance': {
                const { sheetUrl, multipleUpdates } = msg;
                if (!sheetUrl || !multipleUpdates) break;
                touchLiveWsMutation(sheetUrl);
                getScopedCachedBoth('fetchCommAttendance', { sheetUrl }).forEach(c => patchCommAttendanceState(c, multipleUpdates));
                getScopedCachedBoth('fetchManualPairingData', { sheetUrl }).forEach(p => patchPairingDataFromCommSync(p, multipleUpdates));

                broadcastScopedDelta(sheetUrl, {
                    type: 'delta:commAttendance',
                    sheetUrl,
                    multipleUpdates,
                    senderId: msg.senderId || meta.clientId,
                    syncSeq: bumpSyncSeq(),
                    timestamp: Date.now()
                }, { excludeWs: ws });
                break;
            }

            case 'live:busOptions': {
                const { sheetUrl, juncture, busOptions, action: busAction, busName } = msg;
                if (!sheetUrl || !juncture || (!Array.isArray(busOptions) && !busName)) break;
                touchLiveWsMutation(sheetUrl);

                if (!roomBusOptions.has(sheetUrl)) roomBusOptions.set(sheetUrl, {});
                const currentMap = roomBusOptions.get(sheetUrl);
                let opts = Array.isArray(currentMap[juncture]) ? [...currentMap[juncture]] : null;
                if (!opts) {
                    const set = new Set(['Bus 1']);
                    const commData = getScopedCachedBoth('fetchCommAttendance', { sheetUrl })[0];
                    if (commData && commData.busAttendance && commData.busAttendance[juncture]) {
                        Object.values(commData.busAttendance[juncture]).forEach(b => {
                            if (b && String(b).trim()) set.add(String(b).trim());
                        });
                    }
                    opts = Array.from(set);
                }

                const cleanBusName = busName ? String(busName).trim() : '';
                if (busAction === 'add' && cleanBusName) {
                    if (!opts.includes(cleanBusName)) opts.push(cleanBusName);
                } else if (busAction === 'remove' && cleanBusName) {
                    opts = opts.filter(b => b !== cleanBusName);
                    if (opts.length === 0) opts = ['Bus 1'];
                } else if (Array.isArray(busOptions)) {
                    opts = Array.from(new Set([...opts, ...busOptions.map(b => String(b).trim()).filter(Boolean)]));
                }

                opts.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                currentMap[juncture] = opts;

                getScopedCachedBoth('fetchCommAttendance', { sheetUrl }).forEach(c => attachRoomBusOptions(sheetUrl, c));

                const sentSorted = Array.isArray(busOptions)
                    ? [...busOptions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                    : [];
                const mergedDiffersFromSender = JSON.stringify(opts) !== JSON.stringify(sentSorted);

                broadcastScopedDelta(sheetUrl, {
                    type: 'delta:busOptions',
                    sheetUrl,
                    juncture,
                    busOptions: opts,
                    senderId: msg.senderId || meta.clientId,
                    forceApply: mergedDiffersFromSender,
                    syncSeq: bumpSyncSeq(),
                    timestamp: Date.now()
                }, { excludeWs: mergedDiffersFromSender ? null : ws });
                break;
            }

            case 'live:pairing': {
                if (!meta.isAdmin) {
                    try { ws.send(JSON.stringify({ type: 'auth:error', message: 'Admin authentication required for pairing edits.' })); } catch (e) {}
                    break;
                }
                const { sheetUrl, updates } = msg;
                if (!sheetUrl || !Array.isArray(updates)) break;
                touchLiveWsMutation(sheetUrl);
                patchStatesOnPairingUpdate(sheetUrl, updates);

                broadcastScopedDelta(sheetUrl, {
                    type: 'delta:pairing',
                    sheetUrl,
                    updates,
                    senderId: msg.senderId || meta.clientId,
                    syncSeq: bumpSyncSeq(),
                    timestamp: Date.now()
                }, { excludeWs: ws });
                break;
            }

            case 'live:grouping': {
                if (!meta.isAdmin) {
                    try { ws.send(JSON.stringify({ type: 'auth:error', message: 'Admin authentication required for grouping edits.' })); } catch (e) {}
                    break;
                }
                const { sheetUrl, updates, activeGroups, deletedGroup } = msg;
                if (!sheetUrl) break;
                touchLiveWsMutation(sheetUrl);
                if (Array.isArray(updates)) {
                    patchStatesOnGroupingUpdate(sheetUrl, updates);
                }

                broadcastScopedDelta(sheetUrl, {
                    type: 'delta:grouping',
                    sheetUrl,
                    updates: updates || [],
                    activeGroups: activeGroups || null,
                    deletedGroup: deletedGroup || null,
                    senderId: msg.senderId || meta.clientId,
                    syncSeq: bumpSyncSeq(),
                    timestamp: Date.now()
                }, { excludeWs: ws });
                break;
            }

            case 'live:personAttendance': {
                const { sheetUrl, targetName, data } = msg;
                const role = msg.role || msg.personType;
                if (!sheetUrl || !role || !data) break;
                touchLiveWsMutation(sheetUrl);
                patchStatesOnPersonAttendanceUpdate(sheetUrl, role, targetName, data);

                broadcastScopedDelta(sheetUrl, {
                    type: 'delta:personAttendance',
                    sheetUrl,
                    role,
                    personType: role,
                    targetName,
                    data,
                    senderId: msg.senderId || meta.clientId,
                    syncSeq: bumpSyncSeq(),
                    timestamp: Date.now()
                }, { excludeWs: ws });
                break;
            }

            case 'ping': {
                try { ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); } catch (e) {}
                break;
            }
        }
    });

    ws.on('close', () => removeClientSocket(ws, true));
    ws.on('error', () => removeClientSocket(ws, true));
});

// =========================================================
// READ ENGINE WITH ROLE-SCOPED CACHE & READ COLLAPSING
// =========================================================
function getOutingThresholdDateNum() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const tY = d.getFullYear();
    const tM = String(d.getMonth() + 1).padStart(2, '0');
    const tD = String(d.getDate()).padStart(2, '0');
    return parseInt(`${tY}${tM}${tD}`, 10);
}

function filterRecentOutingSheets(resObj) {
    if (!resObj || !resObj.success || !Array.isArray(resObj.data)) return resObj;
    const threshold = getOutingThresholdDateNum();
    resObj.data = resObj.data.filter(item => {
        if (!item) return false;
        let dateNum = item.folderDateNum ? parseInt(item.folderDateNum, 10) : NaN;
        if (isNaN(dateNum) && item.fullName) {
            const m = String(item.fullName).match(/(\d{8})/);
            if (m) dateNum = parseInt(m[1], 10);
        }
        if (isNaN(dateNum) && item.formattedDate) {
            const parsed = new Date(item.formattedDate);
            if (!isNaN(parsed.getTime())) {
                const y = parsed.getFullYear();
                const m = String(parsed.getMonth() + 1).padStart(2, '0');
                const d = String(parsed.getDate()).padStart(2, '0');
                dateNum = parseInt(`${y}${m}${d}`, 10);
            }
        }
        return isNaN(dateNum) ? true : dateNum >= threshold;
    });
    return resObj;
}

async function executeReadAction(action, data, options = {}) {
    const { scope = 'public', bypassCache = false, adminKey = '' } = options;
    const cacheKey = getReadCacheKey(scope, action, data);
    const sheetUrl = (data && typeof data === 'object') ? (data.sheetUrl || data.url) : (typeof data === 'string' ? data : null);

    if (!bypassCache) {
        const cachedResponse = stateCache.get(cacheKey);
        if (cachedResponse) {
            const patched = applyPendingMutationsToState(action, data, cachedResponse);
            return action === 'getRecentOutingSheets'
                ? filterRecentOutingSheets(patched)
                : (action === 'fetchCommAttendance' ? attachRoomBusOptions(sheetUrl, patched) : patched);
        }
    }

    if (inFlightReads.has(cacheKey)) {
        const res = await inFlightReads.get(cacheKey);
        const patched = applyPendingMutationsToState(action, data, res);
        return action === 'getRecentOutingSheets'
            ? filterRecentOutingSheets(patched)
            : (action === 'fetchCommAttendance' ? attachRoomBusOptions(sheetUrl, patched) : patched);
    }

    const fetchPromise = (async () => {
        const readStartedAt = Date.now();
        const parsed = await fetchFromGAS(action, data, { maxAttempts: 3, adminKey });
        const existingCached = stateCache.get(cacheKey);
        if (bypassCache && sheetUrl && (lastLiveWsMutationAt.get(sheetUrl) || 0) > readStartedAt && existingCached) {
            const kept = applyPendingMutationsToState(action, data, existingCached);
            return action === 'fetchCommAttendance' ? attachRoomBusOptions(sheetUrl, kept) : kept;
        }
        let patched = applyPendingMutationsToState(action, data, parsed);
        if (action === 'getRecentOutingSheets') {
            patched = filterRecentOutingSheets(patched);
        } else if (action === 'fetchCommAttendance') {
            patched = attachRoomBusOptions(sheetUrl, patched);
        }
        if (patched && patched.success !== false) {
            stateCache.set(cacheKey, patched);
        }
        return patched;
    })();

    inFlightReads.set(cacheKey, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inFlightReads.delete(cacheKey);
    }
}

// =========================================================
// EXPRESS API ROUTES
// =========================================================
app.use(express.text({ type: '*/*', limit: '50mb' }));

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        env: config.ENV,
        clients: clients.size,
        queueDepth: writeQueue.depth,
        syncSeq: serverSyncSeq,
        uptimeSec: Math.round(process.uptime())
    });
});

app.post('/api/presence/leave', (req, res) => {
    try {
        const parsed = typeof req.body === 'string' && req.body ? JSON.parse(req.body) : req.body;
        const leavingClientId = parsed && parsed.clientId ? String(parsed.clientId) : null;
        if (leavingClientId && evictDuplicateClientId(leavingClientId, null)) {
            broadcastPresence();
        }
    } catch (e) {}
    return res.status(204).end();
});

app.post('/api', async (req, res) => {
    let parsedBody;
    try {
        parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid JSON body' });
    }

    const { action, data, clientId } = parsedBody || {};
    const adminKey = String(parsedBody.adminKey || (data && typeof data === 'object' ? data.adminKey : '') || '');

    if (!action) {
        return res.status(400).json({ success: false, message: 'Missing action' });
    }

    // Direct lightweight getSyncState served from RAM when available (0ms)
    if (action === 'getSyncState') {
        const isAdmin = adminKey ? await verifyAdminKey(adminKey) : false;
        return res.json({
            success: true,
            status: 'success',
            seq: serverSyncSeq,
            changed: false,
            global: Date.now(),
            domains: {},
            events: [],
            authInfo: { isAdmin }
        });
    }

    // Verify password action (also warms authCache)
    if (action === 'verifyAdminPassword') {
        const isValid = await verifyAdminKey(String(data || ''));
        return res.json(isValid);
    }

    // Enforce Admin auth server-side on all Admin-only actions
    let isAdmin = false;
    if (ADMIN_ONLY_ACTIONS.has(action)) {
        const keyToVerify = action === 'changeAdminPassword' && data && data.currentPassword
            ? String(data.currentPassword)
            : adminKey;
        isAdmin = await verifyAdminKey(keyToVerify);
        if (!isAdmin) {
            return res.status(401).json({
                success: false,
                authError: true,
                message: 'Admin authentication required.'
            });
        }
    } else if (adminKey) {
        isAdmin = await verifyAdminKey(adminKey);
    }

    const scope = isAdmin ? 'admin' : 'public';

    if (action === 'forceBackendRefresh') {
        console.log('[CACHE] Flushed via forceBackendRefresh');
        stateCache.flushAll();
    }

    if (READ_ACTIONS.has(action)) {
        try {
            const response = await executeReadAction(action, data, { scope, bypassCache: false, adminKey });
            return res.json(response);
        } catch (err) {
            console.error(`[ERROR] Read ${action}:`, err.message);
            return res.status(500).json({ success: false, message: 'Server Error contacting backend' });
        }
    }

    const sheetUrl = (data && typeof data === 'object') ? (data.sheetUrl || data.url) : (typeof data === 'string' ? data : null);

    // =========================================================
    // 0ms OPTIMISTIC WRITES + FIFO BACKGROUND GAS QUEUE
    // =========================================================
    if (action === 'syncCommAttendance' && data && data.sheetUrl && data.multipleUpdates) {
        const mutationId = addPendingServerMutation(data.sheetUrl, action, data);
        touchLiveWsMutation(data.sheetUrl);
        getScopedCachedBoth('fetchCommAttendance', { sheetUrl: data.sheetUrl }).forEach(c => patchCommAttendanceState(c, data.multipleUpdates));
        getScopedCachedBoth('fetchManualPairingData', { sheetUrl: data.sheetUrl }).forEach(p => patchPairingDataFromCommSync(p, data.multipleUpdates));

        const seq = bumpSyncSeq();
        broadcastScopedDelta(data.sheetUrl, {
            type: 'delta:commAttendance',
            sheetUrl: data.sheetUrl,
            multipleUpdates: data.multipleUpdates,
            senderId: clientId || null,
            syncSeq: seq,
            timestamp: Date.now()
        });

        writeQueue.add(async () => {
            try {
                await fetchFromGAS(action, data, { maxAttempts: 3, adminKey, clientId });
            } catch (err) {
                console.error(`[QUEUE ERROR] ${action}:`, err.message);
            } finally {
                removePendingServerMutation(data.sheetUrl, mutationId);
            }
        });

        return res.json({ success: true, optimistic: true, syncSeq: seq });
    }

    if (action === 'syncManualPairingUpdates' && data && data.sheetUrl && Array.isArray(data.updates)) {
        const mutationId = addPendingServerMutation(data.sheetUrl, action, data);
        touchLiveWsMutation(data.sheetUrl);
        patchStatesOnPairingUpdate(data.sheetUrl, data.updates);

        const seq = bumpSyncSeq();
        broadcastScopedDelta(data.sheetUrl, {
            type: 'delta:pairing',
            sheetUrl: data.sheetUrl,
            updates: data.updates,
            senderId: clientId || null,
            syncSeq: seq,
            timestamp: Date.now()
        });

        writeQueue.add(async () => {
            try {
                if (data.updates.some(u => u && u.op && u.volName) && !stateCache.get(getReadCacheKey('admin', 'fetchManualPairingData', { sheetUrl: data.sheetUrl }))) {
                    await executeReadAction('fetchManualPairingData', { sheetUrl: data.sheetUrl }, { scope: 'admin', bypassCache: false, adminKey });
                    patchStatesOnPairingUpdate(data.sheetUrl, data.updates);
                }
                await fetchFromGAS(action, data, { maxAttempts: 3, adminKey, clientId });
            } catch (err) {
                console.error(`[QUEUE ERROR] ${action}:`, err.message);
            } finally {
                removePendingServerMutation(data.sheetUrl, mutationId);
            }
        });

        return res.json({ success: true, optimistic: true, syncSeq: seq });
    }

    if (action === 'syncManualGroupingUpdates' && data && data.sheetUrl && Array.isArray(data.updates)) {
        const mutationId = addPendingServerMutation(data.sheetUrl, action, data);
        touchLiveWsMutation(data.sheetUrl);
        patchStatesOnGroupingUpdate(data.sheetUrl, data.updates);

        const seq = bumpSyncSeq();
        broadcastScopedDelta(data.sheetUrl, {
            type: 'delta:grouping',
            sheetUrl: data.sheetUrl,
            updates: data.updates,
            senderId: clientId || null,
            syncSeq: seq,
            timestamp: Date.now()
        });

        writeQueue.add(async () => {
            try {
                await fetchFromGAS(action, data, { maxAttempts: 3, adminKey, clientId });
            } catch (err) {
                console.error(`[QUEUE ERROR] ${action}:`, err.message);
            } finally {
                removePendingServerMutation(data.sheetUrl, mutationId);
            }
        });

        return res.json({ success: true, optimistic: true, syncSeq: seq });
    }

    if (action === 'submitAttendanceData' && data && data.sheetUrl) {
        const mutationId = addPendingServerMutation(data.sheetUrl, action, data);
        touchLiveWsMutation(data.sheetUrl);
        patchStatesOnPersonAttendanceUpdate(data.sheetUrl, data.type, data.targetName, data.data);

        const seq = bumpSyncSeq();
        broadcastScopedDelta(data.sheetUrl, {
            type: 'delta:personAttendance',
            sheetUrl: data.sheetUrl,
            role: data.type,
            personType: data.type,
            targetName: data.targetName,
            data: data.data,
            senderId: clientId || null,
            syncSeq: seq,
            timestamp: Date.now()
        });

        writeQueue.add(async () => {
            try {
                const parsed = await fetchFromGAS(action, data, { maxAttempts: 3, adminKey, clientId });
                if (parsed && parsed.success && data.sheetUrl) {
                    delScopedCachedBoth('getOutingDetails', data.sheetUrl);
                    // Only refresh admin stats if an admin is actively viewing dashboard
                    const hasAdminDashboard = Array.from(clients.values()).some(m => m.isAdmin && m.view === 'admin');
                    if (hasAdminDashboard && adminKey) {
                        executeReadAction('getOutingDetails', data.sheetUrl, { scope: 'admin', bypassCache: true, adminKey }).then(freshStats => {
                            if (freshStats && freshStats.success) {
                                broadcastScopedDelta(data.sheetUrl, {
                                    type: 'state:outingStats',
                                    sheetUrl: data.sheetUrl,
                                    statsData: freshStats,
                                    details: freshStats,
                                    timestamp: Date.now()
                                }, { adminOnly: true });
                            }
                        }).catch(() => {});
                    }
                }
            } catch (err) {
                console.error(`[QUEUE ERROR] ${action}:`, err.message);
            } finally {
                removePendingServerMutation(data.sheetUrl, mutationId);
            }
        });

        return res.json({ success: true, optimistic: true, message: 'Attendance updated successfully!', syncSeq: seq });
    }

    if (action === 'saveAppSettings' && data && typeof data === 'object') {
        const warmSettings = stateCache.get(getReadCacheKey('admin', 'getAppSettings', null)) || stateCache.get(getReadCacheKey('public', 'getAppSettings', null));
        if (warmSettings) {
            setScopedCachedBoth('getAppSettings', null, data);
            const seq = bumpSyncSeq();
            broadcastScopedDelta(null, {
                type: 'global:settingsUpdated',
                settings: data,
                senderId: clientId || null,
                syncSeq: seq,
                timestamp: Date.now()
            }, { globalBroadcast: true });

            writeQueue.add(async () => {
                try {
                    await fetchFromGAS(action, data, { maxAttempts: 3, adminKey, clientId });
                } catch (err) {
                    console.error('[QUEUE ERROR] saveAppSettings:', err.message);
                }
            });

            return res.json({ success: true, optimistic: true, message: 'Settings saved successfully!', syncSeq: seq });
        }
    }

    // =========================================================
    // SYNCHRONOUS QUEUED WRITES (Structural / Auth / Cold Settings)
    // =========================================================
    try {
        const response = await writeQueue.add(async () => {
            const parsed = await fetchFromGAS(action, data, { maxAttempts: 3, adminKey, clientId });

            if (action === 'addCommJuncture' || action === 'deleteCommJuncture') {
                if (parsed && parsed.success && sheetUrl) {
                    applyPendingMutationsToState('fetchCommAttendance', { sheetUrl }, parsed);
                    attachRoomBusOptions(sheetUrl, parsed);
                    setScopedCachedBoth('fetchCommAttendance', { sheetUrl }, parsed);
                    broadcastScopedDelta(sheetUrl, {
                        type: 'state:commAttendance',
                        sheetUrl,
                        data: parsed,
                        senderId: clientId || null,
                        syncSeq: bumpSyncSeq(),
                        timestamp: Date.now()
                    });
                }
            } else if (action === 'runAutoPairing' || action === 'runAutoGrouping') {
                if (parsed && parsed.success && sheetUrl) {
                    delScopedCachedBoth('fetchManualPairingData', { sheetUrl });
                    delScopedCachedBoth('fetchCommAttendance', { sheetUrl });
                    delScopedCachedBoth('getOutingDetails', sheetUrl);
                    Promise.all([
                        executeReadAction('fetchManualPairingData', { sheetUrl }, { scope: 'admin', bypassCache: true, adminKey }),
                        executeReadAction('fetchCommAttendance', { sheetUrl }, { scope: 'public', bypassCache: true })
                    ]).then(([freshPair, freshComm]) => {
                        if (freshPair && freshPair.success) {
                            broadcastScopedDelta(sheetUrl, {
                                type: 'state:pairingData',
                                sheetUrl,
                                data: freshPair.data,
                                syncSeq: bumpSyncSeq(),
                                timestamp: Date.now()
                            }, { adminOnly: true });
                        }
                        if (freshComm && freshComm.success) {
                            setScopedCachedBoth('fetchCommAttendance', { sheetUrl }, freshComm);
                            broadcastScopedDelta(sheetUrl, {
                                type: 'state:commAttendance',
                                sheetUrl,
                                data: freshComm,
                                syncSeq: bumpSyncSeq(),
                                timestamp: Date.now()
                            });
                        }
                    }).catch(() => {});
                }
            } else if (action === 'createOuting' || action === 'updateOuting' || action === 'forceBackendRefresh') {
                stateCache.flushAll();
                executeReadAction('getRecentOutingSheets', null, { scope: 'public', bypassCache: true }).then(freshOutings => {
                    if (freshOutings && freshOutings.success) {
                        setScopedCachedBoth('getRecentOutingSheets', null, freshOutings);
                        broadcastScopedDelta(null, {
                            type: 'global:outingsUpdated',
                            sheets: freshOutings.data,
                            sheetUrl: sheetUrl || null,
                            syncSeq: bumpSyncSeq(),
                            timestamp: Date.now()
                        }, { globalBroadcast: true });
                    }
                }).catch(() => {});
            } else if (action === 'saveAppSettings') {
                if (parsed && parsed.success) {
                    setScopedCachedBoth('getAppSettings', null, data);
                    broadcastScopedDelta(null, {
                        type: 'global:settingsUpdated',
                        settings: data,
                        senderId: clientId || null,
                        syncSeq: bumpSyncSeq(),
                        timestamp: Date.now()
                    }, { globalBroadcast: true });
                }
            } else if (action === 'changeAdminPassword') {
                if (parsed && parsed.success) {
                    authCache.flushAll();
                    if (data && data.newPassword) {
                        authCache.set(hashAdminKey(data.newPassword), true, 120);
                    }
                }
            }

            return parsed;
        });

        return res.json(response);
    } catch (err) {
        console.error(`[ERROR] Write action ${action} failed:`, err.message);
        return res.status(500).json({ success: false, message: 'Server Error on Write' });
    }
});

// =========================================================
// STRICT STATIC FILE ALLOWLIST (404 on server.js, package.json, backend/Code.js, etc.)
// =========================================================
app.use('/frontend', express.static(path.join(__dirname, 'frontend'), { dotfiles: 'deny' }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny' }));

app.get('/backend/config.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'backend', 'config.js'));
});

app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets', 'icon-192.png'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:file', (req, res, next) => {
    const file = String(req.params.file || '');
    if (ALLOWED_ROOT_FILES.has(file)) {
        return res.sendFile(path.join(__dirname, file));
    }
    return next();
});

// Explicit 404 for all non-allowlisted paths (blocks /server.js, /package.json, /backend/Code.js, etc.)
app.use((req, res) => {
    res.status(404).send('Not Found');
});

// =========================================================
// GRACEFUL SHUTDOWN (Drain pending GAS writes before exit)
// =========================================================
let isShuttingDown = false;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[SHUTDOWN] Received ${signal}. Draining ${writeQueue.depth} pending GAS write(s)...`);

    clearInterval(wsHeartbeatInterval);
    for (const [ws] of Array.from(clients.entries())) {
        try { ws.close(1001, 'Server shutting down'); } catch (e) {}
    }

    server.close(() => {});

    try {
        await Promise.race([
            writeQueue.drain(),
            new Promise(resolve => setTimeout(resolve, 15000))
        ]);
    } catch (e) {}

    console.log('[SHUTDOWN] Drain complete. Exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`MYG Real-Time Collaboration Server listening on http://0.0.0.0:${PORT} (${config.ENV})`);
    console.log(`GAS Backend: ${config.GAS_BACKEND_URL}`);
});
