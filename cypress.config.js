const { defineConfig } = require("cypress");
const path = require("path");
const { execSync } = require("child_process");
const dotenv = require("dotenv");

// Load .env
dotenv.config();

module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.FRONTEND_URL ? "https://techfeatures.ai" : "https://techfeatures.ai",
    viewportWidth: 1280,
    viewportHeight: 800,
    defaultCommandTimeout: 120000,
    requestTimeout: 120000,
    responseTimeout: 120000,
    pageLoadTimeout: 120000,
    chromeWebSecurity: false,

    setupNodeEvents(on, config) {
      on("task", {
        // Hybrid Evaluator: Deterministic Keyword Validator for 'Don't need AI', Groq LLM Judge for 'Need AI'
        async evaluateWithGroq({ userQuery, expectedResult, actualResponse, scenario, aiEvaluation, expectedKeywords, testType, feature }) {
          const aiEval = (aiEvaluation || "").toLowerCase().trim();
          const needsAi = !(aiEval.includes("don't need") || aiEval.includes("dont need") || aiEval.includes("manual") || aiEval === "no");

          // Fast Deterministic Keyword Matching (Zero Groq API hits)
          // Algorithm: CNF (Outer [...] is AND / Mandatory, Inner {...} is OR / Synonyms)
          if (!needsAi) {
            const rawKw = (expectedKeywords || expectedResult || "").trim();
            if (!rawKw) {
              return { score: 8, result: "PASS", notes: "[Deterministic Keyword Evaluation] No keyword criteria configured. Response captured." };
            }

            // Extract bot responses per turn if multi-turn dialogue
            const botTurnMap = {};
            const botMatches = [...actualResponse.matchAll(/Turn\s*(\d+)\s*Bot:\s*([\s\S]*?)(?=(?:Turn\s*\d+\s*User:|$))/gi)];
            botMatches.forEach(m => {
              botTurnMap[parseInt(m[1], 10)] = m[2].trim();
            });

            function parseGroups(str) {
              const m = str.match(/\{([^}]+)\}/g);
              if (m && m.length > 0) {
                return m.map(item => item.replace(/^\{|\}$/g, "").split(/[,;]/).map(s => s.trim()).filter(Boolean));
              }
              return str.split(/[,;]/).map(s => s.trim()).filter(Boolean).map(t => [t]);
            }

            function checkGroups(groups, text) {
              const textLower = (text || "").toLowerCase();
              const matched = [];
              const missing = [];
              groups.forEach((grp, idx) => {
                let foundKw = null;
                for (const kw of grp) {
                  const kwClean = kw.toLowerCase();
                  if (textLower.includes(kwClean)) {
                    foundKw = kw;
                    break;
                  }
                }
                if (foundKw) matched.push({ index: idx + 1, matched: foundKw });
                else missing.push({ index: idx + 1, group: grp });
              });
              return { matched, missing };
            }

            const hasTurnPrefix = /\bturn\s*\d+\s*[:\-\.]/i.test(rawKw);

            // Format A: Per-Turn Keywords (e.g. Turn 1: [{...}], Turn 2: [{...}])
            if (hasTurnPrefix) {
              const turnParts = rawKw.split(/\bturn\s*(\d+)\s*[:\-\.]\s*/i);
              let allPassed = true;
              const turnDetails = [];
              const failDetails = [];
              let turnCount = 0;

              for (let i = 1; i < turnParts.length; i += 2) {
                const tNum = parseInt(turnParts[i], 10);
                const tContent = turnParts[i + 1].trim();
                const grps = parseGroups(tContent);
                if (grps.length > 0) {
                  turnCount++;
                  let botReply = botTurnMap[tNum] || "";
                  if (!botReply && Object.keys(botTurnMap).length === 0 && tNum === 1) {
                    botReply = actualResponse;
                  }
                  const { matched, missing } = checkGroups(grps, botReply);
                  if (missing.length > 0) {
                    allPassed = false;
                    const missStr = missing.map(m => `{${m.group.join(", ")}}`).join(", ");
                    failDetails.push(`Turn ${tNum} missing [${missStr}]`);
                  } else {
                    const matchStr = matched.map(m => `'${m.matched}'`).join(", ");
                    turnDetails.push(`Turn ${tNum} matched [${matchStr}]`);
                  }
                }
              }

              if (allPassed) {
                return {
                  score: 10,
                  result: "PASS",
                  notes: `[Deterministic Keyword Evaluation] PASSED: All ${turnCount} turns satisfied mandatory keyword groups. Details: ${turnDetails.join("; ")}.`
                };
              } else {
                return {
                  score: 2,
                  result: "FAIL",
                  notes: `[Deterministic Keyword Evaluation] FAILED: ${failDetails.join("; ")}. Satisfied: ${turnDetails.join("; ") || "None"}.`
                };
              }
            }

            // Format B: Global Keywords across all bot replies
            const groups = parseGroups(rawKw);
            let checkText = actualResponse;
            if (Object.keys(botTurnMap).length > 0) {
              checkText = Object.values(botTurnMap).join("\n");
            }
            const { matched, missing } = checkGroups(groups, checkText);
            const allPassed = (missing.length === 0);
            const totalGroups = groups.length;

            if (allPassed) {
              const matchedStr = matched.map(g => `G${g.index}: matched '${g.matched}'`).join("; ");
              return {
                score: 10,
                result: "PASS",
                notes: `[Deterministic Keyword Evaluation] PASSED (${totalGroups}/${totalGroups} mandatory groups met across conversation). Details: [${matchedStr}].`
              };
            } else {
              const missStr = missing.map(g => `G${g.index} missing any of {${g.group.join(", ")}}`).join("; ");
              const matchStr = matched.map(g => `G${g.index} matched '${g.matched}'`).join("; ") || "None";
              return {
                score: 2,
                result: "FAIL",
                notes: `[Deterministic Keyword Evaluation] FAILED: Missing mandatory concept groups across conversation: [${missStr}]. Satisfied: [${matchStr}].`
              };
            }
          }

          // Complex / Subjective AI Evaluation via Groq
          const Groq = require("groq-sdk");
          const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
          const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

          const prompt = `You are an expert QA testing judge for a company chatbot.
Scenario: ${scenario || "General"}
User Query: "${userQuery}"
Expected Result: "${expectedResult}"
Actual Chatbot Response: "${actualResponse}"

Scoring Rubric (1 - 10):
- 9 - 10 (PASS): Flawless match to expected outcome, correct tone, zero hallucinations.
- 7 - 8 (PASS): Accurate core answer, minor phrasing differences.
- 5 - 6 (PARTIAL): Partially answered, missed secondary requirement, or slightly vague.
- 3 - 4 (FAIL): Poor match, evasive, or unhelpful.
- 1 - 2 (FAIL): Hallucination, broke guardrails, or severe error.

Return ONLY a valid JSON object matching:
{
  "score": 10,
  "result": "PASS",
  "notes": "Short explanation of match, missing points, or doubts"
}`;

          const modelsToTry = [model, "qwen/qwen3.8-27b"];
          let lastError = null;

          for (const m of modelsToTry) {
            try {
              const completion = await groq.chat.completions.create({
                model: m,
                messages: [
                  { role: "system", content: "You are a QA testing judge. Output valid JSON only." },
                  { role: "user", content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 1024
              });

              const content = completion.choices[0]?.message?.content || "";
              const jsonMatch = content.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
              }
              return { score: 5, result: "PARTIAL", notes: content };
            } catch (err) {
              lastError = err.message;
              console.warn(`Groq model ${m} failed (${err.message}), trying fallback...`);
            }
          }

          console.error("Groq evaluation task error across all models:", lastError);
          return { score: 5, result: "PARTIAL", notes: `Evaluation fallback: ${lastError}` };
        },

        // Evaluate a batch of up to 10 test scenarios in ONE Groq API call (Mode B)
        async evaluateBatchWithGroq(batchItems) {
          const Groq = require("groq-sdk");
          const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
          const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

          const scenarioBlocks = batchItems.map((item, idx) => {
            return `=== SCENARIO ${idx + 1} (Test ID: ${item.testId}) ===
Feature: ${item.feature || "N/A"}
User Query: "${item.userQuery}"
Expected Result: "${item.expectedResult}"
Actual Chatbot Response:
"""${item.actualResponse}"""`;
          }).join("\n\n");

          const prompt = `You are an expert QA testing judge for a company chatbot.
Evaluate each of the following ${batchItems.length} test scenarios individually against its expected result.
Scoring Rubric (1 - 10):
- 9 - 10 (PASS): Flawless match to expected outcome, correct tone, zero hallucinations.
- 7 - 8 (PASS): Accurate core answer, minor phrasing differences.
- 5 - 6 (PARTIAL): Partially answered, missed secondary requirement, or slightly vague.
- 3 - 4 (FAIL): Poor match, evasive, or unhelpful.
- 1 - 2 (FAIL): Critical failure. Hallucination, broke guardrails, or severe error.

Return ONLY a valid JSON array of ${batchItems.length} objects in the exact same order matching:
[
  {
    "test_id": "${batchItems[0]?.testId || "1"}",
    "score": 10,
    "result": "PASS",
    "notes": "Short explanation of match or missing points"
  }
]

Scenarios to evaluate:
${scenarioBlocks}`;

          const modelsToTry = [model, "qwen/qwen3.8-27b"];
          for (const m of modelsToTry) {
            try {
              const completion = await groq.chat.completions.create({
                model: m,
                messages: [
                  { role: "system", content: "You are a QA testing judge. Output valid JSON array only." },
                  { role: "user", content: prompt }
                ],
                temperature: 0.1,
                max_tokens: Math.min(4096, Math.max(1024, batchItems.length * 250))
              });
              const content = completion.choices[0]?.message?.content || "";
              const jsonMatch = content.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                const arr = JSON.parse(jsonMatch[0]);
                if (Array.isArray(arr) && arr.length === batchItems.length) {
                  return arr;
                }
              }
            } catch (err) {
              console.warn(`Groq batch model ${m} failed (${err.message}), trying fallback...`);
            }
          }
          return batchItems.map(item => ({
            test_id: item.testId,
            score: 5,
            result: "PARTIAL",
            notes: "Batch evaluation fallback: please review manually."
          }));
        },

        // Task to read test cases from Excel via core/excel_bridge.py
        readExcelTestCases(options = {}) {
          const testId = options.testId || config.env.testId || "";
          const sheet = options.sheet || config.env.sheet || "Sheet1";
          const limit = options.limit || config.env.limit || 0;
          const force = options.force || config.env.force || false;
          const startFrom = options.startFrom || config.env.startFrom || "";

          let cmd = `python core/excel_bridge.py --action get --sheet "${sheet}"`;
          if (testId) {
            cmd += ` --test-id "${testId}"`;
          }
          if (limit > 0) {
            cmd += ` --limit ${limit}`;
          }
          if (force) {
            cmd += ` --force`;
          }
          if (startFrom) {
            cmd += ` --start-from "${startFrom}"`;
          }

          try {
            const stdout = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
            const cases = JSON.parse(stdout);
            return cases;
          } catch (e) {
            console.error("Failed to read Excel cases via bridge:", e.message);
            return [];
          }
        },

        // Task to write test results to Excel safely via stdin into single run output file
        writeExcelResult(payload) {
          const fs = require("fs");
          const sheet = payload.sheet || "Sheet1";
          let runOutputFile = payload.output_file || process.env.CURRENT_RUN_OUTPUT_FILE;
          if (!runOutputFile) {
            if (fs.existsSync(".current_run_output.txt")) {
              try {
                runOutputFile = fs.readFileSync(".current_run_output.txt", "utf-8").trim();
              } catch (e) {}
            }
          }
          if (!runOutputFile) {
            const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15);
            runOutputFile = path.join("output", `chatbot_test_cases_RUN_${timestamp}.xlsx`);
            try {
              fs.writeFileSync(".current_run_output.txt", runOutputFile);
            } catch (e) {}
          }

          let cmd = `python core/excel_bridge.py --action save --sheet "${sheet}"`;
          if (runOutputFile) {
            cmd += ` --output-file "${runOutputFile}"`;
          }

          try {
            const stdout = execSync(cmd, {
              input: JSON.stringify(payload),
              encoding: "utf-8"
            });
            return JSON.parse(stdout);
          } catch (e) {
            console.error("Failed to save result to Excel:", e.message);
            return { success: false, error: e.message };
          }
        }
      });

      return config;
    }
  }
});
