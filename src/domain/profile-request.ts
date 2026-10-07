// Profile request policy only; name validation and native layout stay with callers.
export const DEFAULT_PROFILE_NAME = "default";

/** `undefined`, an empty string and "default" mean the default profile. */
export function normalizeProfile(profile?: string): string | undefined {
    return profile && profile !== DEFAULT_PROFILE_NAME ? profile : undefined;
}
