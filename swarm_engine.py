"""
Swarm Architectures for LFM3 1.7B:
1. Map-Reduce Swarm (Distributed Sub-task Workers + Synthesis Coordinator)
2. Consensus / Multi-Agent Debate Swarm (Specialist Debaters + Judge)
"""

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Callable
from ollama_client import OllamaClient

class SwarmAgent:
    def __init__(self, agent_id: str, role: str, system_prompt: str, client: OllamaClient, think: bool = False):
        self.agent_id = agent_id
        self.role = role
        self.system_prompt = system_prompt
        self.client = client
        self.think = think
        self.history: List[Dict[str, str]] = []

    def execute_task(self, prompt: str, temperature: float = 0.3) -> Dict[str, Any]:
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": prompt}
        ]
        result = self.client.chat(messages, think=self.think, temperature=temperature)
        result["agent_id"] = self.agent_id
        result["role"] = self.role
        return result


class SwarmCoordinator:
    def __init__(self, client: OllamaClient, max_workers: int = 10, think: bool = False):
        self.client = client
        self.max_workers = max_workers
        self.think = think

    def run_map_reduce_swarm(self, topic: str, subtasks: List[Dict[str, str]]) -> Dict[str, Any]:
        """
        Executes a Map-Reduce Swarm:
        - Spawns N parallel worker agents to analyze distinct facets
        - Aggregator agent reduces findings into a unified executive deliverable
        """
        t0 = time.time()
        agents = []
        for idx, task_info in enumerate(subtasks):
            agent = SwarmAgent(
                agent_id=f"agent-{idx+1:02d}",
                role=task_info["role"],
                system_prompt=f"You are a focused specialist agent ({task_info['role']}) in an AI swarm. Respond concisely and rigorously.",
                client=self.client,
                think=self.think
            )
            agents.append((agent, task_info["prompt"]))

        worker_results = []
        with ThreadPoolExecutor(max_workers=min(len(agents), self.max_workers)) as executor:
            future_to_agent = {
                executor.submit(agent.execute_task, prompt): agent.agent_id
                for agent, prompt in agents
            }
            for fut in as_completed(future_to_agent):
                res = fut.result()
                worker_results.append(res)

        # Sort worker results by agent_id for deterministic reporting
        worker_results.sort(key=lambda x: x["agent_id"])

        # Coordinator / Synthesizer step (Reduce)
        synthesis_prompt = f"Topic: {topic}\n\nHere are reports from {len(worker_results)} specialist swarm agents:\n\n"
        for r in worker_results:
            status = "SUCCESS" if r["success"] else "FAILED"
            synthesis_prompt += f"[{r['agent_id']} - {r['role']}] ({status}):\n{r['content']}\n\n"

        synthesis_prompt += "Synthesize the above points into a cohesive executive action summary with 3 key pillars."

        synthesizer = SwarmAgent(
            agent_id="coordinator",
            role="Chief Synthesizer",
            system_prompt="You are the lead synthesis agent for the swarm. Aggregate worker outputs into a structured summary.",
            client=self.client,
            think=self.think
        )
        synthesis_result = synthesizer.execute_task(synthesis_prompt, temperature=0.1)

        total_wall_time = time.time() - t0
        total_tokens = sum(r.get("eval_count", 0) for r in worker_results) + synthesis_result.get("eval_count", 0)
        successful_agents = sum(1 for r in worker_results if r["success"])

        return {
            "swarm_type": "Map-Reduce",
            "agent_count": len(subtasks) + 1,
            "wall_time_sec": round(total_wall_time, 2),
            "successful_agents": successful_agents,
            "total_tokens_generated": total_tokens,
            "tokens_per_sec_aggregate": round(total_tokens / total_wall_time, 2) if total_wall_time > 0 else 0,
            "worker_results": worker_results,
            "final_synthesis": synthesis_result["content"],
            "synthesis_metrics": synthesis_result
        }

    def run_consensus_debate_swarm(self, debate_topic: str, debater_personas: List[str], rounds: int = 1) -> Dict[str, Any]:
        """
        Executes a Multi-Agent Consensus Debate Swarm:
        - Multiple diverse persona agents argue viewpoints
        - A judge agent evaluates the argumentation and declares consensus
        """
        t0 = time.time()
        debater_agents = [
            SwarmAgent(
                agent_id=f"debater-{idx+1:02d}",
                role=persona,
                system_prompt=f"You are a debate agent representing the perspective: {persona}. State your rationale clearly and concisely.",
                client=self.client,
                think=self.think
            )
            for idx, persona in enumerate(debater_personas)
        ]

        debate_transcript = []
        with ThreadPoolExecutor(max_workers=min(len(debater_agents), self.max_workers)) as executor:
            futures = [
                executor.submit(
                    agent.execute_task,
                    f"Debate Question: {debate_topic}\nProvide your strongest argument from your perspective in 3-4 sentences."
                )
                for agent in debater_agents
            ]
            for fut in as_completed(futures):
                debate_transcript.append(fut.result())

        debate_transcript.sort(key=lambda x: x["agent_id"])

        # Judge evaluation
        judge_prompt = f"Topic: {debate_topic}\n\nReview these perspectives:\n"
        for item in debate_transcript:
            judge_prompt += f"[{item['role']}]: {item['content']}\n\n"
        judge_prompt += "Deliver an objective consensus verdict balancing the trade-offs in 3 clear points."

        judge = SwarmAgent(
            agent_id="judge-01",
            role="Impartial Swarm Arbiter",
            system_prompt="You are an impartial judge evaluating multi-agent debates. Deliver reasoned verdicts.",
            client=self.client,
            think=self.think
        )
        verdict = judge.execute_task(judge_prompt, temperature=0.1)

        total_wall_time = time.time() - t0
        total_tokens = sum(r.get("eval_count", 0) for r in debate_transcript) + verdict.get("eval_count", 0)

        return {
            "swarm_type": "Consensus-Debate",
            "agent_count": len(debater_personas) + 1,
            "wall_time_sec": round(total_wall_time, 2),
            "successful_agents": sum(1 for r in debate_transcript if r["success"]),
            "total_tokens_generated": total_tokens,
            "tokens_per_sec_aggregate": round(total_tokens / total_wall_time, 2) if total_wall_time > 0 else 0,
            "debate_arguments": debate_transcript,
            "verdict": verdict["content"],
            "verdict_metrics": verdict
        }
