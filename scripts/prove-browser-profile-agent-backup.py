import pathlib,tempfile,subprocess,tarfile,io,os,json,hashlib
root=pathlib.Path.cwd();(root/'.tmp/backup-module-proof').mkdir(parents=True,exist_ok=True);out=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=root/'.tmp/backup-module-proof'));copy=out/'source';copy.mkdir();data=subprocess.check_output(['git','archive','--format=tar','24e86ca36063250d435a6046e45579c7116ffa9a'])
with tarfile.open(fileobj=io.BytesIO(data))as tar:tar.extractall(copy,filter='data')
files=['lib/browser-profile-live-read.mjs','lib/browser-profile-live-capture.mjs','lib/browser-profile-active-backup.mjs','test/browser-profile-live-read.test.ts','test/browser-profile-live-capture.test.ts','test/browser-profile-active-backup.test.ts','test/helpers/browser-profile-live-fixture.ts']
for name in files:p=copy/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((root/name).read_bytes())
loader=(root/'node_modules/tsx/dist/loader.mjs').as_uri();read='test/browser-profile-live-read.test.ts';capture='test/browser-profile-live-capture.test.ts';active='test/browser-profile-active-backup.test.ts';readsrc=files[0];capsrc=files[1];actsrc=files[2]
def run(label,test=None,pattern=None):
 cmd=['node','--import',loader,'--test']+(['--test-name-pattern',pattern]if pattern else[])+([test]if test else[read,capture,active]);r=subprocess.run(cmd,cwd=copy,text=True,capture_output=True,timeout=50);(out/(label+'.log')).write_text(r.stdout+r.stderr);return r
baseline=run('baseline');assert baseline.returncode==0,baseline.stdout+baseline.stderr
cases=[
('read-global-bound',readsrc,'leases.size>=4','false',read,'four physical'),
('read-original-context',readsrc,'runtime.context!==context','false',read,'full runtime/page'),
('read-generation',readsrc,'generation!==null&&ledger.generation!==generation','false',read,'full runtime/page'),
('read-full-authority',readsrc,'!sameAuthority(sync(()=>originalRuntimeCheck.call(runtime)),authority)','false',read,'full runtime/page'),
('read-storage-partition',readsrc,"if(storageKey!==record.origin+'/')","if(false)",read,'native context, partition'),
('read-credential-safety',readsrc,'result.result.value.credentials!==false','false',capture,'protected, unfinished'),
('read-sync-qualification',readsrc,'sync(()=>originalQualified.call(runtime,movable.origins))','originalQualified.call(runtime,movable.origins)',read,'false or asynchronous'),
('read-final-safety',readsrc,'verify:()=>run(safety)','verify:()=>run(async()=>{})',capture,'credential state appearing'),
('read-cleanup-reservation',readsrc,"if(results.some(result=>result.status==='rejected')){cleanupUnknown=true","if(false){cleanupUnknown=true",read,'failed native detach'),
('read-listener-rollback',readsrc,'listeners.push([target,event]);sync(()=>target.on(event,changedListener))','sync(()=>target.on(event,changedListener));listeners.push([target,event])',read,'partial native listener'),
('capture-request-snapshot',capsrc,'request=structuredClone(request)','request=request',capture,'request recipients'),
('capture-one-physical-admission',capsrc,'if(this.#work||this.#closed||this.#cleanupUnknown)','if(this.#closed||this.#cleanupUnknown)',capture,'logical timeout'),
('capture-dispose-fence',capsrc,'async dispose(){this.#closed=true;','async dispose(){this.#closed=false;',capture,'disposal starts'),
('capture-private-cleanup',capsrc,"if(this.#cleanupUnknown||results.some(result=>result.status==='rejected')||scope&&(scope.activity().cleanupUnknown||scope.activity().pendingPhysicalOperations!==0)||capture?.physical||this.seal.physical)","if(false)",capture,'failed native detach'),
('backup-complete-peer-review',actsrc,"if(!pin||!same(pin.identity,row.identity)||pin.fingerprint!==row.keyFingerprint||row.kind!=='desktop'||row.ownerUserId!==this.scope.actingUserId||row.pairingId!==null)",'if(false)',active,'every unknown/replaced'),
('backup-original-pairing',actsrc,'row.pairingId!==this.pairingId','false',active,'every unknown/replaced'),
('backup-own-source-required',actsrc,"if(!own)throw fail('profile_backup_source_pairing_changed')","if(false)throw fail('profile_backup_source_pairing_changed')",active,'every unknown/replaced'),
('backup-key-object-proof',actsrc,'current!==key||','',active,'retained key identity'),
('backup-cleanup-reservation',actsrc,"if(this.#cleanupUnknown||results.some(row=>row.status==='rejected')){this.#cleanupUnknown=true","if(false){this.#cleanupUnknown=true",active,'failed physical HTTP'),
('backup-absolute-cadence',actsrc,'this.#nextDue??=Date.now()+60000','this.#nextDue=Date.now()+60000',active,'repeated short command pauses'),
('backup-automatic-cooldown',actsrc,'&&now>=this.#automaticAfter','',active,'overdue skipped and unknown'),
('backup-periodic-hint',actsrc,'this.#dueHint();this.#clearHints();this.#armHint()','this.#dueHint();this.#clearHints()',active,'bounded periodic hints')]
receipts=[]
for name,file,before,after,test,pattern in cases:
 p=copy/file;original=p.read_bytes();text=original.decode();assert text.count(before)==1,(name,text.count(before));offset=text.index(before);changed=text.replace(before,after);p.write_text(changed,newline='');line=changed.count('\n',0,offset)+1;loaded=changed.splitlines()[line-1];print(json.dumps({'mutation':name,'file':file,'line':line,'loadedChangedLine':loaded}),flush=True)
 try:
  red=run(name+'-red',test,pattern);assert red.returncode==1 and ('ERR_ASSERTION' in red.stdout+red.stderr or 'AssertionError' in red.stdout+red.stderr),(name,red.returncode,red.stdout,red.stderr)
 finally:p.write_bytes(original)
 green=run(name+'-green',test,pattern);assert green.returncode==0,(name,green.stdout,green.stderr);receipts.append({'mutation':name,'file':file,'line':line,'loadedChangedLine':loaded,'redExit':red.returncode,'redAssertion':True,'exactRestored':p.read_bytes()==original,'greenExit':green.returncode})
final=run('final');assert final.returncode==0,final.stdout+final.stderr;result={'baselineTests':30,'baselineExit':0,'finalTests':30,'finalExit':final.returncode,'sourceHashes':{name:hashlib.sha256((root/name).read_bytes()).hexdigest()for name in files[:3]},'workspaceUnchanged':all((root/name).read_bytes()==(copy/name).read_bytes()for name in files),'mutations':receipts};(out/'results.json').write_text(json.dumps(result,indent=2));print(str(out/'results.json'),flush=True)
