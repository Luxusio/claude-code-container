import { invoke } from "@tauri-apps/api/core";

interface WelcomeProps {
  onOpen: (path: string) => void;
}

export function Welcome({ onOpen }: WelcomeProps) {
  const handleClick = async () => {
    try {
      const folder = await invoke<string | null>("cmd_pick_folder");
      if (folder) onOpen(folder);
    } catch (err) {
      console.error("Failed to pick folder:", err);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome__inner">
        {/* Logo */}
        <div className="welcome__logo-wrap">
          <div className="welcome__logo">cc</div>
          <div className="welcome__logo-ring" />
          <div className="welcome__logo-ring-2" />
        </div>

        {/* Title */}
        <h1 className="welcome__title">ccc</h1>
        <p className="welcome__subtitle">claude code container</p>

        {/* CTA */}
        <div className="welcome__cta">
          <button className="welcome__open-btn" onClick={handleClick}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6h12M6 2H2a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1V6a1 1 0 00-1-1H9L7 2H2z"/>
            </svg>
            Open Project Folder
          </button>
          <span className="welcome__kbd-hint">or press + in the tab bar</span>
        </div>

        {/* Feature grid */}
        <div className="welcome__features">
          <FeatureCard
            icon={
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="4" width="14" height="10" rx="1.5"/>
                <path d="M4 4V3a1 1 0 011-1h6a1 1 0 011 1v1"/>
                <path d="M8 8v3M6 9.5h4" strokeLinecap="round"/>
              </svg>
            }
            label="Isolated"
            desc="per-project Docker container"
          />
          <FeatureCard
            icon={
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6"/>
                <path d="M8 5v3l2 2" strokeLinecap="round"/>
              </svg>
            }
            label="Sessions"
            desc="resume any past claude session"
          />
          <FeatureCard
            icon={
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="3" width="14" height="10" rx="1.5"/>
                <path d="M1 6h14" strokeLinecap="round"/>
                <path d="M5 6v7M10 6v7" strokeLinecap="round" strokeOpacity="0.4"/>
              </svg>
            }
            label="Tabs"
            desc="multiple projects side by side"
          />
          <FeatureCard
            icon={
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 1L10.5 6h5L11.5 9.5l2 5L8 11.5 2.5 14.5l2-5L.5 6h5z" strokeLinejoin="round"/>
              </svg>
            }
            label="mise"
            desc="auto tool version management"
          />
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  label,
  desc,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
}) {
  return (
    <div className="welcome__feature">
      <span className="welcome__feature-icon">{icon}</span>
      <div>
        <span className="welcome__feature-label">{label}</span>
        <span className="welcome__feature-text">{desc}</span>
      </div>
    </div>
  );
}
