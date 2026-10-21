# Shared Codex command facts

Derived from the existing [clipboard attachment requirement](../common/REQ__clipboard-image-bridge.md)
and [local resume policy](GUIDE__codex-resume.md): command classification must
agree across CCC's existing domain consumers without widening launch or recovery
eligibility.

Keep the repository's ordered Codex subcommands and value-bearing options in the
existing pure tool registry. Expose narrow internal classification predicates;
do not expose a mutable shared collection. Each default catalog receives its own
subcommand array. Mutating one catalog must not change another or canonical facts.

Clipboard attachment excludes all existing canonical subcommands, including
`e`, `a`, `plugin`, `remote-control`, `update` and `exec-server`, before image read,
directory creation or file write. A preceding option's value is not a command.
`--local-provider ollama` keeps its adjacent value; an eligible interactive image
is inserted before the actual prompt, or with the existing default prompt.
Preserve explicit-image exclusion and caller arguments.

Launch shares the value-option facts while retaining its current boolean,
configuration, profile and administrative/remote/unknown-command policies.
Resume shares lexical facts with explicit local exclusions for `-i`/`--image`,
`-p`/`--profile`, and `-C`/`--cd`. Remote, extra-prompt and missing-value requests
remain ineligible. Fact sharing does not authorize a different profile or working
directory, or replay an image/prompt during recovery.

Use the four existing domain modules. No generic parser, registry, application
port, public facade field, dependency or build configuration is needed. Existing
metadata for other tools remains unchanged; this work adds no support for them.
The relocated resume fixture must include the existing emitted registry and its
pure tool-layout dependency. All-dist packaging already ships those modules.

Verify the six administrative exclusions without clipboard effects, value
adjacency and interactive attachment, fresh catalog independence, unchanged launch
policy and narrower resume admission. Use the existing five behavior/distribution
owners plus affected public consumers, actual strict inclusion, current compiled
and relocated/bundled artifacts. Do not add source-shape or frozen-implementation
comparison tests. Native clipboard, CODEX_HOME migration and upstream Codex service
behavior are separate acceptance work.
