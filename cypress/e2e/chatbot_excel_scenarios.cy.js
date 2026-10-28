/**
 * Data-Driven Cypress Testing directly loaded from Excel test cases.
 * Supports Mode A (Standard 1-by-1) and Mode B (Optimized: No-AI first + Batch AI 10-at-once).
 */
describe("Data-Driven Excel Scenario Automation", () => {
  let testCases = [];

  function isNoAi(tc) {
    const aiEval = (tc.ai_evaluation || tc.ai_eval || "").toLowerCase().trim();
    return aiEval.includes("don't need") || aiEval.includes("dont need") || 
           aiEval.includes("manual") || aiEval === "no" || aiEval.includes("keyword");
  }

  before(() => {
    cy.task("readExcelTestCases").then((cases) => {
      testCases = cases;
    });
  });

  beforeEach(() => {
    cy.clearChatSession();
    cy.visit("/home");
  });

  it("Executes and Evaluates Excel Scenarios in Browser UI", () => {
    cy.then(() => {
      if (testCases.length === 0) {
        cy.log("⏭️ [STATUS CHECK] All test cases are already marked as 'Tested'! (Pass --force to re-test).");
        return;
      }

      const mode = (Cypress.env("mode") || "A").toString().toUpperCase();
      cy.log(`🎯 Testing Mode: Mode ${mode} (${mode === "B" ? "Optimized Batch" : "Standard Sequential"})`);

      let orderedCases = testCases;
      if (mode === "B") {
        const noAi = testCases.filter(c => isNoAi(c));
        const needAi = testCases.filter(c => !isNoAi(c));
        orderedCases = [...noAi, ...needAi];
      }

      const capturedAiCases = [];

      orderedCases.forEach((tc, idx) => {
        // Check Remark column FIRST: skip if marked as Reject
        const remark = (tc.remark || "").toLowerCase().trim();
        if (remark.includes("reject")) {
          cy.log(`🚫 [REMARK: REJECT] Skipping Test ID ${tc.test_id} (Row ${tc.row_idx}) because Remark is 'Reject'.`);
          return;
        }

        const status = (tc.status || "").toLowerCase().trim();
        const isTested = status.includes("tested") && !status.includes("not tested") && !status.includes("untested") && !status.includes("pending");
        if (isTested && !Cypress.env("force")) {
          cy.log(`⏭️ [SKIPPED] Test ID ${tc.test_id} (Row ${tc.row_idx}) is ALREADY marked as 'Tested'. Skipping.`);
          return;
        }

        const isTestCaseNoAi = isNoAi(tc);
        cy.log(`▶ Starting Scenario [${tc.test_id}]: ${tc.feature} (${isTestCaseNoAi ? "No AI" : "Need AI"})`);
        cy.clearChatSession();
        cy.openChatbot();
        cy.startNewChat();

        const turns = (tc.turns && tc.turns.length > 0) ? tc.turns : [tc.input_raw];
        const turnResults = [];
        let scenarioTimedOut = false;

        cy.wrap(turns).each((turnQuery, tIdx) => {
          cy.then(() => {
            if (scenarioTimedOut) return;
            cy.log(`Turn ${tIdx + 1}: ${turnQuery}`);
            cy.sendChatMessage(turnQuery);

            cy.waitForBotReply(120000, turnQuery).then((botResponse) => {
              cy.log(`Turn ${tIdx + 1} Bot Response: ${botResponse.substring(0, 80)}...`);
              turnResults.push({
                turn: tIdx + 1,
                query: turnQuery,
                reply: botResponse
              });
              if (botResponse.startsWith("[TIMEOUT:")) {
                scenarioTimedOut = true;
              }
            });

            if (tIdx < turns.length - 1) {
              cy.wait(1500);
            }
          });
        }).then(() => {
          const lastTurn = turnResults[turnResults.length - 1] || {};
          const isTimeout = scenarioTimedOut || (lastTurn.reply && lastTurn.reply.startsWith("[TIMEOUT:"));

          let displayAnswer = "";
          if (turnResults.length > 1) {
            displayAnswer = turnResults.map(tr => `Turn ${tr.turn} User: ${tr.query}\nTurn ${tr.turn} Bot: ${tr.reply}`).join("\n");
          } else {
            displayAnswer = lastTurn.reply || "[ERROR: No response recorded]";
          }

          if (isTimeout) {
            cy.log(`❌ Scenario ${tc.test_id} timed out after 2 minutes! Recording in sheet and skipping...`);
            cy.task("writeExcelResult", {
              sheet: tc.sheet_name,
              row_idx: tc.row_idx,
              test_id: tc.test_id,
              score: 1,
              result: "FAIL",
              actual_output: "[TIMEOUT: No response received within 120s]",
              notes: "Timed Out: The chatbot backend did not respond within the 2-minute limit (120s max). Scenario skipped."
            });
          } else if (mode === "B" && !isTestCaseNoAi) {
            // Mode B: Capture response and defer AI evaluation to batch step
            cy.log(`💾 Captured response for Test ID ${tc.test_id}. Queued for Batch AI Evaluation.`);
            capturedAiCases.push({
              testId: tc.test_id,
              rowIdx: tc.row_idx,
              sheetName: tc.sheet_name,
              feature: tc.feature,
              userQuery: tc.input_raw,
              expectedResult: tc.expected,
              actualResponse: displayAnswer
            });

            cy.task("writeExcelResult", {
              sheet: tc.sheet_name,
              row_idx: tc.row_idx,
              test_id: tc.test_id,
              score: null,
              result: "PENDING",
              status: "Response Captured (Pending AI Eval)",
              actual_output: displayAnswer,
              notes: "Response captured. Waiting for Batch AI Evaluation."
            });
          } else {
            // Mode A OR No-AI: Evaluate immediately (Deterministic Keywords or Groq)
            cy.task("evaluateWithGroq", {
              scenario: tc.scenario || tc.feature || "General",
              userQuery: tc.input_raw,
              expectedResult: tc.expected,
              actualResponse: displayAnswer,
              aiEvaluation: tc.ai_evaluation,
              expectedKeywords: tc.expected_keywords,
              testType: tc.test_type,
              feature: tc.feature
            }).then((evalResult) => {
              cy.log(`★ Score: ${evalResult.score}/10 | Verdict: ${evalResult.result}`);
              cy.log(`Notes: ${evalResult.notes}`);

              cy.task("writeExcelResult", {
                sheet: tc.sheet_name,
                row_idx: tc.row_idx,
                test_id: tc.test_id,
                score: evalResult.score,
                result: evalResult.result,
                status: "Tested",
                actual_output: displayAnswer,
                notes: evalResult.notes
              });
            });
          }
        });

        if (idx < orderedCases.length - 1) {
          cy.wait(2000);
        }
      });

      // Mode B Phase 3: Execute Batch AI Evaluations in chunks of 10
      cy.then(() => {
        if (mode === "B" && capturedAiCases.length > 0) {
          cy.log(`🤖 Starting Batch AI Evaluation for ${capturedAiCases.length} captured cases...`);
          const batchSize = 10;
          const chunks = [];
          for (let i = 0; i < capturedAiCases.length; i += batchSize) {
            chunks.push(capturedAiCases.slice(i, i + batchSize));
          }

          cy.wrap(chunks).each((batch, bIdx) => {
            cy.log(`▶ Evaluating Batch ${bIdx + 1}/${chunks.length} (${batch.length} scenarios) with Groq...`);
            cy.task("evaluateBatchWithGroq", batch).then((evalResults) => {
              batch.forEach((item, itemIdx) => {
                const res = evalResults[itemIdx] || { score: 5, result: "PARTIAL", notes: "Review manually" };
                cy.task("writeExcelResult", {
                  sheet: item.sheetName,
                  row_idx: item.rowIdx,
                  test_id: item.testId,
                  score: res.score,
                  result: res.result,
                  status: "Tested",
                  actual_output: item.actualResponse,
                  notes: `[Groq Batch Evaluation] ${res.notes}`
                });
              });
            });
          });
        }
      });
    });
  });
});
