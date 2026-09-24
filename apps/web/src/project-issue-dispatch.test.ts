import { beforeEach, expect, it, vi } from "vitest";
import type { DatabasePool, DiagnosticJobSender, IssueDispatch } from "@kestrel/database";
import type { CodexAgentRuntimePort } from "./codex-app-server.js";
import type { FactoryGitHubAdapter } from "./factory-github.js";
import { createProjectIssueDispatcher } from "./project-issue-dispatch.js";

const db=vi.hoisted(()=>({rows:vi.fn(),busy:vi.fn(),update:vi.fn(),retain:vi.fn(),attach:vi.fn(),create:vi.fn(),imports:vi.fn(),plans:vi.fn(),approve:vi.fn(),accept:vi.fn(),requested:vi.fn()}));
const read=vi.hoisted(()=>vi.fn());
vi.mock("./project-issue-reader.js",()=>({createProjectIssueReader:()=>read}));
vi.mock("@kestrel/database",async original=>({
  ...await original<object>(),withProjectIssueDispatchLock:async(_pool:unknown,operation:()=>Promise<void>)=>operation(),
  readIssueDispatches:db.rows,issueProjectBusy:db.busy,updateIssueDispatch:db.update,
  retainIssueDispatchContext:db.retain,attachIssueDispatchFeature:db.attach,createFactoryFeature:db.create,
  importFactoryIssues:db.imports,readFactoryPlans:db.plans,approveFactoryPlan:db.approve,
  acceptPlanningMessage:db.accept,hasIssueDispatchPlanRequest:db.requested,
}));
const project="01991c36-7f90-7000-8000-000000000001";
const feature="01991c36-7f90-7000-8000-000000000002";
const start:IssueDispatch={id:"01991c36-7f90-7000-8000-000000000003",project_id:project,actor_id:project,repository_id:"901",issue_id:"42",issue_number:42,title:"Export",ready_label:"ready-for-agent",plan_request_id:feature,state:"queued",feature_id:null,snapshot:null,feature_state:null};
const issue={repository:{id:"901",owner:"owner",name:"reports"},id:"42",number:42,url:"https://github.com/owner/reports/issues/42",title:"Current export requirements",body:"Read the latest requirements, beyond the original card.",state:"open",dependencies:[],labels:[{name:"ready-for-agent",color:"008800"}]};
const pool={} as DatabasePool;
const dispatch=()=>createProjectIssueDispatcher(pool,{} as DiagnosticJobSender,{} as FactoryGitHubAdapter,{readConnection:async()=>({})} as CodexAgentRuntimePort)();
beforeEach(()=>{
  vi.clearAllMocks();db.rows.mockResolvedValue([start]);db.busy.mockResolvedValue(false);
  db.create.mockResolvedValue({id:feature});db.imports.mockResolvedValue({issues:[{id:project}]});
  read.mockReset().mockResolvedValue({issue,comments:[{id:"71",body:"Latest comment",url:issue.url+"#issuecomment-71",author:"operator"}],nextPage:null});
});

it("reads and retains the current complete conversation when queued work starts",async()=>{
  await dispatch();
  expect(read).toHaveBeenCalledWith(project,42,1,true);
  expect(db.retain).toHaveBeenCalledWith(pool,start.id,expect.objectContaining({issue,conversation:[expect.objectContaining({body:"Latest comment"})]}));
  expect(db.accept).toHaveBeenCalledWith(pool,expect.anything(),project,feature,expect.objectContaining({requestId:feature,text:expect.stringContaining(issue.url)}),{expectedVersion:null},{});
  expect(db.approve).not.toHaveBeenCalled();
});

it("starts the next issue in the same tick when its predecessor enters review, before merge",async()=>{
  db.rows.mockResolvedValue([{...start,id:feature,state:"running",feature_id:feature,feature_state:"in_review"},start]);
  await dispatch();
  expect(db.update).toHaveBeenCalledWith(pool,feature,"done");
  expect(read).toHaveBeenCalledOnce();
  expect(db.accept).toHaveBeenCalledOnce();
});

it("does not read or start a queued issue while another implementation owns the Project",async()=>{
  db.busy.mockResolvedValue(true);await dispatch();
  expect(read).not.toHaveBeenCalled();expect(db.accept).not.toHaveBeenCalled();
});

it("blocks instead of executing when the ready label has been removed during the wait",async()=>{
  read.mockResolvedValue({issue:{...issue,labels:[]},comments:[],nextPage:null});
  await dispatch();
  expect(db.update).toHaveBeenCalledWith(pool,start.id,"blocked",expect.stringContaining("ready label"));
  expect(db.create).not.toHaveBeenCalled();
});

it("collects later comment pages before deriving a plan",async()=>{
  read.mockResolvedValueOnce({issue,comments:[],nextPage:2}).mockResolvedValueOnce({issue,comments:[{body:"Final acceptance"}],nextPage:null});
  await dispatch();
  expect(read).toHaveBeenLastCalledWith(project,42,2,true);
  expect(db.retain).toHaveBeenCalledWith(pool,start.id,expect.objectContaining({conversation:[{body:"Final acceptance"}]}));
});

it("keeps a failed plan visible without authorizing execution",async()=>{
  db.rows.mockResolvedValue([{...start,state:"preparing",feature_id:feature}]);
  db.requested.mockResolvedValue(true);
  db.plans.mockResolvedValue({approval:null,current:null,generation:{state:"failed",question:"Which format?"}});
  await dispatch();
  expect(db.update).toHaveBeenCalledWith(pool,start.id,"blocked","Which format?");
  expect(db.approve).not.toHaveBeenCalled();
});
