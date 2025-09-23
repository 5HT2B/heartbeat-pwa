let db;
let heartbeatInterval;
let activityTimer;
let lastActivity = Date.now();
let beatCount = 0;
let deferredPrompt;
let lastNotificationTime = 0;
let cryptoKey = null;

const config = {
    serverUrl: '',
    authToken: '',
    deviceName: 'PWA Device',
    vapidPublicKey: '',
    enabled: false,
    activityDetection: true,
    pushEnabled: false
};

// Encryption utilities using Web Crypto API
const CryptoUtil = {
    async generateKey() {
        const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
        return key;
    },

    async exportKey(key) {
        const exported = await crypto.subtle.exportKey('jwk', key);
        return JSON.stringify(exported);
    },

    async importKey(keyData) {
        const jwk = JSON.parse(keyData);
        return await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    },

    async encrypt(text, key) {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const iv = crypto.getRandomValues(new Uint8Array(12));

        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            data
        );

        // Combine IV and encrypted data
        const combined = new Uint8Array(iv.length + encrypted.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(encrypted), iv.length);

        // Convert to base64 for storage
        return btoa(String.fromCharCode(...combined));
    },

    async decrypt(encryptedData, key) {
        try {
            // Convert from base64
            const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));

            // Extract IV and encrypted data
            const iv = combined.slice(0, 12);
            const encrypted = combined.slice(12);

            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                encrypted
            );

            const decoder = new TextDecoder();
            return decoder.decode(decrypted);
        } catch (error) {
            console.error('Decryption failed:', error);
            return null;
        }
    },

    async initializeKey() {
        // Try to load existing key from localStorage
        const storedKey = localStorage.getItem('heartbeat-crypto-key');
        if (storedKey) {
            try {
                cryptoKey = await this.importKey(storedKey);
                return cryptoKey;
            } catch (error) {
                console.error('Failed to import stored key:', error);
            }
        }

        // Generate new key if none exists or import failed
        cryptoKey = await this.generateKey();
        const exportedKey = await this.exportKey(cryptoKey);
        localStorage.setItem('heartbeat-crypto-key', exportedKey);
        return cryptoKey;
    }
};

async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('HeartbeatDB', 2);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            
            if (!db.objectStoreNames.contains('config')) {
                db.createObjectStore('config');
            }
            
            if (!db.objectStoreNames.contains('logs')) {
                const logsStore = db.createObjectStore('logs', { autoIncrement: true });
                logsStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('stats')) {
                db.createObjectStore('stats');
            }
        };
    });
}

async function saveConfig() {
    if (!cryptoKey) {
        await CryptoUtil.initializeKey();
    }

    // Create a copy of config with encrypted sensitive fields
    const configToSave = { ...config };

    // Encrypt sensitive fields
    if (config.authToken) {
        configToSave.authToken = await CryptoUtil.encrypt(config.authToken, cryptoKey);
        configToSave.authTokenEncrypted = true;
    }

    if (config.vapidPublicKey) {
        configToSave.vapidPublicKey = await CryptoUtil.encrypt(config.vapidPublicKey, cryptoKey);
        configToSave.vapidKeyEncrypted = true;
    }

    const transaction = db.transaction(['config'], 'readwrite');
    const store = transaction.objectStore('config');
    await store.put(configToSave, 'settings');

    // Save a sanitized version to localStorage (without sensitive data)
    const sanitizedConfig = {
        serverUrl: config.serverUrl,
        deviceName: config.deviceName,
        enabled: config.enabled,
        activityDetection: config.activityDetection,
        pushEnabled: config.pushEnabled
    };
    localStorage.setItem('heartbeat-config', JSON.stringify(sanitizedConfig));
}

async function loadConfig() {
    try {
        // Initialize encryption key
        if (!cryptoKey) {
            await CryptoUtil.initializeKey();
        }

        // Load non-sensitive config from localStorage first
        const savedConfig = localStorage.getItem('heartbeat-config');
        if (savedConfig) {
            const parsedConfig = JSON.parse(savedConfig);
            // Only load non-sensitive fields from localStorage
            config.serverUrl = parsedConfig.serverUrl || '';
            config.deviceName = parsedConfig.deviceName || 'PWA Device';
            config.enabled = parsedConfig.enabled || false;
            config.activityDetection = parsedConfig.activityDetection !== undefined ? parsedConfig.activityDetection : true;
            config.pushEnabled = parsedConfig.pushEnabled || false;
        }

        // Load full config including encrypted fields from IndexedDB
        const transaction = db.transaction(['config'], 'readonly');
        const store = transaction.objectStore('config');
        const request = store.get('settings');

        await new Promise((resolve) => {
            request.onsuccess = async () => {
                if (request.result) {
                    const storedConfig = request.result;

                    // Copy non-sensitive fields
                    config.serverUrl = storedConfig.serverUrl || config.serverUrl;
                    config.deviceName = storedConfig.deviceName || config.deviceName;
                    config.enabled = storedConfig.enabled || config.enabled;
                    config.activityDetection = storedConfig.activityDetection !== undefined ? storedConfig.activityDetection : config.activityDetection;
                    config.pushEnabled = storedConfig.pushEnabled || config.pushEnabled;

                    // Decrypt sensitive fields
                    if (storedConfig.authTokenEncrypted && storedConfig.authToken) {
                        const decrypted = await CryptoUtil.decrypt(storedConfig.authToken, cryptoKey);
                        config.authToken = decrypted || '';
                    } else {
                        config.authToken = storedConfig.authToken || '';
                    }

                    if (storedConfig.vapidKeyEncrypted && storedConfig.vapidPublicKey) {
                        const decrypted = await CryptoUtil.decrypt(storedConfig.vapidPublicKey, cryptoKey);
                        config.vapidPublicKey = decrypted || '';
                    } else {
                        config.vapidPublicKey = storedConfig.vapidPublicKey || '';
                    }

                    updateUIFromConfig();
                }
                resolve();
            };
            request.onerror = () => resolve();
        });

        // Load beat count from IndexedDB
        await loadBeatCount();

        // Load and display recent logs
        await loadRecentLogs();
    } catch (error) {
        console.error('Error loading config:', error);
        // If encryption fails, reset sensitive fields
        config.authToken = '';
        config.vapidPublicKey = '';
        updateUIFromConfig();
    }
}

async function loadBeatCount() {
    try {
        const transaction = db.transaction(['stats'], 'readonly');
        const store = transaction.objectStore('stats');
        const request = store.get('beatCount');
        
        return new Promise((resolve) => {
            request.onsuccess = () => {
                if (request.result !== undefined) {
                    beatCount = request.result;
                    document.getElementById('beatCount').textContent = beatCount;
                }
                resolve();
            };
            request.onerror = () => resolve();
        });
    } catch (error) {
        console.error('Error loading beat count:', error);
    }
}

async function saveBeatCount() {
    try {
        const transaction = db.transaction(['stats'], 'readwrite');
        const store = transaction.objectStore('stats');
        await store.put(beatCount, 'beatCount');
    } catch (error) {
        console.error('Error saving beat count:', error);
    }
}

async function loadRecentLogs() {
    return refreshLogDisplay();
}

async function refreshLogDisplay() {
    try {
        const transaction = db.transaction(['logs'], 'readonly');
        const store = transaction.objectStore('logs');
        const index = store.index('timestamp');
        const request = index.openCursor(null, 'prev');
        
        const logEntries = document.getElementById('logEntries');
        logEntries.innerHTML = '';
        
        let count = 0;
        const maxLogs = 50; // Keep last 50 logs in storage
        const displayLogs = 10; // Display last 10 logs
        
        return new Promise((resolve) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && count < displayLogs) {
                    const logData = cursor.value;
                    const entry = document.createElement('div');
                    entry.className = 'log-entry';
                    const timestamp = new Date(logData.timestamp).toLocaleTimeString();
                    entry.textContent = `${timestamp} - ${logData.message}`;
                    logEntries.appendChild(entry);
                    
                    count++;
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => resolve();
        });
    } catch (error) {
        console.error('Error loading recent logs:', error);
    }
}

async function cleanOldLogs() {
    try {
        const transaction = db.transaction(['logs'], 'readwrite');
        const store = transaction.objectStore('logs');
        const index = store.index('timestamp');
        const request = index.openCursor(null, 'prev');
        
        let count = 0;
        const maxLogs = 50;
        
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                count++;
                if (count > maxLogs) {
                    cursor.delete();
                }
                cursor.continue();
            }
        };
    } catch (error) {
        console.error('Error cleaning old logs:', error);
    }
}

function updateUIFromConfig() {
    document.getElementById('serverUrl').value = config.serverUrl || '';
    document.getElementById('authToken').value = config.authToken || '';
    document.getElementById('deviceName').value = config.deviceName || '';
    document.getElementById('vapidPublicKey').value = config.vapidPublicKey || '';
    
    const enableToggle = document.getElementById('enableToggle');
    const activityToggle = document.getElementById('activityToggle');
    
    if (config.enabled) {
        enableToggle.classList.add('active');
        enableToggle.setAttribute('aria-checked', 'true');
        startHeartbeat();
    } else {
        enableToggle.classList.remove('active');
        enableToggle.setAttribute('aria-checked', 'false');
    }

    if (config.activityDetection) {
        activityToggle.classList.add('active');
        activityToggle.setAttribute('aria-checked', 'true');
    } else {
        activityToggle.classList.remove('active');
        activityToggle.setAttribute('aria-checked', 'false');
    }
}

async function sendHeartbeat() {
    if (!config.enabled || !config.serverUrl || !config.authToken) {
        return;
    }
    
    if (config.activityDetection) {
        const timeSinceActivity = Date.now() - lastActivity;
        if (timeSinceActivity > 120000) {
            await addLog('No recent activity, skipping heartbeat');
            return;
        }
    }
    
    try {
        const response = await fetch(`${config.serverUrl}/api/beat`, {
            method: 'POST',
            headers: {
                'Auth': config.authToken,
                'Device': config.deviceName
            }
        });
        
        if (response.ok) {
            beatCount++;
            await saveBeatCount();
            updateStatus('active', 'Connected');
            document.getElementById('beatCount').textContent = beatCount;
            document.getElementById('lastBeat').textContent = new Date().toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            await addLog('Heartbeat sent successfully');
        } else {
            updateStatus('error', `Error: ${response.status}`);
            await addLog(`Heartbeat failed: ${response.status}`);
            await showNotification('Heartbeat Failed', `Server returned error: ${response.status}`);
        }
    } catch (error) {
        updateStatus('error', 'Network error');
        await addLog(`Network error: ${error.message}`);
        await showNotification('Connection Lost', 'Unable to send heartbeat - check your connection');
        
        if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
            const registration = await navigator.serviceWorker.ready;
            if ('sync' in registration) {
                await registration.sync.register('send-heartbeat');
                await addLog('Heartbeat queued for background sync');
            }
        }
    }
}

function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    sendHeartbeat();
    heartbeatInterval = setInterval(sendHeartbeat, 60000);
    updateStatus('active', 'Monitoring');
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    updateStatus('inactive', 'Disabled');
}

function updateStatus(type, text) {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    statusDot.className = 'status-dot';
    if (type === 'active') {
        statusDot.classList.add('active');
    } else if (type === 'error') {
        statusDot.classList.add('error');
    }
    
    statusText.textContent = text;
}

async function addLog(message) {
    // Store in IndexedDB first
    if (db) {
        try {
            const transaction = db.transaction(['logs'], 'readwrite');
            const store = transaction.objectStore('logs');
            await store.add({
                message: message,
                timestamp: new Date().toISOString()
            });
            
            // Periodically clean old logs (every 20th log entry)
            if (Math.random() < 0.05) {
                await cleanOldLogs();
            }
        } catch (error) {
            console.error('Error adding log:', error);
        }
    }
    
    // Refresh the display to show the new log
    await refreshLogDisplay();
}

async function trackActivity() {
    lastActivity = Date.now();
    
    // Store activity timestamp in IndexedDB for service worker access
    if (db) {
        try {
            const transaction = db.transaction(['stats'], 'readwrite');
            const store = transaction.objectStore('stats');
            await store.put(lastActivity, 'lastActivity');
        } catch (error) {
            console.error('Error saving activity timestamp:', error);
        }
    }
}

async function requestNotificationPermission() {
    if ('Notification' in window) {
        try {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                await addLog('Notification permissions granted - better background support');
                return true;
            } else if (permission === 'denied') {
                await addLog('Notification permissions denied - limited background functionality');
                return false;
            } else {
                await addLog('Notification permissions not decided');
                return false;
            }
        } catch (error) {
            console.error('Error requesting notification permission:', error);
            return false;
        }
    }
    return false;
}

function updateNotificationButton() {
    const button = document.getElementById('requestNotifications');
    if (!button) return;
    
    if (!('Notification' in window)) {
        button.textContent = 'Notifications Not Supported';
        button.disabled = true;
    } else if (Notification.permission === 'granted') {
        button.textContent = 'Notifications Enabled';
        button.disabled = true;
    } else if (Notification.permission === 'denied') {
        button.textContent = 'Notifications Blocked';
        button.disabled = true;
    } else {
        button.textContent = 'Enable Notifications';
        button.disabled = false;
    }
}

async function updatePushButton() {
    const button = document.getElementById('enablePush');
    if (!button) return;
    
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        button.textContent = 'Push Not Supported';
        button.disabled = true;
        return;
    }
    
    try {
        let registration = await navigator.serviceWorker.getRegistration();

        if (!registration || !registration.active) {
            // Service worker not ready, show enable button
            button.textContent = 'Enable Server Checks';
            button.disabled = false;
            return;
        }

        const subscription = await registration.pushManager.getSubscription();

        if (subscription && config.pushEnabled) {
            button.textContent = 'Server Checks Enabled';
            button.disabled = true;
        } else {
            button.textContent = 'Enable Server Checks';
            button.disabled = false;
        }
    } catch (error) {
        button.textContent = 'Push Error';
        button.disabled = true;
        console.error('Error checking push subscription:', error);
    }
}

async function showNotification(title, body) {
    if (Notification.permission !== 'granted') {
        return;
    }

    // Rate limit notifications to prevent spam (max 1 per 30 seconds)
    const now = Date.now();
    if (now - lastNotificationTime < 30000) {
        console.log('Notification rate limited:', title);
        return;
    }
    lastNotificationTime = now;

    try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
            const registration = await navigator.serviceWorker.ready;
            await registration.showNotification(title, {
                body: body,
                icon: '/app-icons/icon-192x192.png',
                badge: '/app-icons/icon-192x192.png',
                vibrate: [200, 100, 200],
                tag: 'heartbeat-alert',
                renotify: true
            });
        } else {
            new Notification(title, { body: body });
        }
    } catch (error) {
        console.error('Error showing notification:', error);
    }
}

async function subscribeToPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        await addLog('Push notifications not supported');
        return null;
    }

    try {
        await addLog('Getting service worker registration...');

        // If there's already a service worker controlling this page, use the ready registration
        let registration;
        if (navigator.serviceWorker.controller) {
            await addLog('Service worker already controlling page');
            registration = await navigator.serviceWorker.ready;
        } else {
            // Otherwise, try to get existing registration
            registration = await navigator.serviceWorker.getRegistration();
        }

        if (!registration) {
            await addLog('No service worker found, registering...');
            registration = await navigator.serviceWorker.register('service-worker.js');
            await addLog('Service worker registered, waiting for activation...');

            // Wait for the new service worker to become active
            await new Promise((resolve) => {
                const checkActive = () => {
                    if (registration.active || navigator.serviceWorker.controller) {
                        resolve();
                    } else {
                        setTimeout(checkActive, 100);
                    }
                };
                checkActive();
            });
        } else if (registration.active || navigator.serviceWorker.controller) {
            await addLog('Service worker already active');
        } else {
            await addLog('Waiting for service worker to activate...');

            // If there's a waiting service worker, activate it
            if (registration.waiting) {
                registration.waiting.postMessage({type: 'SKIP_WAITING'});
            }

            // Wait for the service worker to become active
            await new Promise((resolve) => {
                const checkActive = () => {
                    if (registration.active || navigator.serviceWorker.controller) {
                        resolve();
                    } else {
                        setTimeout(checkActive, 100);
                    }
                };
                checkActive();
            });
        }
        await addLog('Service worker ready');

        await addLog('Checking existing subscription...');
        let subscription = await registration.pushManager.getSubscription();
        await addLog(`Existing subscription: ${subscription ? 'found' : 'none'}`);

        // Check if existing subscription has valid keys
        if (subscription) {
            let existingKeys = subscription.keys;
            if (!existingKeys) {
                // Try to extract from the subscription object directly (Safari/WebKit)
                try {
                    const subObj = JSON.parse(JSON.stringify(subscription));
                    existingKeys = subObj.keys;
                } catch (e) {
                    // Ignore extraction errors
                }
            }

            if (!existingKeys) {
                await addLog('Existing subscription missing keys object - clearing invalid subscription');
                await subscription.unsubscribe();
                subscription = null;
            } else if (!existingKeys.p256dh || !existingKeys.auth) {
                await addLog(`Existing subscription missing required keys (p256dh: ${existingKeys.p256dh ? 'present' : 'missing'}, auth: ${existingKeys.auth ? 'present' : 'missing'}) - clearing invalid subscription`);
                await subscription.unsubscribe();
                subscription = null;
            } else {
                await addLog('Existing subscription has valid keys');
            }
        }

        if (!subscription) {
            // Check if VAPID public key is configured
            if (!config.vapidPublicKey) {
                await addLog('VAPID public key required for push notifications - please configure in settings');
                return null;
            }

            await addLog(`VAPID key configured, subscribing... (key: ${config.vapidPublicKey.substring(0, 20)}...)`);

            try {
                const applicationServerKey = urlBase64ToUint8Array(config.vapidPublicKey);
                await addLog(`VAPID key converted successfully (length: ${applicationServerKey.length})`);

                // Check browser support for required features
                if (!('keys' in PushSubscription.prototype)) {
                    await addLog('Warning: Browser does not support subscription keys');
                }

                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: applicationServerKey
                });

                await addLog(`Push subscription created - endpoint: ${subscription.endpoint ? 'present' : 'missing'}`);
                await addLog(`Push subscription keys present: ${subscription.keys ? 'yes' : 'no'}`);
                await addLog(`Full subscription object keys: ${Object.keys(subscription).join(', ')}`);
                if (subscription.keys) {
                    await addLog(`Keys details: p256dh=${subscription.keys.p256dh ? 'present' : 'missing'}, auth=${subscription.keys.auth ? 'present' : 'missing'}`);
                } else {
                    await addLog(`Subscription properties: ${JSON.stringify(subscription, null, 2)}`);
                }
            } catch (subscribeError) {
                await addLog(`Push subscription creation failed: ${subscribeError.message}`);
                return null;
            }

            await addLog('Browser push subscription successful');
        } else {
            await addLog('Using existing push subscription');
        }

        // Debug: log what we're about to send
        await addLog(`Subscription endpoint: ${subscription.endpoint ? 'present' : 'missing'}`);
        await addLog(`Subscription keys: ${subscription.keys ? JSON.stringify(Object.keys(subscription.keys)) : 'missing'}`);

        // Extract keys from subscription - handle Safari/WebKit differences
        let keys = subscription.keys;
        if (!keys) {
            // Try to extract from the subscription object directly (Safari/WebKit)
            try {
                const subObj = JSON.parse(JSON.stringify(subscription));
                keys = subObj.keys;
                await addLog(`Extracted keys from subscription object: ${keys ? 'success' : 'failed'}`);
            } catch (e) {
                await addLog(`Failed to extract keys: ${e.message}`);
            }
        }

        // Validate that we have the required keys before sending to server
        if (!keys || !keys.p256dh || !keys.auth) {
            await addLog(`Invalid subscription keys: ${JSON.stringify(keys)}`);
            return null;
        }

        await addLog(`Keys validation passed - p256dh: ${keys.p256dh ? 'present' : 'missing'}, auth: ${keys.auth ? 'present' : 'missing'}`);

        await addLog('Registering subscription with server...');
        const response = await fetch(`${config.serverUrl}/api/push-subscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Auth': config.authToken,
                'Device': config.deviceName
            },
            body: JSON.stringify({
                endpoint: subscription.endpoint,
                keys: keys,
                encoding: subscription.encoding || 'aes128gcm',
                deviceName: config.deviceName
            })
        });

        if (response.ok) {
            await addLog('Push subscription registered with server');
            config.pushEnabled = true;
            await saveConfig();
            return subscription;
        } else {
            const errorText = await response.text();
            await addLog(`Failed to register push subscription: ${response.status} - ${errorText}`);
            return null;
        }

    } catch (error) {
        await addLog(`Push subscription error: ${error.message}`);
        return null;
    }
}

async function unsubscribeFromPushNotifications() {
    try {
        let registration = await navigator.serviceWorker.getRegistration();

        if (!registration) {
            await addLog('No service worker found for unsubscribe');
            return;
        }
        const subscription = await registration.pushManager.getSubscription();
        
        if (subscription) {
            // Unsubscribe from browser
            await subscription.unsubscribe();
            
            // Notify server to remove subscription
            if (config.serverUrl && config.authToken) {
                await fetch(`${config.serverUrl}/api/push-unsubscribe`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Auth': config.authToken,
                        'Device': config.deviceName
                    },
                    body: JSON.stringify({
                        endpoint: subscription.endpoint,
                        deviceName: config.deviceName
                    })
                });
            }
            
            await addLog('Unsubscribed from push notifications');
            config.pushEnabled = false;
            await saveConfig();
        }
    } catch (error) {
        console.error('Error unsubscribing from push notifications:', error);
        await addLog(`Push unsubscribe error: ${error.message}`);
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function updateServiceWorkerStatus(isAvailable) {
    const enablePushButton = document.getElementById('enablePush');
    if (!enablePushButton) return;

    if (!isAvailable) {
        enablePushButton.textContent = 'Service Worker Unavailable';
        enablePushButton.disabled = true;
        enablePushButton.style.background = '#f44336';
    }
}

async function registerPeriodicSync() {
    if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
        try {
            const registration = await navigator.serviceWorker.ready;
            let syncRegistered = false;
            
            // Try periodic sync first (Chrome with special flags or PWA installed)
            if ('periodicSync' in registration) {
                try {
                    await registration.periodicSync.register('heartbeat-sync', {
                        minInterval: 60 * 1000  // 1 minute minimum
                    });
                    await addLog('Periodic background sync registered successfully');
                    syncRegistered = true;
                } catch (error) {
                    console.log('Periodic sync registration failed:', error);
                    await addLog('Periodic sync unavailable, using fallback methods');
                }
            }
            
            // Try background fetch as fallback
            if (!syncRegistered && 'serviceWorker' in registration) {
                try {
                    if ('backgroundFetch' in registration) {
                        // Background fetch is available but we'll use it on-demand
                        await addLog('Background fetch API available as fallback');
                    }
                } catch (error) {
                    console.log('Background fetch not available:', error);
                }
            }
            
            // Register for regular background sync (works when app comes back online)
            if ('sync' in registration) {
                await addLog('Background sync (offline) available');
            }
            
            if (!syncRegistered) {
                await addLog('Limited background sync available - heartbeats will work when app is active or comes online');
            }
            
        } catch (error) {
            console.error('Service worker registration error:', error);
            await addLog('Background sync registration failed');
        }
    }
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            const registration = await navigator.serviceWorker.register('service-worker.js', {
                scope: '/'
            });
            console.log('ServiceWorker registered successfully:', registration);
            await addLog('Service worker registered successfully');

            // Handle service worker updates
            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                if (newWorker) {
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            // New service worker available, refresh to activate
                            if (confirm('App update available. Refresh to use the latest version?')) {
                                window.location.reload();
                            }
                        }
                    });
                }
            });

            // Force service worker to activate if it's waiting
            if (registration.waiting) {
                registration.waiting.postMessage({type: 'SKIP_WAITING'});
            }

            navigator.serviceWorker.addEventListener('message', async event => {
                if (event.data.type === 'heartbeat-sent') {
                    // Update beat count from service worker message
                    if (event.data.beatCount !== undefined) {
                        beatCount = event.data.beatCount;
                        document.getElementById('beatCount').textContent = beatCount;
                    } else {
                        // Fallback: reload from storage
                        await loadBeatCount();
                    }

                    document.getElementById('lastBeat').textContent = new Date().toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    await addLog('Background heartbeat sent');
                    updateStatus('active', 'Connected');
                } else if (event.data.type === 'push-subscription-expired') {
                    // Handle expired push subscription
                    config.pushEnabled = false;
                    await saveConfig();
                    updatePushButton();
                    await addLog('Push subscription expired - please re-enable server checks');

                    // Show user notification
                    updateStatus('warning', event.data.message || 'Push subscription expired');
                }
            });
            
        } catch (error) {
            console.error('ServiceWorker registration failed:', error);
            await addLog(`Service worker registration failed: ${error.message}`);
            // Update UI to show service worker is not available
            updateServiceWorkerStatus(false);
        }
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installPrompt = document.getElementById('installPrompt');
    installPrompt.classList.add('show');
});

window.addEventListener('online', async () => {
    document.getElementById('offlineBanner').classList.remove('show');
    updateStatus('active', 'Connected');
    await showNotification('Connection Restored', 'Heartbeat monitoring resumed');
    sendHeartbeat();
});

window.addEventListener('offline', async () => {
    document.getElementById('offlineBanner').classList.add('show');
    updateStatus('error', 'Offline');
    await showNotification('Connection Lost', 'Heartbeats will resume when online');
});

document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    await CryptoUtil.initializeKey();
    await loadConfig();
    
    document.addEventListener('click', trackActivity);
    document.addEventListener('touchstart', trackActivity);
    document.addEventListener('keydown', trackActivity);
    
    const enableToggle = document.getElementById('enableToggle');
    const toggleHandler = (toggle, configKey) => {
        return () => {
            config[configKey] = !config[configKey];
            const isActive = config[configKey];

            if (isActive) {
                toggle.classList.add('active');
                toggle.setAttribute('aria-checked', 'true');
            } else {
                toggle.classList.remove('active');
                toggle.setAttribute('aria-checked', 'false');
            }

            if (toggle === enableToggle) {
                if (isActive) {
                    startHeartbeat();
                    window.dispatchEvent(new CustomEvent('heartbeat-enabled'));
                } else {
                    stopHeartbeat();
                    window.dispatchEvent(new CustomEvent('heartbeat-disabled'));
                }
            }

            saveConfig();
        };
    };

    enableToggle.addEventListener('click', toggleHandler(enableToggle, 'enabled'));
    enableToggle.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            enableToggle.click();
        }
    });

    const activityToggle = document.getElementById('activityToggle');
    activityToggle.addEventListener('click', toggleHandler(activityToggle, 'activityDetection'));
    activityToggle.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            activityToggle.click();
        }
    });
    
    document.getElementById('saveConfig').addEventListener('click', async () => {
        config.serverUrl = document.getElementById('serverUrl').value;
        config.authToken = document.getElementById('authToken').value;
        config.deviceName = document.getElementById('deviceName').value;
        config.vapidPublicKey = document.getElementById('vapidPublicKey').value;
        
        await saveConfig();
        await addLog('Configuration saved');
        
        if (config.enabled) {
            startHeartbeat();
        }
    });
    
    document.getElementById('testBeat').addEventListener('click', async () => {
        await sendHeartbeat();
    });
    
    document.getElementById('requestNotifications').addEventListener('click', async () => {
        await requestNotificationPermission();
        updateNotificationButton();
    });
    
    document.getElementById('enablePush').addEventListener('click', async () => {
        try {
            await addLog('Processing server checks request...');
            await addLog(`Config - serverUrl: ${config.serverUrl ? 'set' : 'missing'}, authToken: ${config.authToken ? 'set' : 'missing'}, deviceName: ${config.deviceName ? 'set' : 'missing'}, vapidKey: ${config.vapidPublicKey ? 'set' : 'missing'}`);

            if (config.pushEnabled) {
                await addLog('Unsubscribing from push notifications...');
                await unsubscribeFromPushNotifications();
            } else {
                // First ensure notifications are enabled
                if (typeof Notification === 'undefined') {
                    await addLog('Notifications API not available');
                    return;
                }

                await addLog(`Notification permission: ${Notification.permission}`);
                if (Notification.permission !== 'granted') {
                    await addLog('Requesting notification permission...');
                    const granted = await requestNotificationPermission();
                    if (!granted) {
                        await addLog('Notifications required for server checks - permission denied');
                        return;
                    }
                    await addLog('Notification permission granted');
                }

                await subscribeToPushNotifications();
            }
            await addLog('Updating button states...');
            updateNotificationButton();
            updatePushButton();
        } catch (error) {
            await addLog(`Button handler error: ${error.message || error}`);
        }
    });
    
    document.getElementById('installButton').addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`User response to install prompt: ${outcome}`);
            deferredPrompt = null;
            document.getElementById('installPrompt').classList.remove('show');
        }
    });
    
    if (config.enabled) {
        startHeartbeat();
    }
    
    // Check and update button status
    updateNotificationButton();
    updatePushButton();
    
    registerPeriodicSync();
});

// Improved wake lock implementation for better background operation
if ('wakeLock' in navigator) {
    let wakeLock = null;
    
    async function requestWakeLock() {
        try {
            if (config.enabled && document.visibilityState === 'visible') {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake lock activated');
                await addLog('Screen wake lock activated');
                
                wakeLock.addEventListener('release', () => {
                    console.log('Wake lock released');
                });
            }
        } catch (error) {
            console.error('Wake lock request failed:', error);
        }
    }
    
    async function releaseWakeLock() {
        if (wakeLock !== null) {
            await wakeLock.release();
            wakeLock = null;
            console.log('Wake lock released manually');
        }
    }
    
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            await requestWakeLock();
        } else {
            await releaseWakeLock();
        }
    });
    
    // Request wake lock when heartbeat is enabled
    window.addEventListener('heartbeat-enabled', requestWakeLock);
    window.addEventListener('heartbeat-disabled', releaseWakeLock);
}