# NORD – The Operating System for AI-Assisted Development

> **Understanding before building. Parallel everything. Full transparency.**

NORD is a Windows desktop application (a single EXE) that orchestrates multiple AI agents across a structured development pipeline. You talk to it. It understands completely. Then it builds.

Unlike Cursor, Claude Code, Copilot, or Trae – which start writing code immediately without understanding – NORD enforces a **design‑first, parallel‑agent** workflow. The result: the right thing built, right design, right packages, and persistent context across sessions.

---

## 🧠 The Problem

Every AI coding tool today has the same flaw: they take your prompt and immediately start writing code. No understanding phase. No design phase. No research phase. Just generation.

The developer becomes the middleware – copy‑pasting between tools, re‑explaining requirements, fixing output that missed the point entirely. AI tools made it faster to build the **wrong** thing.

---

## 🚀 What NORD Does

NORD removes you from that position. Talk once. The CEO understands everything. The `.nord/` folder becomes the shared brain every tool reads from. NORD becomes the conductor. Every other AI tool becomes an instrument it plays.

**Three core rules:**

1. **Understanding before building** – no agent touches code until the picture is complete  
2. **Parallel everything** – agents work simultaneously, never sequentially  
3. **Full transparency** – user sees every agent, every decision, every file being written  

---

## 🏛️ Hierarchy

- **CEO**: Absorbs any user language (technical or non‑technical) and outputs precise technical briefs. The user never needs to be technical.  
- **CTO**: Receives the CEO brief, breaks it into pinpoint tasks, spawns all agents simultaneously, monitors results, reassigns failures, and consolidates outputs. Never talks to the user – pure technical orchestration.  
- **Agents**: One job each. DNA scraper, reference collector, screen generator, research scouts, builder agents – each gets only the context it needs.

---

## 📁 The `.nord/` Folder

NORD creates a `.nord/` folder in your project – like `.git/` or `.cursor/` but smarter. This is the persistent shared brain across every session, every tool, every agent.

Every agent reads from it. Every session starts with full context. Open NORD a week later – the CEO already knows everything. You never re‑explain anything. Ever.

---

## ⚙️ Stages of Development

### Stage 1 – Understanding
CEO opens with *“Hey – what are we building?”* One question at a time. Captures what, why, who, features, design direction, tech preferences, constraints. Everything written to `spec/` files live during conversation.

### Stage 1.1 – Requirements Synthesis
Auto‑triggers after Stage 1. A dedicated 1M‑context model reads the entire conversation holistically and produces six clean requirement documents – project scope, user flows, design direction, technical decisions, integrations, constraints.

### Stage 2 – Design + Research (simultaneously)
- **Design track**: CEO has a short conversation about look & feel (max 4 exchanges). CTO spawns design agents – DNA Scraper, Reference Collector, Screen Generator, Asset Generator – all working in parallel.
- **Research track**: Four scouts simultaneously search GitHub for repos, npm for packages, third‑party services, and official docs. A consolidator merges everything into one resource file.

### Stage 3 – Planning
Reads everything from Stages 1 & 2. Produces a complete build plan – frontend, backend, database, endpoints, security. Every builder agent gets a precise task document. Zero ambiguity before building starts.

### Stage 4 – Building
Specialised builder agents read their specific plan files. Parallel building across all layers. Built‑in test and fix loop.

---

## 🎛️ CLI Control

NORD’s CTO can control external AI CLI tools directly – Claude Code, Kiro CLI, Gemini CLI, OpenCode. These become workers that NORD commands.

```bash
CTO → "claude --task backend.plan.md"
CTO → "kiro run frontend.plan.md"
