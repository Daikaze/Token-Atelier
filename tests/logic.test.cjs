'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.existsSync(`${__dirname}/../scripts/main.js`)
  ? `${__dirname}/../scripts/main.js`
  : `${__dirname}/../token-atelier/scripts/main.js`;
const code = fs.readFileSync(source, 'utf8');
const flags = new Map();
const settings = new Map([['defaultFolder','tokens'], ['borderPresets',[]]]);
const notifications = {info:[],warn:[],error:[]};
const dialogInputs = [];
const userFlags = new Map();
const uploads = [];
const existing = new Map([['tokens',new Set(['hero-smile.png'])]]);
let browsable = true;
let gm = true;
let idCounter=0;
const copies = x => structuredClone(x);
class MockApp {
  constructor(options){this.options=options;this.rendered=false;}
  async render(){this.rendered=true;return this;}
  async close(){this.rendered=false;}
  bringToFront(){}
}
const hooks={};
const actor = {
  id:'test123', name:'Hero', isOwner:true, img:'hero.png',
  prototypeToken:{texture:{src:'old.png'}},updates:[],
  getFlag(_id,key){return copies(flags.get(key) || null);},
  async setFlag(_id,key,val){flags.set(key,copies(val));return val;},
  async update(u){this.updates.push(copies(u));}
};
const savedBackups=[];
let confirmReturn = true;
class MockFile extends Blob {
  constructor(parts,name,options){super(parts,options);this.name=name;}
}
class MockImage {
  naturalHeight=128;
  naturalWidth=128;
  set src(value){this._src=value;queueMicrotask(()=>this.onload?.());}
}
const createCanvas=()=>({
  width:512,height:512,
  toBlob:cb=>cb(new Blob(['PNG'],{type:'image/png'})),
  getContext:()=>({
    beginPath(){},arc(){},moveTo(){},arcTo(){},closePath(){},rect(){},save(){},restore(){},
    translate(){},rotate(){},drawImage(){},clearRect(){},clip(){},stroke(){},fillRect(){},
  })
});
const filePicker=class {};
filePicker.implementation={
  async browse(_type,folder){if(!browsable)throw new Error('Could not list');return {dirs:[],files:[...(existing.get(folder)||new Set())].map(n=>`${folder}/${n}`)};},
  async createDirectory(_type,folder){ if(!existing.has(folder))existing.set(folder,new Set()); },
  async upload(_type,folder,file){uploads.push({folder,name:file.name});let x=existing.get(folder);if(!x){x=new Set();existing.set(folder,x)}; if(x.has(file.name))throw new Error('OVERWRITE');x.add(file.name);return {path:`${folder}/${file.name}`};}
};
const ctx={
  console,
  canvas:{tokens:{controlled:[]}},
  Blob,File:MockFile,Image:MockImage,URL:{createObjectURL:blob=>{savedBackups.push(blob);return `blob:backup-${savedBackups.length}`;},revokeObjectURL(){}},
  setTimeout: (cb,ms) => ms===30000 ? 99999 : globalThis.setTimeout(cb,ms),
  clearTimeout: id => globalThis.clearTimeout(id),
  window:{confirm:()=>confirmReturn},
  document:{body:{appendChild(){}},createElement:type=> type==='canvas' ? createCanvas() : {click(){},remove(){},set href(v){},set download(v){}}},
  ui:{notifications:Object.fromEntries(['info','warn','error'].map(k=>[k,s=>notifications[k].push(s)]))},
  foundry:{applications:{api:{ApplicationV2:MockApp,HandlebarsApplicationMixin:Base=>Base,DialogV2:{async input(options){dialogInputs.push(options);return {actorId:actor.id};}}},apps:{FilePicker:filePicker},instances:new Map()},utils:{deepClone:copies,randomID:()=>`id${++idCounter}`,mergeObject:(a,b)=>({...a,...b,style:{...a.style,...b.style}}),getProperty:(o,p)=>p.split('.').reduce((o,k)=>o?.[k],o),setProperty:(o,p,v)=>{let parts=p.split('.');let obj=o;while(parts.length>1)obj=obj[parts.shift()];obj[parts[0]]=v;},getRoute:p=>p}},
  game:{user:{id:'gm42',get isGM(){return gm},can:()=>true,getFlag(_m,k){return copies(userFlags.get(k) ?? null)},async setFlag(_m,k,v){userFlags.set(k,copies(v));return v},settings:{get(_m,k){return copies(settings.get(k))},async set(_m,k,v){settings.set(k,copies(v));return v},register(_m,k,opts){if(!settings.has(k))settings.set(k,opts.default)}},modules:new Map([['token-atelier',{api:null}]]),i18n:{localize:s=>s},actors:{contents:[actor],get:id=>id===actor.id?actor:null}},
  Hooks:{once:(k,cb)=>hooks[k]=cb,on:(k,cb)=>hooks[k]=cb},
};
vm.createContext(ctx);
vm.runInContext('String.prototype.slugify = function(){return this.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")};',ctx);
vm.runInContext(code + '\n;globalThis.TEST = {TokenAtelierApp,defaultState,restoredActorData,nextAvailableName,existingFilenames,planArtImport,uniqueImageFilename,isImportableImage,openAtelierFromSceneControls};',ctx);
const {TokenAtelierApp: App, defaultState, restoredActorData}=ctx.TEST;
const tasks=[];
function test(label,cb){tasks.push([label,cb]);}

test('Init registers old and new settings, GM-only API, and old actor flag data loads',async()=>{
  hooks.init();
  assert.equal(typeof ctx.game.modules.get('token-atelier').api.open,'function');
  assert.deepEqual(settings.get('borderPresets'),[]);
  const old=defaultState();
  old.arts=[{id:'oldA',src:'hero.png',label:'Smile',linked:true,tf:{ox:0,oy:0,scale:1,rot:0}}];
  old.active='oldA';old.style.ringColor='#aa6600';flags.set('data',copies(old));
  const app=new App(actor);
  assert.equal(app.atelierData.arts[0].id,'oldA');
  assert.equal(app.atelierData.style.ringColor,'#aa6600');
  gm=false;
  assert.throws(()=>new App(actor),/restricted/);
  assert.equal(await ctx.game.modules.get('token-atelier').api.open(actor),null);
  gm=true;
});

test('Left palette opens a separate persistent workspace immediately without selecting an actor',async()=>{
  const makeControls=()=>({tokens:{name:'tokens',order:1,tools:{}}});
  gm=false;
  const denied=makeControls(); hooks.getSceneControlButtons(denied);
  assert.equal(denied['token-atelier'],undefined);
  assert.equal(await ctx.TEST.openAtelierFromSceneControls(),null);
  gm=true;

  const controls=makeControls(); hooks.getSceneControlButtons(controls);
  const button=controls['token-atelier'];
  assert.equal(button.visible,true);
  assert.equal(button.icon,'fa-solid fa-palette');
  assert.equal(button.tools.open.button,true);
  assert.equal(typeof button.tools.open.onChange,'function');
  hooks.getSceneControlButtons(controls);
  assert.equal(Object.keys(controls).filter(k=>k==='token-atelier').length,1);

  const dialogCount=dialogInputs.length, actorFlags=copies(flags.get('data'));
  ctx.canvas.tokens.controlled=[{actor}];
  const selected=await ctx.TEST.openAtelierFromSceneControls();
  assert.equal(selected.isWorkspace,true);
  assert.equal(selected.actor.name,'Workspace');
  assert.notEqual(selected.actor,actor);

  ctx.canvas.tokens.controlled=[];
  const noToken=await ctx.TEST.openAtelierFromSceneControls();
  assert.equal(noToken.isWorkspace,true);
  assert.equal(dialogInputs.length,dialogCount);
  assert.deepEqual(flags.get('data'),actorFlags);

  // No Actors in the world is now supported too.
  const savedActors=ctx.game.actors.contents;
  ctx.game.actors.contents=[];
  assert.equal((await ctx.TEST.openAtelierFromSceneControls()).isWorkspace,true);
  ctx.game.actors.contents=savedActors;

  noToken.atelierData.style.ringColor='#123abc';
  noToken.atelierData.style.applyToken=true;
  noToken.atelierData.style.applyPortrait=true;
  await noToken._save();
  assert.equal(userFlags.get('workspaceData').style.ringColor,'#123abc');
  assert.equal(userFlags.get('workspaceData').style.applyToken,false);
  assert.equal(userFlags.get('workspaceData').style.applyPortrait,false);
  assert.deepEqual(flags.get('data'),actorFlags);
  const reopened=await ctx.game.modules.get('token-atelier').api.open();
  assert.equal(reopened.isWorkspace,true);
  assert.equal(reopened.atelierData.style.ringColor,'#123abc');

  const uploadsBefore=uploads.length, updatesBefore=actor.updates.length;
  reopened.canvas=createCanvas();
  reopened._img={naturalWidth:100,naturalHeight:100};
  reopened.atelierData.arts=[{id:'work-art',src:'hero.png',label:'Portrait',linked:false,tf:{ox:0,oy:0,scale:1,rot:0}}];
  reopened.atelierData.active='work-art';
  reopened.atelierData.style.folder='tokens';
  reopened.atelierData.style.applyToken=true;
  reopened.atelierData.style.applyPortrait=true;
  await reopened._export();
  assert.equal(uploads.length,uploadsBefore+1);
  assert.equal(actor.updates.length,updatesBefore);
  assert.equal(reopened.atelierData.style.applyToken,false);
  assert.equal(reopened.atelierData.style.applyPortrait,false);
  assert.deepEqual(flags.get('data'),actorFlags);
  gm=false;
  assert.equal(await ctx.game.modules.get('token-atelier').api.open(),null);
  gm=true;
});

test('Preset save/apply shares visual style but does not replace actor alignments or export settings',async()=>{
  const app=new App(actor);
  app.element={querySelector:()=>({value:'Celestial Gold'})};
  app.atelierData.style.ringColor='#ffee22';
  app.atelierData.style.ringWidth=7;
  await App.onSavePreset.call(app);
  const preset=settings.get('borderPresets')[0];
  assert.equal(preset.name,'Celestial Gold');
  assert.equal(preset.style.folder,undefined);
  app.atelierData.style.ringColor='#ffffff';
  app.atelierData.style.folder='some-new-folder';
  app.atelierData.shared.ox=0.28;
  await App.onApplyPreset.call(app);
  assert.equal(app.atelierData.style.ringColor,'#ffee22');
  assert.equal(app.atelierData.style.folder,'some-new-folder');
  assert.equal(app.atelierData.shared.ox,0.28);
  await App.onSavePreset.call(app); // duplicate
  assert.equal(settings.get('borderPresets').length,1);
  await App.onDeletePreset.call(app);
  assert.equal(settings.get('borderPresets').length,0);
  assert.equal(app.atelierData.style.ringColor,'#ffee22');
  await app.close();
});

test('Single export never overwrites an existing file and updates actor once',async()=>{
  const app=new App(actor);
  app.canvas=createCanvas();app._img={naturalWidth:100,naturalHeight:100};
  app.atelierData.style.folder='tokens';
  const prior=uploads.length;
  await app._export();
  assert.equal(uploads.length,prior+1);
  assert.equal(uploads[uploads.length-1].name,'hero-smile-2.png');
  assert.equal(actor.updates.at(-1)['prototypeToken.texture.src'],'tokens/hero-smile-2.png');
  assert.equal(actor.updates.at(-1).img,undefined);
  await app.close();
});

test('Batch exports variants, keeps current active, preserves actor token and unique names',async()=>{
  const app=new App(actor);
  app.canvas=createCanvas();app._img={naturalWidth:100,naturalHeight:100};
  app.atelierData.arts.push({id:'newB',src:'another.png',label:'Smile',linked:false,tf:{ox:0.2,oy:0,scale:1.5,rot:12}});
  const oldActive=app.atelierData.active;
  const oldUpdates=actor.updates.length;
  const prior=uploads.length;
  await app._exportAll();
  assert.equal(uploads.length,prior+2);
  assert.equal(new Set(uploads.slice(-2).map(u=>u.name)).size,2);
  assert.equal(app.atelierData.active,oldActive);
  assert.equal(actor.updates.length,oldUpdates);
  await app.close();
});

test('Unbrowseable folder causes no upload or actor change',async()=>{
  const app=new App(actor);app.canvas=createCanvas();app._img={naturalWidth:100,naturalHeight:100};
  const oldUpdates=actor.updates.length;
  const oldUploads=uploads.length;
  browsable=false;
  await app._exportAll();
  await app._export();
  assert.equal(app._exporting,false);
  browsable=true;
  assert.equal(actor.updates.length,oldUpdates);
  assert.equal(uploads.length,oldUploads);
});

test('Restore from actor backup keeps old settings, takes pre-restore backup, rejects invalid files',async()=>{
  const app=new App(actor);
  const old=copies(app.atelierData);
  const data=copies(old);
  data.style.ringColor='#ab12ef';
  const file={size:500,async text(){return JSON.stringify({format:'token-atelier-actor-backup',schema:1,actorName:'Another hero',data})}};
  const prior=savedBackups.length;
  await app._restoreBackup(file);
  assert.equal(app.atelierData.style.ringColor,'#ab12ef');
  assert.equal(savedBackups.length,prior+1);
  assert.equal(flags.get('data').style.ringColor,'#ab12ef');
  await app._restoreBackup({size:500,async text(){return '{"bad":true}'}});
  assert.equal(app.atelierData.style.ringColor,'#ab12ef');
  confirmReturn=false;
  await app._restoreBackup({...file});
  confirmReturn=true;
  assert.equal(savedBackups.length,prior+1);
  await app.close();
});

test('All HTML action buttons map to defined ApplicationV2 actions',async()=>{
  const templatePath = fs.existsSync(`${__dirname}/../templates/token-atelier.hbs`)
    ? `${__dirname}/../templates/token-atelier.hbs`
    : `${__dirname}/../token-atelier/templates/token-atelier.hbs`;
  const template=fs.readFileSync(templatePath,'utf8');
  for (const [,action] of template.matchAll(/data-action="([^"]+)"/g)) {
    assert.equal(typeof App.DEFAULT_OPTIONS.actions[action],'function',`Missing action: ${action}`);
  }
  assert.ok(template.includes('name="restoreBackupFile"'));
  assert.ok(template.includes('tka-workspace-notice'));
  assert.ok(template.includes('data-bind="style.applyToken" {{#if workspace}}disabled{{/if}}'));
});

test('A running export blocks a second export, and player cannot export with open editor',async()=>{
  const app=new App(actor);
  app.canvas=createCanvas();app._img={naturalWidth:100,naturalHeight:100};
  const oldUploads=uploads.length;
  app._exporting=true;
  await app._exportAll();
  await app._export();
  assert.equal(uploads.length,oldUploads);
  app._exporting=false;
  gm=false;
  await app._exportAll();
  await app._export();
  assert.equal(uploads.length,oldUploads);
  gm=true;
});

test('Serialized saves avoid old snapshot races',async()=>{
  const app=new App(actor);
  app.atelierData.style.ringColor='#000001';
  const one=app._save();
  app.atelierData.style.ringColor='#000002';
  const two=app._save();
  await Promise.all([one,two]);
  assert.equal(flags.get('data').style.ringColor,'#000002');
});

test('Bulk import validates extensions, eliminates duplicate paths, enforces 250 image limit',async()=>{
  const {planArtImport,uniqueImageFilename,isImportableImage}=ctx.TEST;
  assert.equal(isImportableImage('folder/a.PNG?query=x'),true);
  assert.equal(isImportableImage('folder/file.txt'),false);
  const base=[{src:'folder/old.png'}];
  const plan=planArtImport(['folder/old.png','folder/NEW.webp','folder/new.webp','folder/manual.pdf','folder/final.jpg'],base,3);
  assert.equal(plan.accepted.length,2);
  assert.equal(plan.skipped,2);
  assert.equal(plan.invalid,1);
  const full=planArtImport(['folder/x.jpg'],base,1);
  assert.equal(full.overLimit,1);
  const used = new Set(['portrait.png']);
  assert.equal(uniqueImageFilename('Portrait.PNG',used),'portrait-2.png');
  assert.equal(uniqueImageFilename('Portrait.PNG',used),'portrait-3.png');
});

test('Bulk folder import adds new arts once, preserves active/current style, duplicate-safe on repeat',async()=>{
  const app = new App(actor);
  const wasActive=app.atelierData.active;
  const wasShared=copies(app.atelierData.shared);
  const wasStyle=copies(app.atelierData.style);
  const beforeUploads=uploads.length;
  const beforeUpdates=actor.updates.length;
  const first=app.atelierData.arts.length;
  existing.set('gallery',['hero-new.png','hero-new.webp','notes.txt','hero-new.PNG']);
  await app._bulkImportFolder('gallery');
  assert.equal(app.atelierData.arts.length,first+2);
  assert.equal(flags.get('data').arts.length,first+2);
  assert.equal(app.atelierData.active,wasActive);
  assert.deepEqual(app.atelierData.shared,wasShared);
  assert.deepEqual(app.atelierData.style,wasStyle);
  assert.equal(uploads.length,beforeUploads);
  assert.equal(actor.updates.length,beforeUpdates);
  await app._bulkImportFolder('gallery');
  assert.equal(app.atelierData.arts.length,first+2);
});

test('Bulk folder import skips malformed, unreadable and unsupported files without destroying actor data',async()=>{
  const app=new App(actor);
  const old=copies(app.atelierData);
  await app._bulkImportFolder('../etc');
  browsable=false;
  await app._bulkImportFolder('badfolder');
  browsable=true;
  assert.deepEqual(app.atelierData,old);
  assert.equal(app._importing,false);
});

test('Bulk upload safely names source files, adds images and does not replace token',async()=>{
  const app = new App(actor);
  const beforeArt=app.atelierData.arts.length;
  const beforeUpdates=actor.updates.length;
  const beforeUpload=uploads.length;
  const files=[
    new MockFile(['data'],'Face.png',{type:'image/png'}),
    new MockFile(['data'],'Face.png',{type:'image/png'}),
    new MockFile(['data'],'Pose.webp',{type:'image/webp'}),
    new MockFile(['data'],'readme.txt',{type:'text/plain'})
  ];
  await app._bulkUploadFiles(files);
  assert.equal(uploads.length-beforeUpload,2);
  assert.equal(app.atelierData.arts.length-beforeArt,2);
  assert.equal(new Set(uploads.slice(beforeUpload).map(x=>x.name)).size,2);
  assert.equal(actor.updates.length,beforeUpdates);
  assert.ok(uploads.slice(beforeUpload).every(x=>x.folder.includes('source-art/hero-test123')));
  const saved=app.atelierData.arts.length;
  await app._bulkUploadFiles([files[0]]);
  assert.equal(app.atelierData.arts.length,saved);
  gm=false;
  await app._bulkImportFolder('gallery');
  await app._bulkUploadFiles(files);
  assert.equal(app.atelierData.arts.length,saved);
  gm=true;
});

(async()=>{
 let failed=0;
 for (const [label,cb] of tasks) {
  try { await cb();console.log(`PASS: ${label}`); }
  catch(e){failed++;console.error(`FAIL: ${label}:`,e.stack||e);}
 }
 console.log(`${tasks.length-failed}/${tasks.length} tests passed`);
 if (failed) process.exitCode=1;
})();
