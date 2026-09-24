import { beforeEach, expect, it, vi } from "vitest";
import type { DatabasePool } from "@kestrel/database";
import { createProjectIssueReader } from "./project-issue-reader.js";
import { FactoryGitHubError, type FactoryGitHubAdapter } from "./factory-github.js";
const db=vi.hoisted(()=>({read:vi.fn(),save:vi.fn()}));
vi.mock("@kestrel/database",async original=>({...await original<object>(),boardProjectId:async()=>"project",readProjectGitHubCoordinates:async()=>({owner:"example",repository:"reports"}),readProjectIssueObservation:db.read,saveProjectIssueObservation:db.save}));
beforeEach(()=>{
  const values=new Map<string,unknown>();
  db.read.mockReset().mockImplementation(async(_pool,_project,key)=>values.get(key)??null);
  db.save.mockReset().mockImplementation(async(_pool,_project,key,value)=>values.set(key,value));
});
it("persists a provider throttle deadline even with no previous issue to display",async()=>{
  const identify=vi.fn().mockRejectedValue(new FactoryGitHubError("rate_limited",new Date(Date.now()+3600000).toISOString()));
  const adapter={identify} as unknown as FactoryGitHubAdapter;
  const pool={} as DatabasePool;
  await expect(createProjectIssueReader(pool,adapter)("project",42,1,true)).rejects.toMatchObject({failure:"rate_limited"});
  await expect(createProjectIssueReader(pool,adapter)("project",42,1,true)).rejects.toMatchObject({failure:"rate_limited"});
  expect(identify).toHaveBeenCalledOnce();
});
