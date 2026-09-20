# Review First runtime tool containment

**Status:** decision support for `Define Review First Agent Runtime tool authority and containment`

**Date:** 2026-08-17

**Scope:** local ACP Agent Runtimes, Codex through `codex-acp`, and OpenHands as implementation prior art

## Question

Can Kestrel constrain native Agent Runtime tools when the upstream agent owns its harness, and how does OpenHands do so?

## Executive finding

The model does not contain or execute the harness. In the selected local path, Kestrel starts an ACP server process; [`codex-acp`](https://github.com/agentclientprotocol/codex-acp/blob/97d260e3d9314d95347e50ab35ea22800546298d/README.md) starts Codex App Server, and that local runtime executes tools and talks to the remote model. Kestrel can therefore contain the process and its descendants even though it cannot normalize or disable every native tool through ACP.

ACP is an interoperability and permission-mediation protocol, not a sandbox. Its [architecture](https://agentclientprotocol.com/get-started/architecture) assumes a client starts an agent subprocess and may answer permission requests, while agents may own tools and connect directly to supplied MCP servers. A compliant server is not thereby proven to route every effect through client filesystem, terminal, or permission methods.

The durable rule for Kestrel is consequently **authority below the runtime, observability through the runtime**. ACP and vendor permission settings supply configuration, UX, and audit signals. Filesystem mounts, process isolation, resource limits, network policy, and credential brokers determine what can actually happen.

## What can be limited

| Layer | What it can control | Security role |
| --- | --- | --- |
| Prompt, instructions, advertised tool list | What the model is asked or encouraged to do | Soft behavior only |
| ACP permission response | A tool request that the particular server elects to expose | Mediation and audit; not a universal containment boundary |
| Codex permission/sandbox profile | Codex command, filesystem, network, web-search, MCP, and approval behavior | Valuable runtime-specific enforcement and defense in depth |
| Kestrel-owned OS/container/VM boundary | Visible mounts, writable locations, processes, syscalls, CPU/RAM/disk, network routes and sockets | Authoritative effective authority |
| Kestrel brokers | Narrow access to Model Provider, dependencies, artifacts, or other services without handing broad credentials to the workload | Authoritative when the workload cannot reach the credential or an alternate route |

Codex exposes materially useful controls. The [App Server protocol](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/app-server/README.md) supports managed permission profiles, allowed approval/sandbox/web-search modes, network-domain constraints, command and filesystem/network approvals, and an `externalSandbox` mode for hosts that enforce containment themselves. `codex-acp` exposes sandbox and approval configuration plus shell, file, permission, MCP, web-search and other native events. These controls must be pinned and conformance-tested for an exact runtime profile; they do not establish a cross-agent guarantee by themselves.

If an agent harness instead runs inside an opaque remote service, Kestrel cannot impose these local process controls. Such a service needs its own verifiable remote authority contract and is not equivalent to the selected local ACP subprocess boundary.

## How OpenHands handles it

OpenHands has two materially different paths:

1. Its built-in Agent supports confirmation policies and security analyzers before OpenHands-owned actions execute. The [security guide](https://docs.openhands.dev/sdk/guides/security) offers always-confirm, never-confirm and risk-based policies. These policies mediate actions visible to that agent stack; they are not an OS sandbox.
2. Its [`ACPAgent`](https://docs.openhands.dev/sdk/guides/agent-acp) delegates the model, tools and execution to the ACP server. OpenHands documents that permission requests are automatically approved. The implementation confirms that [`request_permission` selects the first option](https://github.com/OpenHands/software-agent-sdk/blob/b56221283f74dbced26d1da134ded26860bb4f14/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1445-L1462), while its client filesystem and terminal methods are deliberately unimplemented because the ACP server handles them itself.

OpenHands can place the complete agent server and ACP subprocess in a remote or Docker workspace. This follows the same sound containment direction: its [runtime architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime) executes actions in a container instead of on the host. It does not make ACP permission auto-approval a fail-closed boundary. The current [`DockerWorkspace` launch](https://github.com/OpenHands/software-agent-sdk/blob/b56221283f74dbced26d1da134ded26860bb4f14/openhands-workspace/openhands/workspace/docker/workspace.py) also does not select Docker's `none` network by default, so deny-by-default egress would require additional deployment policy.

OpenHands injects configured secrets into the ACP subprocess environment and masks them if echoed. That is useful output hygiene but gives the subprocess the credential. Kestrel's Review First contract requires a narrower design for credentials that must not be reachable by review tools or repository code.

## Consequence for Kestrel

Kestrel does not need to guarantee that every native tool disappears. It needs to guarantee that native tools have only the authority granted by the exact Review First profile:

- the retained Review Revision remains immutable and is exposed read-only for autonomous inspection;
- registered unit and local regression checks run against a disposable copy through the Operator-owned, versioned Verification Profile;
- verification runs offline, without Kestrel, Repository Provider, or model credentials;
- the Agent Runtime's required model channel is distinct from general tool egress;
- any direct web, MCP, provider-write, host, control-plane, credential, or unregistered execution attempt is denied below ACP and audited;
- a runtime profile is supported only after canary-based conformance proves those limits, including attempts that bypass ACP permission requests.

For Codex, its native sandbox and permission profile can implement part of this separation, but Kestrel still needs an outer disposable workload boundary. If the selected Codex/ACP version cannot prove that tool descendants are unable to reach subscription credentials or general network paths, that profile must fail closed rather than be certified for private Review First.

## Sources checked

- [ACP architecture](https://agentclientprotocol.com/get-started/architecture)
- [`codex-acp` README at the checked revision](https://github.com/agentclientprotocol/codex-acp/blob/97d260e3d9314d95347e50ab35ea22800546298d/README.md)
- [Codex App Server protocol at the checked revision](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/app-server/README.md)
- [OpenHands ACPAgent guide](https://docs.openhands.dev/sdk/guides/agent-acp)
- [OpenHands ACPAgent implementation at the checked revision](https://github.com/OpenHands/software-agent-sdk/blob/b56221283f74dbced26d1da134ded26860bb4f14/openhands-sdk/openhands/sdk/agent/acp_agent.py)
- [OpenHands security guide](https://docs.openhands.dev/sdk/guides/security)
- [OpenHands runtime architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime)
- [OpenHands DockerWorkspace implementation at the checked revision](https://github.com/OpenHands/software-agent-sdk/blob/b56221283f74dbced26d1da134ded26860bb4f14/openhands-workspace/openhands/workspace/docker/workspace.py)
