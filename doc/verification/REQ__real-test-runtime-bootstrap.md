# Real-test runtime bootstrap

The test-level CLI and durability helpers must initialize the existing repository TypeScript loader before loading their TypeScript dependencies. They must run on supported Node releases without requiring experimental type stripping or relying on native TypeScript support. The declared minimum Node engine remains unchanged. CLI output, selected levels, supervision deadlines and failure exit codes remain unchanged.

Source and emitted broker fixtures must accept native platform paths as Node file URLs and may observe their own process identity while retaining denials of real provider mutations and foreign process signaling. Portable path assertions compare native resolved paths. Controlled Hyper-V fixtures provide the required finite network observations; they must not invoke real network commands to fill a missing test port.

Verify the existing complete lifecycle-race, test-level-runner and durability self-test suites on Linux and native Windows, using configured source-loading commands and controlled providers. Default command acceptance must not be replaced by a type-stripping flag, a filtered case set or weaker ownership assertions.
