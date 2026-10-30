# Windows clipboard format branch syntax

The generated Windows clipboard PowerShell must keep an `if` and its `elseif` in the same statement. Joining script fragments must not turn `elseif` into a separate command. Advertised PNG data supplied as a seekable stream, including a stream positioned at EOF, must execute the stream-copy branch and return the complete PNG.

Verify the generated command with an in-memory Windows IDataObject, not the user's clipboard. Native PowerShell execution must show the PNG target and original bytes, while an empty advertised stream still preserves text and produces a valid empty snapshot when appropriate.
