// Global Application State Variables & Shared Utilities
let currentSheetList = [];
let selectedVolType = null;
let allNames = [];
let allProjects = [];
let currentVolTypeRequest = null;

// Synchronously restore admin auth state for the current session to avoid UI flicker
let isAdminAuthenticated = false;
try {
    const savedKey = localStorage.getItem('adminKey');
    const validatedKey = sessionStorage.getItem('adminKeyValidated');
    if (savedKey && savedKey === validatedKey) {
        isAdminAuthenticated = true;
    }
} catch (e) {}

let pendingView = "";
let pendingAction = null;
let currentActiveView = 'landing';
let outingReminders = {};

// Idle-Time Hydration State
let isHydrated = false;
let hydratedEventUrl = null;

// Setting defaults
const DEF_SHARE_FORMAT = "{{Groups}} | {{Meetings}} | {{Dismissals}} | Total: {{Count}}\n\n{{List}}";
let appSettings = null;

// Shared XSS-safe HTML escaper
window.escapeHtml = function(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// Shared JS single-quote attribute escaper (used inside onclick="fn('...')")
window.escapeJsAttr = function(str) {
    if (str == null) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
};

// Collision-safe DOM ID generator (works for Unicode/Chinese names & punctuation)
window.safeDomId = function(prefix, name) {
    const str = String(name || '');
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    const slug = str.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    return `${prefix}-${slug || 'u'}-${hash.toString(36)}`;
};

// Check whether user is actively typing in an input/textarea or editing a modal
window.isUserActivelyTyping = function() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
};
