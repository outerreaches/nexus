---
name: attack-surface
description: Map the attack surface of a target using subdomain enumeration, HTTP probing, tech fingerprinting, and endpoint discovery.
triggers: attack surface, subdomain, subdomains, recon, enumerate, surface mapping, endpoint discovery, ffuf, fuzz, directory brute, httpx, subfinder, asset discovery
---

# Attack Surface Mapping

Use this skill to enumerate and probe a target's external attack surface. Combines subdomain discovery, HTTP probing, technology fingerprinting, and directory/endpoint fuzzing.

## Tools Required

- `shell_exec` — run subfinder, httpx, ffuf, curl, nmap
- `web_fetch` — inspect discovered endpoints
- `file_write` — save scan results
- `write_to_blackboard` — store surface map

## Available Software

- `subfinder` — passive subdomain enumeration (APIs: crt.sh, Shodan, VirusTotal, etc.)
- `httpx` — HTTP probing, tech detection, status codes, titles, content length
- `ffuf` — fast web fuzzer for directory/endpoint discovery
- `nmap` — port scanning (see network-recon skill)
- `curl` — manual HTTP inspection

## Workflow

### Step 1: Confirm Scope

Before starting:
- Confirm the target domain/IP is in scope and authorized.
- Clarify: root domain only, or all subdomains? Specific ports?
- Check for a bug bounty program scope definition (in-scope vs out-of-scope assets).

### Step 2: Subdomain Enumeration

**Passive enumeration (safe, no direct contact with target):**
```
subfinder -d TARGET.com -silent -o /data/workspace/subdomains.txt
```

Count results:
```
wc -l /data/workspace/subdomains.txt
```

For deeper enumeration, use multiple sources:
```
subfinder -d TARGET.com -all -silent -o /data/workspace/subdomains-full.txt
```

### Step 3: HTTP Probing

Probe discovered subdomains for live HTTP services:
```
httpx -l /data/workspace/subdomains.txt -silent -status-code -title -tech-detect -content-length -follow-redirects -o /data/workspace/httpx-results.txt
```

Key flags:
- `-status-code` — show HTTP status
- `-title` — extract page titles
- `-tech-detect` — fingerprint technologies (frameworks, servers, CMS)
- `-content-length` — detect default pages vs real content
- `-follow-redirects` — follow redirect chains

**Filter for interesting results:**
```
# Non-default pages (likely real content)
grep -v "404\|301\|302" /data/workspace/httpx-results.txt

# Specific tech stacks
grep -i "wordpress\|laravel\|django\|express\|nginx\|apache" /data/workspace/httpx-results.txt
```

### Step 4: Technology Fingerprinting

For high-value targets, get detailed tech info:
```
httpx -u https://TARGET.com -tech-detect -status-code -title -server -content-type -cdn -silent
```

Check response headers manually for interesting details:
```
curl -sI https://TARGET.com | grep -iE '(server|x-powered|x-aspnet|x-generator|via|x-cdn)'
```

### Step 5: Directory & Endpoint Fuzzing

**Important**: Only fuzz targets explicitly in scope. Use moderate rate limits.

**Common directories:**
```
ffuf -u https://TARGET.com/FUZZ -w /usr/share/nmap/nselib/data/http-directories.lst -mc 200,301,302,403 -ac -rate 10 -o /data/workspace/ffuf-dirs.json -of json 2>&1 | tail -30
```

If no wordlist is available, use a curated list:
```
printf '%s\n' admin api docs login dashboard app console status health metrics graphql swagger api-docs .well-known robots.txt sitemap.xml | ffuf -u https://TARGET.com/FUZZ -w - -mc 200,301,302,403 -ac -rate 10 2>&1 | tail -20
```

**API endpoint discovery:**
```
printf '%s\n' api/v1 api/v2 api/v3 graphql api/health api/status api/docs api/swagger api/openapi.json .well-known/openid-configuration | ffuf -u https://TARGET.com/FUZZ -w - -mc 200,301,302 -ac -rate 10 2>&1 | tail -20
```

### Step 6: Synthesize Attack Surface Map

```
## Attack Surface: TARGET.com

### Scope
- Domain: TARGET.com
- Subdomains enumerated: [N]
- Live HTTP hosts: [N]

### Subdomains
| Subdomain | Status | Title | Technologies |
|-----------|--------|-------|-------------|
| www.target.com | 200 | Target Inc | nginx, React |
| api.target.com | 200 | API Gateway | nginx, Node.js |
| staging.target.com | 403 | Forbidden | nginx |
| admin.target.com | 301 | → login.target.com | nginx |

### Interesting Findings
- **Staging environment exposed**: staging.target.com returns 403 but is live
- **API documentation public**: api.target.com/swagger returns 200
- **Technology stack**: React frontend, Node.js API, PostgreSQL (inferred from headers)

### Discovered Endpoints
| URL | Status | Notes |
|-----|--------|-------|
| /api/docs | 200 | Swagger UI |
| /admin | 301 | Redirects to login |
| /.well-known/security.txt | 200 | Bug bounty scope |
| /graphql | 200 | GraphQL endpoint |

### Recommended Next Steps
1. [Targeted testing suggestions based on findings]
2. [High-value endpoints for deeper analysis]
```

## Guardrails

1. **Authorization required.** Never enumerate or fuzz without explicit user authorization.
2. Rate-limit ffuf to 10 req/s max (`-rate 10`). Lower for sensitive targets.
3. Use `-ac` (auto-calibrate) with ffuf to filter false positives.
4. Do not attempt to access admin panels or authenticated endpoints.
5. If a target returns WAF blocks (429/403 patterns), stop fuzzing and note the limitation.
6. Save all output to files for auditability.
7. subfinder is passive only — it queries public databases, not the target directly.
