import { describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ContainerPanel, type SidecarCaller } from "../ContainerPanel";

function makeCaller(overrides: Partial<Record<string, unknown>> = {}): SidecarCaller {
  const fn = vi.fn(async (req: { cmd: string; name?: string }) => {
    if (req.cmd === "list_containers") {
      return (
        overrides.list_containers ?? {
          ok: true,
          data: [
            { name: "ccc-one", status: "Up 2 hours", id: "abc123" },
            { name: "ccc-two", status: "Exited (0)", id: "def456" },
          ],
        }
      );
    }
    if (req.cmd === "stop_container") return overrides.stop_container ?? { ok: true };
    if (req.cmd === "remove_container") return overrides.remove_container ?? { ok: true };
    return { ok: false, error: "unknown" };
  });
  return fn as unknown as SidecarCaller;
}

describe("ContainerPanel", () => {
  it("renders a row per container returned by the sidecar", async () => {
    render(<ContainerPanel caller={makeCaller()} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("container-row")).toHaveLength(2);
    });
    expect(screen.getByText("ccc-one")).toBeTruthy();
    expect(screen.getByText("Up 2 hours")).toBeTruthy();
  });

  it("shows an empty state when the sidecar returns no containers", async () => {
    const caller = makeCaller({ list_containers: { ok: true, data: [] } });
    render(<ContainerPanel caller={caller} />);
    await waitFor(() => {
      expect(screen.getByText(/No ccc containers/)).toBeTruthy();
    });
  });

  it("surfaces an error from the sidecar in an alert", async () => {
    const caller = makeCaller({ list_containers: { ok: false, error: "docker: command not found" } });
    render(<ContainerPanel caller={caller} />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("docker: command not found");
    });
  });

  it("Stop button dispatches stop_container and refreshes", async () => {
    const caller = vi.fn(async (req: { cmd: string; name?: string }) => {
      if (req.cmd === "list_containers") {
        return {
          ok: true,
          data: [{ name: "ccc-one", status: "Up", id: "abc" }],
        };
      }
      return { ok: true };
    });
    render(<ContainerPanel caller={caller as unknown as SidecarCaller} />);
    await waitFor(() => expect(screen.getAllByTestId("container-row")).toHaveLength(1));
    await act(async () => {
      screen.getByLabelText("Stop ccc-one").click();
    });
    const stopCall = caller.mock.calls.find(([req]) => req.cmd === "stop_container");
    expect(stopCall?.[0]).toEqual({ cmd: "stop_container", name: "ccc-one" });
  });
});
