// Legacy mutation suites exercise upstream write handlers in isolation. The
// production default remains read_only; dedicated hardening tests assert it.
process.env.MCP_MODE = "write";
