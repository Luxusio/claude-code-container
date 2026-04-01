# Frontend Refactor Review Overlay
summary: Domain-specific frontend/UI checks activated when component or architecture signals are detected.
type: review-overlay

## Required checks

| Area | What to verify |
|------|---------------|
| Component boundary | Single responsibility, clear interface contracts |
| State ownership | State placement, ownership clarity, prop drilling avoidance |
| UI states | Loading, error, and empty state handling |
| Accessibility | Keyboard navigation, semantic HTML, ARIA attributes |
| Type safety | Typed boundaries, data contracts between components |
| Dependencies | Dependency direction, coupling, cohesion assessment |
| Side effects | Effect isolation, cleanup, testability |
| Abstraction | Over-abstraction prevention, pragmatic simplicity |

## Trigger signals

- Prompt keywords: component, ui, layout, hook, state, a11y, responsive, refactor, architecture, dependency, render, css, style
- Touched paths: app/, pages/, components/, src/ui/, src/components/, hooks/, stores/, layouts/
- Lane = refactor with frontend files
