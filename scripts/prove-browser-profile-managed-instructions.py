from pathlib import Path
import argparse,subprocess,tarfile,tempfile,hashlib,json,os,re
parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);args=parser.parse_args();root=Path(args.source).resolve();(root/'.tmp').mkdir(exist_ok=True);out=Path(tempfile.mkdtemp(prefix='managed-instructions-',dir=root/'.tmp'));work=out/'source';work.mkdir();archive=out/'source.tar';sha=lambda b:hashlib.sha256(b).hexdigest();ref=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip();subprocess.run(['git','-C',str(root),'archive','--format=tar','--output',str(archive),ref],check=True)
with tarfile.open(archive) as selected:selected.extractall(work,filter='data')
paths=['bin/hoai-browser-host.mjs','lib/browser-profile-companion.mjs','server.ts','README.md','test/browser-profile-managed-instructions.test.ts'];before={p:(root/p).read_bytes() for p in paths}
for p,value in before.items():(work/p).parent.mkdir(parents=True,exist_ok=True);(work/p).write_bytes(value)
if os.name=='nt':
 subprocess.run(['powershell','-NoProfile','-Command',"New-Item -ItemType Junction -Path '"+str(work/'node_modules').replace("'","''")+"' -Target '"+str(root/'node_modules').replace("'","''")+"' | Out-Null"],check=True,capture_output=True)
else:(work/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
command=['node','--import','tsx','--test','--test-reporter=tap','test/browser-profile-managed-instructions.test.ts']
def run(label):
 result=subprocess.run(command,cwd=work,capture_output=True,timeout=30);(out/(label+'.log')).write_bytes(result.stdout+result.stderr);return result
baseline=run('baseline');assert baseline.returncode==0 and b'# pass 3' in baseline.stdout and b'# skipped 0' in baseline.stdout
mutations=[('factory_to_legacy','bin/hoai-browser-host.mjs','instructions: managedHostInstructions(deviceLabel)','instructions: hostInstructions(deviceLabel)'),('wait_gate_filter','lib/browser-profile-companion.mjs',"tools.filter(tool=>tool.name!=='hoai_browser_wait_gate')",'tools'),('legacy_schema_clone','lib/browser-profile-companion.mjs','const next={...properties};','const next=properties;'),('managed_session_metadata','lib/browser-profile-companion.mjs','if(managedSessionDescriptions[tool.name])result.description=managedSessionDescriptions[tool.name]','if(false)result.description=managedSessionDescriptions[tool.name]'),('managed_deadline_metadata','lib/browser-profile-companion.mjs','if(next.wait_seconds){','if(false&&next.wait_seconds){'),('production_managed_roster','lib/browser-profile-companion.mjs','return [...managedToolRoster(record.engine.roster()),...AGENT_PROFILE_FILE_TOOLS]','return [...managedFileRoster(record.engine.roster()),...AGENT_PROFILE_FILE_TOOLS]')]
rows=[]
for name,path,old,new in mutations:
 original=before[path];text=original.decode();assert text.count(old)==1,(name,'target_not_unique');changed=text.replace(old,new);(work/path).write_text(changed,encoding='utf-8',newline='\n');offset=text.index(old);assert changed[offset:offset+len(new)]==new;line=changed[:offset].count('\n')+1;print(json.dumps({'mutation':name,'path':path,'line':line,'loadedLine':changed.splitlines()[line-1]}),flush=True)
 try:
  red=run(name+'-red');assert red.returncode==1 and b'ERR_ASSERTION' in red.stdout+red.stderr and b'ERR_MODULE_NOT_FOUND'not in red.stdout+red.stderr,name
 finally:(work/path).write_bytes(original)
 assert(work/path).read_bytes()==original;green=run(name+'-restored');assert green.returncode==0 and b'# pass 3'in green.stdout and b'# skipped 0'in green.stdout,name
 rows.append({'name':name,'path':path,'line':line,'loadedLine':changed.splitlines()[line-1],'redExit':red.returncode,'directAssertion':True,'restoredExit':green.returncode,'restoredSourceSha256':sha(original)});print(json.dumps({'mutation':name,'red':1,'exactRestore':True,'green':0}),flush=True)
assert all((root/p).read_bytes()==value for p,value in before.items());raw=[{'path':str(p),'sha256':sha(p.read_bytes())}for p in out.glob('*.log')];result={'baseCommit':ref,'sourcePins':{p:sha(value)for p,value in before.items()},'executedSourceKind':'exact frozen proposed source over the recorded committed archive; dependency graph unchanged','command':command,'mutations':rows,'workingSourceUnchanged':True,'raw':raw};(out/'results.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');print(json.dumps({'output':str(out),'mutations':len(rows)}))
