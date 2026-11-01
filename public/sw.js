// Service Worker обрабатывает Push отдельно от открытой вкладки приложения.
self.addEventListener('install', function (event) {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
    let data = { title: 'Ватэс', body: 'Новое уведомление', url: '/' };

    if (event.data) {
        try {
            const parsedData = event.data.json();
            data = {
                title: typeof parsedData.title === 'string' ? parsedData.title : data.title,
                body: typeof parsedData.body === 'string' ? parsedData.body : data.body,
                url: typeof parsedData.url === 'string' && parsedData.url.startsWith('/')
                    ? parsedData.url
                    : data.url,
            };
        } catch (error) {
            console.error('Ошибка разбора Push-уведомления:', error);
        }
    }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body || 'Откройте приложение, чтобы посмотреть',
            data: { url: data.url },
        }),
    );
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();

    const requestedUrl = event.notification.data && typeof event.notification.data.url === 'string'
        ? event.notification.data.url
        : '/';
    const targetUrl = requestedUrl.startsWith('/') ? requestedUrl : '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            for (const client of clientList) {
                if ('focus' in client && 'navigate' in client) {
                    return client.navigate(targetUrl).then(function (navigatedClient) {
                        return navigatedClient ? navigatedClient.focus() : undefined;
                    });
                }
            }

            return clients.openWindow(targetUrl);
        }),
    );
});
