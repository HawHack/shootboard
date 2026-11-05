import {shootingDays,deadlineInfo} from './deadlines.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=value=>new Date(value).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const dayLabel=d=>new Date(d+'T00:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'});
export function deadlineMarkup(t){const info=deadlineInfo(t);return info?`<span class="deadline ${info.late?'late':info.today?'due-today':''}">до ${esc(dayLabel(t.deadline))}, 23:59 · ${esc(t.timezone||'Asia/Krasnoyarsk')} · ${esc(info.label)}</span>`:'';}
export function daysMarkup(event,ownerOptions=''){const days=shootingDays(event);return `<fieldset class="shooting-days"><legend>Дни съёмки для отправки фото и видео</legend><p class="muted">Видео — через 3 дня, фото — через 22 дня. Срок до 23:59 (${esc(event.timezone)}). Уже созданные задачи сохранятся.</p>${days.map(d=>`<label><input type="checkbox" name="days" value="${d}" checked>${dayLabel(d)}</label>`).join('')}<details><summary>Разные ответственные по дням</summary><p class="muted">Необязательно. Этот выбор применяется к новым задачам выбранных дней.</p>${days.map(d=>`<div class="day-owners"><strong>${dayLabel(d)}</strong>${[['video','Видео'],['photo','Фото']].map(([kind,label])=>`<label>${label}<select name="day-owner-${kind}:${d}"><option value="__default">Как в шаблоне</option><option value="">Без ответственного</option>${ownerOptions}</select></label>`).join('')}</div>`).join('')}</details></fieldset>`;}
export function createTeamUI({api,getState,toast,openEvent}){
 let notificationData={items:[],unread:0,more:false},notificationOpen=false,pushConfig=null,notificationLoading=false;
 let activeEvent=null,host=null,messages=[],more=false,last=0,loading=false,epoch=0,editing=null;
 const drafts=new Map();
 async function pollNotifications(){if(!getState()||notificationLoading)return;notificationLoading=true;try{const data=await api('notifications');notificationData={...data,items:[...data.items,...notificationData.items.filter(n=>n.id<(data.items.at(-1)?.id||0))]};drawBell();if(notificationOpen)drawNotifications();}catch{}finally{notificationLoading=false;}}
 function drawBell(){const button=document.querySelector('#notifications-button');if(button){button.textContent='🔔 Уведомления'+(notificationData.unread?' · '+notificationData.unread:'');button.setAttribute('aria-label','Уведомления, непрочитанных: '+notificationData.unread);}}
 function renderHeader(){return '<button id="notifications-button" type="button" class="quiet">🔔 Уведомления</button>';}
 function bindHeader(){const button=document.querySelector('#notifications-button');if(button)button.onclick=()=>{notificationOpen=!notificationOpen;if(notificationOpen)drawNotifications();else document.querySelector('#notifications-popover')?.remove();};drawBell();}
 function drawNotifications(){
  let pop=document.querySelector('#notifications-popover');if(!pop){pop=document.createElement('section');pop.id='notifications-popover';pop.className='notifications-popover';pop.setAttribute('aria-label','Уведомления');document.body.append(pop);}
  pop.innerHTML=`<div class="section-heading"><h2>Уведомления</h2><button id="close-notifications" aria-label="Закрыть уведомления">×</button></div><div class="actions"><button id="enable-push">Включить уведомления</button><button id="read-notifications">Прочитать все</button></div><p id="push-status" class="muted"></p><div>${notificationData.items.map(n=>`<button class="notification-item ${n.read_at?'':'unread'}" data-notification="${n.id}"><strong>Задача «${esc(n.task_title)}» выполнена · ${esc(n.actor_name)}</strong><span>${esc(n.event_title)} · ${esc(n.event_start.slice(0,10))} — ${esc(n.event_end.slice(0,10))}</span><small>${stamp(n.at)}</small></button>`).join('')||'<p class="muted">Пока нет уведомлений.</p>'}</div>${notificationData.more?'<button id="older-notifications">Показать предыдущие</button>':''}`;
  pop.querySelector('#close-notifications').onclick=()=>{notificationOpen=false;pop.remove();};
  pop.querySelector('#read-notifications').onclick=async()=>{try{await api('notifications/read','POST',{through:notificationData.items[0]?.id||0});await pollNotifications();}catch(e){toast(e.message);}};
  pop.querySelectorAll('[data-notification]').forEach(b=>b.onclick=()=>{const n=notificationData.items.find(n=>n.id===Number(b.dataset.notification));notificationOpen=false;pop.remove();openEvent(n.event_id,n.task_id);});
  pop.querySelector('#enable-push').onclick=enablePush;
  const older=pop.querySelector('#older-notifications');if(older)older.onclick=async()=>{try{const data=await api('notifications?before='+notificationData.items.at(-1).id);notificationData={...data,items:[...notificationData.items,...data.items]};drawNotifications();}catch(e){toast(e.message);}};
  updatePushStatus();
 }
 async function updatePushStatus(){const element=document.querySelector('#push-status');if(!element)return;
  if(!('Notification'in window)||!('serviceWorker'in navigator)||!('PushManager'in window)){element.textContent='Этот браузер не поддерживает Web Push. Все уведомления доступны здесь.';return;}
  try{pushConfig=await api('push/config');element.textContent=!pushConfig.configured?'Браузерные уведомления ещё не настроены администратором.':Notification.permission==='denied'?'Уведомления запрещены. Разрешите их в настройках браузера.':Notification.permission==='granted'?'Разрешение получено. Нажмите «Включить», чтобы подключить это устройство.':'Разрешите уведомления, чтобы получать их вне вкладки ShootBoard.';}catch{}
 }
 async function enablePush(){try{
  if(!('Notification'in window)||!('serviceWorker'in navigator)||!('PushManager'in window))throw Error('Браузер не поддерживает уведомления');
  if(!pushConfig?.configured)throw Error('Web Push ещё не настроен администратором. Откройте уведомления после настройки.');
  const permission=await Notification.requestPermission();if(permission!=='granted'){await updatePushStatus();return;}
  const config=await api('push/config');if(!config.configured)throw Error('Web Push ещё не настроен администратором');
  const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
  let sub=await registration.pushManager.getSubscription();if(sub&&sub.options.applicationServerKey){const expected=Uint8Array.from(atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));if(String(new Uint8Array(sub.options.applicationServerKey))!==String(expected)){await sub.unsubscribe();sub=null;}}
  sub||=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:config.publicKey});await api('push/subscriptions','POST',sub.toJSON());toast('Уведомления включены на этом устройстве');const status=document.querySelector('#push-status');if(status)status.textContent='Уведомления включены на этом устройстве.';
 }catch(e){toast(e.message);}}
 function mount(event,container){
  if(activeEvent===event.id&&host){container.append(host);return;}
  saveDraft();epoch++;activeEvent=event.id;messages=[];last=0;editing=null;loading=false;
  host=document.createElement('div');host.id='event-extras';container.append(host);
  host.innerHTML=`<section class="section"><div class="section-heading"><h2>Реклама</h2></div>${getState().me.admin?'<form id="banner-form"><label>Баннеры JPEG / PNG, до 10 МБ каждый<input id="banner-files" type="file" accept="image/jpeg,image/png" multiple required></label><label>Подпись<input id="banner-caption" maxlength="300"></label><button class="primary">Загрузить баннеры</button></form>':''}<div id="banners" class="banner-grid"></div></section><section class="section discussion"><h2>Обсуждение</h2><button id="older-messages" hidden>Загрузить предыдущие</button><div id="messages" class="messages" tabindex="0" aria-label="Сообщения мероприятия"></div><button id="new-messages" hidden>Новые сообщения ↓</button><form id="message-form"><label id="message-label">Заметка для команды<textarea id="message-draft" maxlength="4000" required rows="3" placeholder="Что важно знать команде?"></textarea></label><div class="actions"><button class="primary" id="send-message">Отправить</button><button type="button" id="cancel-edit" hidden>Отменить изменение</button></div><p class="error" id="message-error"></p></form></section>`;
  host.querySelector('#message-draft').value=drafts.get(event.id)||'';
  host.querySelector('#message-draft').oninput=saveDraft;
  host.querySelector('#message-form').onsubmit=sendMessage;
  host.querySelector('#cancel-edit').onclick=()=>{editing=null;host.querySelector('#message-draft').value=drafts.get(activeEvent)||'';host.querySelector('#cancel-edit').hidden=true;host.querySelector('#send-message').textContent='Отправить';};
  host.querySelector('#older-messages').onclick=loadOlder;
  host.querySelector('#new-messages').onclick=()=>{const box=host.querySelector('#messages');box.scrollTop=box.scrollHeight;host.querySelector('#new-messages').hidden=true;};
  host.querySelector('#messages').onscroll=()=>{const box=host.querySelector('#messages');if(box.scrollHeight-box.scrollTop-box.clientHeight<40)host.querySelector('#new-messages').hidden=true;};
  const form=host.querySelector('#banner-form');if(form)form.onsubmit=uploadBanners;
  void pollEvent(true);
 }
 function saveDraft(){if(host&&activeEvent&&!editing)drafts.set(activeEvent,host.querySelector('#message-draft')?.value||'');}
 async function uploadBanners(e){e.preventDefault();const event=activeEvent,current=host,button=e.target.querySelector('button');button.disabled=true;try{
  const files=[...current.querySelector('#banner-files').files],caption=current.querySelector('#banner-caption').value;
  for(const file of files){if(file.size>10*1024*1024)throw Error(file.name+': больше 10 МБ');const state=getState(),response=await fetch('/api/events/'+event+'/banners?caption='+encodeURIComponent(caption),{method:'POST',headers:{'Content-Type':file.type,'X-CSRF-Token':state.csrf},body:file});const data=await response.json();if(!response.ok)throw Error(data.error);}
  toast('Баннеры загружены');if(event===activeEvent){e.target.reset();await loadBanners(event,current);}
 }catch(err){toast(err.message);}finally{button.disabled=false;}}
 async function loadBanners(event,current){const rows=await api('events/'+event+'/banners');if(event!==activeEvent||current!==host)return;const grid=current.querySelector('#banners');
  const html=rows.map(b=>`<figure><a href="/api/banners/${b.id}" target="_blank" rel="noopener"><img src="/api/banners/${b.id}" alt="${esc(b.caption||'Рекламный баннер')}" loading="lazy"></a><figcaption>${esc(b.caption)}</figcaption><a href="/api/banners/${b.id}?download=1" download>Скачать</a>${getState().me.admin?` <button class="quiet danger" data-delete-banner="${b.id}">Удалить</button>`:''}</figure>`).join('')||'<p class="muted">Баннеры пока не загружены.</p>';
  if(grid.innerHTML!==html)grid.innerHTML=html;
  grid.querySelectorAll('[data-delete-banner]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить баннер?'))return;try{await api('banners/'+b.dataset.deleteBanner,'DELETE',{});await loadBanners(event,current);}catch(e){toast(e.message);}});
 }
 function renderMessages(initial=false,prepend=false){const box=host.querySelector('#messages'),near=box.scrollHeight-box.scrollTop-box.clientHeight<50,top=box.scrollTop,height=box.scrollHeight;
  box.innerHTML=messages.map(m=>`<article class="message" data-message="${m.id}"><div><strong>${esc(m.author_name)}</strong><small>${stamp(m.at)}${m.edited_at?' · изменено':''}</small></div><p>${esc(m.body)}</p><div class="message-actions">${m.can_edit?`<button class="quiet" data-edit-message="${m.id}">Изменить</button>`:''}${m.can_delete?`<button class="quiet danger" data-delete-message="${m.id}">Удалить</button>`:''}</div></article>`).join('')||'<p class="muted">Напишите первую заметку команде.</p>';
  host.querySelector('#older-messages').hidden=!more;
  if(prepend)box.scrollTop=top+box.scrollHeight-height;else if(initial||near)box.scrollTop=box.scrollHeight;else{box.scrollTop=top;host.querySelector('#new-messages').hidden=false;}
  box.querySelectorAll('[data-edit-message]').forEach(b=>b.onclick=()=>{saveDraft();editing=messages.find(m=>m.id===Number(b.dataset.editMessage));host.querySelector('#message-draft').value=editing.body;host.querySelector('#cancel-edit').hidden=false;host.querySelector('#send-message').textContent='Сохранить';host.querySelector('#message-draft').focus();});
  box.querySelectorAll('[data-delete-message]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить сообщение?'))return;try{await api('messages/'+b.dataset.deleteMessage,'DELETE',{});await pollEvent();}catch(e){toast(e.message);}});
 }
 async function pollEvent(initial=false){if(!getState()||!host?.isConnected||loading||document.hidden)return;loading=true;const event=activeEvent,current=host,version=epoch;
  try{
   const data=await api('events/'+event+'/messages'+(last?'?after='+last:''));if(version!==epoch)return;
   const before=JSON.stringify(messages);if(!last){messages=data.items;more=data.more;}else{messages.push(...data.items.filter(m=>!messages.some(old=>old.id===m.id)));}
   // Refresh every visible page, so edits/deletions propagate as well as new messages.
   if(messages.length){let updated=[],cursor=messages[0].id-1;for(let page=0;page<Math.ceil(messages.length/50)+1;page++){const result=await api('events/'+event+'/messages?after='+cursor);if(version!==epoch)return;updated.push(...result.items);if(!result.more)break;cursor=result.items.at(-1).id;}messages=updated;}
   last=messages.at(-1)?.id||0;if(initial||before!==JSON.stringify(messages))renderMessages(initial);
   await loadBanners(event,current);
  }catch(e){if(initial)toast(e.message);}finally{if(version===epoch)loading=false;}
 }
 async function loadOlder(){try{const version=epoch,data=await api('events/'+activeEvent+'/messages?before='+messages[0].id);if(version!==epoch)return;messages=[...data.items,...messages];more=data.more;renderMessages(false,true);}catch(e){toast(e.message);}}
 async function sendMessage(e){e.preventDefault();const event=activeEvent,current=host,input=current.querySelector('#message-draft'),button=current.querySelector('#send-message'),value=input.value,edit=editing;button.disabled=true;try{
  if(!value.trim())throw Error('Напишите сообщение');await api(edit?'messages/'+edit.id:'events/'+event+'/messages',edit?'PUT':'POST',{body:value,...(edit?{revision:edit.revision}:{})});
  if(current===host){input.value='';editing=null;drafts.delete(event);current.querySelector('#cancel-edit').hidden=true;button.textContent='Отправить';current.querySelector('#message-error').textContent='';await pollEvent();const box=current.querySelector('#messages');box.scrollTop=box.scrollHeight;}
 }catch(err){current.querySelector('#message-error').textContent=err.message;}finally{button.disabled=false;}}
 function detach(){saveDraft();return host?.isConnected?host:null;}
 function reset(){epoch++;activeEvent=null;host=null;messages=[];notificationData={items:[],unread:0};notificationOpen=false;document.querySelector('#notifications-popover')?.remove();drafts.clear();}
 const timer=setInterval(()=>{void pollNotifications();void pollEvent();},5000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){void pollNotifications();void pollEvent();}});
 return {renderHeader,bindHeader,mount,detach,reset,pollNotifications};
}
