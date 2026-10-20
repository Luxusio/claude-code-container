import { SSH_KNOWN_HOSTS_PROVENANCE_SCRIPT } from "../../ssh-known-hosts.js";
import type { SshCredentialCopyFailureStage } from "../../ports/credentials/host-refresh.js";

export const SSH_CREDENTIAL_COPY_FAILURE_STAGES: Readonly<Partial<Record<number, SshCredentialCopyFailureStage>>> = Object.freeze({
    11: "staging",
    12: "archive-create",
    13: "archive-read",
    14: "extract",
    15: "permissions",
    16: "known-hosts",
    17: "completion",
    18: "publication",
});

export function gitSigningKeyRewriteShell(): string {
    return [
        "config_path=$1",
        "host_ssh_root=$2",
        "copied_ssh_root=$3",
        "signing_keys=$(git config --file \"$config_path\" --get-all user.signingkey 2>/dev/null || true)",
        "signing_key_count=$(printf '%s\\n' \"$signing_keys\" | sed '/^$/d' | wc -l | tr -d ' ')",
        "if [ \"$signing_key_count\" = 1 ]; then",
        "  normalized_signing_key=$(printf '%s' \"$signing_keys\" | tr '\\\\' '/')",
        "  key_name=${normalized_signing_key##*/}",
        "  case \"$key_name\" in",
        "    id_rsa|id_ed25519|id_ecdsa|id_dsa|id_ed25519_sk|id_ecdsa_sk)",
        "      expected_signing_key=$host_ssh_root/$key_name",
        "      copied_signing_key=$copied_ssh_root/$key_name",
        "      if [ -f \"$copied_ssh_root/.ccc-copy-complete\" ] && [ ! -L \"$copied_ssh_root/.ccc-copy-complete\" ] && [ \"$normalized_signing_key\" = \"$expected_signing_key\" ] && [ -f \"$copied_signing_key\" ] && [ ! -L \"$copied_signing_key\" ]; then",
        "        git config --file \"$config_path\" --replace-all user.signingkey \"$copied_signing_key\"",
        "      fi",
        "      ;;",
        "  esac",
        "fi",
    ].join("\n");
}

export function sshCredentialCopyShell(privilegedRead = false): string {
    return [
        "source_ssh_root=$1",
        "copied_ssh_root=$2",
        "copy_parent=${copied_ssh_root%/*}",
        "copy_name=${copied_ssh_root##*/}",
        "copy_stage=$copy_parent/.${copy_name}.next.$$",
        "copy_previous=$copy_parent/.${copy_name}.previous.$$",
        "prepare_copy_directories() {",
        "  if [ -d \"$1\" ] && [ ! -L \"$1\" ]; then",
        // Apply chmod before descent; the batched false arm preserves chmod failures in find's status.
        "    find -P \"$1\" -type d ! -exec chmod 700 {} \\; -exec false {} +",
        "  fi",
        "}",
        "remove_copy_paths() {",
        "  for copy_managed_path do prepare_copy_directories \"$copy_managed_path\" || :; done",
        "  rm -rf -- \"$@\"",
        "}",
        "fail_copy() {",
        "  remove_copy_paths \"$copy_stage\" \"$copied_ssh_root\" \"$copy_previous\"",
        "  exit \"$1\"",
        "}",
        "remove_copy_paths \"$copy_stage\" \"$copy_previous\" || fail_copy 11",
        "if [ ! -d \"$source_ssh_root\" ] || [ -L \"$source_ssh_root\" ]; then",
        "  remove_copy_paths \"$copied_ssh_root\" || fail_copy 11",
        "  exit 0",
        "fi",
        "umask 077",
        "mkdir \"$copy_stage\" || fail_copy 11",
        ...(privilegedRead ? [
            "copy_archive=$(mktemp \"$copy_parent/.ccc-ssh-archive.XXXXXX\") || fail_copy 12",
            "trap 'rm -f -- \"$copy_archive\"' EXIT",
            // Elevate only source reads. The caller owns the archive and extracts as ccc.
            "sudo -n tar -C \"$source_ssh_root\" -cf - . > \"$copy_archive\" || fail_copy 13",
            "tar --no-same-owner --no-same-permissions -xf \"$copy_archive\" -C \"$copy_stage\" || fail_copy 14",
        ] : ["cp -R \"$source_ssh_root\"/. \"$copy_stage\"/ || fail_copy 14"]),
        "if ! prepare_copy_directories \"$copy_stage\" || ! find -P \"$copy_stage\" -type f -exec chmod 600 {} + || ! find -P \"$copy_stage\" -type f -name '*.pub' -exec chmod 644 {} +; then",
        "  fail_copy 15",
        "fi",
        "if ! /usr/bin/python3 -I - \"$copied_ssh_root\" \"$copy_stage\" <<'CCC_KNOWN_HOSTS'",
        SSH_KNOWN_HOSTS_PROVENANCE_SCRIPT,
        "CCC_KNOWN_HOSTS",
        "then fail_copy 16; fi",
        "if [ -f \"$copy_stage/known_hosts\" ] && [ ! -L \"$copy_stage/known_hosts\" ] && ! chmod 644 \"$copy_stage/known_hosts\"; then",
        "  fail_copy 15",
        "fi",
        "if ! rm -f -- \"$copy_stage/.ccc-copy-complete\" || ! printf '%s\\n' complete > \"$copy_stage/.ccc-copy-complete\" || ! chmod 600 \"$copy_stage/.ccc-copy-complete\"; then",
        "  fail_copy 17",
        "fi",
        "if [ -e \"$copied_ssh_root\" ] || [ -L \"$copied_ssh_root\" ]; then",
        "  if ! mv \"$copied_ssh_root\" \"$copy_previous\"; then",
        "    fail_copy 18",
        "  fi",
        "fi",
        "if mv \"$copy_stage\" \"$copied_ssh_root\"; then",
        "  remove_copy_paths \"$copy_previous\" || fail_copy 18",
        "  exit 0",
        "fi",
        "fail_copy 18",
    ].join("\n");
}

