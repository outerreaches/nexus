---
name: nuclei-scan
description: Run targeted vulnerability scans using Nuclei templates against authorized targets.
triggers: nuclei, vuln scan, vulnerability scan, template scan, cve scan, misconfiguration scan, exposure scan, automated scan
---

# Nuclei Vulnerability Scanning

Use this skill to run targeted, template-based vulnerability scans against authorized targets. Nuclei uses community-maintained templates to detect CVEs, misconfigurations, exposures, and default credentials.

## Tools Required

- `shell_exec` — run nuclei
- `file_read` — review scan results
- `web_search` — research discovered vulnerabilities
- `write_to_blackboard` — store findings

## Available Software

- `nuclei` — template-based vulnerability scanner (ProjectDiscovery)

## Important: First Run

On first use, update templates:
```
nuclei -update-templates 2>&1 | tail -5
```

This downloads the community template library to `~/.local/nuclei-templates/`.

## Workflow

### Step 1: Confirm Authorization

Nuclei sends real requests to targets. Confirm:
- Target is explicitly authorized for scanning.
- Bug bounty program allows automated scanning (check scope/rules).
- Rate limits are appropriate for the target.

### Step 2: Choose Scan Scope

Nuclei templates are organized by severity and type. Choose based on the engagement:

**Template categories:**
- `cves/` — known CVE exploits
- `vulnerabilities/` — generic vulnerability checks
- `misconfiguration/` — server/app misconfigurations
- `exposures/` — sensitive file/data exposure
- `technologies/` — technology detection
- `default-logins/` — default credential checks (use with caution)
- `takeovers/` — subdomain takeover checks

### Step 3: Run Scans

**Quick misconfiguration + exposure scan (safe, low noise):**
```
nuclei -u https://TARGET.com -t misconfiguration/ -t exposures/ -severity medium,high,critical -rate-limit 10 -o /data/workspace/nuclei-quick.txt 2>&1 | tail -40
```

**CVE scan against specific target:**
```
nuclei -u https://TARGET.com -t cves/ -severity high,critical -rate-limit 10 -o /data/workspace/nuclei-cves.txt 2>&1 | tail -40
```

**Technology fingerprinting (very safe, info-only):**
```
nuclei -u https://TARGET.com -t technologies/ -rate-limit 20 -o /data/workspace/nuclei-tech.txt 2>&1 | tail -30
```

**Full scan against a list of targets:**
```
nuclei -l /data/workspace/live-hosts.txt -severity medium,high,critical -rate-limit 5 -o /data/workspace/nuclei-full.txt 2>&1 | tail -60
```

**Subdomain takeover checks:**
```
nuclei -l /data/workspace/subdomains.txt -t takeovers/ -rate-limit 10 -o /data/workspace/nuclei-takeovers.txt 2>&1 | tail -20
```

### Step 4: Filter and Triage Results

Nuclei output format: `[template-id] [severity] [protocol] [matched-url] [extra-info]`

Parse findings by severity:
```
grep "critical" /data/workspace/nuclei-full.txt
grep "high" /data/workspace/nuclei-full.txt
```

For each finding:
1. Verify it's not a false positive — manually check the URL with `web_fetch` or `curl`
2. Look up the template/CVE for details: `web_search` for the template ID or CVE number
3. Assess exploitability in the target's context
4. Determine impact and severity

### Step 5: Report

```
## Nuclei Scan: TARGET.com

### Scan Configuration
- Target(s): [URL or host count]
- Templates: [categories used]
- Rate limit: [N] req/s
- Duration: [time]

### Findings Summary
| Severity | Count |
|----------|-------|
| Critical | N     |
| High     | N     |
| Medium   | N     |
| Info     | N     |

### Critical/High Findings

#### [template-id] — [Severity]
- **URL**: [matched URL]
- **Description**: [What was detected]
- **CVE**: [if applicable]
- **Verified**: [Yes/No — manually confirmed?]
- **Impact**: [What an attacker could do]

### False Positive Notes
- [Any findings ruled out and why]

### Technologies Detected
- [Tech fingerprinting results if included]
```

## Guardrails

1. **Authorization is mandatory.** Nuclei sends real HTTP requests that may trigger alerts.
2. Always use `-rate-limit` (10 req/s for single targets, 5 for bulk lists).
3. Avoid `default-logins/` templates unless explicitly authorized — they attempt credential stuffing.
4. Do not use `-severity info` on large scans — produces excessive noise.
5. If a scan runs longer than 3 minutes, check partial output and consider narrowing scope.
6. Always verify critical/high findings manually before reporting.
7. Save raw output to files (`-o`) for audit trail.
8. Truncate shell output — pipe through `tail -40` to avoid context blow-up on large scans.
