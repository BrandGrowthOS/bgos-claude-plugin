from pathlib import Path
import argparse,base64,hashlib,json,os,subprocess,uuid

parser=argparse.ArgumentParser();parser.add_argument('--native-only',action='store_true');parser.add_argument('--unit-only',action='store_true');args=parser.parse_args()
root=Path.cwd();out=root/'.tmp'/('transfer-factory-'+uuid.uuid4().hex[:8]);out.mkdir(parents=True)
target=root/'lib/browser-profile-companion.mjs';original=target.read_bytes();source=original.decode();digest=lambda value:hashlib.sha256(value).hexdigest()
loader=out/'loader.mjs';loader.write_text("import{registerHooks}from'node:module';import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const row=JSON.parse(readFileSync(process.env.HOAI_FACTORY_MUTATION,'utf8')),target=pathToFileURL(row.target).href;registerHooks({load(url,context,next){if(url===target)return{format:'module',source:row.source+'\\nconsole.error(\"MUTATION_LOADED\");',shortCircuit:true};return next(url,context)}});")
results={'sourceSha256':digest(original),'workspaceUnchanged':True,'unit':[],'native':[]}
def save():
 results['workspaceUnchanged']=target.read_bytes()==original
 (out/'results.json').write_text(json.dumps(results,indent=2))
def run(name,command,env=None):
 p=subprocess.run(command,cwd=root,env={**os.environ,**(env or{})},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60);text=p.stdout.decode(errors='replace');(out/(name+'.log')).write_text(text,encoding='utf-8');return p,text
def mutation(name,old,new):
 assert source.count(old)==1,(name,source.count(old));changed=source.replace(old,new);line=source[:source.index(old)].count('\n')+1
 row={'name':name,'line':line,'loadedChangedLine':changed.splitlines()[line-1]};print(json.dumps(row),flush=True);return changed,row
if not args.native_only:
 test='test/browser-profile-companion-transfer.test.ts';base,log=run('unit-baseline',['node','--import','tsx','--test',test]);assert base.returncode==0,log
 cases=[
 ('factory-callback','        assertTransferAllowed,','        assertTransferAllowed:undefined,','the actual Companion factory'),
 ('original-native-context','physicalRuntime.context!==physicalContext','false','original runtime, native context'),
 ('input-context','input?.context!==physicalContext','false','retained factory callback'),
 ('input-full-authority','!shared.sameAuthority(input?.authority,authority)','false','retained factory callback'),
 ('original-endpoint','record.endpoint!==originalEndpoint','false','original runtime, native context'),
 ('original-public-identity','record.identity!==originalIdentity','false','original runtime, native context'),
 ('original-pairing-scope','Object.keys(originalScope).some(key=>record.scope[key]!==originalScope[key])','false','original runtime, native context'),
 ('current-source-grant','!this._activeMatches(record,record.entry,authority)','false','cached current writer'),
 ('private-retirement-permit',"this.closing&&(!retirement||retirement.runtime!==physicalRuntime||retirement.endpoint!==originalEndpoint||!shared.sameAuthority(retirement.authority,authority))",'false','closing needs'),
 ('pending-engine-work','record.engineTasks.size!==0','false','physical commands'),
 ('live-permission','||record.permissionAbort||this.#permissionCleanupUnknown.has(record)||','||false||this.#permissionCleanupUnknown.has(record)||','physical commands'),
 ('unknown-runner-activity',"if(!Number.isSafeInteger(value?.pendingPhysicalOperations)||value.pendingPhysicalOperations!==0||value.cleanupUnknown!==false||value.outcomeUnknown!==undefined&&value.outcomeUnknown!==false)throw fail('profile_companion_transfer_busy')","if(false)throw fail('profile_companion_transfer_busy')",'physical commands')]
 for name,old,new,pattern in cases:
  changed,row=mutation(name,old,new);meta=out/(name+'.input.json');meta.write_text(json.dumps({'target':str(target),'source':changed}));selected=['--import','tsx','--test','--test-name-pattern='+pattern,test]
  red,log=run(name+'-red',['node','--import',loader.as_uri(),*selected],{'HOAI_FACTORY_MUTATION':str(meta)});assert red.returncode==1 and 'MUTATION_LOADED'in log and ('ERR_ASSERTION'in log or 'AssertionError'in log),(name,red.returncode,log[-2500:]);assert target.read_bytes()==original
  green,log=run(name+'-restored',['node',*selected]);assert green.returncode==0,(name,log[-2500:]);results['unit'].append({**row,'redExit':1,'directAssertion':True,'exactOriginalWorkspaceBytes':True,'restoredExit':0});save()
if not args.unit_only:
 ssh=['ssh','-F','none','-p','6969','-o','BatchMode=yes','karim@100.79.95.82'];probe=(root/'scripts/probe-browser-profile-transfer-factory.mjs').read_bytes();seccomp='/home/karim/hoai-profile-fresh.sdpd8isb/seccomp_profile.json';image='hoai-profile-fresh:418aa6dc'
 for kind in ['baseline','omitted-callback','restored']:
  text=source;row={}
  if kind=='omitted-callback':text,row=mutation('native-omitted-callback','        assertTransferAllowed,','        assertTransferAllowed:undefined,')
  name='hoai-transfer-factory-'+uuid.uuid4().hex[:10]
  remote='''import base64,io,json,os,pathlib,shutil,subprocess,tarfile,tempfile
directory=pathlib.Path(tempfile.mkdtemp(prefix='hoai-transfer-factory-'));os.chmod(directory,0o755);name=%r;forced=False;p=None
try:
 for filename,encoded in %r.items():
  file=directory/filename;file.write_bytes(base64.b64decode(encoded));os.chmod(file,0o644)
 command=['docker','create','--name',name,'--network','none','--init','--user','1000:1000','--cap-drop','ALL','--cap-add','SYS_CHROOT','--security-opt','seccomp='+%r,'--shm-size','1g',%r,'node','/opt/hoai-fresh/scripts/probe-browser-profile-transfer-factory.mjs']
 subprocess.run(command,capture_output=True,text=True,timeout=20,check=True)
 for source,destination in [('companion.mjs','/opt/hoai-fresh/lib/browser-profile-companion.mjs'),('probe.mjs','/opt/hoai-fresh/scripts/probe-browser-profile-transfer-factory.mjs')]:
  archive=io.BytesIO();data=(directory/source).read_bytes()
  with tarfile.open(fileobj=archive,mode='w')as packed:
   info=tarfile.TarInfo(pathlib.Path(destination).name);info.size=len(data);info.mode=0o644;packed.addfile(info,io.BytesIO(data))
  subprocess.run(['docker','cp','-',name+':'+str(pathlib.Path(destination).parent)],input=archive.getvalue(),capture_output=True,timeout=20,check=True)
 p=subprocess.run(['docker','start','-a',name],capture_output=True,text=True,timeout=90)
 status=subprocess.run(['docker','inspect','--format','{{.State.ExitCode}}',name],capture_output=True,text=True,timeout=10,check=True);p.returncode=int(status.stdout.strip());subprocess.run(['docker','rm',name],capture_output=True,text=True,timeout=10,check=True)
finally:
 before=subprocess.run(['docker','ps','-aq','--filter','name=^/'+name+'$'],capture_output=True,text=True,timeout=10);assert before.returncode==0
 if before.stdout.strip():
  forced=True;subprocess.run(['docker','stop','-t','10',name],capture_output=True,timeout=20,check=True)
 after=subprocess.run(['docker','ps','-aq','--filter','name=^/'+name+'$'],capture_output=True,text=True,timeout=10);assert after.returncode==0
 shutil.rmtree(directory)
 print(json.dumps({'exit':None if p is None else p.returncode,'stdout':None if p is None else p.stdout,'stderr':None if p is None else p.stderr[-3000:],'containerAbsent':not after.stdout.strip(),'forcedStop':forced}))
'''%(name,{'companion.mjs':base64.b64encode(text.encode()).decode(),'probe.mjs':base64.b64encode(probe).decode()},seccomp,image)
  p=subprocess.run(ssh+['python3 -'],input=remote,capture_output=True,text=True,timeout=130);(out/('native-'+kind+'.transport.log')).write_text(p.stderr,encoding='utf-8');assert p.returncode==0,p.stderr[-1000:];receipt=json.loads(p.stdout);(out/('native-'+kind+'.json')).write_text(json.dumps(receipt,indent=2));assert receipt['containerAbsent']and not receipt['forcedStop'],receipt
  if kind=='omitted-callback':assert receipt['exit']==1 and 'AssertionError'in receipt['stdout'],receipt
  else:assert receipt['exit']==0 and '"qualified":true'in receipt['stdout']and '"normalCleanup":true'in receipt['stdout']and '"ownedBrowserGone":true'in receipt['stdout'],receipt
  results['native'].append({'kind':kind,**row,'exit':receipt['exit'],'containerAbsent':True,'forcedStop':False,'receiptSha256':digest((out/('native-'+kind+'.json')).read_bytes()),'sourceSha256':digest(text.encode())});save()
save();assert results['workspaceUnchanged'];print(json.dumps({'results':str(out/'results.json'),'unitDrills':len(results['unit']),'nativeRuns':len(results['native'])}),flush=True)
