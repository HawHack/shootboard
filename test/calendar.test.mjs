import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import {createApp} from '../server.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('Calendar pagination, expired sync token, read-only requests and preserved team/tasks',async()=>{
 const key=randomBytes(32),salt=randomBytes(16).toString('hex');const a=createApp({origin:'https://shootboard.test',passwordHash:salt+':'+scryptSync('test-only-password',salt,64).toString('hex'),dataKey:key.toString('hex'),dbPath:':memory:'});
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),enc=Buffer.concat([cipher.update(JSON.stringify({access_token:'test-google-token',refresh_token:'test-refresh',expires:Date.now()+3600000})),cipher.final()]);
 const set=(k,v)=>a.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k,v);
 set('google',Buffer.concat([iv,cipher.getAuthTag(),enc]).toString('base64'));set('calendar','primary');set('syncToken','expired');
 const row={id:'remote-1',summary:'Из Google',start:{dateTime:'2026-11-01T10:00:00+07:00'},end:{dateTime:'2026-11-01T18:00:00+07:00'},etag:'"v1"',location:'Арена'};
 const realFetch=global.fetch;let requests=[],phase=0;
 global.fetch=async(input,opts={})=>{const u=new URL(input);requests.push({url:u,opts});assert.match(opts.headers.Authorization,/test-google-token/);
 assert.ok(!opts.method||opts.method==='GET','Calendar must never receive writes');
 if(u.searchParams.get('syncToken')==='expired')return Response.json({error:'gone'},{status:410});
 if(phase===0&&!u.searchParams.has('pageToken'))return Response.json({items:[row],nextPageToken:'second'});
 if(phase===0)return Response.json({items:[],nextSyncToken:'fresh'});
 return Response.json({items:[{...row,summary:'Новое название',etag:'"v2"'}],nextSyncToken:'latest'});
 };
 try{await a.sync();assert.equal(requests.length,3);assert.equal(a.db.prepare('SELECT value FROM settings WHERE key=?').get('syncToken').value,'fresh');
 const e=a.db.prepare('SELECT * FROM events WHERE google_id=?').get(row.id);assert.equal(e.start,row.start.dateTime);
 a.db.prepare('INSERT INTO employees(id,name) VALUES(?,?)').run('alice','Анна');a.db.prepare('INSERT INTO assignments VALUES(?,?,?)').run(e.id,'alice','Фотограф');a.db.prepare('INSERT INTO tasks(id,event_id,title,employee_id,done) VALUES(?,?,?,?,1)').run('task',e.id,'Оборудование','alice');
 phase=1;await a.sync();assert.equal(a.db.prepare('SELECT title FROM events WHERE id=?').get(e.id).title,'Новое название');assert.equal(a.db.prepare('SELECT done FROM tasks').get().done,1);assert.equal(a.db.prepare('SELECT role FROM assignments').get().role,'Фотограф');assert.equal(a.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 a.db.prepare('UPDATE events SET dirty=1,title=? WHERE id=?').run('Old local edit',e.id);await a.sync();assert.equal(a.db.prepare('SELECT title FROM events WHERE id=?').get(e.id).title,'Новое название');
 a.db.prepare('INSERT INTO events(id,title,start,end,dirty) VALUES(?,?,?,?,1)').run('new-local','Новая','2026-11-03T03:00:00Z','2026-11-03T12:00:00Z');await a.sync();assert.equal(a.db.prepare('SELECT google_id FROM events WHERE id=?').get('new-local').google_id,null);
 const stored=a.db.prepare('SELECT value FROM settings WHERE key=?').get('google').value;assert.ok(!stored.includes('test-google-token'));
 }finally{global.fetch=realFetch;a.close()}
});
test('upgrade preserves existing tasks; full reload restores all-day dates with exclusive end',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shootboard-date-upgrade-')),key=randomBytes(32),salt=randomBytes(16).toString('hex');
 const config={origin:'https://shootboard.test',passwordHash:salt+':'+scryptSync('test-only-password',salt,64).toString('hex'),dataKey:key.toString('hex'),dbPath:join(dir,'existing.sqlite')};
 let a=createApp(config);const realFetch=global.fetch;
 try{
 a.db.prepare('INSERT INTO events(id,title,start,end,google_id,calendar_id) VALUES(?,?,?,?,?,?)').run('existing','Лига','2026-10-25T00:00:00Z','2026-10-30T00:00:00Z','google-existing','team');
 a.db.prepare('INSERT INTO tasks(id,event_id,title,done) VALUES(?,?,?,1)').run('task','existing','Оборудование');
 a.db.prepare('INSERT INTO settings VALUES(?,?)').run('syncToken','previous-token');
 a.db.prepare('INSERT INTO settings VALUES(?,?)').run('calendar','team');
 const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),enc=Buffer.concat([c.update(JSON.stringify({access_token:'test',expires:Date.now()+3600000})),c.final()]);
 a.db.prepare('INSERT INTO settings VALUES(?,?)').run('google',Buffer.concat([iv,c.getAuthTag(),enc]).toString('base64'));
 a.db.exec("DELETE FROM settings WHERE key='dateModelV2'; ALTER TABLE events DROP COLUMN all_day;");a.close();
 a=createApp(config);assert.ok(a.db.prepare('PRAGMA table_info(events)').all().some(c=>c.name==='all_day'));
 assert.equal(a.db.prepare('SELECT value FROM settings WHERE key=?').get('syncToken'),undefined);
 global.fetch=async(u,o)=>{assert.equal(new URL(u).searchParams.has('syncToken'),false);assert.ok(!o.method||o.method==='GET');return Response.json({items:[{id:'google-existing',summary:'Лига',start:{date:'2026-10-25'},end:{date:'2026-10-30'},etag:'new'}],nextSyncToken:'new-token'})};
 await a.sync();const e=a.db.prepare('SELECT * FROM events WHERE id=?').get('existing');
 assert.equal(e.start,'2026-10-25');assert.equal(e.end,'2026-10-30');assert.equal(e.all_day,1);
 assert.equal(a.db.prepare('SELECT done FROM tasks WHERE id=?').get('task').done,1);
 assert.equal(a.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 }finally{global.fetch=realFetch;a.close();rmSync(dir,{recursive:true,force:true})}
});
test('shared reader calendar is selectable; imported event edits rejected; switching preserves data',async()=>{
 const password='test-only-password',salt=randomBytes(16).toString('hex'),key=randomBytes(32);
 const a=createApp({origin:'https://shootboard.test',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),dataKey:key.toString('hex'),dbPath:':memory:'});
 await new Promise(r=>a.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+a.server.address().port;
 const realFetch=global.fetch;const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),enc=Buffer.concat([c.update(JSON.stringify({access_token:'test',expires:Date.now()+3600000})),c.final()]);a.db.prepare('INSERT INTO settings VALUES(?,?)').run('google',Buffer.concat([iv,c.getAuthTag(),enc]).toString('base64'));
 const login=await realFetch(base+'/api/login',{method:'POST',headers:{Origin:'https://shootboard.test','Content-Type':'application/json'},body:JSON.stringify({password})});const cookie=login.headers.get('set-cookie').split(';')[0];
 const headers={Cookie:cookie,Origin:'https://shootboard.test','Content-Type':'application/json'};let state=await(await realFetch(base+'/api/state',{headers})).json();headers['X-CSRF-Token']=state.csrf;
 global.fetch=async(u,o)=>String(u).startsWith('https://www.googleapis.com/')?Response.json({items:[{id:'primary',summary:'Личный',accessRole:'owner'},{id:'team',summary:'PAWELL.RU',accessRole:'reader'},{id:'busy',summary:'Занятость',accessRole:'freeBusyReader'}]}):realFetch(u,o);
 try{
 const calendars=await(await realFetch(base+'/api/google/calendars',{headers})).json();assert.ok(calendars.some(c=>c.id==='team'));assert.ok(!calendars.some(c=>c.id==='busy'));
 a.db.prepare('INSERT INTO events(id,title,start,end,google_id,calendar_id) VALUES(?,?,?,?,?,?)').run('old','Личное','2026-11-01T03:00:00Z','2026-11-01T10:00:00Z','g1','primary');a.db.prepare('INSERT INTO settings VALUES(?,?)').run('calendar','primary');a.db.prepare('INSERT INTO settings VALUES(?,?)').run('syncToken','old-token');
 const update=await realFetch(base+'/api/events/old',{method:'PUT',headers,body:JSON.stringify({title:'Forbidden',start:'2026-11-01T03:00:00Z',end:'2026-11-01T10:00:00Z'})});assert.equal(update.status,403);
 const change=await realFetch(base+'/api/google/calendar',{method:'PUT',headers,body:JSON.stringify({id:'team'})});assert.equal(change.status,200);assert.equal(a.db.prepare('SELECT value FROM settings WHERE key=?').get('syncToken'),undefined);
 state=await(await realFetch(base+'/api/state',{headers})).json();assert.equal(state.events.length,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 }finally{global.fetch=realFetch;a.close()}
});
