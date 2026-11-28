/**
 * Admin Authentication & Role Management
 * - Auto-injects #authModal if missing on any page (fixes direct access to admin/pairing/grouping).
 * - Updates LiveSync WebSocket auth scope immediately on login/logout.
 * - Provides Admin Logout & server-rejection handling.
 */

function ensureAuthModal() {
    let modal = document.getElementById('authModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'authModal';
    modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm hidden z-[100] flex items-center justify-center p-4';
    modal.innerHTML = `
        <div class="bg-white dark:bg-zinc-900 w-full max-w-sm rounded-2xl border border-gray-200 dark:border-zinc-800 p-6 shadow-2xl transform transition-all scale-100">
            <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-2 text-center">Restricted Access</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-4 text-center">Please enter the admin password.</p>
            <form onsubmit="handleAuth(event)">
                <div class="relative mb-4">
                    <input type="password" id="adminPassword" class="w-full bg-gray-50 dark:bg-black border border-gray-300 dark:border-zinc-700 rounded-lg py-3 pl-3 pr-10 text-gray-900 dark:text-white text-center tracking-widest focus:border-primary outline-none shadow-sm" placeholder="Password" autocomplete="current-password" required>
                    <button type="button" onclick="togglePasswordVisibility('adminPassword')" aria-label="Toggle password visibility" class="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors focus:outline-none">
                        <i id="adminPasswordIcon" class="fa-regular fa-eye"></i>
                    </button>
                </div>
                <div id="authError" class="hidden text-red-500 dark:text-red-400 text-xs text-center mb-3 font-bold">Incorrect Password</div>
                <div class="flex gap-2">
                    <button type="button" onclick="closeAuthModal()" class="flex-1 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 font-bold py-2 rounded-lg transition-colors">Cancel</button>
                    <button type="submit" id="authBtn" class="flex-1 bg-primary hover:bg-blue-600 text-white font-bold py-2 rounded-lg transition-colors">Access</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    return modal;
}

function requestAccess(urlPath, actionFn = null) {
    if (isAdminAuthenticated) {
        executeAccess(urlPath, actionFn);
        return;
    }

    const savedKey = localStorage.getItem('adminKey');
    if (savedKey) {
        if (typeof showOverlay === 'function') showOverlay('loading', 'Verifying session...');
        apiCall('verifyAdminPassword', savedKey).then(isValid => {
            if (typeof closeOverlay === 'function') closeOverlay();
            if (isValid === true) {
                isAdminAuthenticated = true;
                sessionStorage.setItem('adminKeyValidated', savedKey);
                if (window.LiveSync && typeof window.LiveSync.refreshAuth === 'function') {
                    window.LiveSync.refreshAuth();
                }
                if (typeof window.updateAdminNavIndicator === 'function') {
                    window.updateAdminNavIndicator();
                }
                executeAccess(urlPath, actionFn);
            } else {
                localStorage.removeItem('adminKey');
                sessionStorage.removeItem('adminKeyValidated');
                isAdminAuthenticated = false;
                if (typeof window.updateAdminNavIndicator === 'function') {
                    window.updateAdminNavIndicator();
                }
                promptAuthModal(urlPath, actionFn);
            }
        });
    } else {
        promptAuthModal(urlPath, actionFn);
    }
}

function executeAccess(urlPath, actionFn) {
    if (actionFn) {
        actionFn();
    } else if (urlPath) {
        window.navigateTo(urlPath);
    }
}

function promptAuthModal(urlPath, actionFn) {
    const modal = ensureAuthModal();
    pendingView = urlPath;
    pendingAction = actionFn;
    modal.classList.remove('hidden');
    const pwdInput = document.getElementById('adminPassword');
    const errEl = document.getElementById('authError');
    if (pwdInput) {
        pwdInput.value = '';
        setTimeout(() => pwdInput.focus(), 50);
    }
    if (errEl) errEl.classList.add('hidden');
}

function closeAuthModal(isCancel = true) {
    const modal = document.getElementById('authModal');
    if (modal) modal.classList.add('hidden');

    if (isCancel && !isAdminAuthenticated) {
        const protectedPages = ['admin.html', 'settings.html', 'grouping.html', 'pairing.html'];
        const currentPath = window.location.pathname.toLowerCase();
        const isProtected = protectedPages.some(page => currentPath.includes(page));

        if (isProtected) {
            if (typeof window.navigateTo === 'function') {
                window.navigateTo('./');
            } else {
                window.location.href = './';
            }
        }
    }

    pendingView = '';
    pendingAction = null;
}

function handleAuth(e) {
    e.preventDefault();
    const pwdInput = document.getElementById('adminPassword');
    const btn = document.getElementById('authBtn');
    const errEl = document.getElementById('authError');
    if (!pwdInput || !btn) return;

    const pwd = pwdInput.value;
    btn.disabled = true;
    btn.innerText = 'Checking...';

    apiCall('verifyAdminPassword', pwd).then(isValid => {
        btn.disabled = false;
        btn.innerText = 'Access';
        if (isValid === true) {
            isAdminAuthenticated = true;
            localStorage.setItem('adminKey', pwd);
            sessionStorage.setItem('adminKeyValidated', pwd);
            if (window.LiveSync && typeof window.LiveSync.refreshAuth === 'function') {
                window.LiveSync.refreshAuth();
            }
            if (typeof window.updateAdminNavIndicator === 'function') {
                window.updateAdminNavIndicator();
            }
            const target = pendingView;
            const action = pendingAction;
            closeAuthModal(false);
            executeAccess(target, action);
        } else {
            if (errEl) errEl.classList.remove('hidden');
            pwdInput.value = '';
            pwdInput.focus();
        }
    });
}

window.logoutAdmin = function() {
    isAdminAuthenticated = false;
    try {
        localStorage.removeItem('adminKey');
        sessionStorage.removeItem('adminKeyValidated');
    } catch (e) {}

    if (window.LiveSync && typeof window.LiveSync.refreshAuth === 'function') {
        window.LiveSync.refreshAuth();
    }
    if (typeof window.updateAdminNavIndicator === 'function') {
        window.updateAdminNavIndicator();
    }

    const protectedPages = ['admin.html', 'settings.html', 'grouping.html', 'pairing.html'];
    const currentPath = (window.location.pathname || '').toLowerCase();
    if (protectedPages.some(page => currentPath.includes(page))) {
        window.navigateTo('./');
    } else if (typeof window.showToast === 'function') {
        window.showToast('Signed out of Admin mode.', 'info');
    }
};

window.handleAdminAuthRejection = function(message) {
    if (window._handlingAdminAuthRejection) return;
    window._handlingAdminAuthRejection = true;
    isAdminAuthenticated = false;
    try {
        localStorage.removeItem('adminKey');
        sessionStorage.removeItem('adminKeyValidated');
    } catch (e) {}
    if (window.LiveSync && typeof window.LiveSync.refreshAuth === 'function') {
        window.LiveSync.refreshAuth();
    }
    if (typeof window.updateAdminNavIndicator === 'function') {
        window.updateAdminNavIndicator();
    }
    if (typeof window.showToast === 'function') {
        window.showToast(message || 'Admin session expired. Please sign in again.', 'error');
    }
    const protectedPages = ['admin.html', 'settings.html', 'grouping.html', 'pairing.html'];
    const currentPath = (window.location.pathname || '').toLowerCase();
    if (protectedPages.some(page => currentPath.includes(page))) {
        promptAuthModal(null, () => window.location.reload());
    }
    setTimeout(() => { window._handlingAdminAuthRejection = false; }, 1500);
};
