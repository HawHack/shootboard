import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskAgenda,sortTaskEvents,eventPhase} from '../public/task-agenda.js';
const now=new Date('2026-11-05T05:00:00Z');
const event=(id,start,end,extra={})=>({id,title:'Кубок',start,end,all_day:1,timezone:'Asia/Krasnoyarsk',...extra});
const events=[event('old','2025-01-01','2025-01-02'),event('recent','2026-11-03','2026-11-04'),event('future','2026-11-08','2026-11-10'),event('current','2026-11-05','2026-11-08'),event('cancel','2026-11-05','2026-11-08',{cancelled:1})];
const task=(id,event_id,deadline=null,extra={})=>({id,event_id,deadline,title:'Задача '+id,done:0,...extra});

test('tasks have explicit date sections, nearest future dates and most recent overdue first',()=>{
 const tasks=[task('far','future','2026-12-01'),task('stale','old','2025-01-01'),task('due','current','2026-11-05'),task('late','recent','2026-11-04'),task('near','current','2026-11-06'),task('no','current'),task('cancel','cancel','2026-11-04'),task('done','current','2026-11-05',{done:1}),task('missing','missing','2026-11-05')];
 const result=taskAgenda(tasks,events,now);
 assert.deepEqual(result.map(s=>s.id),['overdue','today','upcoming','undated','cancelled']);
 assert.deepEqual(result[0].days.map(g=>g.date),['2026-11-04','2025-01-01']);
 assert.deepEqual(result[2].days.map(g=>g.date),['2026-11-06','2026-12-01']);
 assert.equal(result.reduce((n,s)=>n+s.count,0),7);
 assert.deepEqual(taskAgenda([...tasks].reverse(),[...events].reverse(),now),result);
});

test('undated work and event filter prioritize active, upcoming and recent completed events',()=>{
 assert.deepEqual(sortTaskEvents(events,now).map(e=>e.id),['current','future','recent','old','cancel']);
 const section=taskAgenda(events.map(e=>task(e.id,e.id)),events,now)[0];
 assert.equal(section.id,'undated');assert.deepEqual(section.days[0].events.map(g=>g.event.id),['current','future','recent','old']);
 assert.equal(eventPhase(events[3],new Date('2026-11-07T16:59:59Z')),'current');
 assert.equal(eventPhase(events[3],new Date('2026-11-07T17:00:00Z')),'past');
});

test('equal names remain separate events; shooting days are ordered inside each event',()=>{
 const section=taskAgenda([task('second','current','2026-11-10',{shooting_day:'2026-11-06'}),task('first','current','2026-11-10',{shooting_day:'2026-11-05'}),task('other','future','2026-11-10')],events,now)[0];
 assert.equal(section.days[0].events.length,2);assert.deepEqual(section.days[0].events[0].tasks.map(t=>t.id),['first','second']);
});

test('deadline buckets use the task timezone rather than the device timezone; empty results are empty',()=>{
 const instant=new Date('2026-11-05T00:30:00Z');const sections=taskAgenda([task('east','current','2026-11-05',{timezone:'Asia/Krasnoyarsk'}),task('west','current','2026-11-05',{timezone:'America/Los_Angeles'}),task('invalid','current','invalid')],events,instant);
 assert.deepEqual(sections.map(s=>s.id),['today','upcoming','undated']);assert.deepEqual(taskAgenda([],events,now),[]);
});
