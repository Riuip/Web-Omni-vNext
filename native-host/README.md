# Web-Omni LAN native helper

The Windows helper is launched on demand through Chrome or Edge Native
Messaging. It opens a random private-network port, serves the bundled mobile
client and exposes an opaque WebSocket relay at `/v2/ws`. Relay frames remain
encrypted by protocol v2; the helper never receives the pairing key.

Install from PowerShell with the unpacked extension ID:

```powershell
.\install.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The default installer verifies the SHA-256 checksum of the bundled Windows
amd64 helper and copies it into the current user's LocalAppData folder. It does
not require Go. To audit and build the helper from source instead, run:

```powershell
.\install.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -BuildFromSource
```

Source builds use Windows amd64 with CGO disabled and `-H=windowsgui`, so
browser-initiated launches do not open a console window. Installation asks
before adding a Windows Firewall rule. If accepted,
the rule is limited to this executable, inbound TCP, the Private profile and
the local subnet. For unattended installation, select the policy explicitly:

```powershell
.\install.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -PrivateNetworkAccess Allow
.\install.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -PrivateNetworkAccess Skip
```

Creating or removing the firewall rule requires an elevated PowerShell window.
`uninstall.ps1` removes the host registration and binary, and asks whether to
remove the firewall rule. The helper exits after five minutes without a native
request or HTTP/WebSocket client; an open transfer connection prevents that
idle exit.

The extension invokes `com.webomni.lan` through its Native Messaging bridge.
Auto mode uses this helper when a private IPv4 address is reachable and falls
back to the configured HTTPS Pages client otherwise.
