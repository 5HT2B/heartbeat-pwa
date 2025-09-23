const CACHE_NAME = 'heartbeat-v25';
const urlsToCache = [
    './',
    './index.html',
    './app.js',
    './service-worker.js',
    './manifest.json',
    './offline.html',
    './favicon.ico',
    './app-icons/icon-192x192.png',
    './app-icons/icon-512x512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache, caching app shell');
                return cache.addAll(urlsToCache);
            })
            .then(() => {
                console.log('All resources cached');
            })
            .catch(error => {
                console.error('Failed to cache resources:', error);
            })
    );
    // Force the waiting service worker to become the active service worker
    self.skipWaiting();
});

self.addEventListener('fetch', event => {
    // Handle API requests specially - always use network, never cache
    if (event.request.url.includes('/api/')) {
        if (event.request.url.includes('/api/beat')) {
            // Special handling for heartbeat with background sync fallback
            event.respondWith(
                fetch(event.request.clone())
                    .then(response => {
                        return response;
                    })
                    .catch(error => {
                        console.log('Heartbeat failed, will retry with background sync', error);

                        // Check if background sync is supported
                        if ('sync' in self.registration) {
                            return self.registration.sync.register('send-heartbeat')
                                .then(() => {
                                    return new Response(JSON.stringify({
                                        queued: true,
                                        message: 'Heartbeat queued for background sync'
                                    }), {
                                        headers: { 'Content-Type': 'application/json' }
                                    });
                                })
                                .catch(syncError => {
                                    console.error('Background sync registration failed:', syncError);
                                    return new Response(JSON.stringify({
                                        error: true,
                                        message: 'Network error and background sync failed'
                                    }), {
                                        status: 503,
                                        headers: { 'Content-Type': 'application/json' }
                                    });
                                });
                        } else {
                            // Background sync not supported, return error
                            return new Response(JSON.stringify({
                                error: true,
                                message: 'Network error - background sync not supported'
                            }), {
                                status: 503,
                                headers: { 'Content-Type': 'application/json' }
                            });
                        }
                    })
            );
        } else {
            // For other API requests, just fetch directly without caching
            event.respondWith(fetch(event.request));
        }
        return;
    }

    // For navigation requests, try network first then fall back to cache
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // Clone the response before caching
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                    return response;
                })
                .catch(() => {
                    // Network failed, try cache
                    return caches.match(event.request)
                        .then(cachedResponse => {
                            if (cachedResponse) {
                                return cachedResponse;
                            }
                            // If specific page not in cache, return index.html
                            return caches.match('/index.html')
                                .then(indexResponse => {
                                    if (indexResponse) {
                                        return indexResponse;
                                    }
                                    // Last resort: offline page
                                    return caches.match('/offline.html');
                                });
                        });
                })
        );
        return;
    }

    // For other requests, use cache-first strategy
    event.respondWith(
        caches.match(event.request)
            .then(cachedResponse => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(event.request);
            })
    );
});

self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            // Take control of all clients immediately
            return self.clients.claim();
        })
    );
});

self.addEventListener('sync', event => {
    if (event.tag === 'send-heartbeat') {
        event.waitUntil(sendHeartbeat());
    }
});

self.addEventListener('periodicsync', event => {
    if (event.tag === 'heartbeat-sync') {
        event.waitUntil(
            sendHeartbeat().then(() => {
                // Show notification about background heartbeat
                return self.registration.showNotification('Heartbeat Sent', {
                    body: 'Background heartbeat successfully sent',
                    icon: '/app-icons/icon-192x192.png',
                    badge: '/app-icons/icon-192x192.png',
                    tag: 'background-heartbeat',
                    silent: true
                });
            })
        );
    }
});

// Add support for background fetch API as fallback
self.addEventListener('backgroundfetch', event => {
    if (event.tag === 'heartbeat-background') {
        event.waitUntil(handleBackgroundFetch(event));
    }
});

async function handleBackgroundFetch(event) {
    const db = await openDB();
    const config = await getConfig(db);
    
    if (!config || !config.enabled) {
        return;
    }
    
    // Update the background fetch with our request
    await event.updateUI({
        title: 'Sending heartbeat...',
        icons: [{ src: '/app-icons/icon-192x192.png', sizes: '192x192', type: 'image/png' }]
    });
}

async function sendHeartbeat() {
    try {
        const db = await openDB();
        const config = await getConfig(db);
        
        if (!config || !config.enabled) {
            console.log('Service Worker: Heartbeat disabled or no config found');
            return;
        }

        console.log('Service Worker: Sending background heartbeat...');
        
        // Check if we should skip due to activity detection
        if (config.activityDetection) {
            const lastActivity = await getLastActivity(db);
            const timeSinceActivity = Date.now() - lastActivity;
            if (timeSinceActivity > 120000) { // 2 minutes
                console.log('Service Worker: No recent activity, skipping heartbeat');
                await logActivity(db, 'No recent activity, skipping background heartbeat');
                return;
            }
        }

        const response = await fetch(`${config.serverUrl}/api/beat`, {
            method: 'POST',
            headers: {
                'Auth': config.authToken,
                'Device': config.deviceName,
                'User-Agent': 'HeartbeatPWA-ServiceWorker'
            }
        });

        if (response.ok) {
            const timestamp = new Date().toISOString();
            await logActivity(db, 'Background heartbeat sent successfully');
            const newBeatCount = await incrementBeatCount(db);
            
            // Notify all clients about successful heartbeat
            const clients = await self.clients.matchAll();
            clients.forEach(client => {
                client.postMessage({
                    type: 'heartbeat-sent',
                    timestamp: timestamp,
                    source: 'background',
                    beatCount: newBeatCount
                });
            });
            
            console.log('Service Worker: Background heartbeat sent successfully, count:', newBeatCount);
        } else {
            await logActivity(db, `Background heartbeat failed: ${response.status}`);
            console.error('Service Worker: Background heartbeat failed:', response.status);
        }
    } catch (error) {
        console.error('Service Worker: Background heartbeat failed:', error);
        await logActivity(await openDB(), `Background heartbeat error: ${error.message}`);
    }
}

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('HeartbeatDB', 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
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

function getConfig(db) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['config'], 'readonly');
        const store = transaction.objectStore('config');
        const request = store.get('settings');
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

function logActivity(db, message) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['logs'], 'readwrite');
        const store = transaction.objectStore('logs');
        const request = store.add({
            message: message,
            timestamp: new Date().toISOString()
        });
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

function getLastActivity(db) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['stats'], 'readonly');
        const store = transaction.objectStore('stats');
        const request = store.get('lastActivity');
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || Date.now());
    });
}

function incrementBeatCount(db) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['stats'], 'readwrite');
        const store = transaction.objectStore('stats');
        
        // First get current count
        const getRequest = store.get('beatCount');
        getRequest.onsuccess = () => {
            const currentCount = getRequest.result || 0;
            const putRequest = store.put(currentCount + 1, 'beatCount');
            putRequest.onsuccess = () => resolve(currentCount + 1);
            putRequest.onerror = () => reject(putRequest.error);
        };
        getRequest.onerror = () => reject(getRequest.error);
    });
}

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Handle push messages from server
self.addEventListener('push', event => {
    if (!event.data) {
        return;
    }

    try {
        const data = event.data.json();

        if (data.type === 'heartbeat-request') {
            // Server is requesting a heartbeat check
            event.waitUntil(
                sendHeartbeat().then(() => {
                    // Show notification that server-initiated heartbeat was sent
                    return self.registration.showNotification('Server Check', {
                        body: 'Server-initiated heartbeat sent successfully',
                        icon: '/app-icons/icon-192x192.png',
                        badge: '/app-icons/icon-192x192.png',
                        tag: 'server-heartbeat',
                        silent: true,
                        data: { type: 'server-initiated' }
                    });
                }).catch(async (error) => {
                    // Check if subscription is expired (404/410 status)
                    if (error.statusCode === 404 || error.statusCode === 410) {
                        // Clear expired subscription
                        try {
                            const registration = await self.registration;
                            const subscription = await registration.pushManager.getSubscription();
                            if (subscription) {
                                await subscription.unsubscribe();
                            }
                            // Notify clients to re-subscribe
                            const clients = await self.clients.matchAll();
                            clients.forEach(client => {
                                client.postMessage({
                                    type: 'push-subscription-expired',
                                    message: 'Push subscription expired, please re-enable server checks'
                                });
                            });
                        } catch (unsubError) {
                            console.error('Failed to unsubscribe expired subscription:', unsubError);
                        }
                    }

                    // Show notification about failed server-initiated heartbeat
                    return self.registration.showNotification('Server Check Failed', {
                        body: 'Server-initiated heartbeat failed',
                        icon: '/app-icons/icon-192x192.png',
                        badge: '/app-icons/icon-192x192.png',
                        tag: 'server-heartbeat-failed',
                        data: { type: 'server-initiated-failed' }
                    });
                })
            );
        }
    } catch (error) {
        console.error('Error handling push message:', error);
    }
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
    event.notification.close();
    
    // Focus existing window or open new one
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            if (clientList.length > 0) {
                return clientList[0].focus();
            }
            return clients.openWindow('/');
        })
    );
});