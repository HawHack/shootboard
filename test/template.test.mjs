import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,scryptSync} from 'node:crypto';
import {createApp} from '../server.mjs';
test('admin applies template with owners atomically, remembers defaults, and does not duplicate or reset tasks',async()=>{
 const password='test-only-password',salt=randomBytes(16).toString('hex');
 const a=createApp({origin:'https://shootboard.test',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),dataKey:randomBytes(32).toString('hex'),dbPath:':memory:'});
 await new Promise(r=>a.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+a.server.address().port;
 let headers={Origin:'https://shootboard.test','Content-Type':'application/json'};
 const call=async(path,method='GET',body,h=headers)=>{const r=await fetch(base+'/api/'+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')}};
 try{
 const login=await call('login','POST',{password});headers.Cookie=login.cookie.split(';')[0];const state=(await call('state')).data;headers['X-CSRF-Token']=state.csrf;
 const employee=(await call('employees','POST',{name:'Анна'})).data;
 const event=(await call('events','POST',{title:'Кубок',start:'2026-11-01T03:00:00Z',end:'2026-11-01T12:00:00Z'})).data;
 const title=state.settings.template[0];const original=a.db.prepare('SELECT * FROM tasks WHERE event_id=? AND title=?').get(event.id,title);
 a.db.prepare('UPDATE tasks SET done=1,deadline=? WHERE id=?').run('2026-10-30',original.id);
 const b={items:[{title,employee_id:employee.id}],remember:true};
 let r=await call('events/'+event.id+'/template','POST',b);assert.equal(r.status,200);assert.equal(r.data.added,0);assert.equal(r.data.assigned,1);
 const after=a.db.prepare('SELECT * FROM tasks WHERE id=?').get(original.id);assert.equal(after.done,1);assert.equal(after.deadline,'2026-10-30');assert.equal(after.employee_id,employee.id);assert.equal(after.revision,1);
 r=await call('events/'+event.id+'/template','POST',b);assert.equal(r.data.added,0);assert.equal(r.data.assigned,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM tasks WHERE event_id=?').get(event.id).n,state.settings.template.length);
 assert.equal((await call('state')).data.settings.templateOwners[title],employee.id);
 // Imported events start without tasks and can receive the template, too.
 a.db.prepare('INSERT INTO events(id,title,start,end,google_id) VALUES(?,?,?,?,?)').run('imported','Из Google','2026-11-03','2026-11-06','google-id');
 r=await call('events/imported/template','POST',b);assert.equal(r.data.added,1);
 const before=a.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
 r=await call('events/imported/template','POST',{items:[{title,employee_id:employee.id},{title:state.settings.template[1],employee_id:'missing'}]});assert.equal(r.status,400);assert.equal(a.db.prepare('SELECT count(*) AS n FROM tasks').get().n,before);
 assert.equal((await call('events/imported/template','POST',{items:[]})).status,400);
 assert.equal((await call('events/imported/template','POST',{items:[{title:'Шаблон уже другой'}]})).status,409);
 const employeeLogin=await call('access','POST',{token:new URL(employee.link).hash.slice(1)});const eh={...headers,Cookie:employeeLogin.cookie.split(';')[0]};const es=(await call('state','GET',undefined,eh)).data;eh['X-CSRF-Token']=es.csrf;
 assert.equal((await call('events/imported/template','POST',b,eh)).status,403);assert.equal(es.settings,undefined);
 }finally{a.close()}
});
