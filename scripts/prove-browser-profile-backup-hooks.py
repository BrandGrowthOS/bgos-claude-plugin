from pathlib import Path
import hashlib,json,subprocess,uuid,os
r=Path.cwd();out=r/'.tmp'/('backup-hook-mutations-'+uuid.uuid4().hex[:8]);out.mkdir(parents=True);target=r/'lib/browser-profile-companion.mjs';original=target.read_bytes();source=original.decode();assert hashlib.sha256(original).hexdigest()=='3e893c69d16456cd16f8a42a1d4b51255d20abecf9664ccd1cb1596dca2bb71f'
loader=out/'loader.mjs';loader.write_text("import{registerHooks}from'node:module';import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const row=JSON.parse(readFileSync(process.env.HOAI_BACKUP_MUTATION,'utf8')),target=pathToFileURL(row.target).href;registerHooks({load(url,context,next){if(url===target)return{format:'module',source:row.source+'\\nconsole.error(\"MUTATION_LOADED\");',shortCircuit:true};return next(url,context)}});")
test='test/browser-profile-companion-backups.test.ts';cases=[
('activation-hook','await this._startBackups(record);','void 0;','successful activation'),
('original-owner','ownerUserId:binding.scope.ownerUserId','ownerUserId:binding.scope.actingUserId','successful activation'),
('original-context','record.runtime.context!==binding.context','false','original context, account'),
('original-engine','record.engine!==binding.engine','false','original context, account'),
('original-endpoint','record.endpoint!==binding.endpoint','false','original context, account'),
('full-authority','!shared.sameAuthority(record.runtime.authority,binding.authority)','false','original context, account'),
('original-account-scope','Object.keys(binding.scope).some(key=>record.scope[key]!==binding.scope[key])','false','original context, account'),
('pause-before-command','await this._pauseBackups(record);check()','void this._pauseBackups(record);check()','ordinary signed commands'),
('resume-after-command','try{this._resumeBackups(record)}catch{}','try{void 0}catch{}','ordinary signed commands'),
('retirement-drain','try{await this._pauseBackups(record);stopped=await','try{void this._pauseBackups(record);stopped=await','normal retirement drains'),
('disconnect-fence',"disconnected(){for(const record of this.records.values()){void this._pauseBackups(record).catch(()=>{});","disconnected(){for(const record of this.records.values()){",'disconnect fences'),
('native-stop-independent','const native=Promise.resolve().then(()=>record.runtime?.dispose())','const native=Promise.resolve().then(async()=>{await this._stopBackups(record);return record.runtime?.dispose()})','physical revocation starts independently'),
('late-created-disposer','()=>stopping??binding.runner?.dispose()','()=>stopping','account revocation starts'),
('attempted-listener-rollback','binding.listeners.push({target,event,callback});target.on(event,callback)','target.on(event,callback);binding.listeners.push({target,event,callback})','failed native listener setup'),
('independent-listener-cleanup','...binding.listeners.splice(0).map(({target,event,callback})=>()=>target.removeListener(event,callback))','...binding.listeners.splice(0,1).map(({target,event,callback})=>()=>target.removeListener(event,callback))','failed listener removal'),
('cleanup-admission','||backup?.runner?.activity().cleanupUnknown','||false','backup cleanup uncertainty'),
('cleanup-activity','cleanupUnknown||=value.cleanupUnknown}cleanupUnknown||=backup.cleanupUnknown','cleanupUnknown||=false}cleanupUnknown||=backup.cleanupUnknown','backup cleanup uncertainty'),
('monitor-preserves-cadence','if(this.#backups.get(record)?.pauseWanted)','if(this.#backups.get(record))','successful authority monitoring'),
('explicit-read-only-reconcile','await backup.reconcile();','void 0;','existing signed status'),
('shutdown-sync-fence','for(const record of this.records.values())void this._pauseBackups(record).catch(()=>{});const activating','const activating','normal daemon stop fences')]
def run(name,args,env=None):
 p=subprocess.run(['node',*args],cwd=r,env={**os.environ,**(env or{})},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30);s=p.stdout.decode(errors='replace');(out/(name+'.log')).write_text(s,encoding='utf-8');return p,s
base,log=run('baseline',['--import','tsx','--test',test]);assert base.returncode==0,log
results=[]
for name,old,new,pattern in cases:
 assert source.count(old)==(2 if name=='monitor-preserves-cadence'else 1),(name,source.count(old));changed=source.replace(old,new);positions=[];cursor=0
 while True:
  offset=source.find(old,cursor)
  if offset<0:break
  number=source[:offset].count('\n')+1;positions.append({'line':number,'loadedChangedLine':changed.splitlines()[number-1]});cursor=offset+len(old)
 line=positions[0]['line'];loaded=positions[0]['loadedChangedLine'];print(json.dumps({'mutation':name,'file':'lib/browser-profile-companion.mjs','changedExecutableLines':positions}),flush=True);meta=out/(name+'.input.json');meta.write_text(json.dumps({'target':str(target),'source':changed}));args=['--import','tsx','--test','--test-name-pattern='+pattern,test]
 red,log=run(name+'-red',['--import',loader.as_uri(),*args],{'HOAI_BACKUP_MUTATION':str(meta)});assert red.returncode==1 and 'MUTATION_LOADED'in log and ('ERR_ASSERTION'in log or 'AssertionError'in log),(name,red.returncode,log[-3000:]);assert target.read_bytes()==original
 green,log=run(name+'-restored',args);assert green.returncode==0,(name,log[-3000:]);results.append({'mutation':name,'file':'lib/browser-profile-companion.mjs','line':line,'loadedChangedLine':loaded,'changedExecutableLines':positions,'redExit':red.returncode,'directAssertion':True,'exactRestore':target.read_bytes()==original,'restoredExit':green.returncode});(out/'results.json').write_text(json.dumps({'sourceSha256':hashlib.sha256(original).hexdigest(),'workspaceUnchanged':target.read_bytes()==original,'baselineTests':15,'mutations':results},indent=2))
final,log=run('final',['--import','tsx','--test',test]);assert final.returncode==0;print(json.dumps({'qualified':len(results),'results':str(out/'results.json')}),flush=True)
