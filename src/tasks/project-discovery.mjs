import path from "node:path";
import fs from "node:fs";

export function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/^\\\\\?\\/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

const local = (item) => !item.hostId || item.hostId === "local";
const absolute = (value) => typeof value === "string" && path.isAbsolute(value);

// A linked worktree has its own gitdir and points at a shared commondir.
// Do not infer this from folder names or mistake a submodule's gitfile for it.
function linkedWorktree(directory) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error("The existing chat directory is unavailable; its project root could not be verified");
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const marker = path.join(current, ".git");
    const entry = fs.statSync(marker, { throwIfNoEntry: false });
    if (entry?.isDirectory()) return false;
    if (entry?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/.exec(fs.readFileSync(marker, "utf8"));
      if (!pointer) throw new Error("The workspace Git directory could not be verified");
      const gitdir = path.resolve(current, pointer[1]);
      if (!fs.statSync(gitdir, { throwIfNoEntry: false })?.isDirectory())
        throw new Error("The workspace Git directory is unavailable; its project root could not be verified");
      let common;
      try { common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim(); }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
      if (!common) throw new Error("The workspace Git common directory could not be verified");
      return !samePath(gitdir, path.resolve(gitdir, common));
    }
    if (path.dirname(current) === current) return false;
  }
}

// list_projects can omit a real project still identified by existing local chats.
// Recover only the requested association, never a recent chat chosen as a substitute.
export async function discoverProject({ projectId, projectPath }, {
  callApp, projects, threads, verifiedThreads = [], binding, verifiedProject, threadLimit = 50,
} = {}) {
  if (!projectId && !projectPath) throw new Error("Pass projectPath or projectId");
  if (projectPath && !absolute(projectPath)) throw new Error("projectPath must be absolute");
  projects ??= (await callApp("list_projects", {})).projects ?? [];
  const catalogue = projects.filter(local);
  const matches = catalogue.filter((project) => projectId ? project.projectId === projectId : samePath(project.path, projectPath));
  if (matches.length > 1) throw new Error("The project selection is ambiguous; specify an exact projectId");
  if (matches.length === 1) {
    const project = matches[0];
    if (!absolute(project.path)) throw new Error("The selected local Codex project has no absolute working directory");
    if (projectPath && !samePath(project.path, projectPath)) throw new Error("The registered project path conflicts with the expected project path");
    return project;
  }
  // A verified setup/creation receipt owns its original root independently of
  // partial discovery lists. Caller assertions alone must not enter this path.
  if (verifiedProject && absolute(verifiedProject.path) && verifiedProject.projectId && local(verifiedProject) &&
    (!projectId || verifiedProject.projectId === projectId) && (!projectPath || samePath(verifiedProject.path, projectPath))) {
    if (catalogue.some((project) => samePath(project.path, verifiedProject.path) && project.projectId !== verifiedProject.projectId))
      throw new Error("The saved project conflicts with the project registered at this path");
    return verifiedProject;
  }
  if (!threads) {
    const listed = await callApp("list_threads", { limit: threadLimit });
    threads = [...(listed.pinnedThreads ?? []), ...(listed.threads ?? [])];
  }
  const known = verifiedThreads.filter((thread) => thread.kind === "codex" && local(thread));
  const relevant = (thread) => (!projectId || !thread.projectId || thread.projectId === projectId) &&
    (!projectPath || !thread.cwd || samePath(thread.cwd, projectPath) ||
      (binding?.threadId === thread.id && samePath(binding.projectPath, projectPath)));
  const candidates = threads.filter((thread) => thread.kind === "codex" && local(thread) && relevant(thread));
  if (binding?.threadId && binding.hostId === "local" && binding.projectId && absolute(binding.projectPath) && absolute(binding.cwd)) {
    // Filtering to the intended project must not hide a changed binding in the listing.
    for (const row of threads.filter((thread) => thread.id === binding.threadId)) {
      if (row.kind !== "codex" || !local(row) || (row.projectId && row.projectId !== binding.projectId) ||
        (row.cwd && !samePath(row.cwd, binding.cwd)))
        throw new Error("The bound chat project or directory metadata is inconsistent; retry inspection");
    }
    const saved = { id: binding.threadId, kind: "codex", hostId: "local", projectId: binding.projectId, cwd: binding.cwd };
    if (relevant(saved)) candidates.push(saved);
  }
  const rows = new Map();
  for (const row of [...candidates, ...known.filter(relevant)]) {
    const previous = rows.get(row.id);
    if (previous && ((previous.projectId && row.projectId && previous.projectId !== row.projectId) ||
      (previous.cwd && row.cwd && !samePath(previous.cwd, row.cwd))))
      throw new Error("The existing chat project or directory metadata is inconsistent; retry inspection");
    rows.set(row.id, { ...previous, ...row, projectId: row.projectId || previous?.projectId, cwd: row.cwd || previous?.cwd });
  }
  const evidence = [];
  let worktreeWithoutRoot = false;
  for (const row of rows.values()) {
    let thread = known.find((item) => item.id === row.id);
    const required = Boolean(thread) || row.id === binding?.threadId || (projectId && row.projectId === projectId) ||
      (projectPath && samePath(row.cwd, projectPath));
    if (!thread) {
      try { thread = (await callApp("read_thread", { threadId: row.id, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }))?.thread; }
      catch (error) { if (required) throw error; continue; }
    }
    // A partial unrelated recent row is only a discovery candidate. Its absence
    // cannot invalidate exact evidence; conflicts about an identified member can.
    if (!required && !thread) continue;
    if (!thread || thread.id !== row.id || !local(thread) || (thread.kind && thread.kind !== "codex"))
      throw new Error("The existing local chat identity was not confirmed");
    if (!required && !(projectId ? thread.projectId === projectId : samePath(thread.cwd, projectPath))) continue;
    if (!absolute(thread.cwd) || (row.cwd && !samePath(row.cwd, thread.cwd)))
      throw new Error("The existing chat directory was not confirmed or changed during discovery");
    if (thread.projectId && row.projectId && thread.projectId !== row.projectId)
      throw new Error("The existing chat project metadata is inconsistent; retry inspection");
    const membership = row.projectId ?? thread.projectId;
    if (!membership || (projectId && membership !== projectId)) continue;
    if (projectPath && !samePath(thread.cwd, projectPath) &&
      !(binding?.threadId === row.id && binding.projectId === membership && samePath(binding.projectPath, projectPath) && samePath(binding.cwd, thread.cwd))) continue;
    const boundWorkspace = binding?.threadId === row.id && binding.hostId === "local" && binding.projectId === membership &&
      absolute(binding.projectPath) && samePath(binding.cwd, thread.cwd);
    if (!boundWorkspace && linkedWorktree(thread.cwd)) {
      worktreeWithoutRoot = true;
      continue;
    }
    const workspace = boundWorkspace ? binding.projectPath : thread.cwd;
    if (!absolute(workspace)) throw new Error("The existing chat has no verified project directory");
    // A known catalogue entry is authoritative about its root. A worktree cwd
    // must not be reinterpreted as a second root when its real project is listed.
    if (catalogue.some((project) => project.projectId === membership && !samePath(project.path, workspace)))
      throw new Error("The chat workspace differs from its registered project path; select its projectId and assert expectedCwd instead");
    evidence.push({ projectId: membership, path: workspace, threadId: row.id });
  }
  const identities = [];
  for (const entry of evidence)
    if (!identities.some((item) => item.projectId === entry.projectId && samePath(item.path, entry.path))) identities.push(entry);
  if (identities.length !== 1)
    throw new Error(identities.length ? "The existing chat project directory is ambiguous; specify the intended projectPath"
      : worktreeWithoutRoot ? "A worktree cwd cannot establish the project root; verify the original project directory or use its saved target binding"
      : "The project could not be confirmed from the catalogue or existing local chats");
  const selected = identities[0];
  if (catalogue.some((project) => project.projectId !== selected.projectId && samePath(project.path, selected.path)))
    throw new Error("The existing chat project conflicts with the project registered at this path");
  return { projectId: selected.projectId, path: selected.path, label: path.basename(selected.path), hostId: "local",
    discovery: { source: "existingThreads", threadIds: evidence.map((entry) => entry.threadId) } };
}
