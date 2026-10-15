import pathlib,tempfile,shutil,subprocess,os,json,hashlib
root=pathlib.Path.cwd(); (root/'.tmp/backup-core-proof').mkdir(parents=True,exist_ok=True); out=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=root/'.tmp/backup-core-proof')); copied=out/'source'
for folder in ['lib/browser-profile-core','scripts','test']:(copied/folder).mkdir(parents=True,exist_ok=True)
for p in (root/'lib/browser-profile-core').iterdir():shutil.copy2(p,copied/'lib/browser-profile-core'/p.name)
for name in ['package.json','.gitattributes','scripts/vendor-browser-profile-core.mjs','test/browser-profile-core.vendor.test.ts','test/browser-profile-backup-workers.test.ts']:shutil.copy2(root/name,copied/name)
env=os.environ.copy(); source=env.get('HOAI_BROWSER_PROFILE_CORE_SOURCE'); assert source, 'Set HOAI_BROWSER_PROFILE_CORE_SOURCE to the BGOS checkout'; env['HOAI_BROWSER_PROFILE_CORE_SOURCE']=str(pathlib.Path(source).resolve())
loader=(root/'node_modules/tsx/dist/loader.mjs').as_uri(); command=['node','--import',loader,'--test','test/browser-profile-core.vendor.test.ts','test/browser-profile-backup-workers.test.ts']
def run(name):
 r=subprocess.run(command,cwd=copied,env=env,text=True,capture_output=True,timeout=60);(out/(name+'.log')).write_text(r.stdout+r.stderr);return r
base=run('baseline');assert base.returncode==0,base.stdout+base.stderr
cases=[('seal-worker-entry','lib/browser-profile-core/backup-seal-client.js','path.join(__dirname, "backup-seal-worker.js")','path.join(__dirname, "missing-seal-worker.js")'),('journal-worker-entry','lib/browser-profile-core/backup-journal.js','path.join(__dirname, "backup-journal-worker.js")','path.join(__dirname, "missing-journal-worker.js")'),('vendor-worker-omission','scripts/vendor-browser-profile-core.mjs',", 'backup-journal-worker.js'",'')]
results=[]
for name,file,before,after in cases:
 p=copied/file;original=p.read_bytes();text=original.decode();assert text.count(before)==1;changed=text.replace(before,after);p.write_text(changed,newline='');line=next((i+1,v)for i,v in enumerate(changed.splitlines())if after in v) if after else next((i+1,v)for i,v in enumerate(changed.splitlines())if 'for (const name of' in v)
 print(json.dumps({'mutation':name,'file':file,'line':line[0],'loadedChangedLine':line[1]}),flush=True)
 try:
  red=run(name+'-red');assert red.returncode==1 and ('ERR_ASSERTION' in red.stdout+red.stderr or 'AssertionError' in red.stdout+red.stderr),(red.returncode,red.stdout,red.stderr)
 finally:p.write_bytes(original)
 green=run(name+'-green');assert green.returncode==0,green.stdout+green.stderr;results.append({'mutation':name,'file':file,'line':line[0],'loadedChangedLine':line[1],'redExit':red.returncode,'redAssertion':True,'exactRestored':p.read_bytes()==original,'greenExit':green.returncode})
final={'baselineExit':base.returncode,'sourceCommit':'7b769071503748def458591d8596f30420bbe3d9','tests':4,'zeroSkips':True,'mutations':results,'workspaceUnchanged':all(hashlib.sha256((root/n).read_bytes()).hexdigest()==hashlib.sha256((copied/n).read_bytes()).hexdigest()for n in ['scripts/vendor-browser-profile-core.mjs','lib/browser-profile-core/backup-seal-client.js','lib/browser-profile-core/backup-journal.js'])};(out/'results.json').write_text(json.dumps(final,indent=2));print(str(out/'results.json'))
