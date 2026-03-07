---
name: network-recon
description: Perform network reconnaissance using nmap, DNS enumeration, and service fingerprinting against authorized targets.
triggers: nmap, port scan, network scan, recon, reconnaissance, service discovery, open ports, fingerprint, dns enum
---

# Network Reconnaissance

Use this skill for authorized network scanning and service discovery. Only scan targets explicitly authorized by the user.

## Tools Required

- `shell_exec` — run nmap, dig, host, nslookup, whois
- `web_fetch` — pull banners or check HTTP services found during scanning
- `write_to_blackboard` — store scan results
- `file_write` — save detailed scan output

## Available Software

- `nmap` — port scanning, service detection, OS fingerprinting, NSE scripts
- `dig` / `nslookup` — DNS enumeration
- `whois` — domain/IP registration info

## Workflow

### Step 1: Confirm Authorization

Before scanning, confirm:
- The target IP/domain/range is explicitly authorized by the user.
- The scan scope is clear (specific ports, full range, UDP, etc.).
- Never scan targets without explicit user authorization.

### Step 2: DNS & WHOIS Reconnaissance

Start with passive recon:
```
whois example.com
dig example.com ANY +noall +answer
dig example.com MX +short
dig example.com NS +short
dig example.com TXT +short
host -t AAAA example.com
```

For subdomain enumeration (if in scope):
```
dig @8.8.8.8 example.com AXFR  # zone transfer attempt
```

### Step 3: Port Scanning

Start with a fast scan, then go deep on findings:

**Quick discovery (top 1000 ports):**
```
nmap -sS -sV --top-ports 1000 -T4 -oN /data/workspace/scan-quick.txt TARGET
```

**Full port scan (if requested):**
```
nmap -sS -p- -T4 --min-rate 1000 -oN /data/workspace/scan-full.txt TARGET
```

**UDP scan (top 100, slow):**
```
nmap -sU --top-ports 100 -T4 -oN /data/workspace/scan-udp.txt TARGET
```

### Step 4: Service Fingerprinting

For discovered open ports, get details:
```
nmap -sV -sC -p PORT1,PORT2,PORT3 -oN /data/workspace/scan-services.txt TARGET
```

Flags:
- `-sV` — version detection
- `-sC` — default NSE scripts (safe category)
- `-O` — OS fingerprint (requires root/privileged, may not work in container)

### Step 5: Targeted NSE Scripts

Use NSE scripts for specific services:

**HTTP:**
```
nmap --script http-title,http-headers,http-methods -p 80,443,8080 TARGET
```

**SSL/TLS:**
```
nmap --script ssl-enum-ciphers,ssl-cert -p 443 TARGET
```

**SMB (if in scope):**
```
nmap --script smb-os-discovery,smb-enum-shares -p 445 TARGET
```

**DNS:**
```
nmap --script dns-brute -p 53 TARGET
```

### Step 6: Synthesize Findings

Compile results into a structured report:

```
## Network Recon: [TARGET]

### Host Summary
- IP: [IP]
- OS (if detected): [OS]
- Open Ports: [count]

### Services
| Port | Protocol | Service | Version | Notes |
|------|----------|---------|---------|-------|
| 22   | TCP      | SSH     | OpenSSH 8.9 | Key exchange algorithms |
| 80   | TCP      | HTTP    | nginx 1.24 | Redirects to HTTPS |
| 443  | TCP      | HTTPS   | nginx 1.24 | TLS 1.2/1.3 |

### Findings
- [Notable configurations, exposed services, weak ciphers, etc.]

### Risk Assessment
- [Items requiring attention]
```

## Guardrails

1. **Authorization is mandatory.** Never scan without explicit user consent for the target.
2. Do not use aggressive/intrusive NSE scripts (`--script exploit` or `--script vuln`) unless explicitly requested.
3. Use `-T4` max timing. Do not use `-T5` (insane) as it can destabilize targets.
4. Save all scan output to files (`-oN` or `-oX`) for auditability.
5. If a scan is taking too long (>2 minutes), report partial results and suggest narrowing scope.
6. For rate-limited or firewalled targets, adapt: reduce parallelism, use `-T3`.
