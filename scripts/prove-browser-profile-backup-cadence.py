from pathlib import Path
import argparse,hashlib,json,os,subprocess,tarfile,tempfile
parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);args=parser.parse_args();root=Path(args.source).resolve();(root/'.tmp').mkdir(exist_ok=True);out=Path(tempfile.mkdtemp(prefix='backup-cadence-mutations-',dir=root/'.tmp'));work=out/'source';work.mkdir();archive=out/'source.tar'
sha=lambda b:hashlib.sha256(b).hexdigest()
ref=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip();subprocess.run(['git','-C',str(root),'archive','--format=tar','--output',str(archive),ref],check=True)
with tarfile.open(archive)as selected:selected.extractall(work,filter='data')
paths=['lib/browser-profile-active-backup.mjs','test/browser-profile-active-backup.test.ts'];before={p:(root/p).read_bytes()for p in paths}
for p,value in before.items():(work/p).write_bytes(value)
if os.name=='nt':
 subprocess.run(['powershell','-NoProfile','-Command',"New-Item -ItemType Junction -Path '"+str(work/'node_modules').replace("'","''")+"' -Target '"+str(root/'node_modules').replace("'","''")+"' | Out-Null"],check=True,capture_output=True)
else:(work/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
def run(label,pattern=None):
 command=['node','--import','tsx','--test','--test-reporter=tap']
 if pattern:command+=['--test-name-pattern',pattern]
 command+=['test/browser-profile-active-backup.test.ts'];r=subprocess.run(command,cwd=work,capture_output=True,timeout=45);(out/(label+'.log')).write_bytes(r.stdout+r.stderr);return r
baseline=run('baseline');assert baseline.returncode==0 and b'# pass 19'in baseline.stdout
mutations=[
 ('original_fixed_phase','storage-only cadence follows',[(";if(!this.#paused&&!this.#closed){this.#clearHints();this.#armHint()}",''),('Math.max(1,Math.min(60000,eligible-now))','60000')]),
 ('unused_cancel_not_released','repeated short command pauses',[('this.#releaseUnstartedAttempt(attempt);','void attempt;')]),
 ('automatic_cooldown_omitted','overdue skipped and unknown',[('now>=this.#automaticAfter','true')]),
 ('absolute_due_reset_on_resume','repeated short command pauses',[('this.#nextDue??=Date.now()+60000','this.#nextDue=Date.now()+60000')]),
 ('timer_upper_bound_omitted','backward wall clock jump',[('Math.max(1,Math.min(60000,eligible-now))','Math.max(1,eligible-now)')]),
 ('unentered_token_discarded','unentered due attempt',[('&&!(this.#paused&&attempt.owned&&!attempt.entered)','')]),
]
rows=[];path=paths[0]
for name,pattern,changes in mutations:
 original=before[path];text=original.decode();lines=[]
 for old,new in changes:
  assert text.count(old)==1,(name,'nonunique target');offset=text.index(old);text=text.replace(old,new);line=text[:offset].count('\n')+1;lines.append({'line':line,'loadedLine':text.splitlines()[line-1]})
 (work/path).write_text(text,encoding='utf-8',newline='\n');print(json.dumps({'mutation':name,'path':path,'changedLines':lines}),flush=True)
 try:
  red=run(name+'-red',pattern);assert red.returncode==1 and b'ERR_ASSERTION'in red.stdout+red.stderr and b'ERR_MODULE_NOT_FOUND'not in red.stdout+red.stderr,(name,red.stdout[-2000:],red.stderr[-1000:])
 finally:(work/path).write_bytes(original)
 assert(work/path).read_bytes()==original
 green=run(name+'-restored',pattern);assert green.returncode==0 and b'# pass 1'in green.stdout and b'# skipped 0'in green.stdout,name
 row={'name':name,'path':path,'pattern':pattern,'changedLines':lines,'redExit':1,'directAssertion':True,'restoredExit':0,'restoredSelectedTests':1,'restoredSourceSha256':sha(original)};rows.append(row);print(json.dumps({'mutation':name,'red':1,'exactRestore':True,'green':0}),flush=True)
assert all((root/p).read_bytes()==value for p,value in before.items())
raw=[{'path':str(p),'sha256':sha(p.read_bytes())}for p in out.glob('*.log')]
result={'baseCommit':ref,'sourcePins':{p:sha(value)for p,value in before.items()},'executedSourceKind':'Recorded committed archive plus exact frozen two proposed files; unchanged development dependency graph','baselineTests':19,'mutations':rows,'workingSourceUnchanged':True,'raw':raw}
(out/'results.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');(root/'.tmp/backup-cadence-mutations-pointer.json').write_text(json.dumps({'output':str(out)},indent=2),encoding='utf-8');print(json.dumps({'output':str(out),'mutations':len(rows)}))
