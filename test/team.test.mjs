import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scryptSync,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import webpush from 'web-push';
import {createApp} from '../server.mjs';
import {shootingDays,deliveryDeadline,deadlineInfo,validDay,validZone} from '../public/deadlines.js';
const salt=randomBytes(16).toString('hex'),password='test-password-only',key=randomBytes(32).toString('hex'),origin='https://shootboard.test';
const baseConfig={origin,passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),dataKey:key};
async function start(config={}){const a=createApp({...baseConfig,dbPath:':memory:',...config});await new Promise(r=>a.server.listen(0,'127.0.0.1',r));a.base='http://127.0.0.1:'+a.server.address().port;return a;}
async function call(a,path,method='GET',body,c={}){const r=await fetch(a.base+'/api/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:c.cookie||'','X-CSRF-Token':c.csrf||''},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')};}
async function login(a,link){const l=await call(a,link?'access':'login','POST',link?{token:new URL(link).hash.slice(1)}:{password});assert.equal(l.status,200);const c={cookie:l.cookie.split(';')[0]};c.csrf=(await call(a,'state','GET',undefined,c)).data.csrf;return c;}
const sub=endpoint=>({endpoint,keys:{p256dh:Buffer.concat([Buffer.from([4]),randomBytes(64)]).toString('base64url'),auth:randomBytes(16).toString('base64url')}});

test('completion is atomic, notifications reach active team, duplicate/reopen/revoke and read state',async()=>{
 const vapid=webpush.generateVAPIDKeys(),sent=[];const a=await start({vapidPublicKey:vapid.publicKey,vapidPrivateKey:vapid.privateKey,vapidSubject:'https://shootboard.test',sendPush:async(s,p)=>sent.push({s,p:JSON.parse(p)})});
 try{const admin=await login(a),anna=(await call(a,'employees','POST',{name:'Ксения'},admin)).data,bob=(await call(a,'employees','POST',{name:'Павел'},admin)).data,inactive=(await call(a,'employees','POST',{name:'Без доступа'},admin)).data;
  await call(a,'employees/'+inactive.id+'/revoke','POST',{},admin);const ac=await login(a,anna.link),bc=await login(a,bob.link);
  assert.equal((await call(a,'push/config','GET',undefined,ac)).data.configured,true);
  for(const [c,url] of [[ac,'https://fcm.googleapis.com/fcm/send/anna'],[bc,'https://updates.push.services.mozilla.com/wpush/v2/bob']])assert.equal((await call(a,'push/subscriptions','POST',sub(url),c)).status,200);
  assert.equal((await call(a,'push/subscriptions','POST',sub('https://127.0.0.1/private'),ac)).status,400);
  a.db.prepare('INSERT INTO events(id,title,start,end,all_day) VALUES(?,?,?,?,1)').run('cup','Кубок','2026-11-05','2026-11-08');
  await call(a,'tasks','POST',{title:'Отправить видео',event_id:'cup',employee_id:anna.id},admin);let t=a.db.prepare('SELECT * FROM tasks').get();
  assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:t.revision},bc)).status,403);assert.equal(a.db.prepare('SELECT count(*) AS n FROM notifications').get().n,0);
  assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:t.revision},ac)).status,200);
  await a.flushPush();assert.equal(sent.length,2);assert.equal(sent[0].p.eventId,'cup');assert.ok(!JSON.stringify(sent).includes('access#'));
  let notes=(await call(a,'notifications','GET',undefined,bc)).data;assert.equal(notes.unread,1);assert.equal(notes.items[0].actor_name,'Ксения');assert.equal(notes.items[0].event_end,'2026-11-07');
  assert.equal(a.db.prepare('SELECT count(*) AS n FROM notification_receipts').get().n,3);assert.equal(a.db.prepare('SELECT count(*) AS n FROM audit').get().n,1);
  assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:0},ac)).status,409);
  assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:1},ac)).status,200);assert.equal(a.db.prepare('SELECT count(*) AS n FROM notifications').get().n,1);
  await call(a,'notifications/read','POST',{through:notes.items[0].id},bc);assert.equal((await call(a,'notifications','GET',undefined,bc)).data.unread,0);assert.equal((await call(a,'notifications','GET',undefined,admin)).data.unread,1);
  await call(a,'tasks/'+t.id+'/status','PATCH',{done:false,revision:1},ac);assert.equal(a.db.prepare('SELECT count(*) AS n FROM notifications').get().n,1);
  await call(a,'employees/'+bob.id+'/revoke','POST',{},admin);assert.equal(a.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n,1);
  await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:2},ac);await a.flushPush();assert.equal(sent.length,3);assert.equal(a.db.prepare('SELECT count(*) AS n FROM notifications').get().n,2);
  assert.equal((await call(a,'notifications','GET',undefined,bc)).status,401);
 }finally{a.close();}
});

test('messages enforce author permissions, paginate, edit revisions, preserve text and survive restart with banners',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shootboard-team-'));const config={dbPath:join(dir,'data.sqlite')};let a=await start(config);
 try{const admin=await login(a),employee=(await call(a,'employees','POST',{name:'Ксения'},admin)).data,other=(await call(a,'employees','POST',{name:'Павел'},admin)).data,ec=await login(a,employee.link),oc=await login(a,other.link);
  a.db.prepare('INSERT INTO events(id,title,start,end) VALUES(?,?,?,?)').run('cup','Кубок','2026-11-05','2026-11-08');
  const raw='<script>alert(1)</script>\nВажная заметка';const m=(await call(a,'events/cup/messages','POST',{body:raw,author_name:'Администратор'},ec)).data;assert.equal(m.author_name,'Ксения');assert.equal(m.body,raw);
  assert.equal((await call(a,'events/cup/messages','POST',{body:'   '},ec)).status,400);assert.equal((await call(a,'events/cup/messages','POST',{body:'x'.repeat(4001)},ec)).status,400);
  assert.equal((await call(a,'messages/'+m.id,'PUT',{body:'hack',revision:0},admin)).status,403);assert.equal((await call(a,'messages/'+m.id,'DELETE',{},oc)).status,403);
  assert.equal((await call(a,'messages/'+m.id,'PUT',{body:'Готово\nК съёмке',revision:0},ec)).status,200);assert.equal((await call(a,'messages/'+m.id,'PUT',{body:'Готово',revision:0},ec)).status,409);
  for(let i=0;i<55;i++)a.db.prepare('INSERT INTO messages(event_id,author,author_name,body,at) VALUES(?,?,?,?,?)').run('cup','admin','Администратор','Заметка '+i,new Date().toISOString());
  const page=(await call(a,'events/cup/messages','GET',undefined,ec)).data;assert.equal(page.items.length,50);assert.equal(page.more,true);assert.ok(page.items[0].id<page.items.at(-1).id);
  const previous=(await call(a,'events/cup/messages?before='+page.items[0].id,'GET',undefined,oc)).data;assert.equal(previous.items.length,6);assert.ok(previous.items[0].edited_at);assert.equal(previous.items[0].can_edit,false);
  assert.equal((await call(a,'messages/'+m.id,'DELETE',{},admin)).status,200);
  const png=await sharp({create:{width:8,height:8,channels:4,background:'#b1cff5'}}).png().toBuffer();
  const upload=async(buffer,c=admin)=>fetch(a.base+'/api/events/cup/banners?caption='+encodeURIComponent('Баннер турнира'),{method:'POST',headers:{Origin:origin,Cookie:c.cookie,'X-CSRF-Token':c.csrf,'Content-Type':'image/png'},body:buffer});
  assert.equal((await upload(png,ec)).status,403);assert.equal((await upload(Buffer.from('fake PNG'))).status,400);assert.equal((await upload(Buffer.alloc(10*1024*1024+1))).status,413);
  const response=await upload(png);assert.equal(response.status,201);const banner=await response.json();
  assert.equal((await fetch(a.base+'/api/banners/'+banner.id)).status,401);let image=await fetch(a.base+'/api/banners/'+banner.id,{headers:{Cookie:ec.cookie}});assert.equal(image.headers.get('content-type'),'image/png');assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width,8);
  assert.equal((await call(a,'banners/'+banner.id,'DELETE',{},ec)).status,403);
  a.close();a=await start(config);assert.equal((await call(a,'events/cup/messages','GET',undefined,ec)).data.items.length,50);assert.equal((await call(a,'events/cup/banners','GET',undefined,ec)).data[0].caption,'Баннер турнира');
  image=await fetch(a.base+'/api/banners/'+banner.id+'?download=1',{headers:{Cookie:ec.cookie}});assert.equal(image.status,200);assert.match(image.headers.get('content-disposition'),/attachment/);
  assert.equal((await call(a,'banners/'+banner.id,'DELETE',{},admin)).status,200);assert.equal((await fetch(a.base+'/api/banners/'+banner.id,{headers:{Cookie:ec.cookie}})).status,404);
 }finally{a.close();rmSync(dir,{recursive:true,force:true});}
});

test('per-day delivery tasks, typed renamed templates, manual deadlines, owners and completed legacy task preserved',async()=>{
 const a=await start();try{const admin=await login(a),employee=(await call(a,'employees','POST',{name:'Ксения'},admin)).data;
  a.db.prepare('INSERT INTO events(id,title,start,end,all_day,timezone) VALUES(?,?,?,?,1,?)').run('cup','Кубок','2026-11-05','2026-11-08','Asia/Krasnoyarsk');
  const template={items:['Видео участникам','Фото участникам'],kinds:{'Видео участникам':'video','Фото участникам':'photo'}};assert.equal((await call(a,'template','PUT',template,admin)).status,200);
  const request={items:template.items.map(title=>({title,employee_id:employee.id})),days:['2026-11-05','2026-11-06','2026-11-07'],dayOwners:{'video:2026-11-06':null}};
  assert.equal((await call(a,'events/cup/template','POST',request,admin)).data.added,6);let tasks=a.db.prepare('SELECT * FROM tasks ORDER BY kind,shooting_day').all();assert.deepEqual(tasks.map(t=>t.deadline),['2026-11-27','2026-11-28','2026-11-29','2026-11-08','2026-11-09','2026-11-10']);assert.equal(tasks[4].employee_id,null);assert.ok(tasks.filter((t,i)=>i!==4).every(t=>t.employee_id===employee.id));
  const t=tasks[0];await call(a,'tasks/'+t.id,'PUT',{title:'Мой срок',employee_id:employee.id,deadline:'2026-12-01'},admin);await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:1},admin);
  assert.equal((await call(a,'events/cup/template','POST',{...request,items:request.items.map(t=>({...t,employee_id:null}))},admin)).data.added,0);const after=a.db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id);assert.equal(after.done,1);assert.equal(after.deadline,'2026-12-01');assert.equal(after.deadline_mode,'manual');assert.equal(after.employee_id,employee.id);assert.equal(after.title,'Мой срок');
  assert.equal((await call(a,'tasks/'+t.id,'PUT',{title:'Ошибка',deadline:'2026-02-31'},admin)).status,400);
  assert.equal((await call(a,'events/cup/template','POST',{...request,days:['2026-11-08']},admin)).status,400);
  a.db.prepare('INSERT INTO events(id,title,start,end,all_day) VALUES(?,?,?,?,1)').run('old','Старое','2026-11-05','2026-11-08');a.db.prepare('INSERT INTO tasks(id,event_id,title,employee_id,deadline,done) VALUES(?,?,?,?,?,1)').run('legacy','old','Разослать видео',employee.id,'2026-12-02');
  await call(a,'events/old/template','POST',{items:[{title:'Видео участникам'}],days:['2026-11-05','2026-11-06']},admin);const legacy=a.db.prepare('SELECT * FROM tasks WHERE id=?').get('legacy');assert.equal(legacy.done,1);assert.equal(legacy.employee_id,employee.id);assert.equal(legacy.deadline,'2026-12-02');assert.equal(legacy.shooting_day,'2026-11-05');assert.equal(a.db.prepare("SELECT count(*) AS n FROM tasks WHERE event_id='old'").get().n,2);
 }finally{a.close();}
});

test('deadline calendar arithmetic respects all-day exclusive end, timezones, midnight and completed status',()=>{
 assert.equal(validZone(undefined),'Asia/Krasnoyarsk');assert.equal(validZone('invalid'),'Asia/Krasnoyarsk');assert.equal(validDay('2026-02-31'),false);
 assert.deepEqual(shootingDays({start:'2026-11-05',end:'2026-11-08',all_day:1}),['2026-11-05','2026-11-06','2026-11-07']);
 assert.deepEqual(shootingDays({start:'2026-11-05T16:00:00Z',end:'2026-11-05T17:00:00Z',timezone:'Asia/Krasnoyarsk'}),['2026-11-05']);
 assert.deepEqual(shootingDays({start:'2026-11-05T16:00:00Z',end:'2026-11-05T18:00:00Z',timezone:'Asia/Krasnoyarsk'}),['2026-11-05','2026-11-06']);
 assert.equal(deliveryDeadline('photo','2026-12-20'),'2027-01-11');assert.equal(deliveryDeadline('video','2028-02-27'),'2028-03-01');
 const t={deadline:'2026-11-08',timezone:'Asia/Krasnoyarsk',done:0};assert.equal(deadlineInfo(t,new Date('2026-11-08T16:59:59Z')).today,true);assert.equal(deadlineInfo(t,new Date('2026-11-08T17:00:00Z')).late,true);assert.equal(deadlineInfo({...t,done:1},new Date('2026-12-01')).late,false);
});

test('push queue persists through restart and retries temporary errors without creating another notification',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shootboard-push-')),vapid=webpush.generateVAPIDKeys();let attempts=0,delivered=[];
 const config={dbPath:join(dir,'data.sqlite'),vapidPublicKey:vapid.publicKey,vapidPrivateKey:vapid.privateKey,vapidSubject:'https://shootboard.test',sendPush:async()=>{attempts++;throw Object.assign(Error('temporary'),{statusCode:503});}};
 let a=await start(config);
 try{const admin=await login(a);await call(a,'push/subscriptions','POST',sub('https://fcm.googleapis.com/fcm/send/retry'),admin);
  a.db.prepare('INSERT INTO events(id,title,start,end) VALUES(?,?,?,?)').run('cup','Кубок','2026-11-05','2026-11-08');await call(a,'tasks','POST',{event_id:'cup',title:'Видео'},admin);const t=a.db.prepare('SELECT * FROM tasks').get();
  await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:0},admin);await a.flushPush();assert.equal(attempts,1);assert.equal(a.db.prepare('SELECT attempts FROM push_outbox').get().attempts,1);
  a.close();a=await start({...config,sendPush:async(s,p)=>delivered.push(JSON.parse(p))});a.db.prepare('UPDATE push_outbox SET next_at=0').run();await a.flushPush();
  assert.equal(delivered.length,1);assert.equal(a.db.prepare('SELECT count(*) AS n FROM push_outbox').get().n,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM notifications').get().n,1);
 }finally{a.close();rmSync(dir,{recursive:true,force:true});}
});
