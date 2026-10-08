/** Diagnostic values remain raw until terminal publication. */
export interface DoctorCheck {
    name: string;
    status: "ok" | "warn" | "error";
    message: string;
}

/** Structural native observations retain lazy property reads and object identity. */
export interface DoctorRuntimeInfo {
    runtime: string;
    version?: string | null;
    flavor: string;
}

export interface DoctorProbeResult {
    status: number | null;
    stdout?: string | null;
}
