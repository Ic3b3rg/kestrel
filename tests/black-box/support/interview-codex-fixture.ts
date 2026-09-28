import { codexConnectionFixture } from "./codex-connection-fixture.js";
import { verificationPlan } from "./factory-verification-fixture.js";

export const interviewCodexFixture = codexConnectionFixture.replace(
  "const { id, method } = JSON.parse(line);",
  `const { id, method, params } = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (method === 'config/read') { send({id,result:{config:{features:{apps:false,plugins:false,hooks:false,browser_use:false,browser_use_external:false,shell_tool:false},web_search:'disabled',allow_login_shell:false}}});return; }
  if (method === 'thread/start') { send({id,result:{thread:{id:'interview-thread'},cwd:params.cwd,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',approvalsReviewer:'user',model:params.model,modelProvider:'openai'}});return; }
  if (method === 'turn/start') {
    send({id,result:{turn:{id:'interview-turn',status:'inProgress'}}});
    const prompt = params.input[0].text;
    const section = prompt.split('<selected_planning_skills>')[1]?.split('</selected_planning_skills>')[0];
    const name = JSON.parse(section || '[]')[0]?.name || 'none';
    const reply = '## Interview findings\\n\\nProcedure: **'+name+'**\\n\\n- Which outcome matters?\\n- What must stay unchanged?\\n\\n\x60\x60\x60text\\nFree-form answers are welcome.\\n\x60\x60\x60';
    const text = params.outputSchema?.properties?.title ? JSON.stringify({title:'Stable ordering',text:reply}) : params.outputSchema ? ${JSON.stringify(JSON.stringify({ ...verificationPlan(), proposedDocuments: [] }))} : reply;
    send({method:'item/completed',params:{threadId:params.threadId,turnId:'interview-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text}}});
    send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'interview-turn',status:'completed'}}});return;
  }`,
);
