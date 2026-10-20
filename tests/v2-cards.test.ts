import assert from "node:assert/strict";
import test from "node:test";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from './fixtures.js';

function setup(crisis = false) {
  const store = new SqliteStore(":memory:");
  const owner = store.upsertUser("dev:cards-owner", "甲", "dev").id;
  const other = store.upsertUser("dev:cards-other", "乙", "dev").id;
  const cards = new CardService(store, new CrisisSafetyService({ noul: async () => crisis ? 1 : 0 }));
  return { store, owner, other, cards };
}

test('pagination keeps the filtered total and search includes mine and labels',async()=>{
 const {store,owner,cards}=setup();try {
  for(let i=0;i<43;i++) await cards.create(owner,{text:`第${i}条原话`,type:'idea'});
  const first=cards.list(owner),last=cards.list(owner,{cursor:first.cursor!});
  assert.equal(first.data.length,40);assert.equal(first.total,43);assert.equal(last.total,43);assert.equal(last.data.length,3);assert.equal(last.cursor,null);
  assert.equal(new Set([...first.data,...last.data].map(c=>c.id)).size,43);
  const c=first.data[0]!, mine=await cards.mine(owner,c.id,c.version,{text:'这一句我的理解作为特别检索用词'});
  const tag=cards.tagCreate(owner,'标签查询',2);cards.tagsReplace(owner,c.id,mine.card.version,[tag.id]);
  assert.equal(cards.list(owner,{search:'特别检索'}).total,1);assert.equal(cards.list(owner,{search:'标签查询'}).total,1);
  const oldest=cards.list(owner,{order:'created'}).data;assert.ok(oldest[0]!.createdAt<=oldest.at(-1)!.createdAt);
 }finally{store.close();}
});

test('a late card screening cannot overwrite a new version or recreate a deleted card',async()=>{
 const {store,owner,cards}=setup();try {
  const c=(await cards.create(owner,{text:'一些需要梳理的想法',type:'idea'})).card;
  let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});
  const delayed=new CardService(store,new CrisisSafetyService({noul:async()=>{await pending;return 0;}}));
  const edit=delayed.update(owner,c.id,1,{title:'晚到修改'});
  await cards.update(owner,c.id,1,{title:'先完成修改'});release();await assert.rejects(edit,{code:'CARD_CHANGED'});
  assert.equal(cards.detail(owner,c.id).title,'先完成修改');
  let again!:()=>void;const wait=new Promise<void>(r=>{again=r;});
  const removed=new CardService(store,new CrisisSafetyService({noul:async()=>{await wait;return 0;}}));
  const mine=removed.mine(owner,c.id,2,{text:'这一句足够长的我的理解文字'});cards.remove(owner,c.id);again();await assert.rejects(mine,{code:'NOT_FOUND'});
 }finally{store.close();}
});

test('AI preserves user fields and tags; changing type archives incompatible slots',async()=>{
 const {store,owner,cards}=setup();try {
  const c=(await cards.create(owner,{text:'我想把学习安排先梳理清楚',type:'idea'})).card;
  const ai=cards.applyAIData(owner,c.id,1,{title:'初稿',summary:'摘要',slots:[{key:'claim',text:'先梳理安排'}],tags:['安排'],followup:{q:'先做什么',options:['列出任务','排好时间']}});
  assert.equal(ai.stage,'written');assert.equal(ai.tags.length,1);assert.equal((ai.slots[0] as {by:string}).by,'ai');
  const edited=await cards.update(owner,c.id,ai.version,{title:'我的标题',slots:[{key:'claim',text:'我自己的安排',by:'ai'}]});
  const tag=cards.tagCreate(owner,'手动',4),tagged=cards.tagsReplace(owner,c.id,edited.card.version,[tag.id]);
  const next=cards.applyAIData(owner,c.id,tagged.version,{title:'不可覆盖',slots:[{key:'claim',text:'不能覆盖用户文字'}],tags:['新的']});
  assert.equal(next.title,'我的标题');assert.equal((next.slots[0] as {text:string}).text,'我自己的安排');assert.equal(next.tags[0]!.id,tag.id);
  // changing the type keeps what was organized (it used to wipe the slots).
  // the old type's slots are kept as 补充, so every client can save the card.
  const changed=await cards.update(owner,c.id,next.version,{type:'method'});assert.deepEqual(changed.card.slots,[]);
  assert.deepEqual(changed.card.supplements.map(x=>x.text),['我认为：我自己的安排']);
  assert.equal(changed.card.kind,'method');
  assert.ok(cards.detail(owner,c.id).versions.some(v=>v.kind==='type' && v.data.previousKind==='idea'));
 }finally{store.close();}
});

test('closing screens a new result and clearing mine hides the stamp',async()=>{
 const {store,owner,other,cards}=setup();try {
  const c=(await cards.create(owner,{text:'一件想先理清楚的事情',type:'idea'})).card;
  const mine=await cards.mine(owner,c.id,1,{text:'我的理解是先把这件事情拆开'});
  await assert.rejects(cards.close(owner,c.id,mine.card.version),{code:'INVALID_CARD'});
  assert.equal((await cards.close(owner,c.id,mine.card.version,'我不想活了这件事不再继续了')).crisis,true);
  const closed=await cards.close(owner,c.id,mine.card.version,'已经做完第一步并且确认结果了');assert.equal(closed.card.stage,'closed');
  cards.tagCreate(owner,'归档',0);
  const stats=cards.stats(owner);assert.equal(stats.closed,1);assert.equal(stats.closedByType[c.type],1);assert.equal(stats.tagCount,1);assert.equal(cards.stats(other).total,0);
  const cleared=await cards.mine(owner,c.id,closed.card.version,{text:''});assert.equal(cleared.card.stage,'written');assert.equal(cards.list(owner,{closed:true}).total,0);
 }finally{store.close();}
});

test('card routes map search and false filters and reject forged AI or imported sources',async()=>{
 const app=makeApp(fakeServices());try {
  const login=(await app.inject({method:'POST',url:'/v1/auth/dev-login',payload:{key:'card-routes'}})).json().data;
  const headers={authorization:`Bearer ${login.token}`};
  const created=await app.inject({method:'POST',url:'/v1/cards',headers,payload:{text:'这是专门检索用的原话',type:'idea'}});
  assert.equal(created.statusCode,200,created.body);
  const list=await app.inject({url:'/v1/cards?q=专门检索&closed=false&pick=0',headers});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().data.total,1);
  assert.equal((await app.inject({url:'/v1/cards?q=不存在',headers})).json().data.total,0);
  for(const payload of [{text:'x',origin:'import',srcId:'fake'},{text:'x',titleBy:'ai'}]) assert.equal((await app.inject({method:'POST',url:'/v1/cards',headers,payload})).statusCode,400);
 }finally{await app.close();}
});

test("cards preserve ownership, immutable quotes, versions, tags and calculated stages", async () => {
  const { store, owner, other, cards } = setup();
  try {
    const created = await cards.create(owner, { text: "为什么极限需要左右都存在", origin: "jot" });
    assert.equal(created.card.type, "question");
    assert.equal(created.card.stage, "written");
    assert.throws(() => cards.detail(other, created.card.id), { code: "NOT_FOUND" });
    await assert.rejects(cards.update(owner, created.card.id, created.card.version, { title: "改名", pointId: "not-a-point" }), { code: "INVALID_CARD" });
    const tag = cards.tagCreate(owner, "极限", 0);
    assert.throws(() => cards.tagCreate(owner, "极限", 1), { code: "TAG_EXISTS" });
    const tagged = cards.tagsReplace(owner, created.card.id, created.card.version, [tag.id]);
    assert.equal(tagged.stage, "organized");
    assert.equal(tagged.tags[0]?.name, "极限");
    assert.throws(() => cards.tagsReplace(owner, created.card.id, created.card.version, []), { code: "CARD_CHANGED" });
    const mine = await cards.mine(owner, created.card.id, tagged.version, { quote: "为什么极限需要左右都存在" });
    assert.equal(mine.card.stage, "clear");
    const source = await cards.create(owner, { text: "原话只能保存一次", origin: "jot" });
    const edited = await cards.update(owner, source.card.id, source.card.version, { title: "用户改标题" });
    assert.equal(edited.card.quote, "原话只能保存一次");
  } finally { store.close(); }
});

test("crisis creation is retained but editing is blocked, mood and point cards cannot be manually closed, and deletion stays deleted", async () => {
  const { store, owner, cards } = setup(true);
  try {
    const crisis = await cards.create(owner, { text: "普通文字", origin: "jot" });
    assert.equal(crisis.crisis, true);
    const blocked = await cards.update(owner, crisis.card.id, crisis.card.version, { title: "不会保存" });
    assert.equal(blocked.crisis, true);
    assert.equal(cards.detail(owner, crisis.card.id).title, "");
    const safe = new CardService(store, new CrisisSafetyService());
    await assert.rejects(safe.create(owner, { text: "今天心情记录", origin: "chat", scene: "mood", srcId: "missing" }), { code: "INVALID_CARD" });
    const now = "2026-10-12T00:00:00.000Z";
    store.db.prepare("INSERT INTO threads(id,user_id,title,created_at,updated_at) VALUES('thread-x',?,'对话',?,?)").run(owner, now, now);
    store.db.prepare("UPDATE threads SET scene='mood' WHERE id='thread-x'").run();
    store.db.prepare("UPDATE users SET data=json_set(data,'$.moodConsentAt',?) WHERE id=?").run(now,owner);
    store.db.prepare("INSERT INTO messages(id,thread_id,user_id,role,kind,content,status,created_at) VALUES('mood-msg','thread-x',?,'user','text','今天心情记录','done',?)").run(owner,now);
    const mood = await safe.create(owner, { origin: "chat", srcId: "thread-x", messageId:'mood-msg' });
    await assert.rejects(safe.close(owner, mood.card.id, mood.card.version, "这是足够长的一句心情结果文字"), { code: "INVALID_CARD" });
  } finally { store.close(); }
});

test("deleting a note card clears the old note, continuation and its pending task without restoring it", async () => {
  const { store, owner, cards } = setup();
  try {
    const now = "2026-10-12T00:00:00.000Z";
    store.db.prepare("INSERT INTO notes(id,user_id,text,title,status,created_at,updated_at) VALUES('note-x',?,'旧原话','旧原话','raw',?,?)").run(owner, now, now);
    const card = await cards.create(owner, { text: "旧原话", origin: "note", srcId: "note-x" });
    store.db.prepare("INSERT INTO resume_items(id,user_id,src,src_id,item_key,kind,due_on,created_at,updated_at) VALUES('resume-x',?,'card',?,'type','idea','2026-10-12',?,?)").run(owner, card.card.id, now, now);
    store.db.prepare("INSERT INTO jobs(id,user_id,kind,params,params_hash,status,created_at) VALUES('job-x',?,'card_tidy',?,'job-x','queued',?)").run(owner, JSON.stringify({ cardId: card.card.id }), now);
    cards.remove(owner, card.card.id);
    assert.equal(store.db.prepare("SELECT 1 FROM cards WHERE id=?").get(card.card.id), undefined);
    assert.equal(store.db.prepare("SELECT 1 FROM notes WHERE id='note-x'").get(), undefined);
    assert.equal(store.db.prepare("SELECT 1 FROM resume_items WHERE id='resume-x'").get(), undefined);
    assert.equal((store.db.prepare("SELECT status FROM jobs WHERE id='job-x'").get() as { status: string }).status, "failed");
  } finally { store.close(); }
});
