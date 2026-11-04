import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, hash } from '../server.mjs';
const salt=randomBytes(16).toString('hex'),password='test-only-password-782341';
const config={origin:'https://shootboard.test',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),dataKey:randomBytes(32).toString('hex')};
async function start(dbPath=':memory:'){const a=createApp({...config,dbPath});await new Promise(r=>a.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+a.server.address().port;return {...a,base}}
async function call(a,path,method='GET',body,client={},extra={}){const r=await fetch(a.base+'/api/'+path,{method,headers:{Origin:config.origin,'Content-Type':'application/json',Cookie:client.cookie||'','X-CSRF-Token':client.csrf||'',...extra},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});const data=await r.json();return {status:r.status,data,cookie:r.headers.get('set-cookie'),headers:r.headers}}
async function admin(a){const l=await call(a,'login','POST',{password});assert.equal(l.status,200);const c={cookie:l.cookie.split(';')[0]};const s=await call(a,'state','GET',undefined,c);c.csrf=s.data.csrf;return c}
async function employee(a,link){const l=await call(a,'access','POST',{token:new URL(link).hash.slice(1)});assert.equal(l.status,200);const c={cookie:l.cookie.split(';')[0]};const s=await call(a,'state','GET',undefined,c);c.csrf=s.data.csrf;return c}
test('permissions, cookies, audit, concurrency, revocation and token storage',async()=>{const a=await start();try{
 assert.equal((await call(a,'state')).status,401);assert.equal((await call(a,'login','POST',{password:'wrong'})).status,401);
 const login=await call(a,'login','POST',{password});assert.match(login.cookie,/HttpOnly/);assert.match(login.cookie,/Secure/);assert.match(login.cookie,/SameSite=Lax/);assert.match(login.cookie,/__Host-/);
 const owner=await admin(a);
 const alice=(await call(a,'employees','POST',{name:'Анна'},owner)).data;
 const bob=(await call(a,'employees','POST',{name:'Максим'},owner)).data;
 const raw=new URL(alice.link).hash.slice(1);assert.equal(raw.length,43);assert.equal(a.db.prepare('SELECT token_hash FROM employees WHERE id=?').get(alice.id).token_hash,hash(raw));assert.ok(!JSON.stringify(a.db.prepare('SELECT * FROM employees').all()).includes(raw));
 const ac=await employee(a,alice.link),bc=await employee(a,bob.link);
 const e=(await call(a,'events','POST',{title:'Кубок',start:'2026-11-01T03:00:00Z',end:'2026-11-01T12:00:00Z'},owner)).data;
 await call(a,'tasks','POST',{event_id:e.id,title:'Подготовить камеры',employee_id:alice.id},owner);
 let s=(await call(a,'state','GET',undefined,ac)).data,t=s.tasks.find(t=>t.employee_id===alice.id);assert.equal(s.settings,undefined);assert.equal(s.me.admin,false);
 assert.equal((await call(a,'employees','POST',{name:'Злоумышленник'},ac)).status,403);
 assert.equal((await call(a,'google/calendars','GET',undefined,ac)).status,403);
 assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:0},bc)).status,403);
 assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:0},ac,{'X-CSRF-Token':''})).status,403);
 assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:0},ac,{Origin:'https://evil.test'})).status,403);
 assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:0},ac)).status,200);
 s=(await call(a,'state','GET',undefined,bc)).data;assert.equal(s.tasks.find(x=>x.id===t.id).done,1);
 assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:false,revision:0},owner)).status,409);
 assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:false,revision:1},owner)).status,200);
 const log=(await call(a,'audit','GET',undefined,owner)).data;assert.equal(log.length,2);assert.equal(log[1].actor_name,'Анна');assert.equal(log[0].actor_name,'Администратор');assert.ok(log[0].at);
 const newer=(await call(a,'employees/'+alice.id+'/rotate','POST',{},owner)).data;
 assert.equal((await call(a,'state','GET',undefined,ac)).status,401);
 assert.equal((await call(a,'access','POST',{token:raw})).status,401);
 const nc=await employee(a,newer.link);await call(a,'employees/'+alice.id+'/revoke','POST',{},owner);assert.equal((await call(a,'state','GET',undefined,nc)).status,401);
 assert.equal((await call(a,'access','POST',{token:new URL(newer.link).hash.slice(1)})).status,401);
 assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:2},bc)).status,403);
 assert.match((await fetch(a.base+'/access')).headers.get('referrer-policy'),/no-referrer/);
 }finally{a.close()}});
test('data and session persist through restart; unassigned tasks cannot be changed by employee',async()=>{const dir=mkdtempSync(join(tmpdir(),'shootboard-'));let a;try{const file=join(dir,'db.sqlite');a=await start(file);const c=await admin(a);await call(a,'demo','POST',{},c);const first=(await call(a,'state','GET',undefined,c)).data;assert.equal(first.events.length,3);assert.equal(first.employees.length,8);a.close();a=await start(file);const restored=await call(a,'state','GET',undefined,c);assert.equal(restored.status,200);assert.equal(restored.data.tasks.length,24);
 const e=(await call(a,'employees','POST',{name:'Новый'},c)).data,ec=await employee(a,e.link),t=restored.data.tasks[0];assert.equal((await call(a,'tasks/'+t.id+'/status','PATCH',{done:true,revision:0},ec)).status,403);
 }finally{a?.close();rmSync(dir,{recursive:true,force:true})}});
test('login throttling and validation',async()=>{const a=await start();try{for(let i=0;i<10;i++)await call(a,'login','POST',{password:'bad'});assert.equal((await call(a,'login','POST',{password})).status,429)}finally{a.close()}});
