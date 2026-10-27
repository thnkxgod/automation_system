# Automated Chatbot Testing & Evaluation Engine

An intelligent, end-to-end automated testing and AI-driven evaluation system for enterprise chatbots. Supports data-driven scenario execution from Excel sheets, sequential conversational testing (single-turn & multi-turn), headed Cypress UI browser automation, and LLM-powered evaluation with Groq.

---

## 🌟 Key Features

- **Excel Data-Driven Testing:** Ingests test cases directly from Excel workbooks (`input/chatbot test cases.xlsx`).
- **Sequential Waiting Rule:** Strictly waits for each bot response (up to 120s max limit) before triggering the next turn or scenario.
- **Intelligent Status Skipping:** Checks `Test Status` first; skips already tested cases automatically unless `--force` is specified.
- **Single Run File:** Automatically writes all results into a single consolidated report in `output/` per run.
- **Graceful Quit:** Press `q` or `Ctrl+C` at any time to cleanly stop and finalize the Excel report with all evaluated cases so far.
- **Dual Execution Modes:**
  - **Fast API Runner:** Direct backend execution against `/api/v1/chat/messages` with fresh session UUIDs.
  - **Headed Cypress UI Runner:** Visually tests scenarios inside the live browser UI (`--ui` / `--open`), extracts real DOM markdown responses, and avoids user-echo mistakes.
- **AI Judge Evaluation:** Compares actual bot output with expected results using Groq LLMs (`openai/gpt-oss-120b` with fallback to `qwen/qwen3.8-27b`) on a 1–10 rubric.

---

## 🚀 Setup & Installation

### 1. Prerequisites
- **Python:** 3.10+
- **Node.js:** 18+

### 2. Install Dependencies
```bash
# Install Python packages
pip install -r requirements.txt

# Install Cypress & Node modules
npm install
```

### 3. Environment Configuration
Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```
Edit `.env` and provide your Groq API key:
```env
GROQ_API_KEY=gsk_your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
FRONTEND_URL=https://techfeatures.ai/home
CHAT_API_URL=https://aiapi.techfeatures.ai/api/v1/chat/messages
API_ORIGIN=https://techfeatures.ai
```

---

## 🛠️ Usage Guide

### Run All Pending Test Cases (Fast CLI Mode)
```bash
python run_automation.py
```
*(Press `q` or `Ctrl+C` anytime to quit early and save all tested entries)*

### Run Visually in Cypress Browser UI
```bash
python run_automation.py --ui
```

### Run a Single Test Case by ID
```bash
python run_automation.py --test-id 4
python run_automation.py --test-id MS-025 --ui
```

### Start From a Specific Query or Row
```bash
python run_automation.py --start-from "Which industries do you work with?"
python run_automation.py --start-from 36
```

### Force Re-Test Already Tested Cases
```bash
python run_automation.py --force
python run_automation.py --test-id 1 --force
```

---

## 📁 Repository Structure

```text
├── core/
│   ├── runner.py          # Chatbot API runner & session manager
│   ├── judge.py           # Groq AI LLM evaluator & scoring rubric
│   ├── parser.py          # Flexible Excel scenario parser & header matcher
│   ├── writer.py          # Non-destructive Excel report generator
│   └── excel_bridge.py    # Python-to-Cypress data & status bridge
├── cypress/
│   ├── e2e/               # Cypress scenario test specs
│   └── support/           # Custom UI commands & bot reply listeners
├── input/                 # Input Excel workbooks
├── output/                # Generated timestamped test reports
├── config.yaml            # Suite configuration, endpoints, synonyms
├── run_automation.py      # Master CLI test suite orchestrator
├── cypress.config.js      # Cypress configuration & background tasks
└── package.json           # Node.js dependencies
```

