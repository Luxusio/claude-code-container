# Scanner application and tool context

Version discovery, hint precedence and context formatting move into domain,
explicit observation ports, application and presentation modules. The public
scanner facade retains native reads/paths, shared-ignore snapshot and positional
defaults. Matching build, six focused suites (145 tests), five configured type
checks and scoped lint passed. One actual dual-payload verifier exercised compiled
core, parser/context bytes, native byte/depth boundaries and a single named
read failure in separate Node subprocesses, plus emitted declaration consumers.
Independent review and fresh full QA remain required. Baseline is accepted
delivery `52882d39`; its exact CI run `37624710150` passed all five jobs.

The first focused run exposed an incorrect CRLF fixture expectation. Running
the exact extractor from baseline `52882d39` confirmed that CRLF-terminated
`.tool-versions` lines are ignored while LF lines participate in precedence.
The corrected test preserves that behavior and separately asserts LF node/Python
precedence and input immutability. Production expressions are unchanged.

## Known ceiling

Windows backslash hint parsing, `.tool-versions` CRLF-line handling and stat/read replacement semantics remain
unchanged. No parser correction, AI launch or new native platform certification
is introduced. Other M11–M14 work remains incomplete.
