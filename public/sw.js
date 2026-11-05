// No offline caching of authenticated pages, files, or API responses.
self.addEventListener('push',event=>{
 const data=event.data?.json();if(!data?.id)return;
 event.waitUntil(self.registration.showNotification(String(data.title||'ShootBoard'),{body:String(data.body||''),tag:'task-'+data.id,data:{eventId:String(data.eventId||''),taskId:String(data.taskId||'')}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const data=event.notification.data||{};
 const url=new URL('/',self.location.origin);url.searchParams.set('event',data.eventId||'');url.searchParams.set('task',data.taskId||'');
 event.waitUntil((async()=>{const windows=await clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows)if(new URL(client.url).origin===url.origin){await client.navigate(url.href);return client.focus();}return clients.openWindow(url.href);})());
});
