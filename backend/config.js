// ==========================================
// config.js - Application Configuration (SHARED)
// Deployable on both Google AI Studio + GAS and GitHub Pages + GAS
// ==========================================

// ENVIRONMENT TOGGLE
// Options: 'Exp' (Experimental) | 'Dev' (Development) | 'Prod' (Production)
const ENV = 'Prod';

// ENVIRONMENT API ENDPOINTS (Google Apps Script Durable Backend)
const EXP_URL = 'https://script.google.com/macros/s/AKfycby16sDgMLOCkZah70i3GV50aAbNIVcQ9GEYDx83YZjJkoK49FXbw-_tgqE0emQfB0TISw/exec';
const DEV_URL = 'https://script.google.com/macros/s/AKfycbywS4uXR4G_S-Xqvqrkohckp76SEzp78dIyOLwBp6a5pLtHjUxwGjDyo4grEsHxerta/exec';
const PROD_URL = 'https://script.google.com/macros/s/AKfycbwOQHiPXoVB10_T81K1mfWPZyahHFXHnrbR7KuM4GI0tQjnsaGjQMunDJWcXRP5g0aENQ/exec';

// Authoritative GAS URL (used directly on GitHub Pages fallback & by Node.js server)
const API_URL = ENV === 'Exp' ? EXP_URL : (ENV === 'Dev' ? DEV_URL : PROD_URL);
const GAS_BACKEND_URL = API_URL;

// PERSISTENT NODE.JS WEBSOCKET & IN-MEMORY CACHE SERVER URLS
// Used by GitHub Pages (cross-origin) to get <50ms WebSocket push + 0ms cached reads + FIFO GAS write queue.
// When served directly by server.js (Google AI Studio / Cloud Run / localhost), same-origin /api & ws(s):// are auto-detected.
// Set each URL once deployed (e.g. 'https://myg-outing-exp-xxxx.run.app'); leave '' to fall back to direct GAS.
const EXP_REALTIME_URL = '';
const DEV_REALTIME_URL = '';
const PROD_REALTIME_URL = '';
const REALTIME_SERVER_URL = ENV === 'Exp' ? EXP_REALTIME_URL : (ENV === 'Dev' ? DEV_REALTIME_URL : PROD_REALTIME_URL);

// ENVIRONMENT Google Drive Folders (Google Drive Folder IDs)
const EXP_Drive_Folder_ID = '18nZ7uA7Bt-eOhLmGz0XJATDvZ7ZO_o7R';
const DEV_Drive_Folder_ID = '1IPeu_EPJuWkHzKcIs18cG4fHi_CL0mwf';
const PROD_Drive_Folder_ID = '1bb_MhkjNYFRCvnt5hg235o7HWDgGdMDE';
const Drive_Folder_ID = ENV === 'Exp' ? EXP_Drive_Folder_ID : (ENV === 'Dev' ? DEV_Drive_Folder_ID : PROD_Drive_Folder_ID);

// Support both CommonJS (for Node) and Browser/GAS contexts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ENV, API_URL, GAS_BACKEND_URL, REALTIME_SERVER_URL, Drive_Folder_ID };
}
