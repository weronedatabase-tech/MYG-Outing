function loadSettings() {
    const loader = document.getElementById('settingsLoader');
    const content = document.getElementById('settingsContent');
    if (loader) loader.classList.remove('hidden');
    if (content) content.classList.add('hidden');

    apiCall('getAppSettings', null).then(savedSettings => {
        if (!savedSettings || savedSettings.success === false) savedSettings = {};

        window.appSettings = savedSettings;

        apiCall('getTemplateHeaders', null).then(res => {
            if (loader) loader.classList.add('hidden');
            if (content) content.classList.remove('hidden');
            if (res && res.success) {
                renderSettingsCheckboxes(res.tHeaders, res.vHeaders, savedSettings);
            } else {
                const msg = (res && res.message) ? res.message : 'Unable to load template headers.';
                showFlashMessage('settingsStatus', 'Error loading template headers: ' + msg, 'error');
            }
        });
    });
}

function renderSettingsCheckboxes(tHeaders, vHeaders, saved) {
    const tContainer = document.getElementById('traineeColsContainer');
    const vContainer = document.getElementById('volColsContainer');
    if (!tContainer || !vContainer) return;

    tContainer.innerHTML = '';
    vContainer.innerHTML = '';

    (tHeaders || []).forEach(h => {
        const safeH = window.escapeHtml(h);
        const checked = (saved.traineeCols && saved.traineeCols.includes(h) || (!saved.traineeCols || saved.traineeCols.length === 0)) ? 'checked' : '';
        tContainer.innerHTML += `<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" class="t-col-check accent-purple-600 dark:accent-purple-500 w-4 h-4 cursor-pointer" value="${safeH}" ${checked}> <span class="text-gray-700 dark:text-gray-300 font-medium">${safeH}</span></label>`;
    });

    (vHeaders || []).forEach(h => {
        const safeH = window.escapeHtml(h);
        const checked = (saved.volCols && saved.volCols.includes(h) || (!saved.volCols || saved.volCols.length === 0)) ? 'checked' : '';
        vContainer.innerHTML += `<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" class="v-col-check accent-purple-600 dark:accent-purple-500 w-4 h-4 cursor-pointer" value="${safeH}" ${checked}> <span class="text-gray-700 dark:text-gray-300 font-medium">${safeH}</span></label>`;
    });
}

function saveSettings() {
    const tCols = Array.from(document.querySelectorAll('.t-col-check:checked')).map(cb => cb.value);
    const vCols = Array.from(document.querySelectorAll('.v-col-check:checked')).map(cb => cb.value);

    const settings = {
        traineeCols: tCols,
        volCols: vCols
    };

    window.appSettings = settings;

    showFlashMessage('settingsStatus', 'Saving...', 'success');
    apiCall('saveAppSettings', settings).then(res => {
        if (res && res.success) {
            showFlashMessage('settingsStatus', res.message || 'Settings saved!', 'success');
        } else {
            showFlashMessage('settingsStatus', (res && res.message) || 'Failed to save settings.', 'error');
        }
    });
}

function changeAdminPassword() {
    const currentPwd = document.getElementById('settingsCurrentPwd').value;
    const newPwd = document.getElementById('settingsNewPwd').value;
    const btn = document.getElementById('changePwdBtn');

    if (!currentPwd || !newPwd) {
        showFlashMessage('settingsStatus', 'Please fill in both password fields.', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerText = 'Updating...';

    apiCall('changeAdminPassword', { currentPassword: currentPwd, newPassword: newPwd }).then(res => {
        btn.disabled = false;
        btn.innerText = 'Change Password';

        if (res && res.success) {
            document.getElementById('settingsCurrentPwd').value = '';
            document.getElementById('settingsNewPwd').value = '';
            // Update BOTH localStorage and sessionStorage so admin session stays valid without re-prompt
            localStorage.setItem('adminKey', newPwd);
            sessionStorage.setItem('adminKeyValidated', newPwd);
            isAdminAuthenticated = true;
            if (window.LiveSync && typeof window.LiveSync.refreshAuth === 'function') {
                window.LiveSync.refreshAuth();
            }
            showFlashMessage('settingsStatus', 'Password updated successfully!', 'success');
        } else {
            showFlashMessage('settingsStatus', (res && res.message) || 'Failed to update password.', 'error');
        }
    });
}

// 0ms remote settings delta applier (returns true only when settings view is mounted & visible)
window.applyRemoteSettingsDelta = function(settings) {
    const content = document.getElementById('settingsContent');
    const tContainer = document.getElementById('traineeColsContainer');
    if (!settings || !tContainer || !content || content.classList.contains('hidden')) {
        return false;
    }
    window.appSettings = settings;
    document.querySelectorAll('.t-col-check').forEach(cb => {
        cb.checked = !settings.traineeCols || settings.traineeCols.length === 0 || settings.traineeCols.includes(cb.value);
    });
    document.querySelectorAll('.v-col-check').forEach(cb => {
        cb.checked = !settings.volCols || settings.volCols.length === 0 || settings.volCols.includes(cb.value);
    });
    showFlashMessage('settingsStatus', 'Settings updated live by another collaborator.', 'success');
    return true;
};
