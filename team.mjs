import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';
import webpush from 'web-push';
import {defaultZone,validDay,shootingDays,deliveryDeadline,addDays,dateInZone} from './public/deadlines.js';

const id=()=>randomBytes(24).toString('base64url');
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const kinds=new Set(['task','photo','video']);
const actor=s=>s.admin?'admin':'employee:'+s.employee_id;
const name=s=>s.admin?'Администратор':s.name;
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max?v.trim():fail(400,'Проверьте заполненные поля');
// Recognize old defaults once; later rules are stored separately from their labels.
const legacyKind=title=>/^(Разослать фотографии|Отправить фото)$/i.test(title)?'photo':/^(Разослать видео|Отправить видео)$/i.test(title)?'video':'task';

export function installTeam({db,q,one,run,get,set,transaction,root,uploadDir,config}) {
 db.exec(`CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,task_id TEXT NOT NULL,actor_name TEXT NOT NULL,task_title TEXT NOT NULL,event_title TEXT NOT NULL,event_start TEXT NOT NULL,event_end TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_receipts(notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,recipient TEXT NOT NULL,read_at TEXT,PRIMARY KEY(notification_id,recipient));
 CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY,endpoint TEXT UNIQUE NOT NULL,recipient TEXT NOT NULL,employee_id TEXT REFERENCES employees(id),version INTEGER,session_hash TEXT NOT NULL,subscription TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS push_outbox(notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,subscription_id TEXT REFERENCES push_subscriptions(id) ON DELETE CASCADE,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(notification_id,subscription_id));
 CREATE TABLE IF NOT EXISTS banners(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,filename TEXT NOT NULL,mime TEXT NOT NULL,caption TEXT NOT NULL DEFAULT '',at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,author TEXT NOT NULL,author_name TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,edited_at TEXT,revision INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS messages_event ON messages(event_id,id);
 CREATE INDEX IF NOT EXISTS receipts_recipient ON notification_receipts(recipient,notification_id);`);
 const add=(table,column,type)=>{if(!q('PRAGMA table_info('+table+')').some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);};
 transaction(()=>{
 add('events','timezone',`TEXT NOT NULL DEFAULT '${defaultZone}'`);
 add('tasks','kind',"TEXT NOT NULL DEFAULT 'task'");add('tasks','shooting_day','TEXT');add('tasks','deadline_mode',"TEXT NOT NULL DEFAULT 'manual'");add('tasks','timezone',`TEXT NOT NULL DEFAULT '${defaultZone}'`);
 if(!get('templateKinds'))set('templateKinds',JSON.stringify(Object.fromEntries(JSON.parse(get('template')).map(t=>[t,legacyKind(t)]))));
 });
 db.exec("CREATE UNIQUE INDEX IF NOT EXISTS task_delivery_day ON tasks(event_id,kind,shooting_day) WHERE kind IN ('photo','video') AND shooting_day IS NOT NULL");
 const uploads=uploadDir||join(root,'data','uploads');mkdirSync(uploads,{recursive:true});
 const vapid={publicKey:config.vapidPublicKey||process.env.VAPID_PUBLIC_KEY,privateKey:config.vapidPrivateKey||process.env.VAPID_PRIVATE_KEY,subject:config.vapidSubject||process.env.VAPID_SUBJECT};
 let pushConfigured=false;
 if(vapid.publicKey&&vapid.privateKey&&vapid.subject){try{webpush.getVapidHeaders('https://fcm.googleapis.com',vapid.subject,vapid.publicKey,vapid.privateKey,'aes128gcm');pushConfigured=true;}catch{console.error('Web Push: проверьте VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY и VAPID_SUBJECT');}}
 const requireEvent=eventId=>{const e=one('SELECT * FROM events WHERE id=?',eventId);if(!e||e.calendar_id&&e.calendar_id!==get('calendar'))fail(404,'Мероприятие не найдено');return e;};
 const admin=s=>{if(!s.admin)fail(403,'Доступно только администратору');};
 function completed(t,s) {
  const e=requireEvent(t.event_id),at=new Date().toISOString();
  const eventStart=dateInZone(e.start,e.timezone),eventEnd=e.all_day||/^\d{4}-\d{2}-\d{2}$/.test(e.start)?addDays(dateInZone(e.end,e.timezone),-1):dateInZone(new Date(Date.parse(e.end)-1).toISOString(),e.timezone);
  const notification=run('INSERT INTO notifications(event_id,task_id,actor_name,task_title,event_title,event_start,event_end,at) VALUES(?,?,?,?,?,?,?,?)',e.id,t.id,name(s),t.title,e.title,eventStart,eventEnd,at).lastInsertRowid;
  const recipients=['admin',...q('SELECT id FROM employees WHERE token_hash IS NOT NULL').map(e=>'employee:'+e.id)];
  for(const recipient of recipients)run('INSERT INTO notification_receipts(notification_id,recipient) VALUES(?,?)',notification,recipient);
  for(const sub of q('SELECT * FROM push_subscriptions'))if(recipients.includes(sub.recipient))run('INSERT OR IGNORE INTO push_outbox(notification_id,subscription_id) VALUES(?,?)',notification,sub.id);
 }
 let draining=false,closed=false;
 async function drain(){
  if(draining||closed||!pushConfigured)return;draining=true;
  try{for(const job of q('SELECT notification_id,subscription_id FROM push_outbox WHERE next_at<=? LIMIT 20',Date.now())){
   if(closed)break;
   const sub=one('SELECT * FROM push_subscriptions WHERE id=?',job.subscription_id),n=one('SELECT * FROM notifications WHERE id=?',job.notification_id);
   if(!sub||!n)continue;
   if(sub.employee_id){const employee=one('SELECT * FROM employees WHERE id=?',sub.employee_id);if(!employee?.token_hash||employee.version!==sub.version){run('DELETE FROM push_subscriptions WHERE id=?',sub.id);continue;}}
   // No tokens or personal URLs in the payload. Keep enough room for encryption overhead.
  const payload=JSON.stringify({id:n.id,title:('Задача выполнена · '+n.actor_name).slice(0,120),body:n.task_title.slice(0,240)+'\n'+n.event_title.slice(0,180)+' · '+n.event_start+' — '+n.event_end,eventId:n.event_id,taskId:n.task_id});
   try{await (config.sendPush||webpush.sendNotification)(JSON.parse(sub.subscription),payload,{vapidDetails:vapid,TTL:3600,timeout:10000,topic:String(n.id)});if(!closed)run('DELETE FROM push_outbox WHERE notification_id=? AND subscription_id=?',n.id,sub.id);}
   catch(err){if(closed)break;if([404,410].includes(err.statusCode))run('DELETE FROM push_subscriptions WHERE id=?',sub.id);else{run('UPDATE push_outbox SET attempts=attempts+1,next_at=? WHERE notification_id=? AND subscription_id=?',Date.now()+60000,n.id,sub.id);run('DELETE FROM push_outbox WHERE attempts>=5');}}
  }}finally{draining=false;}
 }
 const timer=setInterval(()=>drain().catch(()=>{}),15000);timer.unref();
 function setTemplate(items,types={}) {
  if(!Array.isArray(items)||items.length>30)fail(400,'Не более 30 задач');
  const values=items.map(t=>text(t,200)),old=JSON.parse(get('templateKinds')||'{}'),map={},seen=new Set(),delivery=new Set();
  for(const title of values){const normalized=title.toLocaleLowerCase('ru');if(seen.has(normalized))fail(400,'Названия задач не должны повторяться');seen.add(normalized);const kind=types[title]??old[title]??'task';if(!kinds.has(kind))fail(400,'Неизвестный тип задачи');if(kind!=='task'&&delivery.has(kind))fail(400,'Для фото и видео выберите по одной задаче в шаблоне');delivery.add(kind);map[title]=kind;}
  transaction(()=>{set('template',JSON.stringify(values));set('templateKinds',JSON.stringify(map));});
 }
 function applyTemplate(eventId,b,validEmployee,inTransaction=false) {
  const e=requireEvent(eventId),available=shootingDays(e),days=b.days===undefined?available:b.days;
  if(!Array.isArray(days)||!days.length||days.length>366||new Set(days).size!==days.length||days.some(d=>!available.includes(d)))fail(400,'Выберите дни съёмки внутри мероприятия');
  if(!Array.isArray(b.items)||!b.items.length||b.items.length>30)fail(400,'Выберите от 1 до 30 задач');
  const titles=new Set(JSON.parse(get('template'))),types=JSON.parse(get('templateKinds')),seen=new Set();
  const items=b.items.map(item=>{const title=text(item.title,200);if(!titles.has(title))fail(409,'Шаблон изменился. Откройте его заново.');if(seen.has(title))fail(400,'Задачи повторяются');seen.add(title);return {title,kind:types[title]||'task',employee_id:validEmployee(item.employee_id)};});
  const dayOwners={};for(const item of items)if(item.kind!=='task')for(const day of days){const key=item.kind+':'+day;if(b.dayOwners&&Object.hasOwn(b.dayOwners,key))dayOwners[key]=validEmployee(b.dayOwners[key]);}
  let added=0,assigned=0;
  (inTransaction?fn=>fn():transaction)(()=>{for(const item of items){for(const day of item.kind==='task'?[null]:days){
   const owner=Object.hasOwn(dayOwners,item.kind+':'+day)?dayOwners[item.kind+':'+day]:item.employee_id;
   let existing=day?one('SELECT * FROM tasks WHERE event_id=? AND kind=? AND shooting_day=?',eventId,item.kind,day):q('SELECT * FROM tasks WHERE event_id=?',eventId).find(t=>t.title.trim().toLocaleLowerCase('ru')===item.title.toLocaleLowerCase('ru'));
   // Adopt an old delivery task once; preserve its completion, owner, manual deadline and audit ID.
   if(!existing&&day)existing=q('SELECT * FROM tasks WHERE event_id=? AND shooting_day IS NULL',eventId).find(t=>t.kind===item.kind||legacyKind(t.title)===item.kind||t.title.trim().toLocaleLowerCase('ru')===item.title.toLocaleLowerCase('ru'));
   if(existing){if(day&&!existing.shooting_day)run('UPDATE tasks SET kind=?,shooting_day=?,deadline=COALESCE(deadline,?),deadline_mode=CASE WHEN deadline IS NULL THEN ? ELSE deadline_mode END,timezone=?,revision=revision+1 WHERE id=?',item.kind,day,deliveryDeadline(item.kind,day),'auto',e.timezone,existing.id);
    if(!existing.employee_id&&owner){run('UPDATE tasks SET employee_id=?,revision=revision+1 WHERE id=?',owner,existing.id);assigned++;}
   }
   else{const title=day?item.title.slice(0,170)+' · съёмка '+day:item.title;run('INSERT INTO tasks(id,event_id,title,employee_id,deadline,kind,shooting_day,deadline_mode,timezone) VALUES(?,?,?,?,?,?,?,?,?)',id(),eventId,title,owner,day?deliveryDeadline(item.kind,day):null,item.kind,day,day?'auto':'manual',e.timezone);added++;}
  }}if(b.remember===true){const owners=JSON.parse(get('templateOwners')||'{}');for(const item of items)owners[item.title]=item.employee_id;set('templateOwners',JSON.stringify(owners));}});
  return {added,assigned};
 }
 function validateDeadline(value){if(value!==null&&value!==undefined&&value!==''&&!validDay(value))fail(400,'Укажите корректную дату дедлайна');return value||null;}
 async function routes({req,res,url,path,s,json,body,limited}){
  if(path==='/api/notifications'&&req.method==='GET'){
   const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER;
   const rows=q('SELECT n.*,r.read_at FROM notifications n JOIN notification_receipts r ON r.notification_id=n.id WHERE r.recipient=? AND n.id<? ORDER BY n.id DESC LIMIT 51',actor(s),before);
   json({items:rows.slice(0,50),more:rows.length>50,unread:one('SELECT count(*) AS n FROM notification_receipts WHERE recipient=? AND read_at IS NULL',actor(s)).n});return true;
  }
  if(path==='/api/notifications/read'&&req.method==='POST'){const b=await body(req);if(!Number.isSafeInteger(b.through)||b.through<0)fail(400,'Неверное уведомление');run('UPDATE notification_receipts SET read_at=? WHERE recipient=? AND notification_id<=? AND read_at IS NULL',new Date().toISOString(),actor(s),b.through);json({ok:true});return true;}
  if(path==='/api/push/config'&&req.method==='GET'){json({configured:pushConfigured,publicKey:pushConfigured?vapid.publicKey:null});return true;}
  if(path==='/api/push/subscriptions'&&req.method==='POST'){
   const b=await body(req);limited('push:'+actor(s),50);
   let endpoint;try{endpoint=new URL(b.endpoint);}catch{fail(400,'Неверная подписка');}
   const host=endpoint.hostname,allowed=host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host==='web.push.apple.com'||host.endsWith('.push.apple.com')||host.endsWith('.notify.windows.com');
   if(endpoint.protocol!=='https:'||endpoint.port||endpoint.username||endpoint.password||!allowed||b.endpoint.length>2048)fail(400,'Этот сервис браузерных уведомлений не поддерживается');
   if(!/^[\w-]{87}$/.test(b.keys?.p256dh||'')||Buffer.from(b.keys.p256dh,'base64url').length!==65||!/^[\w-]{22}$/.test(b.keys?.auth||''))fail(400,'Неверные ключи подписки');
   if(!pushConfigured)fail(409,'Браузерные уведомления ещё не настроены администратором');
   transaction(()=>{run('DELETE FROM push_subscriptions WHERE endpoint=?',b.endpoint);run('INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?,?)',id(),b.endpoint,actor(s),s.employee_id,s.version,s.hash,JSON.stringify({endpoint:b.endpoint,keys:b.keys}));});json({ok:true});return true;
  }
  if(path==='/api/push/subscriptions'&&req.method==='DELETE'){const b=await body(req);run('DELETE FROM push_subscriptions WHERE endpoint=? AND recipient=?',String(b.endpoint),actor(s));json({ok:true});return true;}
  const banners=path.match(/^\/api\/events\/([^/]+)\/banners$/),banner=path.match(/^\/api\/banners\/([\w-]+)$/);
  if(banners){const e=requireEvent(banners[1]);if(req.method==='GET'){json(q('SELECT id,event_id,mime,caption,at FROM banners WHERE event_id=? ORDER BY at,id',e.id));return true;}
   if(req.method==='POST'){
    admin(s);limited('upload:'+actor(s),50);const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>10*1024*1024)fail(413,'Файл больше 10 МБ');chunks.push(chunk);}const buffer=Buffer.concat(chunks);
    let image,mime;try{const source=sharp(buffer,{limitInputPixels:25000000,failOn:'warning',animated:false});const meta=await source.metadata();if(!['jpeg','png'].includes(meta.format)||meta.pages>1)fail(400,'Нужна обычная картинка JPEG или PNG');mime='image/'+meta.format;image=await source.rotate().toFormat(meta.format).toBuffer();}catch(err){if(err.code===400)throw err;fail(400,'Не удалось прочитать картинку. Используйте JPEG или PNG до 25 мегапикселей');}
    if(closed)fail(503,'Сервер перезапускается');
    const caption=url.searchParams.get('caption')||'';if(caption.length>300)fail(400,'Подпись — до 300 символов');const bannerId=id(),filename=bannerId+(mime==='image/png'?'.png':'.jpg');
    writeFileSync(join(uploads,filename),image,{flag:'wx'});try{run('INSERT INTO banners VALUES(?,?,?,?,?,?)',bannerId,e.id,filename,mime,caption,new Date().toISOString());}catch(err){unlinkSync(join(uploads,filename));throw err;}json({id:bannerId},201);return true;
   }
  }
  if(banner){const b=one('SELECT * FROM banners WHERE id=?',banner[1]);if(!b)fail(404,'Баннер не найден');requireEvent(b.event_id);
   if(req.method==='GET'){const file=join(uploads,b.filename);if(!existsSync(file))fail(404,'Файл не найден');res.setHeader('Content-Type',b.mime);res.setHeader('Content-Disposition',(url.searchParams.has('download')?'attachment':'inline')+'; filename="banner'+(b.mime==='image/png'?'.png':'.jpg')+'"');res.end(readFileSync(file));return true;}
   if(req.method==='DELETE'){admin(s);const file=join(uploads,b.filename);if(existsSync(file))unlinkSync(file);run('DELETE FROM banners WHERE id=?',b.id);json({ok:true});return true;}
  }
  const messages=path.match(/^\/api\/events\/([^/]+)\/messages$/),message=path.match(/^\/api\/messages\/(\d+)$/);
  const messageView=m=>({...m,can_edit:m.author===actor(s),can_delete:s.admin||m.author===actor(s)});
  if(messages){requireEvent(messages[1]);if(req.method==='GET'){
   const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER,after=Number(url.searchParams.get('after'))||0;
   const rows=q('SELECT * FROM messages WHERE event_id=? AND id<? AND id>? ORDER BY id '+(after?'ASC':'DESC')+' LIMIT 51',messages[1],before,after);const items=rows.slice(0,50);if(!after)items.reverse();json({items:items.map(messageView),more:rows.length>50});return true;
  }if(req.method==='POST'){limited('message:'+actor(s),100);const b=await body(req),bodyText=text(b.body,4000);const result=run('INSERT INTO messages(event_id,author,author_name,body,at) VALUES(?,?,?,?,?)',messages[1],actor(s),name(s),bodyText,new Date().toISOString());json(messageView(one('SELECT * FROM messages WHERE id=?',result.lastInsertRowid)),201);return true;}}
  if(message){const m=one('SELECT * FROM messages WHERE id=?',message[1]);if(!m)fail(404,'Сообщение не найдено');requireEvent(m.event_id);
   if(req.method==='PUT'){if(m.author!==actor(s))fail(403,'Можно менять только свои сообщения');const b=await body(req);if(b.revision!==m.revision)fail(409,'Сообщение уже изменилось');run('UPDATE messages SET body=?,edited_at=?,revision=revision+1 WHERE id=?',text(b.body,4000),new Date().toISOString(),m.id);json({ok:true});return true;}
   if(req.method==='DELETE'){if(!s.admin&&m.author!==actor(s))fail(403,'Можно удалять только свои сообщения');run('DELETE FROM messages WHERE id=?',m.id);json({ok:true});return true;}
  }
  return false;
 }
 return {routes,completed,drain,applyTemplate,setTemplate,requireEvent,validateDeadline,close(){closed=true;clearInterval(timer);},revoke(employeeId){run('DELETE FROM push_subscriptions WHERE employee_id=?',employeeId);},logout(s){run('DELETE FROM push_subscriptions WHERE session_hash=?',s.hash);}};
}
