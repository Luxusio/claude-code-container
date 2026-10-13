# Native control file identity

Authentication, image use and owned artifact cleanup must accept a stable regular file or directory when its native identity can be proved on a supported host.

Pathname metadata alone does not grant authority. Opened handles must provide matching positive volume and exact bigint inode identities. A Windows pathname volume of zero requires independent read-only handle qualification and fresh pathname checks. Missing identity, replacement, links where forbidden, or a failed verification open must refuse the operation and preserve its artifacts.

Admit supported pathname kinds before opening, and use available nonblocking read-only flags to cover replacement between inspection and open. Revalidate the opened type and identity before reading. A writerless FIFO must not stall broker requests or retain a cleanup lock. Cleanup handles special entries through checked rename and unlink only, without opening them.

Authentication retains its bounded 4096-byte read, owner and secret validation, and directory admission. Host and MCP readers share this implementation. A valid credential remains stable across repeated authenticated requests; a rejected credential cannot dispatch an authenticated operation. Secret bytes are read only from the original validated descriptor.

Image copy and hashing retain single-link regular-file checks, size and byte bounds, hashes, exclusive destinations and deadlines. Verification handles close before compensation.

Owned directory cleanup retains atomic quarantine, containment, successor checks and symlink entry unlink-only behavior. Directory size and link counts may change during traversal; the qualified volume, inode and type must remain the same before removal.

Verification uses the existing broker authentication/routing, Hyper-V image and clone, and quarantine cleanup suites. Model missing pathname volume with actual file I/O and verify both success and identity/refusal cases. Execute the affected whole suites on native Windows; simulated syscall observations alone do not certify a host.
