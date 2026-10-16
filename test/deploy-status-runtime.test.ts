import {test} from 'node:test';
import assert from 'node:assert/strict';

test('actual MCP status tool does not call an unmapped digest never deployed or up to date',async t=>{
  const calls:string[]=[];
  t.mock.module('../src/api.js',{namedExports:{
    apiRequest:async(_method:string,path:string)=>{calls.push(path);return {ok:true,data:path.endsWith('/deploy-status')?{mode:'git',current_sha:null,latest_sha:'newsha',has_new_version:null,can_deploy:false,is_building:true,runtime:{available:true,desired_image:'app@sha256:abc',running_images:['app@sha256:abc'],ready_replicas:2,desired_replicas:2,rollout_complete:true,commit_sha:null},pipeline:{id:'run',status:'running',commit_sha:'newsha'},active_pipeline:{id:'run',status:'running'}}:{builds:[]}}},
    formatError:()=>'',textResult:(text:string)=>({content:[{type:'text',text}]}),isValidProjectId:()=>true,invalidProjectIdResult:()=>({})
  }});
  const {registerDeployStatusTools}=await import('../src/tools/deploy-status.js');
  const handlers=new Map<string,any>();registerDeployStatusTools({tool:(name:string,_d:any,_s:any,h:any)=>handlers.set(name,h)} as any);
  const result=await handlers.get('dailey_deploy_status')({project_id:'owned'});const text=result.content[0].text;
  assert.match(text,/Deployed SHA: unknown/);assert.match(text,/Runtime commit: unknown/);assert.match(text,/Active pipeline: run/);assert.doesNotMatch(text,/New version: no|Deployed SHA: never/);
  assert.deepEqual(calls,['/projects/owned/deploy-status','/projects/owned/deploys']);
});
