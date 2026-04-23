import { useEffect } from "react";
import { useSessionStore, useActiveProjectPath } from "./store/sessions";
import { useProjectStore } from "./store/projects";
import { ProjectExplorer } from "./components/ProjectExplorer";
import { FilePanel } from "./components/FilePanel";
import { SplitPane } from "./components/SplitPane";
import { Welcome } from "./components/Welcome";
import { usePty } from "./hooks/usePty";
import { useSessionEvents } from "./hooks/useSessionEvents";
import { useTabStore } from "./store/tabs";

function App() {
  useSessionEvents();
  const { sessions, removeSessionsForProject } = useSessionStore();
  const { rootPane } = useTabStore();
  const { closePty } = usePty();
  const { projects, hydrated, hydrate, addProject, setExpanded } = useProjectStore();
  const activeProjectPath = useActiveProjectPath();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const handleWelcomeOpen = async (path: string) => {
    const proj = addProject(path);
    if (proj) setExpanded(proj.id, true);
  };

  const handleCloseProjectSessions = async (projectPath: string) => {
    const ids = sessions.filter((s) => s.projectPath === projectPath).map((s) => s.id);
    await Promise.all(
      ids.map(async (id) => {
        try {
          await closePty(id);
        } catch {
          /* ignore */
        }
      })
    );
    removeSessionsForProject(projectPath);
  };

  if (!hydrated) {
    return <div className="app" />;
  }

  const showWelcome = projects.length === 0;

  return (
    <div className="app">
      <div className="main-area">
        {!showWelcome && (
          <ProjectExplorer onCloseProjectSessions={handleCloseProjectSessions} />
        )}

        <div className="terminal-area">
          {showWelcome ? (
            <Welcome onOpen={handleWelcomeOpen} />
          ) : (
            <SplitPane node={rootPane} />
          )}
        </div>

        {!showWelcome && activeProjectPath && (
          <FilePanel projectPath={activeProjectPath} />
        )}
      </div>
    </div>
  );
}

export default App;
