import { invoke } from "@tauri-apps/api/core";

interface ProjectPickerProps {
  onSelect: (path: string) => void;
  label?: string;
}

export function ProjectPicker({ onSelect, label = "Open Project" }: ProjectPickerProps) {
  const handleClick = async () => {
    try {
      const folder = await invoke<string | null>("cmd_pick_folder");
      if (folder) {
        onSelect(folder);
      }
    } catch (err) {
      console.error("Failed to pick folder:", err);
    }
  };

  return (
    <button
      onClick={handleClick}
      style={{
        background: "#007acc",
        border: "none",
        color: "#fff",
        cursor: "pointer",
        padding: "8px 16px",
        borderRadius: "4px",
        fontSize: "13px",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}
