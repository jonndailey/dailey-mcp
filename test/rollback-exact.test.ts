import { test } from 'node:test';
import assert from 'node:assert/strict';

test('exact rollback forwards digest, requires verified response, and captures artifact', async t => {
  const calls: any[] = []; let verified = true;
  t.mock.module('../src/api.js', { namedExports: {
    apiRequest: async (method: string, path: string, body: any) => {
      calls.push({method,path,body}); return {ok:true,data:{verified,image:body.image,previous_image:'previous'}};
    },
    formatError: () => 'error',
    textResult: (text: string) => ({content:[{type:'text',text}]}),
    isValidProjectId: () => true,
    invalidProjectIdResult: () => ({content:[]}),
  } });
  const { registerDeployTools } = await import('../src/tools/deploy.js');
  const handlers = new Map<string, any>();
  registerDeployTools({tool:(name: string, _d: any, _s: any, h: any) => handlers.set(name,h)} as any);
  const image = 'registry.dailey.cloud/customer/app@sha256:'+'a'.repeat(64);
  let out = await handlers.get('dailey_rollback')({project_id:'project',image});
  assert.match(out.content[0].text,/Rollback verified/);
  assert.deepEqual(calls[0].body,{image});
  verified = false;
  out = await handlers.get('dailey_rollback')({project_id:'project',image});
  assert.match(out.content[0].text,/not verified/);
  const count = calls.length;
  await handlers.get('dailey_rollback')({project_id:'project',image,build_id:'build'});
  assert.equal(calls.length,count);
  await handlers.get('dailey_rollback_artifact')({project_id:'project',process_name:'worker'});
  assert.deepEqual(calls.at(-1).body,{process_name:'worker'});
  assert.equal(calls.at(-1).path,'/projects/project/rollback-artifact');
});
