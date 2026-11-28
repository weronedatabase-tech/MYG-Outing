/**
 * Main Bootstrap: Theme, Environment Banner, Global Collab Listeners,
 * Admin Navbar Indicator, Toast & Custom Modal System, Keyboard Shortcuts, SW Registration
 */

document.addEventListener('DOMContentLoaded', () => {
    // 1. Theme initialization
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // 2. Environment Banner
    const envBar = document.getElementById('envBar');
    if (envBar) {
        if (ENV === 'Dev') {
            envBar.innerText = 'Testing';
            envBar.classList.add('bg-red-600', 'border-red-800');
            envBar.classList.remove('hidden');
        } else if (ENV === 'Exp') {
            envBar.innerText = 'Experimentation';
            envBar.classList.add('bg-purple-600', 'border-purple-800');
            envBar.classList.remove('hidden');
        }
    }

    const realtimeBase = typeof window.getRealtimeServerBaseUrl === 'function' ? window.getRealtimeServerBaseUrl() : '';
    console.log(`Running in ${ENV} mode | Transport: ${realtimeBase ? 'Realtime Node (' + realtimeBase + ')' : 'Direct GAS'}`);

    // 3. Navbar Presence Badge + Admin Lock/Logout Indicator
    if (window.LiveSync && typeof window.LiveSync.refreshPresenceBadge === 'function') {
        window.LiveSync.refreshPresenceBadge();
    }
    window.updateAdminNavIndicator();
    bindGlobalCollabEvents();
    initGlobalKeyboardShortcuts();
    initOfflineBanner();

    // 4. Load App Settings
    apiCall('getAppSettings', null).then(res => {
        if (res && res.success !== false) {
            appSettings = res;
        }
    });

    // 5. Validate cached Admin session silently
    const savedKey = localStorage.getItem('adminKey');
    if (savedKey) {
        if (sessionStorage.getItem('adminKeyValidated') === savedKey) {
            isAdminAuthenticated = true;
            window.updateAdminNavIndicator();
        } else {
            apiCall('verifyAdminPassword', savedKey).then(isValid => {
                if (isValid === true) {
                    isAdminAuthenticated = true;
                    sessionStorage.setItem('adminKeyValidated', savedKey);
                    if (window.LiveSync) window.LiveSync.refreshAuth();
                } else {
                    localStorage.removeItem('adminKey');
                    sessionStorage.removeItem('adminKeyValidated');
                    isAdminAuthenticated = false;
                }
                window.updateAdminNavIndicator();
            });
        }
    }

    silentHydration();
});

// =========================================================
// ADMIN SESSION INDICATOR & LOGOUT BUTTON IN NAVBAR
// =========================================================
window.updateAdminNavIndicator = function() {
    const refreshBtn = document.querySelector('button[onclick="refreshApp()"]');
    if (!refreshBtn || !refreshBtn.parentElement) return;

    let btn = document.getElementById('adminLogoutNavBtn');
    if (isAdminAuthenticated) {
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'adminLogoutNavBtn';
            btn.type = 'button';
            btn.onclick = () => window.logoutAdmin && window.logoutAdmin();
            btn.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold border border-blue-200 dark:border-blue-800/70 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 hover:bg-red-50 hover:text-red-600 hover:border-red-300 dark:hover:bg-red-950/50 dark:hover:text-red-400 transition-colors shrink-0';
            btn.title = 'Admin signed in — click to lock / sign out';
            btn.setAttribute('aria-label', 'Sign out of Admin mode');
            btn.innerHTML = `<i class="fa-solid fa-shield-halved text-[9px]"></i><span class="hidden sm:inline">Admin</span><i class="fa-solid fa-right-from-bracket text-[9px] opacity-75"></i>`;
            const badge = document.getElementById('collabPresenceBadge');
            refreshBtn.parentElement.insertBefore(btn, badge || refreshBtn);
        }
        btn.classList.remove('hidden');
    } else if (btn) {
        btn.classList.add('hidden');
    }
};

// =========================================================
// GLOBAL TOAST NOTIFICATION SYSTEM (with Optional Undo)
// =========================================================
let toastTimeoutId = null;
window.showToast = function(message, type = 'info', options = {}) {
    if (!message) return;
    const { undoLabel = 'Undo', onUndo = null, durationMs = onUndo ? 4500 : 3000 } = options || {};

    let container = document.getElementById('mygGlobalToast');
    if (!container) {
        container = document.createElement('div');
        container.id = 'mygGlobalToast';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        container.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-[150] max-w-[92vw] w-auto pointer-events-none transition-all duration-200 opacity-0 translate-y-2';
        document.body.appendChild(container);
    }

    if (toastTimeoutId) clearTimeout(toastTimeoutId);

    const palette = type === 'success'
        ? 'bg-zinc-900 dark:bg-zinc-800 text-white border-emerald-500/60'
        : type === 'error'
            ? 'bg-red-600 text-white border-red-400/60'
            : 'bg-zinc-900 dark:bg-zinc-800 text-white border-zinc-700';

    const icon = type === 'success'
        ? '<i class="fa-solid fa-circle-check text-emerald-400 shrink-0"></i>'
        : type === 'error'
            ? '<i class="fa-solid fa-circle-exclamation text-white shrink-0"></i>'
            : '<i class="fa-solid fa-circle-info text-blue-400 shrink-0"></i>';

    container.innerHTML = `
        <div class="pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-2xl text-xs md:text-sm font-semibold ${palette}">
            ${icon}
            <span class="leading-snug">${window.escapeHtml(message)}</span>
            ${typeof onUndo === 'function' ? `<button type="button" id="mygToastUndoBtn" class="ml-1 px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white font-black text-xs uppercase tracking-wider transition-colors shrink-0">${window.escapeHtml(undoLabel)}</button>` : ''}
        </div>
    `;

    if (typeof onUndo === 'function') {
        const undoBtn = document.getElementById('mygToastUndoBtn');
        if (undoBtn) {
            undoBtn.onclick = () => {
                if (toastTimeoutId) clearTimeout(toastTimeoutId);
                container.classList.add('opacity-0', 'translate-y-2');
                try { onUndo(); } catch (e) {}
            };
        }
    }

    requestAnimationFrame(() => {
        container.classList.remove('opacity-0', 'translate-y-2');
    });

    toastTimeoutId = setTimeout(() => {
        container.classList.add('opacity-0', 'translate-y-2');
    }, durationMs);
};

// =========================================================
// CUSTOM STYLED PROMPT & CONFIRM MODALS (Replaces browser prompt/confirm)
// =========================================================
window.showCustomPrompt = function({ title = 'Enter Value', message = '', placeholder = '', defaultValue = '', confirmText = 'Confirm', confirmClass = 'bg-primary hover:bg-blue-600' } = {}) {
    return new Promise((resolve) => {
        const existing = document.getElementById('mygCustomDialog');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'mygCustomDialog';
        modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[140] flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-zinc-900 w-full max-w-sm rounded-2xl border border-gray-200 dark:border-zinc-800 p-5 shadow-2xl">
                <h3 class="text-base font-bold text-gray-900 dark:text-white mb-1">${window.escapeHtml(title)}</h3>
                ${message ? `<p class="text-xs text-gray-500 dark:text-gray-400 mb-3">${window.escapeHtml(message)}</p>` : ''}
                <form id="mygCustomDialogForm">
                    <input type="text" id="mygCustomDialogInput" value="${window.escapeHtml(defaultValue)}" placeholder="${window.escapeHtml(placeholder)}" class="w-full bg-gray-50 dark:bg-black border border-gray-300 dark:border-zinc-700 rounded-lg py-2.5 px-3 text-sm text-gray-900 dark:text-white focus:border-primary outline-none shadow-sm mb-4" autocomplete="off">
                    <div class="flex gap-2">
                        <button type="button" id="mygCustomDialogCancel" class="flex-1 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 font-bold py-2 rounded-lg text-sm transition-colors">Cancel</button>
                        <button type="submit" class="flex-1 ${confirmClass} text-white font-bold py-2 rounded-lg text-sm transition-colors">${window.escapeHtml(confirmText)}</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(modal);

        const input = document.getElementById('mygCustomDialogInput');
        const closeWith = (val) => {
            modal.remove();
            resolve(val);
        };

        document.getElementById('mygCustomDialogCancel').onclick = () => closeWith(null);
        modal.onclick = (e) => { if (e.target === modal) closeWith(null); };
        document.getElementById('mygCustomDialogForm').onsubmit = (e) => {
            e.preventDefault();
            closeWith(input.value);
        };
        setTimeout(() => { input.focus(); input.select(); }, 30);
    });
};

window.showCustomConfirm = function({ title = 'Confirm Action', message = '', confirmText = 'Confirm', cancelText = 'Cancel', destructive = false } = {}) {
    return new Promise((resolve) => {
        const existing = document.getElementById('mygCustomDialog');
        if (existing) existing.remove();

        const btnClass = destructive
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-primary hover:bg-blue-600 text-white';

        const modal = document.createElement('div');
        modal.id = 'mygCustomDialog';
        modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[140] flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-zinc-900 w-full max-w-sm rounded-2xl border border-gray-200 dark:border-zinc-800 p-5 shadow-2xl">
                <h3 class="text-base font-bold text-gray-900 dark:text-white mb-2">${window.escapeHtml(title)}</h3>
                <p class="text-sm text-gray-600 dark:text-gray-300 mb-5 leading-relaxed">${window.escapeHtml(message)}</p>
                <div class="flex gap-2">
                    <button type="button" id="mygCustomDialogCancel" class="flex-1 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 font-bold py-2.5 rounded-lg text-sm transition-colors">${window.escapeHtml(cancelText)}</button>
                    <button type="button" id="mygCustomDialogOk" class="flex-1 ${btnClass} font-bold py-2.5 rounded-lg text-sm transition-colors">${window.escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const closeWith = (val) => {
            modal.remove();
            resolve(val);
        };

        document.getElementById('mygCustomDialogCancel').onclick = () => closeWith(false);
        document.getElementById('mygCustomDialogOk').onclick = () => closeWith(true);
        modal.onclick = (e) => { if (e.target === modal) closeWith(false); };
        setTimeout(() => document.getElementById('mygCustomDialogOk')?.focus(), 30);
    });
};

// =========================================================
// OFFLINE BANNER & KEYBOARD ACCESSIBILITY (Escape-to-Close)
// =========================================================
function initOfflineBanner() {
    const updateOfflineUI = () => {
        let banner = document.getElementById('mygOfflineBanner');
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (offline) {
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'mygOfflineBanner';
                banner.className = 'fixed bottom-0 inset-x-0 z-[130] bg-amber-600 text-white text-center text-xs font-bold py-1.5 px-3 shadow-lg';
                banner.innerHTML = '<i class="fa-solid fa-wifi mr-1.5"></i>You are offline. Changes are queued locally and will sync automatically when reconnected.';
                document.body.appendChild(banner);
            }
            banner.classList.remove('hidden');
        } else if (banner) {
            banner.classList.add('hidden');
        }
    };
    window.addEventListener('online', updateOfflineUI);
    window.addEventListener('offline', updateOfflineUI);
    updateOfflineUI();
}

function initGlobalKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;

        const customDialog = document.getElementById('mygCustomDialog');
        if (customDialog) {
            document.getElementById('mygCustomDialogCancel')?.click();
            return;
        }
        const globalGroup = document.getElementById('globalGroupSelectModal');
        if (globalGroup && !globalGroup.classList.contains('hidden') && typeof window.closeGlobalGroupSelect === 'function') {
            window.closeGlobalGroupSelect();
            return;
        }
        const authModal = document.getElementById('authModal');
        if (authModal && !authModal.classList.contains('hidden') && typeof closeAuthModal === 'function') {
            closeAuthModal(true);
            return;
        }
        const personInfo = document.getElementById('personInfoModal');
        if (personInfo && !personInfo.classList.contains('hidden') && typeof closePersonInfoModal === 'function') {
            closePersonInfoModal();
            return;
        }
        const busModal = document.getElementById('busTrackerModal');
        if (busModal && !busModal.classList.contains('hidden') && typeof closeBusTrackerModal === 'function') {
            closeBusTrackerModal();
            return;
        }
        const quickPair = document.getElementById('quickPairModal');
        if (quickPair && !quickPair.classList.contains('hidden') && typeof closeQuickPairModal === 'function') {
            closeQuickPairModal();
            return;
        }
        const quickGroup = document.getElementById('quickGroupModal');
        if (quickGroup && !quickGroup.classList.contains('hidden') && typeof closeQuickGroupModal === 'function') {
            closeQuickGroupModal();
            return;
        }
        const assignIC = document.getElementById('assignICModal');
        if (assignIC && !assignIC.classList.contains('hidden') && typeof closeAssignICModal === 'function') {
            closeAssignICModal();
            return;
        }
        const exportModal = document.getElementById('exportTableModal');
        if (exportModal && !exportModal.classList.contains('hidden') && typeof closeTableExportModal === 'function') {
            closeTableExportModal();
            return;
        }
        const createModal = document.getElementById('createModal');
        if (createModal && !createModal.classList.contains('hidden') && typeof closeModal === 'function') {
            closeModal();
            return;
        }
        const editModal = document.getElementById('editModal');
        if (editModal && !editModal.classList.contains('hidden') && typeof closeEditModal === 'function') {
            closeEditModal();
            return;
        }
        const reminderModal = document.getElementById('reminderModal');
        if (reminderModal && !reminderModal.classList.contains('hidden') && typeof closeReminderModal === 'function') {
            closeReminderModal();
            return;
        }
    });
}

// =========================================================
// REMOTE COLLABORATIVE FOCUS INDICATORS & GLOBAL EVENTS
// =========================================================
window.applyAllCollabRemoteFocus = function() {
    document.querySelectorAll('.collab-remote-focus').forEach(el => {
        el.classList.remove('collab-remote-focus');
        el.style.removeProperty('--collab-color');
        const oldBadge = el.querySelector('.collab-focus-badge');
        if (oldBadge) oldBadge.remove();
    });

    if (!window.collabState || !window.collabState.remoteFocusMap) return;
    const now = Date.now();

    for (const [clientId, info] of window.collabState.remoteFocusMap.entries()) {
        if (!info || !info.item || !info.item.name || (info.expiresAt && info.expiresAt < now)) {
            window.collabState.remoteFocusMap.delete(clientId);
            continue;
        }
        const targetName = info.item.name;
        const cards = document.querySelectorAll('.comm-att-card, .bus-att-card, .dnd-dropzone, .grouping-card');
        cards.forEach(card => {
            const cardName = card.getAttribute('data-name');
            if (cardName && cardName.toLowerCase() === targetName.toLowerCase()) {
                card.classList.add('collab-remote-focus');
                card.style.setProperty('--collab-color', info.color || '#3b82f6');
                if (!card.querySelector('.collab-focus-badge')) {
                    const b = document.createElement('div');
                    b.className = 'collab-focus-badge';
                    b.style.setProperty('--collab-color', info.color || '#3b82f6');
                    b.textContent = info.item.action === 'moving' ? 'Moving' : 'Editing';
                    card.appendChild(b);
                }
            }
        });
    }
};

function bindGlobalCollabEvents() {
    if (typeof window.collabOn !== 'function') return;

    window.collabOn('ephemeral:focus', (msg) => {
        if (!msg || !msg.clientId) return;
        if (!msg.item) {
            window.collabState.remoteFocusMap.delete(msg.clientId);
        } else {
            window.collabState.remoteFocusMap.set(msg.clientId, {
                clientId: msg.clientId,
                color: msg.color || '#3b82f6',
                label: msg.label || 'Collaborator',
                item: msg.item,
                expiresAt: Date.now() + 30000
            });
        }
        window.applyAllCollabRemoteFocus();
    });

    window.collabOn('global:outingsUpdated', (msg) => {
        if (msg && Array.isArray(msg.sheets)) {
            const activeSheets = window.filterActiveOutings(msg.sheets);
            currentSheetList = activeSheets;
            try {
                localStorage.setItem('myg_sheetList', JSON.stringify(activeSheets));
            } catch (e) {}

            if (typeof populateHomeSelectors === 'function') {
                populateHomeSelectors(activeSheets);
            }
            if (typeof renderCommDashboardCards === 'function' && document.getElementById('upcomingList')) {
                loadSheets('comm', true);
            }
            if (typeof loadVolunteerEvents === 'function' && document.getElementById('volEventName')) {
                loadVolunteerEvents();
            }
        }
    });

    window.collabOn('global:settingsUpdated', (msg) => {
        if (msg && msg.settings) {
            appSettings = msg.settings;
            window.appSettings = msg.settings;
            if (msg.senderId && msg.senderId === window.collabClientId) return;
            if (typeof window.applyRemoteSettingsDelta === 'function') {
                window.applyRemoteSettingsDelta(msg.settings);
            }
        }
    });
}

window.getOutingThresholdDateNum = function() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const tY = d.getFullYear();
    const tM = String(d.getMonth() + 1).padStart(2, '0');
    const tD = String(d.getDate()).padStart(2, '0');
    return parseInt(`${tY}${tM}${tD}`, 10);
};

window.filterActiveOutings = function(data) {
    if (!Array.isArray(data)) return [];
    const threshold = window.getOutingThresholdDateNum();
    return data.filter(item => {
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
};

function silentHydration() {
    if (isHydrated) return;

    apiCall('getRecentOutingSheets', null).then(res => {
        if (res && res.success && Array.isArray(res.data)) {
            const activeData = window.filterActiveOutings(res.data);
            currentSheetList = activeData;
            localStorage.setItem('myg_sheetList', JSON.stringify(activeData));
            isHydrated = true;
        }
    }).catch(e => console.warn('Hydration failed silently', e));
}

window.getClosestEventUrl = function(data) {
    const activeData = window.filterActiveOutings ? window.filterActiveOutings(data) : data;
    if (!activeData || activeData.length === 0) return null;
    if (activeData.length === 1) return activeData[0].sheetUrl;

    const today = new Date();
    const tY = today.getFullYear();
    const tM = String(today.getMonth() + 1).padStart(2, '0');
    const tD = String(today.getDate()).padStart(2, '0');
    const todayNum = parseInt(`${tY}${tM}${tD}`, 10);

    let closestFuture = null;
    for (let i = 0; i < activeData.length; i++) {
        if (activeData[i].folderDateNum >= todayNum) {
            closestFuture = activeData[i];
            break;
        }
    }

    if (closestFuture) return closestFuture.sheetUrl;
    return activeData[activeData.length - 1].sheetUrl;
};

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then(() => {
            console.log('Service Worker Registered successfully');
        }).catch(err => {
            console.warn('Service Worker registration failed:', err);
        });
    });
}
