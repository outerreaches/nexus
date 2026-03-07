---
name: web-app-audit
description: Structured web application security audit covering headers, TLS, misconfigurations, and common vulnerabilities.
triggers: web audit, security audit, header check, tls check, security headers, owasp, web security, ssl check, https audit, website security
---

# Web Application Security Audit

Use this skill for systematic web application security assessments. Combines automated checks with manual analysis.

## Tools Required

- `shell_exec` — run curl, nmap ssl scripts, nikto
- `web_fetch` — retrieve pages, check responses
- `web_search` — look up CVEs and known issues
- `code_search` / `file_read` — review source code if available
- `write_to_blackboard` — store findings

## Available Software

- `curl` — HTTP header/response inspection
- `nmap` — SSL/TLS cipher enumeration, HTTP NSE scripts
- `nikto` — web server vulnerability scanner

## Audit Phases

### Phase 1: HTTP Security Headers

Check all relevant security headers:
```
curl -sI https://TARGET | grep -iE '(strict-transport|content-security|x-frame|x-content-type|referrer-policy|permissions-policy|x-xss|access-control)'
```

**Expected headers and ideal values:**
| Header | Expected | Risk if Missing |
|--------|----------|-----------------|
| Strict-Transport-Security | max-age=31536000; includeSubDomains | Downgrade attacks |
| Content-Security-Policy | Defined, restrictive | XSS |
| X-Frame-Options | DENY or SAMEORIGIN | Clickjacking |
| X-Content-Type-Options | nosniff | MIME sniffing |
| Referrer-Policy | strict-origin-when-cross-origin | Information leakage |
| Permissions-Policy | Restrictive | Feature abuse |

### Phase 2: TLS Configuration

```
nmap --script ssl-enum-ciphers -p 443 TARGET
```

Check for:
- TLS 1.0/1.1 support (should be disabled)
- Weak cipher suites (RC4, DES, NULL, export)
- Certificate validity, chain, and SANs
- HSTS preload status

### Phase 3: Information Disclosure

Check for exposed sensitive paths:
```
# Common information leaks
curl -s -o /dev/null -w "%{http_code}" https://TARGET/.env
curl -s -o /dev/null -w "%{http_code}" https://TARGET/.git/HEAD
curl -s -o /dev/null -w "%{http_code}" https://TARGET/robots.txt
curl -s -o /dev/null -w "%{http_code}" https://TARGET/sitemap.xml
curl -s -o /dev/null -w "%{http_code}" https://TARGET/.well-known/security.txt
```

Check server banners:
```
curl -sI https://TARGET | grep -i server
```

### Phase 4: Nikto Scan

Run a baseline nikto scan:
```
nikto -h https://TARGET -Tuning 1234 -maxtime 120s -o /data/workspace/nikto-report.txt 2>&1 | head -80
```

Tuning options (combine as needed):
- `1` — Interesting File / Seen in logs
- `2` — Misconfiguration / Default File
- `3` — Information Disclosure
- `4` — Injection (XSS/Script/HTML)

### Phase 5: Cookie Security

```
curl -sI https://TARGET/login 2>/dev/null | grep -i set-cookie
```

Check for:
- `Secure` flag (required for HTTPS)
- `HttpOnly` flag (prevents JS access)
- `SameSite` attribute (CSRF protection)
- Session cookie naming conventions

### Phase 6: Source Code Review (if available)

If the target's source code is accessible:
- Search for hardcoded credentials: `code_search` for patterns like `password =`, `api_key`, `secret`
- Check input validation on endpoints
- Review authentication/authorization logic
- Check for SQL injection patterns (string concatenation in queries)
- Check dependency versions against known CVEs

## Report Format

```
## Web Application Audit: [TARGET]

### Audit Scope
- URL: [URL]
- Date: [Date]
- Type: [External/Internal/Source Review]

### Summary
- Critical: [N] | High: [N] | Medium: [N] | Low: [N] | Info: [N]

### Findings

#### [CRITICAL/HIGH] Missing Content-Security-Policy
**Impact**: Application vulnerable to XSS attacks
**Evidence**: No CSP header returned
**Remediation**: Add `Content-Security-Policy: default-src 'self'; script-src 'self'`

#### [MEDIUM] TLS 1.1 Still Enabled
...

### Positive Controls
- [List security measures that ARE in place]
```

## Guardrails

1. Do not attempt exploitation — this is assessment only.
2. Do not brute-force paths beyond the standard checks listed above.
3. If nikto runs longer than 2 minutes, terminate and use partial results.
4. Do not test authentication bypass unless explicitly authorized.
5. Rate-limit requests: no more than 5 requests/second to any single target.
6. If a target returns 403/WAF blocks, note it and move on — do not attempt evasion.
