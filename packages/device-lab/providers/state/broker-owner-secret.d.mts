export function readBrokerOwnerSecret(
    file: string,
    ownerId: string,
    onVerifiedDescriptor?: (descriptor: number) => void,
): string | null;
