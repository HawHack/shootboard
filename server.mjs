import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const derive=promisify(scrypt), root=dirname(fileURLToPath(import.meta.url));
const token=()=>randomBytes(32).toString('base64url');
export const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(code,message)=>{throw Object.assign(Error(message),{code})};
const str=(x,max=200)=>typeof x==='string'&&x.trim().length>0&&x.length<=max?x.trim():fail(400,'Проверьте заполненные поля');
const defaults=['Сделать оформление','Разослать рекламу','Подготовить оборудование','Провести съёмку','Обработать фотографии','Смонтировать видео','Разослать фотографии','Разослать видео'];
export function createApp(config={}){
 const origin=config.origin||process.env.APP_ORIGIN||'http://localhost:4318', urlOrigin=new URL(origin);
 if(urlOrigin.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(urlOrigin.hostname)) throw Error('APP_ORIGIN должен использовать HTTPS');
 const passwordHash=config.passwordHash||process.env.ADMIN_PASSWORD_HASH;
 if(!passwordHash) throw Error('Сначала выполните npm run setup');
 const key=Buffer.from(config.dataKey||process.env.DATA_KEY||'','hex'); if(key.length!==32) throw Error('DATA_KEY должен содержать 32 случайных байта');
 const dataPath=config.dbPath||join(root,'data','shootboard.sqlite'); if(dataPath!==':memory:') mkdirSync(dirname(dataPath),{recursive:true});
 const db=new DatabaseSync(dataPath); db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE,version INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,employee_id TEXT REFERENCES employees(id),version INTEGER,expires INTEGER NOT NULL,csrf TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,title TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,location TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',cancelled INTEGER DEFAULT 0,google_id TEXT,calendar_id TEXT,etag TEXT,dirty INTEGER DEFAULT 0,conflict INTEGER DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,UNIQUE(calendar_id,google_id));
 CREATE TABLE IF NOT EXISTS assignments(event_id TEXT REFERENCES events(id) ON DELETE CASCADE,employee_id TEXT REFERENCES employees(id),role TEXT NOT NULL,PRIMARY KEY(event_id,employee_id));
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,title TEXT NOT NULL,employee_id TEXT REFERENCES employees(id),deadline TEXT,done INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,event_id TEXT NOT NULL,task_title TEXT NOT NULL,actor_id TEXT,actor_name TEXT NOT NULL,done INTEGER NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS oauth(state_hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);`);
 const q=(sql,...args)=>db.prepare(sql).all(...args), one=(sql,...args)=>db.prepare(sql).get(...args), run=(sql,...args)=>db.prepare(sql).run(...args);
 if(!q('PRAGMA table_info(events)').some(c=>c.name==='all_day'))db.exec('ALTER TABLE events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0');
 const get=k=>one('SELECT value FROM settings WHERE key=?',k)?.value;
 const set=(k,v)=>run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,v);
 if(!get('dateModelV2')){run('DELETE FROM settings WHERE key=?','syncToken');set('dateModelV2','1');}
 if(!get('template')) set('template',JSON.stringify(defaults));
 function transaction(fn){db.exec('BEGIN IMMEDIATE'); try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}
 function seal(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv); const body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64')}
 function unseal(value){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString())}
 function session(req){const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-shootboard='))?.split('=')[1]; if(!raw)return null;
 const s=one('SELECT s.*,e.name,e.version AS current_version FROM sessions s LEFT JOIN employees e ON e.id=s.employee_id WHERE s.hash=? AND s.expires>?',hash(raw),Date.now());
 if(!s||s.employee_id&&(s.version!==s.current_version||!s.name))return null;return {...s,admin:s.employee_id===null};}
 const cookie=(v,age)=>`__Host-shootboard=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
 function newSession(employee=null){const raw=token(),csrf=token(),hours=employee?24*14:12;
 run('DELETE FROM sessions WHERE expires<?',Date.now());run('INSERT INTO sessions VALUES(?,?,?,?,?)',hash(raw),employee?.id||null,employee?.version??null,Date.now()+hours*3600000,csrf);return {raw,csrf,age:hours*3600};}
 async function body(req){let s='';for await(const c of req){s+=c;if(s.length>65536)fail(413,'Слишком большой запрос')}try{return JSON.parse(s||'{}')}catch{fail(400,'Неверный запрос')}}
 function limited(key,max){const now=Date.now(),a=one('SELECT * FROM attempts WHERE key=?',key); if(a?.until>now&&a.count>=max)fail(429,'Слишком много попыток. Подождите 15 минут.');
 run('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until<? THEN 1 ELSE count+1 END,until=CASE WHEN until<? THEN excluded.until ELSE until END',key,now+900000,now,now);
 run('DELETE FROM attempts WHERE until<?',now);}
 function validEmployee(id){if(id&&!one('SELECT id FROM employees WHERE id=?',id))fail(400,'Сотрудник не найден');return id||null}
 function eventFields(b){const title=str(b.title),start=str(b.start,100),end=str(b.end,100);if(!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||Date.parse(end)<=Date.parse(start))fail(400,'Укажите время окончания после начала');return [title,start,end,String(b.location||'').slice(0,500),String(b.description||'').slice(0,5000)]}
 async function accessToken(){const encrypted=get('google');if(!encrypted)fail(400,'Google Calendar не подключён');let g=unseal(encrypted);if(g.expires>Date.now()+60000)return g.access_token;
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(15000),body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:g.refresh_token,grant_type:'refresh_token'})});
 if(!response.ok)fail(502,'Google: требуется повторное подключение');const r=await response.json();g={...g,...r,expires:Date.now()+r.expires_in*1000};set('google',seal(g));return g.access_token;}
 async function google(path,options={}){if(options.method&&options.method!=='GET')fail(403,'Google Calendar подключён только для чтения');const t=await accessToken();const r=await fetch('https://www.googleapis.com/calendar/v3/'+path,{...options,signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+t,'Content-Type':'application/json',...options.headers}});if(!r.ok)throw Object.assign(Error('Ошибка Google Calendar ('+r.status+')'),{code:502,googleStatus:r.status});return r.status===204?null:r.json()}
 let syncing=null;
 async function doSync(){const cal=get('calendar');if(!cal||!get('google'))fail(400,'Выберите подключённый календарь');
 const path='calendars/'+encodeURIComponent(cal)+'/events';
 try{
 let syncToken=get('syncToken'),page,received=[],next;
 for(let reset=0;reset<2;reset++){
 try{do{const p=new URLSearchParams({singleEvents:'true',showDeleted:'true',maxResults:'2500'});if(syncToken)p.set('syncToken',syncToken);if(page)p.set('pageToken',page);
 const r=await google(path+'?'+p);received.push(...(r.items||[]));page=r.nextPageToken;next=r.nextSyncToken;}while(page);break;
 }catch(err){if(err.googleStatus===410&&reset===0){syncToken=null;page=null;received=[];continue}throw err}}
 transaction(()=>{for(const e of received){const old=one('SELECT * FROM events WHERE calendar_id=? AND google_id=?',cal,e.id);
 if(e.status==='cancelled'){if(old)run('UPDATE events SET cancelled=1,etag=? WHERE id=?',e.etag||'',old.id);continue}
 const start=e.start?.dateTime||e.start?.date,end=e.end?.dateTime||e.end?.date,allDay=Number(!!e.start?.date);if(!start||!end)continue;
 if(old)run('UPDATE events SET title=?,start=?,end=?,location=?,description=?,cancelled=0,etag=?,dirty=0,conflict=0,all_day=? WHERE id=?',e.summary||'Без названия',start,end,e.location||'',e.description||'',e.etag,allDay,old.id);
 else run('INSERT INTO events(id,title,start,end,location,description,calendar_id,google_id,etag,all_day) VALUES(?,?,?,?,?,?,?,?,?,?)',token(),e.summary||'Без названия',start,end,e.location||'',e.description||'',cal,e.id,e.etag,allDay);
 }if(next)set('syncToken',next);set('lastSync',new Date().toISOString());set('syncError','')});
 }catch(err){set('syncError',err.message);throw err}}
 const sync=()=>syncing|| (syncing=doSync().finally(()=>{syncing=null}));
 const timer=setInterval(()=>{if(get('calendar')&&get('google'))sync().catch(()=>{})},60000);timer.unref();
 const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,origin),path=url.pathname;
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
 if(urlOrigin.protocol==='https:')res.setHeader('Strict-Transport-Security','max-age=31536000');
 const json=(obj,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj))};
 const redirect=location=>{res.writeHead(303,{Location:location});res.end()};
 try{
 if(!path.startsWith('/api/')){const files={'/':'index.html','/app.js':'app.js','/calendar.js':'calendar.js','/cards.js':'cards.js','/style.css':'style.css','/access':'access.html','/access.js':'access.js'};if(!files[path])fail(404,'Не найдено');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(readFileSync(join(root,'public',files[path])));return}
 if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)fail(403,'Недопустимый источник запроса');
 const s=session(req);
 if(path==='/api/login'&&req.method==='POST'){
 limited('login:'+req.socket.remoteAddress,10); const b=await body(req),[salt,h]=passwordHash.split(':');const candidate=await derive(String(b.password||'').slice(0,1024),salt,64);
 if(!h||h.length!==128||!timingSafeEqual(Buffer.from(h,'hex'),candidate))fail(401,'Неверный пароль');
 if(s)run('DELETE FROM sessions WHERE hash=?',s.hash);const n=newSession();res.setHeader('Set-Cookie',cookie(n.raw,n.age));return json({ok:true});}
 if(path==='/api/access'&&req.method==='POST'){
 limited('access:'+req.socket.remoteAddress,30);const b=await body(req);if(typeof b.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.token))fail(401,'Ссылка недействительна или отозвана');
 const e=one('SELECT * FROM employees WHERE token_hash=?',hash(b.token));if(!e)fail(401,'Ссылка недействительна или отозвана');if(s)run('DELETE FROM sessions WHERE hash=?',s.hash);const n=newSession(e);res.setHeader('Set-Cookie',cookie(n.raw,n.age));return json({ok:true});}
 if(!s)fail(401,'Войдите или откройте персональную ссылку');
 if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==s.csrf)fail(403,'Сессия устарела. Обновите страницу');
 if(path==='/api/logout'&&req.method==='POST'){run('DELETE FROM sessions WHERE hash=?',s.hash);res.setHeader('Set-Cookie',cookie('',0));return json({ok:true})}
 if(path==='/api/state'&&req.method==='GET'){
 const state={me:{id:s.employee_id,name:s.admin?'Администратор':s.name,admin:s.admin},csrf:s.csrf,events:q('SELECT '+(s.admin?'*':'id,title,start,end,location,description,cancelled,calendar_id,all_day')+' FROM events ORDER BY start'),employees:q('SELECT id,name FROM employees ORDER BY name'),assignments:q('SELECT * FROM assignments'),tasks:q('SELECT * FROM tasks')};
 const visible=new Set(state.events.filter(e=>!e.calendar_id||e.calendar_id===get('calendar')).map(e=>e.id));state.events=state.events.filter(e=>visible.has(e.id));state.tasks=state.tasks.filter(t=>visible.has(t.event_id));state.assignments=state.assignments.filter(a=>visible.has(a.event_id));if(!s.admin)state.events=state.events.map(({calendar_id,...e})=>e);
 if(s.admin)state.settings={template:JSON.parse(get('template')),templateOwners:JSON.parse(get('templateOwners')||'{}'),googleConnected:!!get('google'),googleConfigured:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),calendar:get('calendar')||'',lastSync:get('lastSync')||null,syncError:get('syncError')||'',links:q('SELECT id,token_hash IS NOT NULL AS active FROM employees')};return json(state)}
 const taskMatch=path.match(/^\/api\/tasks\/([^/]+)\/status$/);
 if(taskMatch&&req.method==='PATCH'){
 const b=await body(req);if(typeof b.done!=='boolean'||!Number.isInteger(b.revision))fail(400,'Неверный статус');
 transaction(()=>{const t=one('SELECT * FROM tasks WHERE id=?',taskMatch[1]);if(!t)fail(404,'Задача не найдена');if(!s.admin&&t.employee_id!==s.employee_id)fail(403,'Можно менять только свои задачи');if(t.revision!==b.revision)fail(409,'Задача уже изменена. Данные обновлены.');
 if(t.done===Number(b.done))return;run('UPDATE tasks SET done=?,revision=revision+1 WHERE id=?',Number(b.done),t.id);run('INSERT INTO audit(task_id,event_id,task_title,actor_id,actor_name,done,at) VALUES(?,?,?,?,?,?,?)',t.id,t.event_id,t.title,s.employee_id,s.admin?'Администратор':s.name,Number(b.done),new Date().toISOString())});return json({ok:true})}
 if(!s.admin)fail(403,'Доступно только администратору');
 if(path==='/api/employees'&&req.method==='POST'){const b=await body(req),id=token(),raw=token();run('INSERT INTO employees(id,name,token_hash) VALUES(?,?,?)',id,str(b.name,80),hash(raw));return json({id,link:origin+'/access#'+raw})}
 const emp=path.match(/^\/api\/employees\/([^/]+)\/(rotate|revoke)$/);
 if(emp&&req.method==='POST'){const e=one('SELECT * FROM employees WHERE id=?',emp[1]);if(!e)fail(404,'Сотрудник не найден');const raw=emp[2]==='rotate'?token():null;
 transaction(()=>{run('UPDATE employees SET token_hash=?,version=version+1 WHERE id=?',raw?hash(raw):null,e.id);run('DELETE FROM sessions WHERE employee_id=?',e.id)});return json({link:raw?origin+'/access#'+raw:null})}
 if(path==='/api/template'&&req.method==='PUT'){const b=await body(req);if(!Array.isArray(b.items)||b.items.length>30)fail(400,'Не более 30 задач');set('template',JSON.stringify(b.items.map(t=>str(t))));return json({ok:true})}
 const applyTemplate=path.match(/^\/api\/events\/([^/]+)\/template$/);
 if(applyTemplate&&req.method==='POST'){
 const b=await body(req),eventId=applyTemplate[1];
 if(!one('SELECT id FROM events WHERE id=?',eventId))fail(404,'Съёмка не найдена');
 if(!Array.isArray(b.items)||!b.items.length||b.items.length>30)fail(400,'Выберите от 1 до 30 задач');
 const titles=new Set(JSON.parse(get('template'))),seen=new Set();
 const items=b.items.map(item=>{const title=str(item.title),employee_id=validEmployee(item.employee_id);if(!titles.has(title))fail(409,'Шаблон изменился. Откройте его заново.');if(seen.has(title.toLocaleLowerCase('ru')))fail(400,'Задачи в шаблоне не должны повторяться');seen.add(title.toLocaleLowerCase('ru'));return {title,employee_id}});
 let added=0,assigned=0;
 transaction(()=>{for(const item of items){const existing=q('SELECT * FROM tasks WHERE event_id=?',eventId).find(t=>t.title.trim().toLocaleLowerCase('ru')===item.title.toLocaleLowerCase('ru'));
 if(existing){if(existing.employee_id!==item.employee_id){run('UPDATE tasks SET employee_id=?,revision=revision+1 WHERE id=?',item.employee_id,existing.id);assigned++}}
 else{run('INSERT INTO tasks(id,event_id,title,employee_id) VALUES(?,?,?,?)',token(),eventId,item.title,item.employee_id);added++}}
 if(b.remember===true){const owners=JSON.parse(get('templateOwners')||'{}');set('templateOwners',JSON.stringify(Object.fromEntries([...Object.entries(owners).filter(([title])=>!items.some(i=>i.title===title)),...items.map(i=>[i.title,i.employee_id])])))}
 });return json({added,assigned});}
 if(path==='/api/events'&&req.method==='POST'){const b=await body(req),v=eventFields(b),id=token();transaction(()=>{run('INSERT INTO events(id,title,start,end,location,description,dirty) VALUES(?,?,?,?,?,?,1)',id,...v);for(const title of JSON.parse(get('template')))run('INSERT INTO tasks(id,event_id,title) VALUES(?,?,?)',token(),id,title)});return json({id})}
 const ev=path.match(/^\/api\/events\/([^/]+)$/);
 if(ev&&req.method==='PUT'){const b=await body(req),v=eventFields(b);const existing=one('SELECT * FROM events WHERE id=?',ev[1]);if(!existing)fail(404,'Съёмка не найдена');if(existing.google_id)fail(403,'Это событие доступно только для чтения. Изменяйте его в Google Calendar.');run('UPDATE events SET title=?,start=?,end=?,location=?,description=?,dirty=1,revision=revision+1 WHERE id=?',...v,ev[1]);return json({ok:true})}
 const assign=path.match(/^\/api\/events\/([^/]+)\/assignments$/);
 if(assign&&req.method==='PUT'){const b=await body(req);if(!Array.isArray(b.items)||b.items.length>20)fail(400,'Проверьте команду');transaction(()=>{run('DELETE FROM assignments WHERE event_id=?',assign[1]);for(const a of b.items)run('INSERT INTO assignments VALUES(?,?,?)',assign[1],validEmployee(str(a.employee_id)),str(a.role,80))});return json({ok:true})}
 if(path==='/api/tasks'&&req.method==='POST'){const b=await body(req);run('INSERT INTO tasks(id,event_id,title,employee_id,deadline) VALUES(?,?,?,?,?)',token(),str(b.event_id),str(b.title),validEmployee(b.employee_id),b.deadline?str(b.deadline,30):null);return json({ok:true})}
 const tm=path.match(/^\/api\/tasks\/([^/]+)$/);
 if(tm&&req.method==='PUT'){const b=await body(req);run('UPDATE tasks SET title=?,employee_id=?,deadline=?,revision=revision+1 WHERE id=?',str(b.title),validEmployee(b.employee_id),b.deadline?str(b.deadline,30):null,tm[1]);return json({ok:true})}
 if(tm&&req.method==='DELETE'){run('DELETE FROM tasks WHERE id=?',tm[1]);return json({ok:true})}
 if(path==='/api/audit'&&req.method==='GET')return json(q('SELECT * FROM audit ORDER BY id DESC LIMIT 300'));
 if(path==='/api/demo'&&req.method==='POST'){if(one('SELECT id FROM events LIMIT 1'))fail(409,'Пример можно добавить только в пустое расписание');transaction(()=>{const names=['Андрей','Максим','Анна','Мария','Илья','Ольга','Денис','София'];for(const name of names)run('INSERT INTO employees(id,name) VALUES(?,?)',token(),name);const team=q('SELECT id FROM employees');for(let i=0;i<3;i++){const id=token(),d=new Date();d.setUTCDate(d.getUTCDate()+2+i*5);d.setUTCHours(3,0,0,0);run('INSERT INTO events(id,title,start,end,location,description) VALUES(?,?,?,?,?,?)',id,['Осенняя грация','Кубок Сибири','Первые звёзды'][i],d.toISOString(),new Date(+d+8*3600000).toISOString(),['Центр гимнастики','Арена «Север»','Спортивный комплекс'][i],'Тестовая съёмка. Можно отредактировать.');run('INSERT INTO assignments VALUES(?,?,?)',id,team[i].id,'Фотограф');for(const title of defaults)run('INSERT INTO tasks(id,event_id,title,employee_id) VALUES(?,?,?,?)',token(),id,title,team[i].id)}});return json({ok:true})}
 if(path==='/api/google/connect'&&req.method==='GET'){
 if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)fail(400,'Сначала настройте OAuth Google на сервере');const state=token(),verifier=token();run('DELETE FROM oauth WHERE expires<?',Date.now());run('INSERT INTO oauth VALUES(?,?,?,?)',hash(state),s.hash,verifier,Date.now()+600000);
 const params=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:origin+'/api/google/callback',response_type:'code',scope:'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly',access_type:'offline',prompt:'consent',state,code_challenge:Buffer.from(hash(verifier),'hex').toString('base64url'),code_challenge_method:'S256'});return redirect('https://accounts.google.com/o/oauth2/v2/auth?'+params)}
 if(path==='/api/google/callback'&&req.method==='GET'){
 const o=one('SELECT * FROM oauth WHERE state_hash=? AND session_hash=? AND expires>?',hash(url.searchParams.get('state')||''),s.hash,Date.now());if(!o)fail(403,'Неверный OAuth state');run('DELETE FROM oauth WHERE state_hash=?',o.state_hash);
 if(url.searchParams.has('error'))return redirect('/?google=cancelled');const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(15000),body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,code:url.searchParams.get('code')||'',code_verifier:o.verifier,grant_type:'authorization_code',redirect_uri:origin+'/api/google/callback'})});if(!r.ok)fail(502,'Google не подтвердил подключение');const g=await r.json();if(!g.refresh_token)fail(400,'Google не выдал offline-доступ. Повторите подключение');set('google',seal({...g,expires:Date.now()+g.expires_in*1000}));return redirect('/')}
 if(path==='/api/google/calendars'&&req.method==='GET'){let list=[],page;do{const r=await google('users/me/calendarList'+(page?'?pageToken='+encodeURIComponent(page):''));list.push(...(r.items||[]));page=r.nextPageToken}while(page);return json(list.filter(c=>['owner','writer','reader','writerWithoutPrivateAccess'].includes(c.accessRole)).map(c=>({id:c.id,name:c.summary}))) }
 if(path==='/api/google/calendar'&&req.method==='PUT'){if(syncing)fail(409,'Дождитесь синхронизации');const b=await body(req),id=str(b.id,500);if(get('calendar')!==id){run('DELETE FROM settings WHERE key IN (?,?,?)','syncToken','lastSync','syncError');}set('calendar',id);return json({ok:true})}
 if(path==='/api/google/sync'&&req.method==='POST'){await sync();return json({ok:true})}
 fail(404,'Не найдено');
 }catch(e){json({error:e.code&&e.code<500?e.message:e.code===502?e.message:'Не удалось выполнить действие'},e.code||500)}
 });
 return {server,db,sync,close:()=>{clearInterval(timer);server.close();db.close()}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const app=createApp();app.server.listen(Number(process.env.PORT||4318),process.env.HOST||'127.0.0.1',()=>console.log('ShootBoard: '+(process.env.APP_ORIGIN||'http://localhost:4318')))}

