import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventStatus,orderedEvents,pageOf,overlapCount} from '../public/cards.js';
const now=new Date('2026-11-04T12:00:00');
const e=(id,start,end,cancelled=0)=>({id,start,end,cancelled});
const events=[e('past','2026-11-01','2026-11-02'),e('live','2026-11-03','2026-11-06'),e('future','2026-11-07','2026-11-09'),e('cancel','2026-11-04','2026-11-07',1)];
test('statuses respect multi-day exclusive end and cancellations',()=>{
 assert.equal(eventStatus(events[1],now),'Идёт сейчас');assert.equal(eventStatus(events[0],now),'Завершено');assert.equal(eventStatus(events[2],now),'Предстоит');assert.equal(eventStatus(events[3],now),'Отменено');
 assert.equal(eventStatus(e('all','2026-11-03','2026-11-04'),now),'Завершено');
});
test('all orders active then future then completed then cancelled; active and future filters differ',()=>{
 assert.deepEqual(orderedEvents(events,'all',now).map(e=>e.id),['live','future','past','cancel']);
 assert.deepEqual(orderedEvents(events,'active',now).map(e=>e.id),['live','future']);assert.deepEqual(orderedEvents(events,'upcoming',now).map(e=>e.id),['future']);
});
test('pagination preserves valid page and clamps after removal including empty state',()=>{
 const list=Array.from({length:10},(_,i)=>i);assert.deepEqual(pageOf(list,2).items,[4,5,6,7]);assert.equal(pageOf(list,2).page,2);assert.equal(pageOf(list,3).to,10);assert.equal(pageOf(list.slice(0,3),3).page,1);assert.equal(pageOf([],5).from,0);assert.equal(pageOf([],5).pages,1);
});
test('overlap ignores touching boundaries and cancelled events',()=>{
 assert.equal(overlapCount(events[1],events),0);assert.equal(overlapCount(events[1],[...events,e('other','2026-11-04','2026-11-05')]),1);
 assert.equal(overlapCount(events[1],[...events,e('touch','2026-11-06','2026-11-07')]),0);
});
