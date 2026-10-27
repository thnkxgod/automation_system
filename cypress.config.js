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
        // Evaluate chatbot response using Groq (openai/gpt-oss-120b)
        async evaluateWithGroq({ userQuery, expectedResult, actualResponse, scenario }) {
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

        // Task to read test cases from Excel via core/excel_bridge.py
        readExcelTestCases(options = {}) {
          const testId = options.testId || config.env.testId || "";
          const sheet = options.sheet || config.env.sheet || "genral user test cases";
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
          const sheet = payload.sheet || "genral user test cases";
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
