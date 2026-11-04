import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventRange,calendarWeeks,dayKey,formatRange,isFinished,eventColors,eventColorStyle} from '../public/calendar.js';
const event=(start,end,id='event')=>({id,start,end,title:'Съёмка'});
test('overlapping events have distinct stable colors across weeks and more than six overlaps',()=>{
 const events=Array.from({length:10},(_,i)=>event('2026-10-25','2026-11-03','event-'+i));
 const colors=eventColors(events);assert.equal(new Set(colors.values()).size,10);
 assert.equal(new Set([...colors.values()].map(eventColorStyle)).size,10);
 assert.deepEqual([...eventColors([...events].reverse())],[...colors]);
 const separate=eventColors([event('2026-10-25','2026-10-26','a'),event('2026-10-26','2026-10-27','b')]);assert.equal(separate.get('a'),separate.get('b'));
 const segments=calendarWeeks(events,2026,9).flatMap(w=>w.segments).filter(s=>s.event.id==='event-0');assert.ok(segments.length>1);assert.ok(segments.every(s=>colors.get(s.event.id)===colors.get('event-0')));
});
test('all-day end is exclusive, dates survive device timezone, and single day has no time',()=>{
 const e=event('2026-10-25','2026-10-30');
 assert.equal(eventRange(e).days,5);assert.equal(dayKey(eventRange(e).last),'2026-10-29');
 assert.match(formatRange(e),/25 октября.*29 октября.*5 дней/);
 assert.match(formatRange(event('2026-10-30','2026-10-31')),/весь день/);
 assert.equal(isFinished(e,new Date('2026-10-29T23:59:00')),false);
 assert.equal(isFinished(e,new Date('2026-10-30T00:00:00')),true);
});
test('multi-day bars cross weeks and months without adding an extra day',()=>{
 const e=event('2026-10-30','2026-11-03');
 const oct=calendarWeeks([e],2026,9).flatMap(w=>w.segments);
 assert.equal(oct.length,1);assert.equal(oct[0].from,4);assert.equal(oct[0].to,6);assert.equal(oct[0].continuesAfter,true);
 const nov=calendarWeeks([e],2026,10).flatMap(w=>w.segments);
 assert.equal(nov.length,2);assert.equal(nov[1].from,0);assert.equal(nov[1].to,0);assert.equal(nov[1].continuesBefore,true);
 assert.equal(nov[1].range.days,4);
});
test('Sunday-to-Thursday example occupies both week rows',()=>{
 const weeks=calendarWeeks([event('2026-10-25','2026-10-30')],2026,9);
 const segments=weeks.flatMap(w=>w.segments);
 assert.equal(segments.length,2);assert.equal(segments[0].from,6);assert.equal(segments[0].to,6);
 assert.equal(segments[1].from,0);assert.equal(segments[1].to,3);
});
test('overlapping events never share a lane; adjacent events reuse a lane',()=>{
 const events=[event('2026-10-26','2026-10-29','a'),event('2026-10-27','2026-10-30','b'),event('2026-10-29','2026-10-30','c')];
 const segs=calendarWeeks(events,2026,9).at(-1).segments;
 assert.notEqual(segs.find(s=>s.event.id==='a').lane,segs.find(s=>s.event.id==='b').lane);
 assert.equal(segs.find(s=>s.event.id==='a').lane,segs.find(s=>s.event.id==='c').lane);
});
test('midnight end excludes following day, timed overnight includes both dates, invalid interval omitted',()=>{
 const e=event('2026-10-30T07:00:00','2026-11-01T00:00:00');assert.equal(eventRange(e).days,2);
 const night=event('2026-10-30T23:00:00','2026-10-31T02:00:00');assert.equal(eventRange(night).days,2);assert.match(formatRange(night),/30 октября.*23:00.*31 октября.*02:00/);
 assert.equal(eventRange(event('bad','bad')),null);assert.equal(calendarWeeks([event('bad','bad')],2026,9).flatMap(w=>w.segments).length,0);
});
test('calendar layout includes long event that starts before displayed month',()=>{
 const weeks=calendarWeeks([event('2026-09-15','2026-11-02')],2026,9);
 assert.ok(weeks.every(w=>w.segments.length===1));assert.ok(weeks[0].segments[0].continuesBefore);
 assert.equal(weeks.at(-1).segments[0].to,6);
});
