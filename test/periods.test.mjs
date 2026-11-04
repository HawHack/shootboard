import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterEvents,monthsAgo} from '../public/calendar.js';
const now=new Date('2026-10-28T12:00:00');
const e=(id,start,end)=>({id,start,end});
const events=[e('old','2025-01-01','2025-01-02'),e('five','2026-05-01','2026-05-03'),e('two','2026-08-01','2026-08-03'),e('ongoing','2026-10-27','2026-10-30'),e('future','2026-11-01','2026-11-03')];
const ids=period=>filterEvents(events,period,now).map(e=>e.id);
test('upcoming includes ongoing; past excludes ongoing and future',()=>{
 assert.deepEqual(ids('upcoming'),['ongoing','future']);assert.deepEqual(ids('past'),['two','five','old']);
});
test('last 3 and 6 months include only completed events inside rolling date window',()=>{
 assert.deepEqual(ids('recent3'),['two']);assert.deepEqual(ids('recent6'),['two','five']);
 assert.equal(filterEvents([e('boundary','2026-07-27T12:00:00','2026-07-28T12:00:00')],'recent3',now).length,1);
 assert.equal(filterEvents([e('before','2026-07-27T12:00:00','2026-07-28T11:59:59')],'recent3',now).length,0);
});
test('show all includes past, ongoing, and future; all-day ends and exact end time are exclusive',()=>{
 assert.deepEqual(ids('all'),['old','five','two','ongoing','future']);
 const ended=e('ended','2026-10-27','2026-10-28');assert.equal(filterEvents([ended],'past',now).length,1);
 const exact=e('exact','2026-10-28T10:00:00','2026-10-28T12:00:00');assert.equal(filterEvents([exact],'past',now).length,1);assert.equal(filterEvents([exact],'upcoming',now).length,0);
});
test('month subtraction clamps month-end and handles year boundary',()=>{
 const d=monthsAgo(new Date('2026-05-31T12:30:00'),3);assert.equal(d.getMonth(),1);assert.equal(d.getDate(),28);assert.equal(d.getHours(),12);
 const y=monthsAgo(new Date('2026-02-28T12:00:00'),6);assert.equal(y.getFullYear(),2025);assert.equal(y.getMonth(),7);
});
