import path from "node:path";
import { callApp as defaultCallApp, MAX_RECENT_THREADS } from "../desktop/codex-client.mjs";
import { discoverProject, samePath } from "./project-discovery.mjs";
export { samePath } from "./project-discovery.mjs";

export function assertTarget(expected, actual) {
  for (const field of ["threadId", "hostId", "projectId"])
    if (expected?.[field] && expected[field] !== actual[field]) throw new Error(`Execution target ${field} does not match its binding`);
  for (const field of ["projectPath", "cwd"])
    if (expected?.[field] && !samePath(expected[field], actual[field])) throw new Error(`Execution target ${field} does not match its binding`);
  // Titles are display metadata: renaming a chat must not select another chat.
}

export function validateTarget(target) {
  for (const field of ["threadId", "hostId", "projectId", "projectPath", "cwd"])
    if (typeof target?.[field] !== "string" || !target[field].trim()) throw new Error(`A verified target binding requires ${field}`);
  if (target.hostId !== "local" || !path.isAbsolute(target.projectPath) || !path.isAbsolute(target.cwd))
    throw new Error("A verified target binding requires a local host and absolute project and working directories");
}

export function assertLocalThread(threadId, thread) {
  if (!thread || thread.id !== threadId || (thread.kind && thread.kind !== "codex") || (thread.hostId && thread.hostId !== "local"))
    throw new Error("The local execution chat identity was not confirmed");
}

export async function resolveTarget(threadId, { callApp = defaultCallApp, projects, threads, expected, verifiedProject, createdThreadId } = {}) {
  if (expected?.threadId && threadId !== expected.threadId) throw new Error("Execution target threadId does not match its binding");
  const [projectList, threadList, view] = await Promise.all([
    projects ?? callApp("list_projects", {}).then((result) => result.projects ?? []),
    threads ?? callApp("list_threads", { limit: MAX_RECENT_THREADS }).then((result) => [...(result.pinnedThreads ?? []), ...(result.threads ?? [])]),
    callApp("read_thread", { threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }),
  ]);
  const thread = view?.thread;
  assertLocalThread(threadId, thread);
  if (!thread.cwd || !path.isAbsolute(thread.cwd)) throw new Error("The execution chat working directory was not confirmed");
  const listed = threadList.filter((item) => item.id === threadId);
  if (listed.some((item) => item.kind !== "codex" || (item.hostId && item.hostId !== "local")))
    throw new Error("The listed local execution chat identity is inconsistent");
  if (listed.some((item) => item.cwd && !samePath(item.cwd, thread.cwd)))
    throw new Error("The execution chat working directory metadata is inconsistent; retry inspection");
  const memberships = [...new Set([thread.projectId, ...listed.map((item) => item.projectId)].filter(Boolean))];
  if (memberships.length > 1) throw new Error("The execution chat project metadata is inconsistent; retry inspection");
  // Recent listings are partial. An already verified binding remains usable when
  // read_thread confirms its exact ID/cwd but omits project membership.
  if (!memberships.length && expected?.threadId && expected?.projectId && expected?.projectPath && expected?.cwd) {
    assertTarget({ threadId: expected.threadId, cwd: expected.cwd }, { threadId, cwd: thread.cwd });
    memberships.push(expected.projectId);
  }
  // An exact creation result links this new ID to the verified project request.
  // This internal evidence is never inferred for an ordinary takeover/reply.
  if (!memberships.length && createdThreadId === threadId && verifiedProject?.projectId && path.isAbsolute(verifiedProject.path))
    memberships.push(verifiedProject.projectId);
  if (expected?.projectId && memberships.length && expected.projectId !== memberships[0])
    throw new Error("Execution target projectId does not match its binding");
  const verifiedThreads = [{ ...thread, kind: "codex", projectId: memberships[0] }];
  const discovery = { callApp, projects: projectList, threads: threadList, verifiedThreads, binding: expected, verifiedProject };
  if (expected?.projectPath && !expected.projectId) {
    const intended = await discoverProject({ projectPath: expected.projectPath }, discovery);
    expected = { ...expected, projectId: intended.projectId };
  }
  let project;
  try {
    project = await discoverProject(memberships.length
      ? { projectId: memberships[0], projectPath: expected?.projectPath }
      : { projectPath: thread.cwd }, discovery);
  } catch (error) { throw new Error(`The execution chat project could not be confirmed: ${error.message}`); }
  const target = { threadId, hostId: "local", title: thread.title ?? listed[0]?.title ?? null,
    projectId: project.projectId, projectPath: project.path, cwd: thread.cwd };
  validateTarget(target);
  assertTarget(expected, target);
  return target;
}
