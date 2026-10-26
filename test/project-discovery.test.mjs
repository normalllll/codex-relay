import { adaptTest } from "./support/harness.mjs";
const nativeTest = await import(process.versions.bun ? "bun:test" : "node:test");
const test = adaptTest(nativeTest);
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { discoverProject } from "../src/tasks/project-discovery.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-discovery-fixture-"));
const root = path.join(directory, "project"), otherRoot = path.join(directory, "other-project"), worktree = path.join(directory, "worktree");
for (const entry of [root, otherRoot, worktree]) fs.mkdirSync(entry);
(process.versions.bun ? nativeTest.afterAll : nativeTest.after)(() => fs.rmSync(directory, { recursive: true, force: true }));

function fixture({ projects = [], threads = [{ id: "task-1", kind: "codex", projectId: "project-1" }],
  views = { "task-1": { id: "task-1", cwd: root } } } = {}) {
  const calls = [];
  const callApp = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_projects") return { projects };
    if (tool === "list_threads") return { threads };
    if (tool === "read_thread") return { thread: views[args.threadId] };
    throw new Error(`Unexpected app tool ${tool}`);
  };
  return { projects, threads, views, calls, callApp };
}

const saved = () => ({ threadId: "task-1", hostId: "local", title: "Bound worktree", projectId: "project-1", projectPath: root, cwd: worktree });

test("an exact catalogue project resolves without reading an unrelated chat", async () => {
  const project = { projectId: "project-1", path: root, hostId: "local" };
  const f = fixture({ projects: [project] });
  assert.deepEqual(await discoverProject({ projectId: project.projectId }, { callApp: f.callApp }), project);
  assert.deepEqual(f.calls.map((call) => call.tool), ["list_projects"]);
});

test("an omitted catalogue project resolves its explicit path from split listing and read evidence", async () => {
  const f = fixture();
  const project = await discoverProject({ projectPath: root }, { callApp: f.callApp });
  assert.equal(project.projectId, "project-1");
  assert.equal(project.path, root);
  assert.deepEqual(project.discovery, { source: "existingThreads", threadIds: ["task-1"] });
  assert.deepEqual(f.calls.find((call) => call.tool === "read_thread").args,
    { threadId: "task-1", hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
});

test("an omitted catalogue project resolves its explicit ID from matching local chats", async () => {
  const f = fixture({ threads: [{ id: "task-1", kind: "codex", projectId: "project-1" }, { id: "task-2", kind: "codex", projectId: "project-1" }],
    views: { "task-1": { id: "task-1", cwd: root }, "task-2": { id: "task-2", cwd: root } } });
  const project = await discoverProject({ projectId: "project-1" }, { callApp: f.callApp });
  assert.equal(project.projectId, "project-1");
  assert.equal(project.path, root);
  assert.deepEqual(project.discovery.threadIds, ["task-1", "task-2"]);
});

test("membership available only from the exact thread read can confirm an omitted project", async () => {
  const f = fixture({ threads: [{ id: "task-1", kind: "codex" }], views: { "task-1": { id: "task-1", cwd: root, projectId: "project-1" } } });
  const project = await discoverProject({ projectPath: root }, { callApp: f.callApp });
  assert.equal(project.projectId, "project-1");
  assert.equal(project.path, root);
});

test("one project path associated with multiple project IDs is ambiguous", async () => {
  const f = fixture({ threads: [{ id: "task-1", kind: "codex", projectId: "project-1" }, { id: "task-2", kind: "codex", projectId: "project-2" }],
    views: { "task-1": { id: "task-1", cwd: root }, "task-2": { id: "task-2", cwd: root } } });
  await assert.rejects(discoverProject({ projectPath: root }, { callApp: f.callApp }), /ambiguous/);
});

test("one project ID associated with multiple directories requires the intended path", async () => {
  const f = fixture({ threads: [{ id: "task-1", kind: "codex", projectId: "project-1" }, { id: "task-2", kind: "codex", projectId: "project-1" }],
    views: { "task-1": { id: "task-1", cwd: root }, "task-2": { id: "task-2", cwd: otherRoot } } });
  await assert.rejects(discoverProject({ projectId: "project-1" }, { callApp: f.callApp }), /ambiguous/);
  const exact = await discoverProject({ projectId: "project-1", projectPath: root }, { callApp: f.callApp });
  assert.equal(exact.path, root);
});

test("an existing chat read must confirm its exact requested ID and local host", async () => {
  for (const view of [{ id: "different-task", cwd: root }, { id: "task-1", cwd: root, hostId: "remote" }, { id: "task-1", cwd: root, kind: "chatgpt" }]) {
    const f = fixture({ views: { "task-1": view } });
    await assert.rejects(discoverProject({ projectPath: root }, { callApp: f.callApp }), /local chat identity/);
  }
});

test("remote chat listings do not establish a local project association", async () => {
  const f = fixture({ threads: [{ id: "task-1", kind: "codex", projectId: "project-1", cwd: root, hostId: "remote" }] });
  await assert.rejects(discoverProject({ projectPath: root }, { callApp: f.callApp }), /could not be confirmed/);
  assert.equal(f.calls.filter((call) => call.tool === "read_thread").length, 0);
});

test("a listed directory change or contradictory project read is rejected", async () => {
  const changedCwd = fixture({ threads: [{ id: "task-1", kind: "codex", projectId: "project-1", cwd: root }], views: { "task-1": { id: "task-1", cwd: otherRoot } } });
  await assert.rejects(discoverProject({ projectPath: root }, { callApp: changedCwd.callApp }), /directory.*changed/);
  const changedProject = fixture({ views: { "task-1": { id: "task-1", cwd: root, projectId: "different-project" } } });
  await assert.rejects(discoverProject({ projectPath: root }, { callApp: changedProject.callApp }), /project metadata is inconsistent/);
});

test("missing or relative thread working directories cannot establish a project", async () => {
  for (const cwd of [undefined, "relative-workspace"]) {
    const f = fixture({ views: { "task-1": { id: "task-1", cwd } } });
    await assert.rejects(discoverProject({ projectId: "project-1" }, { callApp: f.callApp }), /directory was not confirmed/);
  }
});

test("a known catalogue root prevents reinterpreting its member worktree as another root", async () => {
  const f = fixture({ projects: [{ projectId: "project-1", path: root }], threads: [{ id: "task-1", kind: "codex", projectId: "project-1", cwd: worktree }],
    views: { "task-1": { id: "task-1", cwd: worktree } } });
  await assert.rejects(discoverProject({ projectPath: worktree }, { callApp: f.callApp }), /registered project path/);
});

test("catalogue evidence conflicting with an existing chat path is preserved as a conflict", async () => {
  const f = fixture({ projects: [{ projectId: "different-project", path: root }] });
  await assert.rejects(discoverProject({ projectId: "project-1" }, { callApp: f.callApp }), /conflicts with the project registered at this path/);
  await assert.rejects(discoverProject({ projectId: "different-project", projectPath: otherRoot }, { callApp: f.callApp }), /registered project path conflicts/);
});

test("a complete saved worktree binding survives omission from catalogue and recent results", async () => {
  const binding = saved();
  const f = fixture({ threads: [], views: { "task-1": { id: "task-1", cwd: worktree } } });
  const project = await discoverProject({ projectId: binding.projectId, projectPath: binding.projectPath }, { callApp: f.callApp, binding });
  assert.equal(project.projectId, binding.projectId);
  assert.equal(project.path, binding.projectPath);
  assert.deepEqual(project.discovery.threadIds, [binding.threadId]);
  assert.equal(f.calls.filter((call) => call.tool === "read_thread")[0].args.threadId, binding.threadId);
});

test("a saved worktree root is not displaced by another member's different cwd", async () => {
  const binding = saved();
  const f = fixture({ threads: [{ id: "task-2", kind: "codex", projectId: "project-1" }],
    views: { "task-1": { id: "task-1", cwd: worktree }, "task-2": { id: "task-2", cwd: otherRoot } } });
  const project = await discoverProject({ projectId: binding.projectId, projectPath: binding.projectPath }, { callApp: f.callApp, binding });
  assert.equal(project.path, binding.projectPath);
  assert.deepEqual(project.discovery.threadIds, [binding.threadId]);
});

test("saved worktree discovery rejects changed cwd and current project membership", async () => {
  const binding = saved();
  for (const view of [{ id: binding.threadId, cwd: otherRoot }, { id: binding.threadId, cwd: binding.cwd, projectId: "different-project" }]) {
    const f = fixture({ threads: [], views: { [binding.threadId]: view } });
    await assert.rejects(discoverProject({ projectId: binding.projectId, projectPath: binding.projectPath }, { callApp: f.callApp, binding }), /directory.*changed|project metadata is inconsistent/);
  }
  const conflictingListing = fixture({ threads: [{ id: binding.threadId, kind: "codex", projectId: "different-project", cwd: binding.cwd }],
    views: { [binding.threadId]: { id: binding.threadId, cwd: binding.cwd, projectId: "different-project" } } });
  await assert.rejects(discoverProject({ projectPath: binding.projectPath }, { callApp: conflictingListing.callApp, binding }), /metadata is inconsistent/);
});

test("an inaccessible bound chat is never replaced by another chat of the same project", async () => {
  const binding = saved();
  const f = fixture({ threads: [{ id: "replacement", kind: "codex", projectId: binding.projectId, cwd: root }],
    views: { replacement: { id: "replacement", cwd: root } } });
  await assert.rejects(discoverProject({ projectId: binding.projectId, projectPath: binding.projectPath }, { callApp: f.callApp, binding }), /local chat identity/);
  assert.ok(f.calls.some((call) => call.tool === "read_thread" && call.args.threadId === binding.threadId));
});

test("a partial legacy binding does not replace the verified cwd with an absent project root", async () => {
  const f = fixture();
  const binding = { threadId: "task-1", projectId: "project-1", cwd: root };
  const project = await discoverProject({ projectId: binding.projectId }, { callApp: f.callApp, binding });
  assert.equal(project.path, root);
});

test("an explicit ID cannot filter away current listing conflicts with its full saved binding", async () => {
  const binding = saved();
  const f = fixture({ threads: [{ id: binding.threadId, kind: "codex", projectId: "different-project", cwd: binding.cwd }],
    views: { [binding.threadId]: { id: binding.threadId, cwd: binding.cwd } } });
  await assert.rejects(discoverProject({ projectId: binding.projectId, projectPath: binding.projectPath }, { callApp: f.callApp, binding }), /metadata is inconsistent/);
});

test("linked worktree metadata cannot become an omitted project's root, even with an explicit cwd path", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worktree-discovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = path.join(directory, "primary"), member = path.join(directory, "member");
  const gitdir = path.join(primary, ".git", "worktrees", "member");
  fs.mkdirSync(gitdir, { recursive: true }); fs.mkdirSync(member);
  fs.writeFileSync(path.join(member, ".git"), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  const f = fixture({ threads: [{ id: "task-1", kind: "codex", projectId: "project-1", cwd: member }],
    views: { "task-1": { id: "task-1", cwd: member } } });
  for (const selector of [{ projectId: "project-1" }, { projectPath: member }])
    await assert.rejects(discoverProject(selector, { callApp: f.callApp }), /worktree cwd cannot establish the project root/);
  const binding = { ...saved(), projectPath: primary, cwd: member };
  assert.equal((await discoverProject({ projectId: binding.projectId, projectPath: primary }, { callApp: f.callApp, binding })).path, primary);
  f.threads.push({ id: "root-chat", kind: "codex", projectId: "project-1", cwd: primary });
  f.views["root-chat"] = { id: "root-chat", cwd: primary };
  const discovered = await discoverProject({ projectId: "project-1" }, { callApp: f.callApp });
  assert.equal(discovered.path, primary, "The root chat confirms the project without treating its worktree as another root");
  assert.deepEqual(discovered.discovery.threadIds, ["root-chat"]);
});

test("submodule gitfiles and ordinary directories named worktrees remain valid project directories", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gitfile-discovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const module = path.join(directory, "module"), gitdir = path.join(directory, "metadata", "module");
  const named = path.join(directory, "worktrees", "project");
  fs.mkdirSync(gitdir, { recursive: true }); fs.mkdirSync(module); fs.mkdirSync(named, { recursive: true });
  fs.writeFileSync(path.join(module, ".git"), `gitdir: ${gitdir}\n`);
  for (const cwd of [module, named]) {
    const f = fixture({ views: { "task-1": { id: "task-1", cwd } } });
    assert.equal((await discoverProject({ projectId: "project-1" }, { callApp: f.callApp })).path, cwd);
  }
});

test("unavailable unrelated partial recent chats cannot block exact verified project evidence", async () => {
  const f = fixture({ threads: [{ id: "unrelated", kind: "codex" }], views: {} });
  const verifiedThreads = [{ id: "selected", kind: "codex", cwd: root, projectId: "project-1" }];
  for (const unavailable of [false, true]) {
    const project = await discoverProject({ projectId: "project-1", projectPath: root }, { verifiedThreads,
      callApp: async (tool, args) => {
        if (tool === "read_thread" && unavailable) throw new Error("Unrelated chat is unavailable");
        return f.callApp(tool, args);
      } });
    assert.equal(project.projectId, "project-1");
    assert.deepEqual(project.discovery.threadIds, ["selected"]);
  }
  f.threads[0] = { id: "selected", kind: "codex", projectId: "different-project", cwd: root };
  await assert.rejects(discoverProject({ projectPath: root }, { callApp: f.callApp, verifiedThreads }), /metadata is inconsistent/);
});

test("a removed workspace cannot be inferred as an omitted project's root", async () => {
  const cwd = path.join(directory, "removed-worktree");
  const f = fixture({ views: { "task-1": { id: "task-1", cwd } } });
  await assert.rejects(discoverProject({ projectId: "project-1" }, { callApp: f.callApp }), /directory is unavailable/);
});

test("null project metadata in an exact read preserves membership established by the listing", async () => {
  const f = fixture();
  const project = await discoverProject({ projectPath: root }, { callApp: f.callApp,
    verifiedThreads: [{ id: "task-1", kind: "codex", cwd: root, projectId: null }] });
  assert.equal(project.projectId, "project-1");
});
