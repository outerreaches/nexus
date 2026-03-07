---
name: dependency-audit
description: Audit project dependencies for known vulnerabilities, outdated packages, and supply chain risks.
triggers: npm audit, dependency check, cve, vulnerability scan, outdated packages, supply chain, dependency audit, security scan, package audit
---

# Dependency Security Audit

Use this skill to audit a project's dependencies for known vulnerabilities, outdated versions, and supply chain risks.

## Tools Required

- `shell_exec` — run npm audit, pip audit, package managers
- `file_read` — examine lock files, package manifests
- `web_search` — look up CVEs and advisories
- `code_search` — find dependency usage patterns
- `write_to_blackboard` — store findings

## Workflow

### Step 1: Identify Ecosystem

Detect the project's package ecosystem(s):
- `package.json` / `package-lock.json` → Node.js/npm
- `requirements.txt` / `Pipfile` / `pyproject.toml` → Python
- `go.mod` → Go
- `Cargo.toml` → Rust
- `Gemfile` → Ruby

### Step 2: Run Built-in Audits

**Node.js:**
```
npm audit --json 2>/dev/null | head -200
```
Parse the JSON output for severity counts and affected packages.

**Python (if pip-audit available):**
```
pip-audit -r requirements.txt --format json 2>/dev/null | head -200
```

**Go:**
```
go list -json -m all 2>/dev/null | head -100
```

### Step 3: Check for Outdated Packages

**Node.js:**
```
npm outdated --json 2>/dev/null | head -100
```

Focus on packages that are multiple major versions behind — these often have unpatched vulnerabilities.

### Step 4: Analyze High-Risk Patterns

Search the codebase for risky dependency usage:
- Packages imported but not in lock file (phantom deps)
- `eval()` or dynamic `require()` with user input
- Dependencies with very few maintainers or downloads
- Post-install scripts in dependencies: check `package.json` for `preinstall`, `postinstall` hooks

```
# Check for install scripts in dependencies
cat node_modules/*/package.json 2>/dev/null | grep -l '"postinstall"' | head -20
```

### Step 5: CVE Deep Dive

For each critical/high vulnerability found:
1. Look up the CVE: `web_search` for "CVE-XXXX-XXXX [package name]"
2. Check if the vulnerable code path is actually used in the project
3. Check if a patched version exists
4. Assess exploitability in the project's context

### Step 6: Report

```
## Dependency Audit: [Project]

### Summary
- Total dependencies: [N direct] + [N transitive]
- Vulnerabilities: [Critical: N] [High: N] [Medium: N] [Low: N]
- Outdated (major): [N packages]

### Critical Vulnerabilities
#### CVE-XXXX-XXXX — [Package Name] [Version]
- **Severity**: Critical (CVSS X.X)
- **Description**: [What the vulnerability allows]
- **Used in project**: [Yes/No — is the vulnerable API/path used?]
- **Fix**: Upgrade to [version]

### Outdated Packages (High Risk)
| Package | Current | Latest | Versions Behind |
|---------|---------|--------|-----------------|
| express | 4.17.1  | 4.21.0 | 8 minor         |

### Supply Chain Observations
- [Install script findings]
- [Unmaintained packages]
- [Packages with typosquat risk]

### Recommendations
1. [Priority-ordered upgrade steps]
```

## Guardrails

1. Do not run `npm audit fix` or modify any dependencies — audit only.
2. Limit `npm outdated` / audit output to first 200 lines to avoid context blow-up.
3. Do not download or execute any packages during the audit.
4. For large dependency trees (>500 packages), focus on direct dependencies first.
