import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTarget, resolveTarget } from "../src/tasks/task-target.mjs";

function fixture(t, { projectPath, projects, threads, thread, cwd } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-task-target-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registeredPath = projectPath ?? directory;
  const projectList = projects ?? [{ projectId: "project-1", path: registeredPath, hostId: "local" }];
  const threadList = threads ?? [{ kind: "codex", id: "task-1", title: "Original title", projectId: "project-1", hostId: "local" }];
  const threadView = thread ?? { kind: "codex", id: "task-1", title: "Original title", projectId: "project-1", hostId: "local", cwd: cwd ?? registeredPath };
  const calls = [];
  const callApp = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_projects") return { projects: projectList };
    if (tool === "list_threads") return { threads: threadList };
    if (tool === "read_thread") return { thread: threadView.id === args.threadId ? threadView : undefined };
    throw new Error(`Unexpected app tool ${tool}`);
  };
  return { directory, projectList, threadList, threadView, calls, callApp };
}

test("exact thread identity remains valid after a title rename", async (t) => {
  const f = fixture(t);
  const target = await resolveTarget("task-1", { callApp: f.callApp });
  assert.equal(target.threadId, "task-1");
  assert.equal(target.title, "Original title");
  assert.doesNotThrow(() => assertTarget({ ...target, title: "Old title" }, { ...target, title: "Renamed title" }));
  const renamed = await resolveTarget("task-1", { callApp: async (tool, args) => tool === "read_thread"
    ? { thread: { ...f.threadView, title: "Renamed title" } } : f.callApp(tool, args) });
  assert.equal(renamed.threadId, target.threadId);
  assert.equal(renamed.title, "Renamed title");
});

test("bound identity rejects a different thread, host, project, or cwd", () => {
  const expected = { threadId: "task-1", hostId: "local", projectId: "project-1", projectPath: "C:/repo", cwd: "C:/repo" };
  const actual = { ...expected };
  for (const [field, value] of [["threadId", "other-task"], ["hostId", "remote"], ["projectId", "other-project"], ["projectPath", "C:/other"], ["cwd", "C:/other"]]) {
    assert.throws(() => assertTarget(expected, { ...actual, [field]: value }), new RegExp(field));
  }
});

test("thread and recent-list project metadata disagreement is rejected", async (t) => {
  const f = fixture(t, { threads: [{ kind: "codex", id: "task-1", projectId: "project-2", hostId: "local" }] });
  await assert.rejects(resolveTarget("task-1", { callApp: f.callApp }), /metadata is inconsistent/);
});

test("unknown project identity does not fall back to a matching cwd", async (t) => {
  const f = fixture(t, { threads: [], thread: { kind: "codex", id: "task-1", projectId: "missing-project", hostId: "local", cwd: undefined } });
  f.threadView.cwd = f.projectList[0].path;
  await assert.rejects(resolveTarget("task-1", { callApp: f.callApp }), /project could not be confirmed/);
});

test("an older thread absent from recent results resolves by cwd and registered local project", async (t) => {
  const f = fixture(t, { threads: [], thread: { kind: "codex", id: "task-1", hostId: "local", cwd: undefined } });
  f.threadView.cwd = f.projectList[0].path;
  const target = await resolveTarget("task-1", { callApp: f.callApp });
  assert.deepEqual(target, { threadId: "task-1", hostId: "local", title: null, projectId: "project-1", projectPath: f.projectList[0].path, cwd: f.projectList[0].path });
});

test("explicit project membership supports a worktree cwd distinct from project path", async (t) => {
  const f = fixture(t);
  const worktreePath = path.join(f.directory, "worktrees", "task-1");
  const worktree = await resolveTarget("task-1", { callApp: async (tool, args) => tool === "read_thread"
    ? { thread: { ...f.threadView, cwd: worktreePath } } : f.callApp(tool, args) });
  assert.equal(worktree.projectId, "project-1");
  assert.equal(worktree.projectPath, f.directory);
  assert.equal(worktree.cwd, worktreePath);
  assert.doesNotThrow(() => assertTarget({ threadId: "task-1", hostId: "local", projectId: "project-1", projectPath: f.directory, cwd: worktreePath }, worktree));
  assert.throws(() => assertTarget({ threadId: "task-1", hostId: "local", projectId: "project-1", projectPath: f.directory, cwd: f.directory }, worktree), /cwd/);
});

test("multiple registered projects matching an ungrouped thread cwd are ambiguous", async (t) => {
  const f = fixture(t, { threads: [], thread: { kind: "codex", id: "task-1", hostId: "local", cwd: undefined } });
  f.threadView.cwd = f.directory;
  const projects = [
    { projectId: "project-1", path: f.directory, hostId: "local" },
    { projectId: "project-2", path: f.directory, hostId: "local" },
  ];
  await assert.rejects(resolveTarget("task-1", { callApp: async (tool, args) => tool === "list_projects"
    ? { projects } : f.callApp(tool, args) }), /project could not be confirmed/);
});

test("a standalone project path must identify one project even when the thread has explicit membership", async (t) => {
  const f = fixture(t);
  const projects = [...f.projectList, { projectId: "other-project", path: f.directory, hostId: "local" }];
  await assert.rejects(resolveTarget("task-1", { callApp: f.callApp, projects, expected: { projectPath: f.directory } }), /ambiguous/);
  const byId = await resolveTarget("task-1", { callApp: f.callApp, projects, expected: { projectId: "project-1", projectPath: f.directory } });
  assert.equal(byId.projectId, "project-1");
});

test("a saved worktree binding survives absent recent membership but rejects authoritative changes", async (t) => {
  const f = fixture(t, { threads: [] });
  const cwd = path.join(f.directory, "worktree");
  const expected = { threadId: "task-1", hostId: "local", projectId: "project-1", projectPath: f.directory, cwd };
  const inspect = (patch = {}) => resolveTarget("task-1", { expected, projects: f.projectList, threads: [],
    callApp: async () => ({ thread: { id: "task-1", cwd, ...patch } }) });
  assert.equal((await inspect()).projectId, expected.projectId);
  await assert.rejects(inspect({ projectId: "other-project" }), /project could not be confirmed|projectId/);
  await assert.rejects(inspect({ cwd: path.join(f.directory, "different-worktree") }), /cwd/);
  await assert.rejects(resolveTarget("task-1", { expected: { projectId: expected.projectId, projectPath: expected.projectPath },
    projects: f.projectList, threads: [], callApp: async () => ({ thread: { id: "task-1", cwd } }) }), /project could not be confirmed/);
});

test("an omitted project resolves target membership from an exact thread read and listing", async (t) => {
  const f = fixture(t, { projects: [], thread: { id: "task-1", cwd: undefined } });
  f.threadView.cwd = f.directory;
  const target = await resolveTarget("task-1", { callApp: f.callApp, expected: { projectPath: f.directory } });
  assert.equal(target.projectId, "project-1");
  assert.equal(target.projectPath, f.directory);
  assert.equal(target.cwd, f.directory);
});

test("a saved worktree target survives omitted project and recent listings without accepting changed membership", async (t) => {
  const f = fixture(t, { projects: [], threads: [] });
  const cwd = path.join(f.directory, "worktree");
  const expected = { threadId: "task-1", hostId: "local", projectId: "project-1", projectPath: f.directory, cwd };
  const callApp = async () => ({ thread: { id: "task-1", cwd } });
  assert.deepEqual(await resolveTarget("task-1", { callApp, projects: [], threads: [], expected }), { ...expected, title: null });
  await assert.rejects(resolveTarget("task-1", { callApp, projects: [], expected,
    threads: [{ id: "task-1", kind: "codex", projectId: "other-project", cwd }] }), /projectId/);
});

test("verified project roots do not hide current target cwd or local identity conflicts", async (t) => {
  const f = fixture(t);
  for (const patch of [{ cwd: path.join(f.directory, "changed") }, { hostId: "remote" }, { kind: "chatgpt" }]) {
    await assert.rejects(resolveTarget("task-1", { callApp: f.callApp, projects: [],
      threads: [{ ...f.threadList[0], ...patch }], verifiedProject: f.projectList[0],
      expected: { projectId: "project-1", projectPath: f.directory } }), /metadata is inconsistent|identity is inconsistent/);
  }
});

test("an exact internal creation result supplies omitted membership only for its own new ID", async (t) => {
  const f = fixture(t, { projects: [], threads: [] });
  const cwd = path.join(f.directory, "worktree");
  const options = { projects: [], threads: [], verifiedProject: { projectId: "project-1", path: f.directory },
    expected: { projectId: "project-1", projectPath: f.directory }, callApp: async () => ({ thread: { id: "task-1", cwd } }) };
  await assert.rejects(resolveTarget("task-1", options), /project could not be confirmed/);
  await assert.rejects(resolveTarget("task-1", { ...options, createdThreadId: "another-created-chat" }), /project could not be confirmed/);
  const created = await resolveTarget("task-1", { ...options, createdThreadId: "task-1" });
  assert.equal(created.projectPath, f.directory);
  assert.equal(created.cwd, cwd);
  await assert.rejects(resolveTarget("task-1", { ...options, createdThreadId: "task-1",
    callApp: async () => ({ thread: { id: "task-1", cwd, projectId: "other-project" } }) }), /projectId/);
});
