export interface BrokerOwnerRepositoryPorts {
    withLock<T>(ownerId: string, stateKey: string, operation: () => T): T;
    read(ownerId: string, stateKey: string): unknown[];
    validate(devices: unknown[]): undefined;
    publish(ownerId: string, stateKey: string, devices: unknown[]): undefined;
    equal(left: unknown, right: unknown): boolean;
    timestamp(): string;
}
