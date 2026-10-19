from pathlib import Path
import hashlib,json,subprocess,uuid,os
root=Path.cwd(); feature=Path(os.environ['HOAI_BROWSER_PROFILE_BGOS_SOURCE']).resolve(); out=root/'.tmp'/('field-mutations-'+uuid.uuid4().hex[:8]);out.mkdir(parents=True)
helper='lib/browser-profile-field-input.mjs';companion='lib/browser-profile-companion.mjs';client='lib/browser-profile-permission-client.mjs';runner='lib/browser-profile-permission-runner.mjs';ft='test/browser-profile-field-input.test.ts';ct='test/browser-profile-companion-fields.test.ts'
cases=[]
def add(id,file,old,new,pattern,test=ft,kind='esm',count=1):cases.append(dict(id=id,file=file,old=old,new=new,pattern=pattern,test=test,kind=kind,count=count))
add('unsupported-entry-modes',helper,"['submit','slowly'].some(key=>Object.hasOwn(args,key)&&args[key]!==false)",'false','unsupported mode flags')
add('duplicate-batch-target',helper,'new Set(fields.map(field=>field.target)).size!==fields.length','false','bounded textbox batches')
add('original-signed-values',helper,'argumentsFor(name,args).wire!==record.wire','false','another helper, forged capability')
add('original-abort-signal',helper,'record.signal!==signal','false','another helper, forged capability')
add('fresh-native-authority',helper,'synchronous(this.assertCurrent);record.signal.throwIfAborted()','record.signal.throwIfAborted()','page, URL, navigation history')
add('original-selected-page',helper,'this.engine.selectedPage()!==record.page','false','page, URL, navigation history')
add('native-main-frame',helper,'native?._frame!==nativeFrame','false','different native page, subframe')
add('native-handle-connection',helper,'handle._connection!==connection','false','different native page, subframe')
add('clean-utility-world',helper,"utility?.world!=='utility'",'false','different native page, subframe')
add('ticket-capture-cleanup',helper,'if(record.ticket)work.push(()=>record.ticket.dispose())','if(false)work.push(()=>record.ticket.dispose())','native refusal and capture readback')
add('independent-handle-cleanup',helper,'for(const handle of record.handles)work.push(()=>handle.dispose())','for(const handle of [])work.push(()=>handle.dispose())','exact original MCP field handles')
add('physical-cleanup-latch',helper,"if(this.#cleanupUnknown||[...this.#records.values()].some(record=>record.lease))throw fail('profile_field_cleanup_unconfirmed')","if(false)throw fail('profile_field_cleanup_unconfirmed')",'independent ticket and handle cleanup failure')
add('unknown-native-write-latch',helper,'this.#writeUnknown=true','this.#writeUnknown=false','native exception, partial event outcome',count=3)
add('concurrent-one-use-capability',helper,'    record.used=true\n    try{if(argumentsFor','    record.used=false\n    try{if(argumentsFor','one native capability cannot')
add('native-all-fields-before-write',helper,'row.signature===ticket.classify(row.node)','true','native synchronous batch validation')
add('native-ticket-single-use',helper,'  ticket.consumed=true','  ticket.consumed=false','native synchronous batch validation')
add('native-partial-write-unknown',helper,"dispatched?'outcome-unknown':'refused'","'refused'",'native setter or dispatch interruption')
add('companion-exact-executor',companion,'execute:(tool,originalArgs,originalSignal)=>fields.execute({capability,name:tool,args:originalArgs,signal:originalSignal})','execute:(tool,originalArgs,originalSignal)=>engine.callTool(tool,originalArgs,originalSignal)','actual endpoint and unchanged MCP relay',ct)
add('companion-unknown-admission',companion,'if(activity?.outcomeUnknown===true)','if(false)','an unknown native field write',ct)
add('native-stop-independent',companion,'const native=Promise.resolve().then(()=>record.runtime?.dispose())','const native=Promise.resolve().then(async()=>{await this.#fieldRunners.get(record)?.runner.dispose();return record.runtime?.dispose()})','runtime revocation starts physical shutdown',ct)
add('text-runner-method',runner,"'browser_type', 'browser_fill_form', ",'','actual endpoint and unchanged MCP relay',ct)
add('fixed-text-kind',client,"browser_type: 'text'","browser_type: 'write'",'supported text methods','test/browser-profile-permission-client.test.ts')
add('native-review-label','frontend/electron-app/agent-browser/profile-sync/runtime-permission-wire.js','text: "Enter page text"','text: "Change a page selection"','text field permission','frontend/electron-app/agent-browser/__tests__/profile-sync-native-runtime-permission-review.test.js','cjs')
add('backend-stored-text-kind','backend/src/agent-browser/profile-runtime-rpc.service.ts',"browser_type:'text'","browser_type:'write'",'text approval cannot','src/agent-browser/profile-runtime-permission.service.spec.ts','jest')
add('backend-fixed-text-label','backend/src/agent-browser/profile-runtime-permission.dto.ts',"text: 'Enter page text'","text: 'Change a page selection'",'text approval cannot','src/agent-browser/profile-runtime-permission.service.spec.ts','jest')
preload=out/'preload.mjs';preload.write_text("import{registerHooks}from'node:module';import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const row=JSON.parse(readFileSync(process.env.HOAI_FIELD_MUTATION,'utf8')),url=pathToFileURL(row.target).href;registerHooks({load(id,context,next){if(id===url)return{format:'module',source:row.source+'\\nconsole.error(\"MUTATION_LOADED\");',shortCircuit:true};return next(id,context)}});\n")
cjs=out/'loader.cjs';cjs.write_text("const fs=require('node:fs'),Module=require('node:module'),row=JSON.parse(fs.readFileSync(process.env.HOAI_FIELD_MUTATION,'utf8')),ordinary=Module._extensions['.js'];Module._extensions['.js']=function(module,file){if(file===row.target)module._compile(row.source+'\\nconsole.error(\"MUTATION_LOADED\");',file);else ordinary(module,file)};\n")
transformer=out/'transformer.cjs';transformer.write_text("const fs=require('node:fs'),crypto=require('node:crypto'),ordinary=require("+json.dumps(str(feature/'backend/node_modules/ts-jest'))+").default.createTransformer(),row=JSON.parse(fs.readFileSync(process.env.HOAI_FIELD_MUTATION,'utf8'));module.exports={process(source,file,...args){if(file===row.target)source=row.source+'\\nconsole.error(\"MUTATION_LOADED\");';return ordinary.process(source,file,...args)},getCacheKey(source,file,...args){return crypto.createHash('sha256').update(ordinary.getCacheKey(source,file,...args)).update(row.source).digest('hex')}};\n")
config=out/'jest.json';package=json.loads((feature/'backend/package.json').read_text());config.write_text(json.dumps({**package['jest'],'rootDir':str(feature/'backend'),'roots':['<rootDir>/src','<rootDir>/test'],'setupFiles':[str(feature/'backend/test/jest.env-setup.js')],'transform':{'^.+\\.(t|j)s$':str(transformer)},'silent':False}))
results=[]
for row in cases:
 if len(os.sys.argv)>1 and row['id'] not in os.sys.argv[1:]:continue
 base=root if row['kind']=='esm' else feature;target=base/row['file'];original=target.read_bytes();source=original.decode();assert source.count(row['old'])==row['count'],(row['id'],source.count(row['old']))
 changed=source.replace(row['old'],row['new']);line=source[:source.index(row['old'])].count('\n')+1;changedline=changed.splitlines()[line-1];print(json.dumps({'mutation':row['id'],'file':row['file'],'line':line,'changedExecutableLine':changedline}),flush=True)
 metadata=out/(row['id']+'.input.json');metadata.write_text(json.dumps({'target':str(target),'source':changed}))
 if row['kind']=='esm':redargs=['--import',preload.as_uri(),'--import','tsx','--test','--test-name-pattern='+row['pattern'],row['test']];greenargs=redargs[2:]
 elif row['kind']=='cjs':redargs=['--require',str(cjs),'--test','--test-name-pattern='+row['pattern'],row['test']];greenargs=redargs[2:]
 else:redargs=[str(feature/'backend/node_modules/jest/bin/jest.js'),'--config',str(config),'--runInBand','--runTestsByPath',row['test'],'--testNamePattern',row['pattern']];greenargs=[str(feature/'backend/node_modules/jest/bin/jest.js'),'--runInBand','--runTestsByPath',row['test'],'--testNamePattern',row['pattern']]
 cwd=base/'backend' if row['kind']=='jest' else base
 def run(args,mutant):
  env={**os.environ,**({'HOAI_FIELD_MUTATION':str(metadata)} if mutant else {})};r=subprocess.run(['node',*args],cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60);return r,r.stdout.decode(errors='replace')
 red,output=run(redargs,True);(out/(row['id']+'.red.txt')).write_text(output);assert red.returncode==1 and 'MUTATION_LOADED'in output and any(marker in output for marker in ['ERR_ASSERTION','AssertionError','expect(received)','Expected:']),(row['id'],red.returncode,output[-2200:]);assert target.read_bytes()==original
 green,text=run(greenargs,False);(out/(row['id']+'.green.txt')).write_text(text);assert green.returncode==0,(row['id'],text[-2000:]);assert target.read_bytes()==original
 results.append({'id':row['id'],'file':row['file'],'line':line,'changedExecutableLine':changedline,'sourceSHA256':hashlib.sha256(original).hexdigest(),'mutantSHA256':hashlib.sha256(changed.encode()).hexdigest(),'restoredSHA256':hashlib.sha256(target.read_bytes()).hexdigest(),'redExit':1,'restoredExit':0,'test':row['test'],'pattern':row['pattern'],'loaderExecuted':True,'workspaceUnchanged':True});(out/'results.json').write_text(json.dumps({'results':results},indent=2)+'\n');print('RED_ASSERTION_1_RESTORE_GREEN_0 '+row['id'],flush=True)
print(json.dumps({'qualified':len(results),'output':str(out)}))
