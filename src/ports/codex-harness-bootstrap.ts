/** Python native contract: raw observations and mechanisms, never classified probe. */
export const CODEX_HARNESS_PORTS_SOURCE = String.raw`
class CodexBootstrapPorts:
    read_configuration: object
    unregistered_payload_present: object
    marketplace_paths: object
    read_plugin_manifest: object
    cache_payloads: object
    command_available: object
    declared_payload_available: object
    required_payload_available: object
    read_installed_hooks: object
    installation_workspace: object
    initialize_repository: object
    fetch_pinned_revision: object
    fetched_revision: object
    checkout_fetched_revision: object
    install_codex: object
    restore_interpreter: object
    installer_home: object
    report_installing: object
    report_failure: object
    exit_failure: object
`;
