# Security policy

## Credential boundary

The runtime snapshot catalog must contain packet data only. It must never contain Govee credentials, account tokens, API keys, usernames, device identifiers, Homebridge pairing data, or private IP addresses.

The snapshot importer reads the stock Homebridge Govee plugin's existing local session and sends it only to Govee account endpoints. It writes a sanitized catalog with owner-only permissions. Do not attach account caches, Homebridge configuration, snapshot catalogs, or debug logs containing identifiers to public issues.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's security-advisory feature for this repository. Do not open a public issue containing credentials, private network details, or reproduction data tied to a real Govee account.
