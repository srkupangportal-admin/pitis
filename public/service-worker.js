self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('srk-portal-shell-v5').then((cache) => cache.addAll([
    '/offline.html',
    '/manifest.webmanifest',
    '/pwa-manifest.webmanifest',
    '/images/brunei-school-logo.jpg',
    '/css/theme-c.css',
    '/css/styles.css',
    '/css/pwa-quick-pitis.css',
    '/js/pwa.js',
    '/js/notifications.js',
    '/js/pwa-quick-pitis.js'
  ])));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('srk-portal-shell-') && key !== 'srk-portal-shell-v5')
    .map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
    return;
  }
  if (requestUrl.pathname.startsWith('/css/') || requestUrl.pathname.startsWith('/js/') || requestUrl.pathname.startsWith('/images/')) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (!response.ok) return response;
      const copy = response.clone();
      caches.open('srk-portal-shell-v5').then((cache) => cache.put(event.request, copy));
      return response;
    })));
  }
});
self.addEventListener('push',event=>{let data={};try{data=event.data?.json()||{}}catch{}const url=typeof data.url==='string'&&data.url.startsWith('/')&&!data.url.startsWith('//')?data.url:'/notifications';event.waitUntil(self.registration.showNotification(String(data.title||'PITIS'),{body:String(data.body||''),icon:'/images/brunei-school-logo.jpg',badge:'/images/brunei-school-logo.jpg',data:{url},tag:data.notificationId?`portal-${data.notificationId}`:undefined}))});
self.addEventListener('notificationclick',event=>{event.notification.close();const target=new URL(event.notification.data?.url||'/notifications',self.location.origin).href;event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{const existing=list.find(client=>new URL(client.url).origin===self.location.origin);if(existing){existing.navigate(target);return existing.focus()}return clients.openWindow(target)}))});
