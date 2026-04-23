import { invoke } from "@tauri-apps/api/core";
import { useProjectStore, type Project } from "../store/projects";
import { useSessionStore } from "../store/sessions";
import { useTabStore } from "../store/tabs";
import { SessionHistory } from "./SessionHistory";

interface ProjectExplorerProps {
  onCloseProjectSessions: (projectPath: string) => Promise<void>;
}

export function ProjectExplorer({ onCloseProjectSessions }: ProjectExplorerProps) {
  const { projects, expandedProjectIds, toggleExpanded, addProject, removeProject } =
    useProjectStore();
  const { addSession, setActiveSession } = useSessionStore();
  const { openTab } = useTabStore();

  const handleAddProject = async () => {
    try {
      const folder = await invoke<string | null>("cmd_pick_folder");
      if (folder) {
        const proj = addProject(folder);
        if (proj) useProjectStore.getState().setExpanded(proj.id, true);
      }
    } catch (err) {
      console.error("Pick folder failed", err);
    }
  };

  const handleNewSession = (project: Project) => {
    const id = crypto.randomUUID();
    addSession({
      id,
      projectPath: project.path,
      title: project.name,
      archived: false,
      createdAt: Date.now(),
    });
    openTab({ kind: "terminal", label: project.name, sessionId: id }, true);
    setActiveSession(id);
  };

  const handleRemoveProject = async (project: Project) => {
    const ok = window.confirm(
      `Remove project "${project.name}" from sidebar?\nAll its open sessions will be closed (container stays).`
    );
    if (!ok) return;
    await onCloseProjectSessions(project.path);
    removeProject(project.id);
  };

  return (
    <div className="sidebar project-explorer">
      <div className="project-explorer__header">
        <span>Projects</span>
        <button
          className="sidebar-new-session-btn"
          onClick={handleAddProject}
          title="Add project"
        >
          +
        </button>
      </div>

      <div className="project-explorer__list">
        {projects.length === 0 && (
          <div className="project-explorer__empty">
            No projects yet.<br />Click <b>+</b> to add one.
          </div>
        )}
        {projects.map((project) => {
          const expanded = expandedProjectIds.has(project.id);
          return (
            <div key={project.id} className="project-node">
              <div
                className="project-node__row"
                onClick={() => toggleExpanded(project.id)}
                title={project.path}
              >
                <span className={`chevron${expanded ? " open" : ""}`}>›</span>
                <span className="project-node__name">{project.name}</span>
                <button
                  className="project-node__action"
                  title="New session"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNewSession(project);
                  }}
                >
                  +
                </button>
                <button
                  className="project-node__action project-node__action--danger"
                  title="Remove project"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveProject(project);
                  }}
                >
                  ✕
                </button>
              </div>
              {expanded && (
                <div className="project-node__children">
                  <SessionHistory projectPath={project.path} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
