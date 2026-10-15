import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createAgentProfileFileArea } from '/opt/hoai-fresh/lib/browser-profile-file-area.mjs'
import { AgentProfileArtifacts } from '/opt/hoai-fresh/lib/browser-profile-artifacts.mjs'
const require=createRequire('/opt/hoai-fresh/package.json'),{ProfileFileStaging}=require('/opt/hoai-fresh/lib/browser-profile-core/profile-file-staging.js')
assert.equal(process.platform,'linux');assert.equal(process.getuid(),1000)
const base=await fs.mkdtemp('/proof/posix-'),directory=path.join(base,'private'),check=()=>true
let artifacts,staging,clean=false
try {
 const area=await createAgentProfileFileArea({directory,assertCurrent:check});assert.equal((await fs.stat(directory)).mode&0o777,0o700);assert.equal(await area.assertPrivateDirectory(directory),true)
 const permissive=path.join(base,'permissive');await fs.mkdir(permissive,{mode:0o755});await assert.rejects(createAgentProfileFileArea({directory:permissive,assertCurrent:check}),/private_directory_unproved/);assert.equal((await fs.stat(permissive)).mode&0o777,0o755)
 const linked=path.join(base,'linked');await fs.symlink(directory,linked);await assert.rejects(createAgentProfileFileArea({directory:linked,assertCurrent:check}),/private_directory_unproved/)
 const old=path.join(base,'old');await fs.rename(directory,old);await fs.mkdir(directory,{mode:0o700});try{await assert.rejects(area.assertPrivateDirectory(directory),/private_directory_unproved/)}finally{await fs.rmdir(directory);await fs.rename(old,directory)}
 staging=new ProfileFileStaging({directory,scope:'a'.repeat(64),assertPrivateDirectory:area.assertPrivateDirectory});artifacts=new AgentProfileArtifacts({area,staging})
 const fixture=Buffer.from('SYNTHETIC_POSIX_FILE_ONLY'),captured=await artifacts.capture({name:'browser_take_screenshot',args:{filename:'fixture.png'},assertCurrent:check,execute:async(_name,args)=>{assert.equal(path.dirname(path.dirname(args.filename)),directory);await fs.writeFile(args.filename,fixture,{mode:0o600,flag:'wx'});return{content:[{type:'text',text:args.filename}]}}})
 const metadata=JSON.parse(captured.content[0].text);assert.match(metadata.artifactToken,/^hoai-artifact:/);assert.equal(JSON.stringify(captured).includes(directory),false)
 let borrowed;await artifacts.consume(metadata.artifactToken,{assertCurrent:check,use:async(bytes,name,type)=>{assert.deepEqual(bytes,fixture);assert.equal(name,'fixture.png');assert.equal(type,'image/png');borrowed=bytes}});assert.equal(borrowed.every(byte=>byte===0),true);await assert.rejects(artifacts.consume(metadata.artifactToken,{assertCurrent:check,use:async()=>{throw Error('must not execute')}}))
 const incoming=staging.stage({bytes:fixture,fileName:'incoming.txt',expiresAt:Date.now()+30000,assertCurrent:check});let selectedPath
 await staging.withFile(incoming,{assertCurrent:check,use:async file=>{selectedPath=file;assert.deepEqual(await fs.readFile(file),fixture);assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700)}});await assert.rejects(fs.lstat(selectedPath),{code:'ENOENT'})
 const selected=path.join(base,'selected.txt'),symlink=path.join(base,'selected-link'),hardlink=path.join(base,'selected-hard');await fs.writeFile(selected,fixture,{mode:0o600});await fs.symlink(selected,symlink);await assert.rejects(staging.readSelected({selectedPath:symlink,assertCurrent:check}),/path_refused/);await fs.link(selected,hardlink);await assert.rejects(staging.readSelected({selectedPath:selected,assertCurrent:check}),/path_refused/)
 await artifacts.dispose();await staging.dispose();await staging.whenDrained();assert.deepEqual(artifacts.activity(),{pendingPhysicalOperations:0,cleanupUnknown:false});assert.deepEqual(await fs.readdir(directory),[]);clean=true
 console.log(JSON.stringify({kind:'actual Linux POSIX file foundation smoke',uid:process.getuid(),privateMode0700:true,permissiveDirectoryRefusedWithoutChmod:true,symlinkRefused:true,replacedOriginalInodeRefused:true,opaqueArtifactOneUse:true,borrowedPlaintextZeroed:true,materializedMode0600:true,materializedFileRemoved:true,hardlinkRefused:true,physicalOperations:0,cleanupUnknown:false,scope:'Actual filesystem and module behavior. Synthetic engine file write, no browser automation, HOAI relay or cross-machine file delivery.'}))
} finally {
 if(!clean){await Promise.allSettled([artifacts?.dispose(),staging?.dispose()])}
 assert.equal(path.dirname(base),'/proof');assert.match(path.basename(base),/^posix-[A-Za-z0-9]+$/);await fs.rm(base,{recursive:true,force:false})
}
