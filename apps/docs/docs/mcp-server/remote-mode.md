---
title: Remote (hosted) mode
sidebar_position: 8
---

# Remote (hosted) mode

The tool layer is transport-agnostic. `src/worker.js` provides the remote-specific
pieces (`buildMcpServer`, `staticTokenAuth`) so the same tools can later be mounted
as an HTTP route on the existing Worker (`apps/api`) for clients like claude.ai —
the recommended bridge there is the Agents SDK `McpAgent`. Wiring that route is the
one remaining step; the local stdio server above is the supported path today.
